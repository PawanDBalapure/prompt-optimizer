package com.promptproxy.intellij

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Persistent application-level settings for Prompt Proxy.
 * Values are stored in promptproxy.xml inside the IDE config directory.
 */
@State(
    name = "PromptProxyAppSettings",
    storages = [Storage("promptproxy.xml")]
)
class PromptProxyAppSettings : PersistentStateComponent<PromptProxyAppSettings.State> {

    data class State(
        /** Absolute path to the `node` executable, e.g. /usr/local/bin/node */
        var nodePath: String = "node",
        /** Absolute path to the engine CLI entry point (cli.js) */
        var engineCliPath: String = "",
        /** Absolute path for the SQLite cache database */
        var dbPath: String = "",
        /** Default run mode: optimize | agent | direct */
        var defaultMode: String = "optimize",
        /** Model-family compiler target: claude | gpt | gemini | local */
        var targetModel: String = "gpt",
        /** Cache lookup mode: blocking | non-blocking */
        var processingMode: String = "blocking",
        /** Controls editor action source picking: ask | auto | selection-first | clipboard-first */
        var sourcePicker: String = "ask",
        /** Automatically copy agent/direct output for the external AI chat surface */
        var autoCopyForChat: Boolean = true,
        /** Whether secret / API-key detection is enabled */
        var enableSecretDetection: Boolean = true,
        /** Additional custom secret-detection regex rules, one per line */
        var customSecretPatterns: String = "",
        /** Whether to pack the active editor file as context */
        var includeActiveFile: Boolean = true,
        /** Whether to pack other open editor files as context */
        var includeOpenFiles: Boolean = true,
        /** Whether to include prior local turns where supported by the engine */
        var enableSessionContext: Boolean = true,
        /** Input cost per 1K tokens in USD */
        var pricingInput: Double = 0.0015,
        /** Output cost per 1K tokens in USD */
        var pricingOutput: Double = 0.002,
        /** Copilot plan name used for monthly premium-request forecast */
        var subscriptionPlan: String = "pro",
        /** Forecasted optimized requests per working day */
        var forecastRequestsPerDay: Int = 20,
        /** Premium-request overage price in USD */
        var creditOveragePrice: Double = 0.04,
        /** Base credit rate per input token (Rin) */
        var creditBaseInputRate: Double = 0.001,
        /** Base credit rate per output token (Rout) */
        var creditBaseOutputRate: Double = 0.002,
        /** Fixed execution factor (Fe) charged per request */
        var creditFixedExecutionOverhead: Double = 1.0,
        /** Fallback Tin when no live analysis tokens are available */
        var forecastInputTokens: Int = 800,
        /** Fallback Tout when no live analysis tokens are available */
        var forecastOutputTokens: Int = 400,
    )

    private var myState = State()

    override fun getState(): State = myState

    override fun loadState(state: State) {
        myState = state
    }

    companion object {
        fun getInstance(): PromptProxyAppSettings =
            ApplicationManager.getApplication()
                .getService(PromptProxyAppSettings::class.java)
    }
}
