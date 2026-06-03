package com.promptproxy.intellij

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.diagnostic.logger
import java.io.File
import java.net.URLDecoder
import java.util.concurrent.TimeUnit
import java.util.jar.JarFile

private val LOG = logger<PromptProxyService>()
private const val MAX_CONTEXT_CHARS = 12000
private const val MAX_SEED_COUNT = 200
private const val ENGINE_TIMEOUT_SECONDS = 60L

/** Result returned from the engine. */
data class OptimizationResult(
    val optimizedPrompt: String,
    val originalTokens: Int,
    val optimizedTokens: Int,
    val tokensSaved: Int,
    val estimatedCostUsd: Double,
    val estimatedOutputTokens: Int,
    val cacheStatus: String,
    val cacheConfidence: Double,
    val improvements: List<String>,
    val diagnostics: List<String>,
    val warnings: List<String>,
    val explanation: String,
    val sdlcMode: String?,
    val requestId: String?,
    val reusedSegments: List<ReusedSegment> = emptyList(),
    val reusedTokensSaved: Int = 0,
)

/** A context block served from the local cache instead of resent. */
data class ReusedSegment(
    val label: String,
    val ref: String,
    val tokensSaved: Int,
)

data class StatusOverview(
    val cacheEntries: Int,
    val cacheHits: Int,
    val memoryEntries: Int,
    val kgNodes: Int,
    val kgEdges: Int,
    val peerTotal: Int,
    val peerEnabled: Int,
    val digestFiles: Int,
)

data class PeerInfo(
    val label: String,
    val dbPath: String,
    val enabled: Boolean,
)

private fun JsonObject.obj(name: String): JsonObject? =
    get(name)?.takeIf { it.isJsonObject }?.asJsonObject

private fun JsonObject.arr(name: String): JsonArray? =
    get(name)?.takeIf { it.isJsonArray }?.asJsonArray

private fun JsonObject.str(name: String): String? =
    get(name)?.takeIf { !it.isJsonNull }?.asString

private fun JsonObject.int(name: String): Int? =
    get(name)?.takeIf { !it.isJsonNull }?.asInt

private fun JsonObject.double(name: String): Double? =
    get(name)?.takeIf { !it.isJsonNull }?.asDouble

private fun JsonArray.toStringList(): List<String> = mapNotNull { element ->
    when {
        element.isJsonPrimitive -> element.asString
        element.isJsonObject -> {
            val obj = element.asJsonObject
            val code = obj.str("code")
            val message = obj.str("message")
            val fix = obj.str("fix_suggestion")
            listOfNotNull(code?.let { "[$it]" }, message, fix?.let { "Suggestion: $it" })
                .joinToString(" ")
        }
        else -> null
    }
}

/**
 * Application service that wraps the Node.js engine CLI subprocess.
 * Calls: `node <cli.js> --stdin` and sends JSON on stdin, reads JSON on stdout.
 */
class PromptProxyService {

    private val gson = Gson()
    private val prettyGson = GsonBuilder().setPrettyPrinting().create()

