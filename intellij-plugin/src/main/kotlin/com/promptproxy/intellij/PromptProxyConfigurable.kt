package com.promptproxy.intellij

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel

class PromptProxyConfigurable : Configurable {

    private val nodePathField = JBTextField()
    private val engineCliPathField = JBTextField()
    private val dbPathField = JBTextField()
    private val modeCombo = JComboBox(arrayOf("optimize", "agent", "direct"))
    private val targetModelCombo = JComboBox(arrayOf("gpt", "claude", "gemini", "deepseek", "grok", "local"))
    private val processingModeCombo = JComboBox(arrayOf("blocking", "non-blocking"))
    private val sourcePickerCombo = JComboBox(arrayOf("ask", "auto", "selection-first", "clipboard-first"))
    private val autoCopyForChatBox = JBCheckBox("Copy agent/direct output for the external AI chat surface")
    private val secretDetectionBox = JBCheckBox("Enable secret / API-key detection in prompts")
    private val includeActiveFileBox = JBCheckBox("Pack active editor file as context")
    private val includeOpenFilesBox = JBCheckBox("Pack other open editor files as context")
    private val sessionContextBox = JBCheckBox("Enable local session/context enrichment where supported")
    private val pricingInputField = JBTextField()
    private val pricingOutputField = JBTextField()
    private val subscriptionPlanCombo = JComboBox(arrayOf("free", "pro", "pro-plus", "business", "enterprise"))
    private val requestsPerDayField = JBTextField()
    private val overagePriceField = JBTextField()
    private val creditBaseInputRateField = JBTextField()
    private val creditBaseOutputRateField = JBTextField()
    private val creditFixedExecutionField = JBTextField()
    private val forecastInputTokensField = JBTextField()
    private val forecastOutputTokensField = JBTextField()
    private val customSecretPatternsArea = JBTextArea(5, 48).apply {
        lineWrap = true
        wrapStyleWord = true
        emptyText.text = "Optional: Label::regex, one rule per line"
    }

    private var panel: JPanel? = null

    override fun getDisplayName(): String = "Prompt Optimizer"

    override fun createComponent(): JComponent {
        panel = FormBuilder.createFormBuilder()
            .addComponent(JBLabel("Runtime"))
            .addLabeledComponent(JBLabel("Node.js executable path:"), nodePathField, 1, false)
            .addLabeledComponent(JBLabel("Engine CLI path (optional when bundled runtime is available):"), engineCliPathField, 1, false)
            .addLabeledComponent(JBLabel("SQLite cache path (blank = IDE system directory):"), dbPathField, 1, false)
            .addComponent(JBLabel("Optimization"))
            .addLabeledComponent(JBLabel("Default mode:"), modeCombo, 1, false)
            .addLabeledComponent(JBLabel("Target model:"), targetModelCombo, 1, false)
            .addLabeledComponent(JBLabel("Processing mode:"), processingModeCombo, 1, false)
            .addLabeledComponent(JBLabel("Editor action source picker:"), sourcePickerCombo, 1, false)
            .addComponent(autoCopyForChatBox)
            .addComponent(JBLabel("Context and memory"))
            .addComponent(includeActiveFileBox)
            .addComponent(includeOpenFilesBox)
            .addComponent(sessionContextBox)
            .addComponent(JBLabel("Pricing and credit forecast"))
            .addLabeledComponent(JBLabel("Input cost per 1K tokens:"), pricingInputField, 1, false)
            .addLabeledComponent(JBLabel("Output cost per 1K tokens:"), pricingOutputField, 1, false)
            .addLabeledComponent(JBLabel("Copilot subscription plan:"), subscriptionPlanCombo, 1, false)
            .addLabeledComponent(JBLabel("Forecast requests per day:"), requestsPerDayField, 1, false)
            .addLabeledComponent(JBLabel("Credit overage price:"), overagePriceField, 1, false)
            .addLabeledComponent(JBLabel("Base input credit rate (Rin):"), creditBaseInputRateField, 1, false)
            .addLabeledComponent(JBLabel("Base output credit rate (Rout):"), creditBaseOutputRateField, 1, false)
            .addLabeledComponent(JBLabel("Fixed execution overhead (Fe):"), creditFixedExecutionField, 1, false)
            .addLabeledComponent(JBLabel("Fallback input tokens (Tin):"), forecastInputTokensField, 1, false)
            .addLabeledComponent(JBLabel("Fallback output tokens (Tout):"), forecastOutputTokensField, 1, false)
            .addComponent(JBLabel("Secrets"))
            .addComponent(secretDetectionBox)
            .addLabeledComponent(JBLabel("Custom secret patterns:"), JBScrollPane(customSecretPatternsArea), 1, false)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        reset()
        return panel!!
    }

