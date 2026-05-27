package com.promptproxy.intellij

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Settings page shown under IDE Settings > Tools > Prompt Proxy.
 */
class PromptProxyConfigurable : Configurable {

    private val nodePathField       = JBTextField()
    private val engineCliPathField  = JBTextField()
    private val dbPathField         = JBTextField()
    private val secretDetectionBox  = JBCheckBox("Enable secret / API-key detection in prompts")
    private val includeActiveFileBox = JBCheckBox("Pack active editor file as context")

    private var panel: JPanel? = null

    override fun getDisplayName(): String = "Prompt Proxy"

    override fun createComponent(): JComponent {
        panel = FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Node.js executable path:"), nodePathField, 1, false)
            .addLabeledComponent(JBLabel("Engine CLI path (cli.js):"), engineCliPathField, 1, false)
            .addLabeledComponent(JBLabel("SQLite cache path (leave blank for default):"), dbPathField, 1, false)
            .addComponent(secretDetectionBox, 10)
            .addComponent(includeActiveFileBox)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        return panel!!
    }

    override fun isModified(): Boolean {
        val s = PromptProxyAppSettings.getInstance().state
        return nodePathField.text != s.nodePath ||
            engineCliPathField.text != s.engineCliPath ||
            dbPathField.text != s.dbPath ||
            secretDetectionBox.isSelected != s.enableSecretDetection ||
            includeActiveFileBox.isSelected != s.includeActiveFile
    }

    override fun apply() {
        val s = PromptProxyAppSettings.getInstance().state
        s.nodePath              = nodePathField.text.trim()
        s.engineCliPath         = engineCliPathField.text.trim()
        s.dbPath                = dbPathField.text.trim()
        s.enableSecretDetection = secretDetectionBox.isSelected
        s.includeActiveFile     = includeActiveFileBox.isSelected
    }

    override fun reset() {
        val s = PromptProxyAppSettings.getInstance().state
        nodePathField.text              = s.nodePath
        engineCliPathField.text         = s.engineCliPath
        dbPathField.text                = s.dbPath
        secretDetectionBox.isSelected   = s.enableSecretDetection
        includeActiveFileBox.isSelected = s.includeActiveFile
    }
}