    /**
     * Optimizes [prompt] by calling the engine CLI.
     *
     * @param prompt The raw user prompt to optimize.
     * @param project Current IntelliJ project, used for workspace-aware context.
     * @throws IllegalStateException when the CLI is not configured or fails.
     */
    @Throws(IllegalStateException::class)
    fun optimize(prompt: String, project: Project): OptimizationResult {
        val settings = PromptProxyAppSettings.getInstance().state
        val dbPath = resolveDbPath()
        val workspaceRoot = workspaceRoot(project)
        val warnings = if (settings.enableSecretDetection) scanForSecrets(prompt, settings.customSecretPatterns) else emptyList()

        val request = JsonObject().apply {
            addProperty("raw_prompt", prompt)
            addProperty("mode", settings.processingMode.ifBlank { "blocking" })
            addProperty("workspace_id", computeWorkspaceId(workspaceRoot))
            addProperty("target_model", settings.targetModel.ifBlank { "gpt" })
            add("pricing", JsonObject().apply {
                addProperty("input_cost_per_1k_tokens", settings.pricingInput)
                addProperty("output_cost_per_1k_tokens", settings.pricingOutput)
            })
            add("ide_context", buildIdeContext(project, settings, workspaceRoot))
        }

        val json = runJson(listOf("--stdin", "--db", dbPath), gson.toJson(request))
        val metrics = json.obj("metrics")
        val analysis = json.obj("analysis")
        val cache = analysis?.obj("cache") ?: json.obj("cache")
        val optimized = cleanOptimizedPrompt(json.str("optimized_prompt") ?: prompt)
        val sdlc = json.obj("sdlc_mode")?.str("label") ?: json.obj("sdlc_mode")?.str("id")

        val reusedSegments = cache?.arr("reused_segments")?.mapNotNull { element ->
            element.takeIf { it.isJsonObject }?.asJsonObject?.let { obj ->
                ReusedSegment(
                    label = obj.str("label") ?: "context block",
                    ref = obj.str("ref") ?: "",
                    tokensSaved = obj.int("tokens_saved") ?: 0,
                )
            }
        } ?: emptyList()

        return OptimizationResult(
            optimizedPrompt = optimized,
            originalTokens = metrics?.int("raw_input_tokens") ?: metrics?.int("original_tokens") ?: 0,
            optimizedTokens = metrics?.int("optimized_input_tokens") ?: metrics?.int("optimized_tokens") ?: 0,
            tokensSaved = metrics?.int("tokens_saved") ?: 0,
            estimatedCostUsd = metrics?.double("estimated_cost_usd") ?: 0.0,
            estimatedOutputTokens = metrics?.int("estimated_output_tokens") ?: 0,
            cacheStatus = cache?.str("status") ?: "miss",
            cacheConfidence = cache?.double("confidence") ?: 0.0,
            improvements = json.arr("improvements")?.toStringList() ?: emptyList(),
            diagnostics = json.arr("diagnostics")?.toStringList() ?: emptyList(),
            warnings = warnings,
            explanation = json.str("explanation") ?: "",
            sdlcMode = sdlc,
            requestId = json.str("request_id"),
            reusedSegments = reusedSegments,
            reusedTokensSaved = cache?.int("reused_tokens_saved") ?: reusedSegments.sumOf { it.tokensSaved },
        )
    }

    fun resolveDbPath(): String {
        val configured = PromptProxyAppSettings.getInstance().state.dbPath.trim()
        val dbFile = if (configured.isNotEmpty()) {
            File(configured)
        } else {
            File(PathManager.getSystemPath(), "prompt-optimizer/prompt_semantic_cache.db")
        }
        dbFile.parentFile?.mkdirs()
        return dbFile.absolutePath
    }

    fun statusOverview(project: Project): StatusOverview {
        val workspace = computeWorkspaceId(workspaceRoot(project))
        val json = runJson(listOf("--status-overview", "--workspace", workspace, "--db", resolveDbPath()))
        val cache = json.obj("cache")
        val kg = json.obj("kg")
        val peers = json.obj("peers")
        val memory = json.obj("memory")
        val digests = json.obj("digests")
        return StatusOverview(
            cacheEntries = cache?.int("entries") ?: 0,
            cacheHits = cache?.int("hits") ?: 0,
            memoryEntries = memory?.int("entries") ?: 0,
            kgNodes = kg?.int("nodes") ?: 0,
            kgEdges = kg?.int("edges") ?: 0,
            peerTotal = peers?.int("total") ?: 0,
            peerEnabled = peers?.int("enabled") ?: 0,
            digestFiles = digests?.int("files") ?: 0,
        )
    }

    fun seedWorkspace(project: Project, force: Boolean = false): JsonObject {
        val root = workspaceRoot(project)
        val workspace = computeWorkspaceId(root)
        val seeds = harvestSeedPrompts(root).ifEmpty {
            listOf("Summarize the architecture and conventions of this codebase.")
        }.take(MAX_SEED_COUNT)
        val args = mutableListOf("--seed-batch", "--db", resolveDbPath(), "--workspace-id", workspace)
        if (!root.isNullOrBlank()) {
            args.add("--workspace-root")
            args.add(root)
        }
        if (force || seeds.isNotEmpty()) {
            return runJson(args, gson.toJson(seeds))
        }
        return JsonObject().apply { addProperty("seeded", 0) }
    }

    fun ingestMemoryFiles(project: Project): JsonObject {
        val root = workspaceRoot(project)
        val workspace = computeWorkspaceId(root)
        val args = mutableListOf("--seed-batch", "--db", resolveDbPath(), "--workspace-id", workspace)
        if (!root.isNullOrBlank()) {
            args.add("--workspace-root")
            args.add(root)
        }
        return runJson(args, gson.toJson(listOf("Refresh long-lived memory and project conventions for this workspace.")))
    }

    fun cacheStats(): String = pretty(runJson(listOf("--cache-stats", "--db", resolveDbPath())))

    fun clearCache(): String = pretty(runJson(listOf("--clear-cache", "--db", resolveDbPath())))

    fun healthCheck(): String = pretty(runJson(listOf("--health-check", "--db", resolveDbPath())))

