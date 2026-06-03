package com.promptproxy.intellij

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import java.awt.Toolkit
import java.awt.datatransfer.DataFlavor

/**
 * Editor right-click action: "Optimize with Prompt Proxy"
 *
 * Takes editor/clipboard text and opens the Prompt Optimizer tool window with the text pre-populated.
 */
class OptimizeSelectionAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor  = e.getData(CommonDataKeys.EDITOR) ?: return
        val selectedText = resolvePromptSource(project, editor.selectionModel.selectedText, editor.document.text)

        if (selectedText.isBlank()) {
            Messages.showInfoMessage(
                project,
                "Nothing to optimize. Select text, open a document, or copy a prompt first.",
                "Prompt Optimizer"
            )
            return
        }

        val tw = ToolWindowManager.getInstance(project).getToolWindow("Prompt Optimizer")
        tw?.activate {
            val component = tw.contentManager.contents.firstOrNull()?.component
            val panel = component?.getClientProperty(PromptProxyPanel.PANEL_CLIENT_KEY) as? PromptProxyPanel
            if (panel != null) {
                panel.setPrompt(selectedText)
            } else {
                findTextArea(component as? javax.swing.JPanel)?.text = selectedText
            }
        }
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null &&
            e.getData(CommonDataKeys.EDITOR) != null
    }

    private fun findTextArea(panel: javax.swing.JPanel?): javax.swing.JTextArea? {
        if (panel == null) return null
        for (c in panel.components) {
            if (c is javax.swing.JTextArea) return c
            if (c is javax.swing.JPanel) findTextArea(c)?.let { return it }
            if (c is javax.swing.JScrollPane) {
                val view = c.viewport?.view
                if (view is javax.swing.JTextArea) return view
            }
        }
        return null
    }

    private fun resolvePromptSource(project: com.intellij.openapi.project.Project, selection: String?, documentText: String): String {
        val settings = PromptProxyAppSettings.getInstance().state
        val clipboard = readClipboard()
        val editorText = selection?.takeIf { it.isNotBlank() } ?: documentText
        return when (settings.sourcePicker) {
            "clipboard-first" -> clipboard ?: editorText
            "selection-first" -> editorText
            "auto" -> selection?.takeIf { it.isNotBlank() } ?: clipboard ?: documentText
            "ask" -> askPromptSource(project, selection, documentText, clipboard)
            else -> selection?.takeIf { it.isNotBlank() } ?: documentText
        }.trim()
    }

    private fun askPromptSource(
        project: com.intellij.openapi.project.Project,
        selection: String?,
        documentText: String,
        clipboard: String?,
    ): String {
        val options = listOfNotNull(
            selection?.takeIf { it.isNotBlank() }?.let { "Selection" },
            "Document",
            clipboard?.let { "Clipboard" },
        ).toTypedArray()
        val choice = Messages.showDialog(project, "Choose prompt source", "Prompt Optimizer", options, 0, null)
        return when (options.getOrNull(choice)) {
            "Selection" -> selection.orEmpty()
            "Clipboard" -> clipboard.orEmpty()
            else -> documentText
        }
    }

    private fun readClipboard(): String? = runCatching {
        Toolkit.getDefaultToolkit().systemClipboard.getData(DataFlavor.stringFlavor) as? String
    }.getOrNull()?.trim()?.takeIf { it.isNotBlank() }
}
