package com.promptproxy.intellij

import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.FlowLayout
import java.awt.Font
import java.awt.GridLayout
import java.awt.Toolkit
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.io.File
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JFileChooser
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JTabbedPane
import javax.swing.JTextArea
import javax.swing.SwingUtilities
import javax.swing.UIManager

class PromptProxyPanel(private val project: Project) {

    val root: JPanel = JPanel(BorderLayout(0, 8))

    private val service = PromptProxyService()
    private val settings: PromptProxyAppSettings.State
        get() = PromptProxyAppSettings.getInstance().state

    private val tabs = JTabbedPane()
    private val promptArea = JBTextArea(7, 56).apply {
        lineWrap = true
        wrapStyleWord = true
        emptyText.text = "Paste a prompt, use the editor action, or pull from clipboard/selection."
    }
    private val outputArea = readOnlyArea(10, 56)
    private val detailsArea = readOnlyArea(8, 56).apply { font = font.deriveFont(11f) }
    private val metricsLabel = JBLabel(" ")
    private val statusLabel = JBLabel("Ready").apply { font = font.deriveFont(Font.ITALIC, 11f) }
    private val overviewLabel = JBLabel("Cache 0 | Memory 0 | KG 0/0 | Peers 0/0 | Files 0")
    private val modeCombo = JComboBox(arrayOf("optimize", "agent", "direct"))
    private val targetModelCombo = JComboBox(arrayOf("gpt", "claude", "gemini", "deepseek", "grok", "local"))
    private val optimizeBtn = JButton("Optimize", AllIcons.Actions.Execute)
    private val copyBtn = JButton("Copy", AllIcons.Actions.Copy).apply { isEnabled = false }

    init {
        root.border = JBUI.Borders.empty(8)
        root.putClientProperty(PANEL_CLIENT_KEY, this)
        modeCombo.selectedItem = settings.defaultMode
        targetModelCombo.selectedItem = settings.targetModel

        tabs.addTab("Optimize", buildOptimizeTab())
        tabs.addTab("Context", buildContextTab())
        tabs.addTab("Admin", buildAdminTab())
        tabs.addTab("Guide", buildGuideTab())
        root.add(tabs, BorderLayout.CENTER)

        optimizeBtn.addActionListener { runPrimaryAction() }
        copyBtn.addActionListener { copyText(outputArea.text, "Optimized prompt copied.") }
        modeCombo.addActionListener { settings.defaultMode = modeCombo.selectedItem as String }
        targetModelCombo.addActionListener { settings.targetModel = targetModelCombo.selectedItem as String }

        refreshOverview()
        seedWorkspace(force = false)
    }

    fun setPrompt(text: String, optimizeNow: Boolean = false) {
        tabs.selectedIndex = 0
        promptArea.text = text
        promptArea.caretPosition = 0
        if (optimizeNow) runPrimaryAction()
    }