    override fun isModified(): Boolean {
        val s = PromptProxyAppSettings.getInstance().state
        return nodePathField.text.trim() != s.nodePath ||
            engineCliPathField.text.trim() != s.engineCliPath ||
            dbPathField.text.trim() != s.dbPath ||
            modeCombo.selectedItem as String != s.defaultMode ||
            targetModelCombo.selectedItem as String != s.targetModel ||
            processingModeCombo.selectedItem as String != s.processingMode ||
            sourcePickerCombo.selectedItem as String != s.sourcePicker ||
            autoCopyForChatBox.isSelected != s.autoCopyForChat ||
            secretDetectionBox.isSelected != s.enableSecretDetection ||
            customSecretPatternsArea.text.trim() != s.customSecretPatterns.trim() ||
            includeActiveFileBox.isSelected != s.includeActiveFile ||
            includeOpenFilesBox.isSelected != s.includeOpenFiles ||
            sessionContextBox.isSelected != s.enableSessionContext ||
            doubleValue(pricingInputField, s.pricingInput) != s.pricingInput ||
            doubleValue(pricingOutputField, s.pricingOutput) != s.pricingOutput ||
            subscriptionPlanCombo.selectedItem as String != s.subscriptionPlan ||
            intValue(requestsPerDayField, s.forecastRequestsPerDay) != s.forecastRequestsPerDay ||
            doubleValue(overagePriceField, s.creditOveragePrice) != s.creditOveragePrice ||
            doubleValue(creditBaseInputRateField, s.creditBaseInputRate) != s.creditBaseInputRate ||
            doubleValue(creditBaseOutputRateField, s.creditBaseOutputRate) != s.creditBaseOutputRate ||
            doubleValue(creditFixedExecutionField, s.creditFixedExecutionOverhead) != s.creditFixedExecutionOverhead ||
            intValue(forecastInputTokensField, s.forecastInputTokens) != s.forecastInputTokens ||
            intValue(forecastOutputTokensField, s.forecastOutputTokens) != s.forecastOutputTokens
    }

    override fun apply() {
        val s = PromptProxyAppSettings.getInstance().state
        s.nodePath = nodePathField.text.trim().ifBlank { "node" }
        s.engineCliPath = engineCliPathField.text.trim()
        s.dbPath = dbPathField.text.trim()
        s.defaultMode = modeCombo.selectedItem as String
        s.targetModel = targetModelCombo.selectedItem as String
        s.processingMode = processingModeCombo.selectedItem as String
        s.sourcePicker = sourcePickerCombo.selectedItem as String
        s.autoCopyForChat = autoCopyForChatBox.isSelected
        s.enableSecretDetection = secretDetectionBox.isSelected
        s.customSecretPatterns = customSecretPatternsArea.text.trim()
        s.includeActiveFile = includeActiveFileBox.isSelected
        s.includeOpenFiles = includeOpenFilesBox.isSelected
        s.enableSessionContext = sessionContextBox.isSelected
        s.pricingInput = doubleValue(pricingInputField, 0.0015)
        s.pricingOutput = doubleValue(pricingOutputField, 0.002)
        s.subscriptionPlan = subscriptionPlanCombo.selectedItem as String
        s.forecastRequestsPerDay = intValue(requestsPerDayField, 20).coerceAtLeast(0)
        s.creditOveragePrice = doubleValue(overagePriceField, 0.04).coerceAtLeast(0.0)
        s.creditBaseInputRate = doubleValue(creditBaseInputRateField, 0.001).coerceAtLeast(0.0)
        s.creditBaseOutputRate = doubleValue(creditBaseOutputRateField, 0.002).coerceAtLeast(0.0)
        s.creditFixedExecutionOverhead = doubleValue(creditFixedExecutionField, 1.0).coerceAtLeast(0.0)
        s.forecastInputTokens = intValue(forecastInputTokensField, 800).coerceAtLeast(0)
        s.forecastOutputTokens = intValue(forecastOutputTokensField, 400).coerceAtLeast(0)
    }

    override fun reset() {
        val s = PromptProxyAppSettings.getInstance().state
        nodePathField.text = s.nodePath
        engineCliPathField.text = s.engineCliPath
        dbPathField.text = s.dbPath
        modeCombo.selectedItem = s.defaultMode
        targetModelCombo.selectedItem = s.targetModel
        processingModeCombo.selectedItem = s.processingMode
        sourcePickerCombo.selectedItem = s.sourcePicker
        autoCopyForChatBox.isSelected = s.autoCopyForChat
        secretDetectionBox.isSelected = s.enableSecretDetection
        customSecretPatternsArea.text = s.customSecretPatterns
        includeActiveFileBox.isSelected = s.includeActiveFile
        includeOpenFilesBox.isSelected = s.includeOpenFiles
        sessionContextBox.isSelected = s.enableSessionContext
        pricingInputField.text = s.pricingInput.toString()
        pricingOutputField.text = s.pricingOutput.toString()
        subscriptionPlanCombo.selectedItem = s.subscriptionPlan
        requestsPerDayField.text = s.forecastRequestsPerDay.toString()
        overagePriceField.text = s.creditOveragePrice.toString()
        creditBaseInputRateField.text = s.creditBaseInputRate.toString()
        creditBaseOutputRateField.text = s.creditBaseOutputRate.toString()
        creditFixedExecutionField.text = s.creditFixedExecutionOverhead.toString()
        forecastInputTokensField.text = s.forecastInputTokens.toString()
        forecastOutputTokensField.text = s.forecastOutputTokens.toString()
    }

    private fun doubleValue(field: JBTextField, fallback: Double): Double =
        field.text.trim().toDoubleOrNull() ?: fallback

    private fun intValue(field: JBTextField, fallback: Int): Int =
        field.text.trim().toIntOrNull() ?: fallback
}