    fun metrics(reset: Boolean = false): String {
        val args = mutableListOf("--metrics", "--db", resolveDbPath())
        if (reset) args.add("--reset")
        return pretty(runJson(args))
    }

    fun runMaintenance(vacuum: Boolean = false): String {
        val args = mutableListOf("--db-prune", "--max-cache", "2000", "--max-digests", "500", "--max-kg", "5000", "--older-than-days", "90", "--db", resolveDbPath())
        if (vacuum) args.add("--vacuum")
        return pretty(runJson(args))
    }

    fun exportDatabase(destinationPath: String): String =
        pretty(runJson(listOf("--export-db", destinationPath, "--db", resolveDbPath())))

    fun knowledgeGraphStats(project: Project): String =
        pretty(runJson(listOf("--kg-stats", "--workspace", computeWorkspaceId(workspaceRoot(project)), "--db", resolveDbPath())))

    fun digestStats(project: Project): String =
        pretty(runJson(listOf("--digest-stats", "--workspace", computeWorkspaceId(workspaceRoot(project)), "--db", resolveDbPath())))

    fun digestList(project: Project): String =
        pretty(parseElement(runRaw(listOf("--digest-list", "--workspace", computeWorkspaceId(workspaceRoot(project)), "--limit", "40", "--db", resolveDbPath()))))

    fun clearDigests(project: Project): String =
        pretty(runJson(listOf("--digest-clear", "--workspace", computeWorkspaceId(workspaceRoot(project)), "--db", resolveDbPath())))

    fun recallMemory(project: Project, query: String): String =
        runRaw(listOf("--recall-memory", "--query", query, "--workspace", computeWorkspaceId(workspaceRoot(project)), "--scope", "all", "--limit", "8", "--format", "markdown", "--db", resolveDbPath()))

    fun listModes(project: Project): String {
        val args = mutableListOf("--list-modes", "--db", resolveDbPath())
        workspaceRoot(project)?.let {
            args.add("--workspace-root")
            args.add(it)
        }
        return pretty(parseElement(runRaw(args)))
    }

    fun peerList(): List<PeerInfo> {
        val json = runJson(listOf("--peer-list", "--db", resolveDbPath()))
        return json.arr("peers")?.mapNotNull { element ->
            if (!element.isJsonObject) return@mapNotNull null
            val peer = element.asJsonObject
            PeerInfo(
                label = peer.str("label") ?: "peer",
                dbPath = peer.str("peer_db_path") ?: peer.str("db_path") ?: peer.str("endpoint") ?: "",
                enabled = peer.get("enabled")?.takeIf { !it.isJsonNull }?.asBoolean ?: true,
            )
        } ?: emptyList()
    }

    fun addPeer(label: String, peerDb: String): String =
        pretty(runJson(listOf("--peer-add", "--label", label, "--peer-db", peerDb, "--db", resolveDbPath())))

    fun removePeer(peerDb: String): String =
        pretty(runJson(listOf("--peer-remove", "--peer-db", peerDb, "--db", resolveDbPath())))

    fun togglePeer(peerDb: String, enabled: Boolean): String =
        pretty(runJson(listOf("--peer-toggle", "--peer-db", peerDb, "--enabled", enabled.toString(), "--db", resolveDbPath())))

    fun openMemoryFile(project: Project): File {
        val root = workspaceRoot(project) ?: throw IllegalStateException("Open a project before editing workspace memory.")
        val file = File(root, ".promptoptimizer/memory.md")
        file.parentFile.mkdirs()
        if (!file.exists()) {
            file.writeText(
                "# Prompt Optimizer workspace memory\n\n" +
                    "Add project conventions, architectural decisions, local commands, and AI-agent preferences here.\n" +
                    "This file is indexed locally and injected into optimized prompts.\n",
                Charsets.UTF_8,
            )
        }
        return file
    }

    fun pretty(element: JsonElement): String = prettyGson.toJson(element)

    fun runJson(args: List<String>, stdin: String? = null): JsonObject {
        val element = parseElement(runRaw(args, stdin))
        check(element.isJsonObject) { "Engine returned JSON that is not an object." }
        return element.asJsonObject
    }

