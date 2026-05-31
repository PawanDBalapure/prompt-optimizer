// acquireVsCodeApi() must be called exactly once per webview lifetime.
// var → window.vscode, accessible to sibling scripts loaded before this file.
var vscode = acquireVsCodeApi();

// ── DOM refs used in this module ─────────────────────────────────────────────
var promptInput     = document.getElementById('promptInput');
var loading         = document.getElementById('loading');
var resultCard      = document.getElementById('resultCard');
var responseCard    = document.getElementById('responseCard');
var responseContent = document.getElementById('responseContent');
var streamBadge     = document.getElementById('streamBadge');
var modeSelect      = document.getElementById('modeSelect');
var btnPrimary      = document.getElementById('btnPrimary');
var optimizedCard   = document.getElementById('optimizedCard');
var optimizedPrompt = document.getElementById('optimizedPrompt');
var targetModelSelect = document.getElementById('targetModelSelect');
var btnSettingsMenu = document.getElementById('btnSettingsMenu');
var settingsMenu    = document.getElementById('settingsMenu');

// ── Mode state (currentMode declared in panel.helpers.js as var) ─────────────
var currentMode = 'optimize';

var MODE_TITLES = {
  agent:    'Run Agent \u2014 optimize + send to Copilot Chat',
  optimize: 'Analyze locally \u2014 optimize only',
  direct:   'Send to @promptoptimizer chat',
};

function applyMode(mode) {
  currentMode = mode;
  modeSelect.value = mode;
  btnPrimary.title = MODE_TITLES[mode] || 'Run';
}

function setSettingsMenuOpen(isOpen) {
  settingsMenu.hidden = !isOpen;
  btnSettingsMenu.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

// ── Event wiring ─────────────────────────────────────────────────────────────

modeSelect.addEventListener('change', function() {
  applyMode(modeSelect.value);
  vscode.postMessage({ type: 'setMode', mode: modeSelect.value });
});

targetModelSelect.addEventListener('change', function() {
  vscode.postMessage({ type: 'setTargetModel', model: targetModelSelect.value });
});

btnPrimary.addEventListener('click', function() {
  var text = promptInput.value.trim();
  if (!text) { clearAlerts(); addAlert('error', 'Enter a prompt.'); return; }
  clearAlerts();
  if (currentMode === 'agent') {
    // Agent: optimize locally, then send the optimized prompt directly to
    // Copilot Chat (auto-submitted). The in-panel response card is no
    // longer used for this mode \u2014 the answer streams in the Chat view.
    optimizedCard.style.display = 'none';
    responseCard.style.display = 'none';
    loading.style.display = 'block';
    loading.setAttribute('aria-hidden', 'false');
    vscode.postMessage({ type: 'agentRun', prompt: text });
  } else if (currentMode === 'direct') {
    vscode.postMessage({ type: 'openChatWithPrompt', prompt: text });
  } else {
    optimizedCard.style.display = 'none';
    loading.style.display = 'block';
    loading.setAttribute('aria-hidden', 'false');
    vscode.postMessage({ type: 'analyze', prompt: text });
  }
});

document.getElementById('btnOpenChat').addEventListener('click', function() {
  vscode.postMessage({ type: 'openChat' });
});

document.getElementById('btnUseOptimized').addEventListener('click', function() {
  if (!currentState || !currentState.optimized) { clearAlerts(); addAlert('warning', 'Run Optimize or Agent first.'); return; }
  vscode.postMessage({ type: 'sendPrompt', prompt: currentState.optimized });
});

optimizedPrompt.addEventListener('click', function(e) {
  var btn = e.target.closest('.secret-del');
  if (btn) { removeSecretFromOutput(btn.getAttribute('data-remove'), optimizedPrompt); }
});

document.getElementById('btnCopyOptimized').addEventListener('click', function() {
  if (!currentState || !currentState.optimized) { clearAlerts(); addAlert('warning', 'Run Optimize or Agent first.'); return; }
  vscode.postMessage({ type: 'copyPrompt', prompt: currentState.optimized });
});

btnSettingsMenu.addEventListener('click', function(event) {
  event.stopPropagation();
  setSettingsMenuOpen(settingsMenu.hidden);
});

settingsMenu.addEventListener('click', function(event) { event.stopPropagation(); });

document.getElementById('btnSecretSettings').addEventListener('click', function() {
  setSettingsMenuOpen(false);
  vscode.postMessage({ type: 'openSecretSettings' });
});

document.getElementById('btnReadme').addEventListener('click', function() {
  setSettingsMenuOpen(false);
  vscode.postMessage({ type: 'openReadme' });
});

document.addEventListener('click', function() {
  if (!settingsMenu.hidden) { setSettingsMenuOpen(false); }
});

document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') {
    if (!settingsMenu.hidden) { setSettingsMenuOpen(false); return; }
    clearAlerts();
    loading.style.display = 'none';
    loading.setAttribute('aria-hidden', 'true');
    return;
  }
  // Ctrl/Cmd+Enter in the prompt textarea runs the primary action.
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    if (document.activeElement === promptInput) {
      event.preventDefault();
      btnPrimary.click();
    }
  }
});

