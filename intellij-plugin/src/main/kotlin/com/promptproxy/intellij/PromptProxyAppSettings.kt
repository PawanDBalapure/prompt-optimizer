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
        /** Whether secret / API-key detection is enabled */
        var enableSecretDetection: Boolean = true,
        /** Whether to pack the active editor file as context */
        var includeActiveFile: Boolean = true,
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
