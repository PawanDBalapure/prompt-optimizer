package com.promptproxy.intellij

import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.FlowLayout
import java.awt.Font
import javax.swing.*

/**
 * Main Swing panel rendered inside the Prompt Proxy tool window.
 *
 * Layout:
 *   ┌──────────────────────────────┐
 *   │  Prompt input (text area)    │
 *   │  [Optimize ▶]  [Copy]        │
 *   ├──────────────────────────────┤
 *   │  Metrics bar                 │
 *   │  Optimized output (readonly) │
 *   │  Improvements list           │
 *   └──────────────────────────────┘
 */
class PromptProxyPanel(private val project: Project) {

    val root: JPanel = JPanel(BorderLayout(0, 8))

    // ── Input ──────────────────────────────────────────────────────────────────
    private val promptArea  = JBTextArea(6, 40).apply {
        lineWrap    = true
        wrapStyleWord = true
        toolTipText = "Enter your AI prompt here"
    }

    // ── Controls ───────────────────────────────────────────────────────────────
    private val optimizeBtn = JButton("Optimize  ▶").apply {
        toolTipText = "Send the prompt to the local engine and show the optimized result"
        icon = AllIcons.Actions.Execute
    }
    private val copyBtn = JButton("Copy").apply {
        toolTipText = "Copy the optimized prompt to the clipboard"
        isEnabled   = false
    }
    private val statusLabel = JBLabel(" ").apply {
        font = font.deriveFont(Font.ITALIC, 11f)
    }

    // ── Output ─────────────────────────────────────────────────────────────────
    private val metricsLabel     = JBLabel(" ")
    private val outputArea       = JBTextArea(8, 40).apply {
        lineWrap    = true
        wrapStyleWord = true
        isEditable  = false
        background  = UIManager.getColor("Panel.background") ?: Color(0xF5F5F5)
    }
    private val improvementsList = JTextArea(4, 40).apply {
        isEditable  = false
        background  = UIManager.getColor("Panel.background") ?: Color(0xF5F5F5)
        font        = font.deriveFont(11f)
    }

    private val service = PromptProxyService()

    init {
        root.border = JBUI.Borders.empty(8)

        // Input section
        val inputPanel = JPanel(BorderLayout()).apply {
            add(JBScrollPane(promptArea), BorderLayout.CENTER)
        }

        // Buttons row
        val btnRow = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
            add(optimizeBtn)
            add(copyBtn)
            add(statusLabel)
        }

        // Output section
        val outputPanel = JPanel(BorderLayout(0, 4)).apply {
            add(metricsLabel, BorderLayout.NORTH)
            add(JBScrollPane(outputArea), BorderLayout.CENTER)
            add(JBScrollPane(improvementsList), BorderLayout.SOUTH)
        }

        root.add(inputPanel,  BorderLayout.NORTH)
        root.add(btnRow,      BorderLayout.CENTER)
        root.add(outputPanel, BorderLayout.SOUTH)

        // ── Handlers ──────────────────────────────────────────────────────────
        optimizeBtn.addActionListener { runOptimize() }

        copyBtn.addActionListener {
            val text = outputArea.text
            if (text.isNotBlank()) {
                val clipboard = java.awt.Toolkit.getDefaultToolkit().systemClipboard
                clipboard.setContents(java.awt.datatransfer.StringSelection(text), null)
                statusLabel.text = "✓ Copied"
            }
        }
    }

    // ── Optimization ──────────────────────────────────────────────────────────

    private fun runOptimize() {
        val prompt = promptArea.text.trim()
        if (prompt.isBlank()) {
            statusLabel.text = "⚠ Enter a prompt first"
            return
        }

        optimizeBtn.isEnabled = false
        copyBtn.isEnabled     = false
        statusLabel.text      = "⏳ Optimizing…"
        metricsLabel.text     = ""
        outputArea.text       = ""
        improvementsList.text = ""

        // Resolve active file content on EDT, then off-load to background thread.
        val activeFileContent: String? = try {
            val editor = FileEditorManager.getInstance(project).selectedTextEditor
            editor?.document?.text
        } catch (_: Exception) { null }

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val result = service.optimize(prompt, activeFileContent)
                SwingUtilities.invokeLater {
                    applyResult(result)
                }
            } catch (ex: Exception) {
                SwingUtilities.invokeLater {
                    statusLabel.text = "✗ Error: ${ex.message}"
                    optimizeBtn.isEnabled = true
                }
            }
        }
    }

    private fun applyResult(r: OptimizationResult) {
        outputArea.text = r.optimizedPrompt
        metricsLabel.text = buildString {
            append("Tokens: ${r.originalTokens} → ${r.optimizedTokens}")
            if (r.tokensSaved > 0) append("  (−${r.tokensSaved} saved)")
            if (r.estimatedCostUsd > 0) append("  |  Est. cost: \$%.4f".format(r.estimatedCostUsd))
            if (r.cacheStatus != "miss") append("  |  Cache: ${r.cacheStatus}")
        }
        improvementsList.text = if (r.improvements.isEmpty()) ""
            else r.improvements.joinToString("\n") { "• $it" }
        copyBtn.isEnabled  = true
        optimizeBtn.isEnabled = true
        statusLabel.text   = "✓ Done"
    }
}