    fun runRaw(args: List<String>, stdin: String? = null): String {
        val settings = PromptProxyAppSettings.getInstance().state
        val nodePath = settings.nodePath.ifBlank { "node" }
        val cliPath = resolveCliPath(settings)
        val command = mutableListOf(nodePath, cliPath).apply { addAll(args) }
        val process = ProcessBuilder(command)
            .redirectErrorStream(false)
            .start()

        try {
            process.outputStream.use { stream ->
                if (stdin != null) stream.write(stdin.toByteArray(Charsets.UTF_8))
            }
            val timedOut = !process.waitFor(ENGINE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            if (timedOut) {
                process.destroyForcibly()
                error("Engine timed out after $ENGINE_TIMEOUT_SECONDS s.")
            }

            val stderr = process.errorStream.bufferedReader().readText()
            val stdout = process.inputStream.bufferedReader().readText()
            if (stderr.isNotBlank()) LOG.warn("[PromptOptimizer engine stderr] $stderr")
            check(process.exitValue() == 0) { stderr.ifBlank { "Engine exited with ${process.exitValue()}." } }
            check(stdout.isNotBlank()) { "Engine returned no output. stderr: $stderr" }
            return stdout.trim()
        } finally {
            process.destroyForcibly()
        }
    }

    private fun parseElement(raw: String): JsonElement = JsonParser.parseString(raw)

    private fun buildIdeContext(
        project: Project,
        settings: PromptProxyAppSettings.State,
        workspaceRoot: String?,
    ): JsonObject = JsonObject().apply {
        if (!workspaceRoot.isNullOrBlank()) addProperty("workspace_root", workspaceRoot)
        val editorManager = FileEditorManager.getInstance(project)
        val activeEditor = editorManager.selectedTextEditor
        val activeVirtualFile = activeEditor?.document?.let { FileDocumentManager.getInstance().getFile(it) }
        if (settings.includeActiveFile && activeEditor != null) {
            val active = fileSnapshot(activeVirtualFile?.path ?: "active-file", activeEditor.document.text, activeVirtualFile?.extension, true, activeEditor.selectionModel.selectedText)
            add("active_file", active)
        }
        if (settings.includeOpenFiles) {
            val openFiles = JsonArray()
            editorManager.openFiles
                .filter { it.path != activeVirtualFile?.path }
                .take(8)
                .forEach { file ->
                    val doc = FileDocumentManager.getInstance().getDocument(file) ?: return@forEach
                    openFiles.add(fileSnapshot(file.path, doc.text, file.extension, false, null))
                }
            add("open_files", openFiles)
        }
        add("logs", JsonArray())
    }

    private fun fileSnapshot(path: String, content: String, language: String?, active: Boolean, selection: String?): JsonObject =
        JsonObject().apply {
            addProperty("path", path)
            addProperty("content", content.take(MAX_CONTEXT_CHARS))
            if (!language.isNullOrBlank()) addProperty("language", language)
            addProperty("is_active", active)
            if (!selection.isNullOrBlank()) addProperty("selection", selection.take(MAX_CONTEXT_CHARS))
        }

    private fun cleanOptimizedPrompt(prompt: String): String = prompt
        .replace(Regex("(?:^|\\n\\n)# Problems\\n[\\s\\S]*?(?=\\n\\n#|\\s*$)"), "")
        .replace(Regex("(?:^|\\n\\n)# Prompt (?:Proxy|Optimizer)[^\\n]*\\n[\\s\\S]*?(?=\\n\\n#|\\s*$)", RegexOption.IGNORE_CASE), "")
        .replace(Regex("(?:^|\\n\\n)# (?:Prompt Optimizer Session Buffer|Prompt Optimizer Chat History|Knowledge graph --|Peer workspace \\()[\\s\\S]*?(?=\\n\\n#|\\s*$)", RegexOption.IGNORE_CASE), "")
        .trim()

    private fun workspaceRoot(project: Project): String? = project.basePath

    private fun computeWorkspaceId(workspaceRoot: String?): String {
        if (workspaceRoot.isNullOrBlank()) return "global"
        var hash = 5381L
        workspaceRoot.forEach { ch ->
            hash = ((hash shl 5) + hash) xor ch.code.toLong()
            hash = hash and 0xffffffffL
        }
        return hash.toString(16)
    }

    private fun harvestSeedPrompts(workspaceRoot: String?): List<String> {
        if (workspaceRoot.isNullOrBlank()) return emptyList()
        val root = File(workspaceRoot)
        val seeds = mutableListOf<String>()
        val seedFiles = listOf(
            ".github/copilot-instructions.md",
            "AGENTS.md",
            "CLAUDE.md",
            ".cursorrules",
            ".copilot-instructions.md",
            "copilot-instructions.md",
            ".promptoptimizer/memory.md",
            ".promptoptimizer/knowledge.md",
        )
        seedFiles.forEach { rel ->
            val file = File(root, rel)
            if (file.isFile) {
                seeds += file.readLines(Charsets.UTF_8)
                    .map { it.replace(Regex("^[-*#>\\s]+"), "").trim() }
                    .filter { it.length in 20..300 }
            }
        }
        val readme = File(root, "README.md")
        if (readme.isFile) {
            seeds += readme.readText(Charsets.UTF_8).take(5000).lines()
                .map { it.replace(Regex("^[#*\\->|\\s]+"), "").trim() }
                .filter { it.length in 30..300 && !it.startsWith("!") }
        }
        val packageJson = File(root, "package.json")
        if (packageJson.isFile) {
            runCatching {
                val pkg = JsonParser.parseString(packageJson.readText(Charsets.UTF_8)).asJsonObject
                pkg.str("description")?.takeIf { it.length > 10 }?.let { seeds += "Explain this project: $it" }
                pkg.obj("scripts")?.keySet()?.forEach { script -> seeds += "What does the npm $script script do and when should I run it?" }
            }
        }
        runCatching {
            val git = ProcessBuilder("git", "log", "--pretty=format:%s%n%b", "-n", "80")
                .directory(root)
                .redirectErrorStream(true)
                .start()
            if (git.waitFor(5, TimeUnit.SECONDS) && git.exitValue() == 0) {
                seeds += git.inputStream.bufferedReader().readLines()
                    .map { it.trim() }
                    .filter { it.length in 15..300 }
            } else {
                git.destroyForcibly()
            }
        }
        return seeds.map { it.trim() }.filter { it.length in 15..400 }.distinct().take(MAX_SEED_COUNT)
    }

    private fun scanForSecrets(prompt: String, customPatterns: String): List<String> {
        val builtIns = listOf(
            "GitHub token" to Regex("gh[pousr]_[A-Za-z0-9_]{20,}"),
            "OpenAI-style API key" to Regex("sk-[A-Za-z0-9]{20,}"),
            "AWS access key" to Regex("AKIA[0-9A-Z]{16}"),
            "Generic credential assignment" to Regex("(?i)(api[_-]?key|token|password|secret)\\s*[:=]\\s*['\"]?[^'\"\\s]{8,}"),
        )
        val warnings = builtIns.mapNotNull { (label, regex) ->
            regex.find(prompt)?.let { "Possible secret detected: $label" }
        }.toMutableList()
        customPatterns.lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .forEachIndexed { index, raw ->
                val parts = raw.split("::", limit = 2)
                val label = if (parts.size == 2) parts[0].trim().ifBlank { "Custom pattern ${index + 1}" } else "Custom pattern ${index + 1}"
                val pattern = if (parts.size == 2) parts[1] else raw
                runCatching { Regex(pattern) }.getOrNull()?.find(prompt)?.let {
                    warnings += "Possible secret detected: $label"
                }
            }
        return warnings.distinct()
    }

    private fun resolveCliPath(settings: PromptProxyAppSettings.State): String {
        val configured = settings.engineCliPath.trim()
        if (configured.isNotEmpty() && File(configured).exists()) return File(configured).absolutePath
        extractBundledEngineIfNeeded()?.let { return it.absolutePath }
        check(configured.isNotEmpty()) {
            "Engine CLI path is not configured and no bundled engine runtime was found. Open Settings > Tools > Prompt Optimizer."
        }
        error("Engine CLI not found at '$configured'.")
    }

    private fun extractBundledEngineIfNeeded(): File? {
        val cachedRoot = File(PathManager.getSystemPath(), "prompt-optimizer/engine")
        val cachedCli = File(cachedRoot, "dist/cli.js")
        if (cachedCli.exists()) return cachedCli

        val resource = javaClass.classLoader.getResource("engine/dist/cli.js") ?: return null
        cachedRoot.mkdirs()
        if (resource.protocol == "file") {
            val cliFile = File(resource.toURI())
            val engineRoot = cliFile.parentFile?.parentFile ?: return null
            engineRoot.copyRecursively(cachedRoot, overwrite = true)
            return cachedCli.takeIf { it.exists() }
        }

        if (resource.protocol == "jar") {
            val jarPath = resource.path.substringBefore("!").removePrefix("file:")
            val jarFile = File(URLDecoder.decode(jarPath, Charsets.UTF_8.name()))
            JarFile(jarFile).use { jar ->
                val entries = jar.entries()
                while (entries.hasMoreElements()) {
                    val entry = entries.nextElement()
                    if (entry.isDirectory || !entry.name.startsWith("engine/")) continue
                    val relative = entry.name.removePrefix("engine/")
                    val out = File(cachedRoot, relative)
                    out.parentFile.mkdirs()
                    jar.getInputStream(entry).use { input -> out.outputStream().use { output -> input.copyTo(output) } }
                }
            }
            return cachedCli.takeIf { it.exists() }
        }

        return null
    }

}