// ── Quick chips ──────────────────────────────────────────────────────────────
var chipTour    = document.getElementById('chipTour');
var chipGuide   = document.getElementById('chipGuide');
var chipHistory = document.getElementById('chipHistory');
var chipExample = document.getElementById('chipExample');
var chipMemory  = document.getElementById('chipMemory');
var chipPeers   = document.getElementById('chipPeers');
var chipAgents  = document.getElementById('chipAgents');
var btnClearInput     = document.getElementById('btnClearInput');
var btnClearOptimized = document.getElementById('btnClearOptimized');
var optimizedCard     = document.getElementById('optimizedCard');
if (chipTour) {
  chipTour.addEventListener('click', function() {
    vscode.postMessage({ type: 'openOnboarding' });
  });
}
if (chipGuide) {
  chipGuide.addEventListener('click', function() {
    vscode.postMessage({ type: 'openUserGuide' });
  });
}
if (chipHistory) {
  chipHistory.addEventListener('click', function() {
    vscode.postMessage({ type: 'showHistory' });
  });
}
var chipVersions = document.getElementById('chipVersions');
if (chipVersions) {
  chipVersions.addEventListener('click', function() {
    vscode.postMessage({ type: 'showPromptLog' });
  });
}
var btnCommitOptimized = document.getElementById('btnCommitOptimized');
if (btnCommitOptimized) {
  btnCommitOptimized.addEventListener('click', function() {
    var promptText = (promptInput && promptInput.value) || '';
    var optimizedText = (optimizedPrompt && optimizedPrompt.textContent) || '';
    vscode.postMessage({
      type: 'commitPrompt',
      prompt: promptText.trim(),
      optimized: optimizedText.trim(),
    });
  });
}
if (btnClearInput) {
  btnClearInput.addEventListener('click', function() {
    promptInput.value = '';
    promptInput.focus();
  });
}
if (btnClearOptimized) {
  btnClearOptimized.addEventListener('click', function() {
    if (optimizedPrompt) { optimizedPrompt.textContent = ''; }
    if (optimizedCard) { optimizedCard.style.display = 'none'; }
  });
}
if (chipExample) {
  chipExample.addEventListener('click', function() {
    promptInput.value = 'Refactor the auth middleware to use async/await and add unit tests for the happy path and 401 case.';
    promptInput.focus();
  });
}
if (chipMemory) {
  chipMemory.addEventListener('click', function() {
    vscode.postMessage({ type: 'openMemoryFile' });
  });
}
if (chipPeers) {
  chipPeers.addEventListener('click', function() {
    vscode.postMessage({ type: 'openPeerWorkspaces' });
  });
}
if (chipAgents) {
  chipAgents.addEventListener('click', function() {
    vscode.postMessage({ type: 'manageAgentSkills' });
  });
}

// ── Message handler ───────────────────────────────────────────────────────────
// Helper functions (renderState, clearAlerts, addAlert, openSecretSettingsState)
// are defined in sibling scripts loaded before this file.