    private fun buildOptimizeTab(): JPanel {
        val topControls = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
            add(JBLabel("Mode:"))
            add(modeCombo)
            add(JBLabel("Target:"))
            add(targetModelCombo)
            add(optimizeBtn)
            add(copyBtn)
            add(JButton("Clipboard").apply { addActionListener { useClipboard() } })
            add(JButton("Selection").apply { addActionListener { useEditorSelection() } })
            add(statusLabel)
        }
        val outputPanel = JPanel(BorderLayout(0, 4)).apply {
            add(metricsLabel, BorderLayout.NORTH)
            add(JBScrollPane(outputArea), BorderLayout.CENTER)
            add(JBScrollPane(detailsArea), BorderLayout.SOUTH)
        }
        return JPanel(BorderLayout(0, 6)).apply {
            add(JBScrollPane(promptArea), BorderLayout.NORTH)
            add(topControls, BorderLayout.CENTER)
            add(outputPanel, BorderLayout.SOUTH)
        }
    }

    private fun buildContextTab(): JPanel {
        val buttons = JPanel(FlowLayout(FlowLayout.LEFT, 6, 4)).apply {
            add(JButton("Refresh Overview").apply { addActionListener { refreshOverview() } })
            add(JButton("Index Workspace").apply { addActionListener { seedWorkspace(force = true) } })
            add(JButton("Memory").apply { addActionListener { openMemoryFile() } })
            add(JButton("Recall Memory").apply { addActionListener { recallMemory() } })
            add(JButton("Peers").apply { addActionListener { managePeers() } })
            add(JButton("Knowledge Graph").apply { addActionListener { showBackground("Knowledge Graph", { service.knowledgeGraphStats(project) }) } })
            add(JButton("Studied Files").apply { addActionListener { showBackground("Studied Files", { service.digestList(project) }) } })
            add(JButton("Refresh Memory").apply { addActionListener { refreshMemoryFiles() } })
        }
        return JPanel(BorderLayout(0, 8)).apply {
            add(overviewLabel, BorderLayout.NORTH)
            add(buttons, BorderLayout.CENTER)
            add(readOnlyText(CONTEXT_GUIDE), BorderLayout.SOUTH)
        }
    }

    private fun buildAdminTab(): JPanel {
        val grid = JPanel(GridLayout(0, 2, 6, 6)).apply {
            add(JButton("Cache Stats").apply { addActionListener { showBackground("Cache Stats", { service.cacheStats() }) } })
            add(JButton("Clear Cache").apply { addActionListener { confirmAndRun("Clear semantic cache?", "Clear Cache") { service.clearCache() } } })
            add(JButton("Health Check").apply { addActionListener { showBackground("Health Check", { service.healthCheck() }) } })
            add(JButton("Metrics").apply { addActionListener { showBackground("Metrics", { service.metrics() }) } })
            add(JButton("Maintenance").apply { addActionListener { confirmAndRun("Run retention, eviction, and vacuum maintenance?", "Maintenance") { service.runMaintenance(vacuum = true) } } })
            add(JButton("Export DB").apply { addActionListener { exportDatabase() } })
            add(JButton("Agent Skills").apply { addActionListener { showBackground("Agent Skills", { service.listModes(project) }) } })
            add(JButton("Clear Studied Files").apply { addActionListener { confirmAndRun("Clear cross-session file digest memory?", "Clear Studied Files") { service.clearDigests(project) } } })
            add(JButton("Digest Stats").apply { addActionListener { showBackground("Digest Stats", { service.digestStats(project) }) } })
            add(JButton("Database Path").apply { addActionListener { showTextDialog("Database Path", service.resolveDbPath()) } })
        }
        return JPanel(BorderLayout(0, 8)).apply {
            add(grid, BorderLayout.NORTH)
            add(readOnlyText(ADMIN_GUIDE), BorderLayout.CENTER)
        }
    }

    private fun buildGuideTab(): JPanel = JPanel(BorderLayout()).apply {
        add(readOnlyText(ONBOARDING_GUIDE), BorderLayout.CENTER)
    }

    private fun runPrimaryAction() {
        settings.defaultMode = modeCombo.selectedItem as String
        settings.targetModel = targetModelCombo.selectedItem as String
        val prompt = promptArea.text.trim()
        if (prompt.isBlank()) {
            statusLabel.text = "Enter a prompt first."
            return
        }

        when (settings.defaultMode) {
            "direct" -> {
                val directPrompt = "@promptoptimizer $prompt"
                outputArea.text = directPrompt
                detailsArea.text = "Direct mode mirrors the VS Code chat participant by preparing the prompt. IntelliJ does not expose the same Copilot Chat submission API, so copy/paste is the handoff."
                copyBtn.isEnabled = true
                if (settings.autoCopyForChat) copyText(directPrompt, "Direct prompt copied for chat.")
                statusLabel.text = "Direct prompt ready."
            }
            "agent" -> runOptimize(agentMode = true)
            else -> runOptimize(agentMode = false)
        }
    }

    private fun runOptimize(agentMode: Boolean) {
        val prompt = promptArea.text.trim()
        optimizeBtn.isEnabled = false
        copyBtn.isEnabled = false
        statusLabel.text = "Optimizing..."
        metricsLabel.text = " "
        outputArea.text = ""
        detailsArea.text = ""

        runBackground(
            task = { service.optimize(prompt, project) },
            onSuccess = { applyResult(it, agentMode) },
            onFinally = { optimizeBtn.isEnabled = true },
        )
    }

    private fun applyResult(result: OptimizationResult, agentMode: Boolean) {
        outputArea.text = result.optimizedPrompt
        outputArea.caretPosition = 0
        metricsLabel.text = buildMetrics(result)
        detailsArea.text = buildDetails(result)
        detailsArea.caretPosition = 0
        copyBtn.isEnabled = result.optimizedPrompt.isNotBlank()
        statusLabel.text = if (agentMode) "Agent mode result ready." else "Done."
        if (agentMode && settings.autoCopyForChat) {
            copyText(result.optimizedPrompt, "Agent mode optimized prompt copied.")
            statusLabel.text = "Agent mode copied optimized prompt for chat."
        }
        openContextFilesWithSelection(result)
        refreshOverview()
    }

    private fun buildMetrics(result: OptimizationResult): String {
        val cache = if (result.cacheStatus == "miss") "miss" else "${result.cacheStatus} %.0f%%".format(result.cacheConfidence * 100)
        val reuse = if (result.reusedSegments.isNotEmpty()) " | Reused ${result.reusedSegments.size} block(s) ~${result.reusedTokensSaved} tok" else ""
        return "Tokens ${result.originalTokens} -> ${result.optimizedTokens} (${result.tokensSaved} saved) | Output est ${result.estimatedOutputTokens} | Cost $%.4f | Cache $cache$reuse | ${creditForecast(result)}"
            .format(result.estimatedCostUsd)
    }

    private fun buildDetails(result: OptimizationResult): String = buildString {
        if (result.warnings.isNotEmpty()) {
            appendLine("Warnings")
            result.warnings.forEach { appendLine("- $it") }
            appendLine()
        }
        if (!result.sdlcMode.isNullOrBlank()) appendLine("Mode detected: ${result.sdlcMode}")
        if (!result.requestId.isNullOrBlank()) appendLine("Request ID: ${result.requestId}")
        result.deterministicRouting?.let { routing ->
            appendLine("Deterministic routing: ${routing.status} (${routing.strategy})")
            appendLine("Routing reason: ${routing.reason}")
        }
        if (result.reusedSegments.isNotEmpty()) {
            appendLine("Reused from cache (~${result.reusedTokensSaved} tokens saved)")
            appendLine("These context blocks were already sent for this workspace and are referenced in the optimized prompt instead of resent.")
            result.reusedSegments.forEach { appendLine("- ${it.label} (~${it.tokensSaved} tokens, ref: ${it.ref})") }
            appendLine()
        }
        if (result.improvements.isNotEmpty()) {
            appendLine("Improvements")
            result.improvements.forEach { appendLine("- $it") }
            appendLine()
        }
        if (result.diagnostics.isNotEmpty()) {
            appendLine("Diagnostics")
            result.diagnostics.forEach { appendLine("- $it") }
            appendLine()
        }
        if (result.explanation.isNotBlank()) {
            appendLine("Explanation")
            appendLine(result.explanation)
        }
    }.trim()

    private fun openContextFilesWithSelection(result: OptimizationResult) {
        val files = buildList {
            result.contextActiveFile?.let { add(it) }
            addAll(result.contextSelectedFiles)
        }.distinct()
        if (files.isEmpty()) {
            return
        }

        val snippetsByPath = result.contextSnippets.associateBy { it.path }
        val editorManager = FileEditorManager.getInstance(project)
        val root = result.contextWorkspaceRoot ?: project.basePath

        var opened = 0
        var selected = 0
        var unresolved = 0

        for (rawPath in files) {
            val target = resolveContextFile(root, rawPath)
            if (target == null) {
                unresolved++
                continue
            }
            val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(target)
            if (virtualFile == null) {
                unresolved++
                continue
            }

            val snippet = snippetsByPath[rawPath]
            val descriptor = if (snippet?.ranges?.isNotEmpty() == true) {
                val first = snippet.ranges.first()
                OpenFileDescriptor(project, virtualFile, first.startLine, 0)
            } else {
                OpenFileDescriptor(project, virtualFile)
            }
            val editor = editorManager.openTextEditor(descriptor, true)
            opened++

            val ranges = snippet?.ranges ?: emptyList()
            if (ranges.isEmpty() || editor == null) {
                unresolved++
                continue
            }

            val first = ranges.first()
            val document = editor.document
            val maxLine = (document.lineCount - 1).coerceAtLeast(0)
            val startLine = first.startLine.coerceIn(0, maxLine)
            val endLine = first.endLine.coerceIn(startLine, maxLine)
            val startOffset = document.getLineStartOffset(startLine)
            val endOffset = document.getLineEndOffset(endLine)
            editor.selectionModel.setSelection(startOffset, endOffset)
            editor.caretModel.moveToOffset(startOffset)
            editor.scrollingModel.scrollToCaret(ScrollType.CENTER)
            selected++
        }

        if (opened > 0) {
            val detail = StringBuilder("Opened $opened file(s)")
            if (selected > 0) {
                detail.append("; selected exact ranges in $selected")
            }
            if (unresolved > 0) {
                detail.append("; exact selection unavailable for $unresolved")
            }
            result.deterministicRouting?.takeIf { it.status != "resolved" }?.let {
                detail.append("; routing ${it.status}: ${it.reason}")
            }
            statusLabel.text = detail.toString()
        }
    }

    private fun resolveContextFile(workspaceRoot: String?, rawPath: String): File? {
        val file = File(rawPath)
        if (file.isAbsolute) {
            return file
        }
        val root = workspaceRoot ?: return null
        return File(root, rawPath)
    }

    private fun refreshOverview() {
        runBackground(
            task = { service.statusOverview(project) },
            onSuccess = { overview ->
                overviewLabel.text = "Cache ${overview.cacheEntries} (${overview.cacheHits} hits) | Memory ${overview.memoryEntries} | KG ${overview.kgNodes}/${overview.kgEdges} | Peers ${overview.peerEnabled}/${overview.peerTotal} | Files ${overview.digestFiles}"
            },
            onError = { overviewLabel.text = "Overview unavailable until the engine is configured." },
        )
    }

    private fun seedWorkspace(force: Boolean) {
        runBackground(
            task = { service.seedWorkspace(project, force) },
            onSuccess = { refreshOverview() },
            onError = {},
        )
    }

    private fun refreshMemoryFiles() {
        runBackground(
            task = { service.ingestMemoryFiles(project) },
            onSuccess = {
                showTextDialog("Refresh Memory", service.pretty(it))
                refreshOverview()
            },
        )
    }

    private fun openMemoryFile() {
        try {
            val file = service.openMemoryFile(project)
            LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)?.let {
                FileEditorManager.getInstance(project).openFile(it, true)
            }
            refreshMemoryFiles()
        } catch (ex: Exception) {
            Messages.showErrorDialog(project, ex.message ?: "Could not open memory file.", "Prompt Optimizer")
        }
    }

    private fun recallMemory() {
        val query = JOptionPane.showInputDialog(root, "Memory query:", "Recall Memory", JOptionPane.QUESTION_MESSAGE)
        if (query.isNullOrBlank()) return
        showBackground("Memory Recall", { service.recallMemory(project, query.trim()) })
    }

    private fun managePeers() {
        runBackground(
            task = { service.peerList() },
            onSuccess = { showPeerDialog(it) },
        )
    }

    private fun showPeerDialog(peers: List<PeerInfo>) {
        val summary = if (peers.isEmpty()) {
            "No peer workspaces configured."
        } else {
            peers.joinToString("\n") { "${if (it.enabled) "enabled" else "disabled"} | ${it.label} | ${it.dbPath}" }
        }
        val options = arrayOf("Add", "Remove", "Toggle", "Close")
        when (JOptionPane.showOptionDialog(root, summary, "Peer Workspaces", JOptionPane.DEFAULT_OPTION, JOptionPane.INFORMATION_MESSAGE, null, options, options.last())) {
            0 -> addPeer()
            1 -> choosePeer(peers, "Remove Peer")?.let { showBackground("Remove Peer", { service.removePeer(it.dbPath) }, refresh = true) }
            2 -> choosePeer(peers, "Toggle Peer")?.let { showBackground("Toggle Peer", { service.togglePeer(it.dbPath, !it.enabled) }, refresh = true) }
        }
    }

    private fun addPeer() {
        val label = JOptionPane.showInputDialog(root, "Peer label:", "Add Peer", JOptionPane.QUESTION_MESSAGE) ?: return
        val path = JOptionPane.showInputDialog(root, "Peer SQLite database path:", "Add Peer", JOptionPane.QUESTION_MESSAGE) ?: return
        if (label.isBlank() || path.isBlank()) return
        showBackground("Add Peer", { service.addPeer(label.trim(), path.trim()) }, refresh = true)
    }

    private fun choosePeer(peers: List<PeerInfo>, title: String): PeerInfo? {
        if (peers.isEmpty()) {
            Messages.showInfoMessage(project, "No peer workspaces configured.", "Prompt Optimizer")
            return null
        }
        val labels = peers.map { "${it.label} - ${it.dbPath}" }.toTypedArray()
        val picked = JOptionPane.showInputDialog(root, "Choose peer:", title, JOptionPane.QUESTION_MESSAGE, null, labels, labels.first())
        return peers.firstOrNull { picked == "${it.label} - ${it.dbPath}" }
    }

    private fun exportDatabase() {
        val chooser = JFileChooser().apply {
            dialogTitle = "Export Prompt Optimizer database"
            selectedFile = File("prompt-optimizer-backup.db")
        }
        if (chooser.showSaveDialog(root) != JFileChooser.APPROVE_OPTION) return
        showBackground("Export Database", { service.exportDatabase(chooser.selectedFile.absolutePath) })
    }

    private fun confirmAndRun(message: String, title: String, action: () -> String) {
        val answer = Messages.showYesNoDialog(project, message, title, null)
        if (answer == Messages.YES) showBackground(title, action, refresh = true)
    }

    private fun showBackground(title: String, action: () -> String, refresh: Boolean = false) {
        statusLabel.text = "$title..."
        runBackground(
            task = action,
            onSuccess = {
                statusLabel.text = "Ready"
                showTextDialog(title, it)
                if (refresh) refreshOverview()
            },
        )
    }

    private fun <T> runBackground(
        task: () -> T,
        onSuccess: (T) -> Unit,
        onError: (Exception) -> Unit = { Messages.showErrorDialog(project, it.message ?: "Prompt Optimizer action failed.", "Prompt Optimizer") },
        onFinally: () -> Unit = {},
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val result = task()
                SwingUtilities.invokeLater {
                    onSuccess(result)
                    onFinally()
                }
            } catch (ex: Exception) {
                SwingUtilities.invokeLater {
                    onError(ex)
                    onFinally()
                }
            }
        }
    }

    private fun showTextDialog(title: String, text: String) {
        val area = JTextArea(24, 88).apply {
            this.text = text
            caretPosition = 0
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
        }
        JOptionPane.showMessageDialog(root, JBScrollPane(area), title, JOptionPane.INFORMATION_MESSAGE)
    }

    private fun useClipboard() {
        val clipboard = Toolkit.getDefaultToolkit().systemClipboard
        val text = runCatching { clipboard.getData(DataFlavor.stringFlavor) as? String }.getOrNull()
        if (text.isNullOrBlank()) {
            statusLabel.text = "Clipboard is empty."
            return
        }
        promptArea.text = text.trim()
        statusLabel.text = "Loaded clipboard."
    }

    private fun useEditorSelection() {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor
        val text = editor?.selectionModel?.selectedText ?: editor?.document?.text
        if (text.isNullOrBlank()) {
            statusLabel.text = "No editor text found."
            return
        }
        promptArea.text = text.trim()
        statusLabel.text = "Loaded editor text."
    }

    private fun copyText(text: String, message: String) {
        if (text.isBlank()) return
        Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(text), null)
        statusLabel.text = message
    }

    private fun creditForecast(result: OptimizationResult? = null): String {
        val allowances = mapOf("free" to 50, "pro" to 300, "pro-plus" to 1500, "business" to 300, "enterprise" to 1000)
        val allowance = allowances[settings.subscriptionPlan] ?: 300
        val modelWeight = when (settings.targetModel) {
            "claude" -> 2.5
            "deepseek", "grok" -> 3.0
            "gpt", "gemini" -> 2.0
            else -> 0.0 // local included by default
        }
        val tin = (result?.optimizedTokens ?: settings.forecastInputTokens).coerceAtLeast(0)
        val tout = (result?.estimatedOutputTokens ?: settings.forecastOutputTokens).coerceAtLeast(0)
        val rin = settings.creditBaseInputRate.coerceAtLeast(0.0)
        val rout = settings.creditBaseOutputRate.coerceAtLeast(0.0)
        val fe = if (settings.targetModel == "local") 0.0 else settings.creditFixedExecutionOverhead.coerceAtLeast(0.0)

        // C = ceil((Tin*Rin*Wm) + (Tout*Rout*Wm) + Fe)
        val creditsPerRequest = kotlin.math.ceil((tin * rin * modelWeight) + (tout * rout * modelWeight) + fe).toInt()
        val monthlyRequests = settings.forecastRequestsPerDay.coerceAtLeast(0) * 22
        val monthlyCredits = monthlyRequests * creditsPerRequest
        val over = (monthlyCredits - allowance).coerceAtLeast(0)
        val overCost = over * settings.creditOveragePrice
        return "Credits $monthlyCredits/$allowance mo (C=$creditsPerRequest), overage $%.2f".format(overCost)
    }

    private fun readOnlyArea(rows: Int, columns: Int): JBTextArea = JBTextArea(rows, columns).apply {
        lineWrap = true
        wrapStyleWord = true
        isEditable = false
        background = UIManager.getColor("Panel.background") ?: Color(0xF5F5F5)
    }

    private fun readOnlyText(text: String): JBScrollPane {
        val area = readOnlyArea(12, 70).apply {
            this.text = text.trimIndent()
            caretPosition = 0
        }
        return JBScrollPane(area)
    }

    companion object {
        const val PANEL_CLIENT_KEY = "PromptProxyPanel.instance"

        private val CONTEXT_GUIDE = """
            Workspace memory is read from AGENTS.md, CLAUDE.md, .github/copilot-instructions.md,
            .promptoptimizer/memory.md, .promptoptimizer/knowledge.md, .cursorrules, and .clinerules.

            Index Workspace mirrors the VS Code bootstrap: git log, README, package metadata,
            instruction files, workspace memory, knowledge graph nodes, and file digest memory are pushed
            into the local SQLite database.
        """

        private val ADMIN_GUIDE = """
            Admin actions call the same engine CLI used by VS Code: cache stats/clear, health checks,
            metrics, database maintenance, backup export, SDLC agent skill listing, and file digest cleanup.

            IntelliJ can optimize and copy prompts locally. JetBrains does not expose the same VS Code
            Copilot Chat participant API, so Agent and Direct modes prepare prompts for your AI chat surface.
        """

        private val ONBOARDING_GUIDE = """
            Prompt Optimizer for IntelliJ

            1. Open the Prompt Optimizer tool window.
            2. Pick a mode: optimize, agent, or direct.
            3. Pick a target model: GPT, Claude, Gemini, or Local.
            4. Paste a prompt, load clipboard text, or use the editor action.
            5. Review token savings, cost, cache status, credit forecast, diagnostics, and the optimized prompt.

            Modes
            - optimize: analyze locally and show the optimized prompt for review.
            - agent: optimize locally and copy the optimized prompt for your AI chat surface.
            - direct: copy an @promptoptimizer-prefixed prompt for compatible chat surfaces.

            Local features
            - Secret detection before send, including custom regex patterns from Settings.
            - Exact and semantic cache lookup in a local SQLite database.
            - Workspace memory and knowledge graph enrichment from project files.
            - Peer workspace cache management for cross-project reuse.
            - Health, metrics, maintenance, database export, file digest, and skill listing tools.

            Privacy
            Processing runs through your local Node.js engine. The plugin does not add telemetry. Data leaves
            your machine only when you paste or send the optimized prompt to an external AI service.
        """
    }
}