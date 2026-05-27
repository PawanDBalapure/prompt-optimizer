package com.promptproxy.intellij

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager

/**
 * Editor right-click action: "Optimize with Prompt Proxy"
 *
 * Takes the selected text (or entire document if nothing is selected)
 * and opens the Prompt Proxy tool window with the text pre-populated.
 */
class OptimizeSelectionAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor  = e.getData(CommonDataKeys.EDITOR) ?: return

        val selectedText = editor.selectionModel.selectedText
            ?: editor.document.text

        if (selectedText.isBlank()) {
            Messages.showInfoMessage(
                project,
                "Nothing to optimize — please select some text first.",
                "Prompt Proxy"
            )
            return
        }

        // Open (or focus) the Prompt Proxy tool window
        val tw = ToolWindowManager.getInstance(project).getToolWindow("Prompt Proxy")
        tw?.activate {
            // Locate the panel and populate the prompt area
            tw.contentManager.contents.firstOrNull()
                ?.component
                ?.let { root ->
                    // Walk the component tree to find PromptProxyPanel.promptArea
                    findTextArea(root as? javax.swing.JPanel)?.text = selectedText
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
}