window.addEventListener('message', function(event) {
  var msg = event.data;
  switch (msg.type) {
    case 'modeState':
      applyMode(msg.mode);
      break;
    case 'targetModelPattern':
      targetModelSelect.value = msg.model;
      break;
    case 'analysisState':
      renderState(msg.payload);
      break;
    case 'restorePrompt':
      if (promptInput && typeof msg.prompt === 'string') {
        promptInput.value = msg.prompt;
        promptInput.focus();
        try { promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length); } catch (_) {}
      }
      break;
    case 'versionsChanged':
      // Reserved for future badge updates; no-op for now.
      break;
    case 'responseStart':
      responseContent.textContent = '';
      streamBadge.style.display = 'inline';
      responseCard.style.display = 'block';
      loading.style.display = 'none';
      loading.setAttribute('aria-hidden', 'true');
      break;
    case 'responseChunk':
      responseContent.textContent += msg.chunk;
      responseContent.scrollTop = responseContent.scrollHeight;
      break;
    case 'responseDone':
      streamBadge.style.display = 'none';
      loading.style.display = 'none';
      loading.setAttribute('aria-hidden', 'true');
      break;
    case 'responseError':
      streamBadge.style.display = 'none';
      loading.style.display = 'none';
      loading.setAttribute('aria-hidden', 'true');
      clearAlerts();
      addAlert('error', msg.message || 'Agent call failed.');
      break;
    case 'error':
      loading.style.display = 'none';
      loading.setAttribute('aria-hidden', 'true');
      clearAlerts();
      addAlert('error', msg.message || 'Prompt Optimizer failed to analyze the prompt.');
      break;
    case 'secretSettingsState':
      openSecretSettingsState(msg);
      break;
    case 'secretSettingsSaved':
      savedNotice.style.display = 'block';
      setTimeout(function() {
        savedNotice.style.display = 'none';
        secretMgrOverlay.setAttribute('aria-hidden', 'true');
        secretMgrOverlay.style.display = 'none';
      }, 1200);
      break;
    case 'statusOverview':
      renderStatusOverview(msg.payload);
      break;
  }
});

function renderStatusOverview(overview) {
  if (!overview) { return; }
  var strip = document.getElementById('statusStrip');
  if (!strip) { return; }
  var memoryCount = document.getElementById('memoryCount');
  var kgCount     = document.getElementById('kgCount');
  var cacheCount  = document.getElementById('cacheCount');
  var peerCount   = document.getElementById('peerCount');
  var digestCount = document.getElementById('digestCount');
  var memoryVal = (overview.memory && overview.memory.entries) || 0;
  var kgNodes   = (overview.kg && overview.kg.nodes) || 0;
  var kgEdges   = (overview.kg && overview.kg.edges) || 0;
  var cacheVal  = (overview.cache && overview.cache.entries) || 0;
  var peerVal   = (overview.peers && overview.peers.enabled) || 0;
  var digestVal = (overview.digests && overview.digests.files) || 0;
  if (memoryCount) { memoryCount.textContent = String(memoryVal); }
  if (kgCount)     { kgCount.textContent     = String(kgNodes + '/' + kgEdges); }
  if (cacheCount)  { cacheCount.textContent  = String(cacheVal); }
  if (peerCount)   { peerCount.textContent   = String(peerVal); }
  if (digestCount) { digestCount.textContent = String(digestVal); }

  var hasAnyData = memoryVal > 0 || kgNodes > 0 || cacheVal > 0 || peerVal > 0 || digestVal > 0;
  var pillMemory   = document.getElementById('pillMemory');
  var pillKg       = document.getElementById('pillKg');
  var pillCache    = document.getElementById('pillCache');
  var pillPeers    = document.getElementById('pillPeers');
  var pillDigests  = document.getElementById('pillDigests');
  if (hasAnyData) {
    if (pillMemory)   { pillMemory.hidden = false; }
    if (pillKg)       { pillKg.hidden = false; }
    if (pillCache)    { pillCache.hidden = false; }
    if (pillPeers)    { pillPeers.hidden = false; }
    if (pillDigests)  { pillDigests.hidden = false; }
  } else {
    // No data rows yet — hide everything; the status-bar item shows the
    // "Indexing workspace…" state in a minimalist way.
    if (pillMemory) { pillMemory.hidden = true; }
    if (pillKg)     { pillKg.hidden = true; }
    if (pillCache)  { pillCache.hidden = true; }
    if (pillPeers)  { pillPeers.hidden = true; }
    if (pillDigests) { pillDigests.hidden = true; }
  }
  strip.hidden = !hasAnyData;
}

vscode.postMessage({ type: 'ready' });