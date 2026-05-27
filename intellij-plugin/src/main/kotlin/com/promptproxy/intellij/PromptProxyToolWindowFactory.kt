package com.promptproxy.intellij

import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.project.Project
import com.intellij.ui.content.ContentFactory

/**
 * Registers the Prompt Proxy tool window in the IDE sidebar.
 */
class PromptProxyToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel   = PromptProxyPanel(project)
        val content = ContentFactory.getInstance()
            .createContent(panel.root, "", false)
        toolWindow.contentManager.addContent(content)
    }
}
