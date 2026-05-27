package com.promptproxy.intellij

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.logger
import java.io.File
import java.util.concurrent.TimeUnit

private val LOG = logger<PromptProxyService>()

/** Result returned from the engine. */
data class OptimizationResult(
    val optimizedPrompt: String,
    val originalTokens: Int,
    val optimizedTokens: Int,
    val tokensSaved: Int,
    val estimatedCostUsd: Double,
    val cacheStatus: String,
    val improvements: List<String>,
)

/**
 * Application service that wraps the Node.js engine CLI subprocess.
 * Calls: `node <cli.js> --stdin` and sends JSON on stdin, reads JSON on stdout.
 */
class PromptProxyService {

    private val gson = Gson()

    /**
     * Optimizes [prompt] by calling the engine CLI.
     *
     * @param prompt The raw user prompt to optimize.
     * @param activeFileContent Optional active file content to pack as context.
     * @throws IllegalStateException when the CLI is not configured or fails.
     */
    @Throws(IllegalStateException::class)
    fun optimize(prompt: String, activeFileContent: String? = null): OptimizationResult {
        val settings   = PromptProxyAppSettings.getInstance().state
        val nodePath   = settings.nodePath.ifBlank { "node" }
        val cliPath    = settings.engineCliPath

        check(cliPath.isNotBlank()) {
            "Engine CLI path is not configured. Open Settings > Tools > Prompt Proxy."
        }
        check(File(cliPath).exists()) {
            "Engine CLI not found at '$cliPath'. Run 'npm run build' in the repo root."
        }

        // Build input JSON compatible with IntelliJPromptProxyAdapter
        val input = JsonObject().apply {
            addProperty("prompt", prompt)
            addProperty("enableSecretDetection", settings.enableSecretDetection)
            if (!settings.dbPath.isBlank()) addProperty("dbPath", settings.dbPath)
            if (settings.includeActiveFile && activeFileContent != null) {
                val filesArr = gson.toJsonTree(
                    listOf(
                        mapOf("path" to "active-file", "content" to activeFileContent)
                    )
                )
                add("editorSnapshots", filesArr)
            }
        }

        val process = ProcessBuilder(nodePath, cliPath, "--stdin")
            .redirectErrorStream(false)
            .start()

        try {
            process.outputStream.use { it.write(gson.toJson(input).toByteArray(Charsets.UTF_8)) }

            val timedOut = !process.waitFor(30, TimeUnit.SECONDS)
            if (timedOut) {
                process.destroyForcibly()
                error("Engine timed out after 30 s.")
            }

            val stderr = process.errorStream.bufferedReader().readText()
            if (stderr.isNotBlank()) LOG.warn("[PromptProxy engine stderr] $stderr")

            val stdout = process.inputStream.bufferedReader().readText()
            check(stdout.isNotBlank()) { "Engine returned no output. stderr: $stderr" }

            val json = gson.fromJson(stdout, JsonObject::class.java)

            return OptimizationResult(
                optimizedPrompt  = json.get("optimized_prompt")?.asString ?: prompt,
                originalTokens   = json.getAsJsonObject("metrics")?.get("original_tokens")?.asInt ?: 0,
                optimizedTokens  = json.getAsJsonObject("metrics")?.get("optimized_tokens")?.asInt ?: 0,
                tokensSaved      = json.getAsJsonObject("metrics")?.get("tokens_saved")?.asInt ?: 0,
                estimatedCostUsd = json.getAsJsonObject("metrics")?.get("estimated_cost_usd")?.asDouble ?: 0.0,
                cacheStatus      = json.getAsJsonObject("cache")?.get("status")?.asString ?: "miss",
                improvements     = json.getAsJsonArray("improvements")
                    ?.map { it.asString } ?: emptyList(),
            )
        } finally {
            process.destroyForcibly()
        }
    }
}
