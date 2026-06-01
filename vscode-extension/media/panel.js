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

// ── Voice input (Web Speech API) ─────────────────────────────────────────────
var btnMic = document.getElementById('btnMic');
(function setupVoiceInput() {
  if (!btnMic) { return; }
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btnMic.disabled = true;
    btnMic.title = 'Voice input not supported in this VS Code build';
    return;
  }
  var recognition = null;
  var recording = false;
  var baseValue = '';

  function setRecording(on) {
    recording = on;
    btnMic.classList.toggle('mic-recording', on);
    btnMic.setAttribute('aria-pressed', on ? 'true' : 'false');
    btnMic.title = on
      ? 'Listening… click to stop'
      : 'Dictate prompt — click to start/stop voice input';
  }

  function start() {
    try {
      recognition = new SR();
    } catch (_e) {
      btnMic.disabled = true;
      return;
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = (navigator && navigator.language) || 'en-US';

    baseValue = (promptInput && promptInput.value) || '';
    if (baseValue && !/\s$/.test(baseValue)) { baseValue += ' '; }

    recognition.onresult = function(event) {
      var finalText = '';
      var interim = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var res = event.results[i];
        if (res.isFinal) { finalText += res[0].transcript; }
        else { interim += res[0].transcript; }
      }
      if (finalText) {
        baseValue += finalText;
        if (!/\s$/.test(baseValue)) { baseValue += ' '; }
      }
      promptInput.value = baseValue + interim;
    };
    recognition.onerror = function(event) {
      var msg = (event && event.error) ? event.error : 'unknown';
      if (msg === 'not-allowed' || msg === 'service-not-allowed') {
        btnMic.title = 'Microphone permission denied';
      }
      setRecording(false);
    };
    recognition.onend = function() {
      setRecording(false);
    };
    try {
      recognition.start();
      setRecording(true);
      promptInput.focus();
    } catch (_e) {
      setRecording(false);
    }
  }

  function stop() {
    if (recognition) {
      try { recognition.stop(); } catch (_e) { /* ignore */ }
    }
    setRecording(false);
  }

  btnMic.addEventListener('click', function() {
    if (recording) { stop(); } else { start(); }
  });
})();
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
var chipReport = document.getElementById('chipReport');
if (chipReport) {
  chipReport.addEventListener('click', function() {
    vscode.postMessage({ type: 'reportIssue' });
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
    case 'ocrImageResult':
      handleOcrImageResult(msg);
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

// ── Image attachments + OCR ──────────────────────────────────────────────────
// Users can attach images via the paperclip button, drag-and-drop, or paste
// from clipboard. Each image is shipped to the extension host as base64; the
// host runs Tesseract OCR (fully offline, English) and posts back the
// extracted text, which we append to the textarea so it becomes part of the
// prompt the optimizer sees.

var attachmentStrip = document.getElementById('attachmentStrip');
var imageFileInput  = document.getElementById('imageFileInput');
var btnAttachImage  = document.getElementById('btnAttachImage');
var inputWrap       = promptInput && promptInput.parentElement;

// Hard cap to avoid OOM-ing the host when someone drags a 50 MP photo.
var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
var pendingOcrChips = Object.create(null); // requestId -> { chipEl, name }
var ocrSeq = 0;

function genOcrId() {
  ocrSeq += 1;
  return 'ocr-' + Date.now().toString(36) + '-' + ocrSeq;
}

function makeChip(id, name) {
  var chip = document.createElement('span');
  chip.className = 'attach-chip';
  chip.dataset.id = id;
  var nameEl = document.createElement('span');
  nameEl.className = 'chip-name';
  nameEl.textContent = name;
  nameEl.title = name;
  var statusEl = document.createElement('span');
  statusEl.className = 'chip-status';
  statusEl.textContent = '\u22EF reading\u2026';
  var removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'chip-remove';
  removeBtn.setAttribute('aria-label', 'Remove attachment');
  removeBtn.textContent = '\u2715';
  removeBtn.addEventListener('click', function() {
    chip.remove();
    delete pendingOcrChips[id];
  });
  chip.appendChild(nameEl);
  chip.appendChild(statusEl);
  chip.appendChild(removeBtn);
  return chip;
}

function arrayBufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var binary = '';
  var chunk = 0x8000;
  for (var i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function appendOcrText(name, text) {
  if (!text) { return; }
  var block = '\n\n--- OCR text from ' + name + ' ---\n' + text;
  // Append at end of textarea so users can see the extracted content
  // directly and edit it before optimizing.
  if (promptInput.value.trim().length === 0) {
    promptInput.value = block.replace(/^\n+/, '');
  } else {
    promptInput.value = promptInput.value + block;
  }
  promptInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function handleOcrImageResult(msg) {
  var entry = pendingOcrChips[msg.id];
  if (!entry) { return; }
  delete pendingOcrChips[msg.id];
  var chip = entry.chipEl;
  var statusEl = chip.querySelector('.chip-status');
  if (msg.ok && typeof msg.text === 'string' && msg.text.length > 0) {
    appendOcrText(entry.name, msg.text);
    if (statusEl) { statusEl.textContent = '\u2713 ' + msg.text.length + ' chars'; }
    setTimeout(function() {
      chip.classList.add('chip-fade');
      chip.remove();
    }, 2500);
  } else {
    chip.classList.add('error');
    if (statusEl) { statusEl.textContent = msg.error ? msg.error : 'no text found'; }
  }
}

function processFile(file) {
  if (!file || !/^image\//.test(file.type)) {
    addAlert('warning', 'Skipped "' + (file && file.name || 'file') + '": not an image.');
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    addAlert('warning', '"' + file.name + '" is larger than 8 MB and was skipped.');
    return;
  }
  var id = genOcrId();
  var chip = makeChip(id, file.name || 'image');
  pendingOcrChips[id] = { chipEl: chip, name: file.name || 'image' };
  attachmentStrip.appendChild(chip);

  var reader = new FileReader();
  reader.onload = function() {
    try {
      var b64 = arrayBufferToBase64(reader.result);
      vscode.postMessage({
        type: 'ocrImage',
        id: id,
        name: file.name || 'image',
        mime: file.type || 'image/png',
        dataBase64: b64,
      });
    } catch (err) {
      handleOcrImageResult({ id: id, ok: false, error: 'encode failed' });
    }
  };
  reader.onerror = function() {
    handleOcrImageResult({ id: id, ok: false, error: 'read failed' });
  };
  reader.readAsArrayBuffer(file);
}

function processFiles(files) {
  if (!files) { return; }
  for (var i = 0; i < files.length; i++) { processFile(files[i]); }
}

if (btnAttachImage && imageFileInput) {
  btnAttachImage.addEventListener('click', function() { imageFileInput.click(); });
  imageFileInput.addEventListener('change', function() {
    processFiles(imageFileInput.files);
    imageFileInput.value = ''; // allow re-selecting the same file
  });
}

// Drag-and-drop on the textarea wrapper.
if (inputWrap) {
  ['dragenter', 'dragover'].forEach(function(evt) {
    inputWrap.addEventListener(evt, function(e) {
      if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function(t) { return t === 'Files'; })) {
        e.preventDefault();
        e.stopPropagation();
        inputWrap.classList.add('drop-target');
      }
    });
  });
  ['dragleave', 'drop'].forEach(function(evt) {
    inputWrap.addEventListener(evt, function(e) {
      if (evt === 'drop') {
        e.preventDefault();
        e.stopPropagation();
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
          processFiles(dt.files);
        }
      }
      inputWrap.classList.remove('drop-target');
    });
  });
}

// Clipboard paste support: `Ctrl+V` an image into the textarea.
if (promptInput) {
  promptInput.addEventListener('paste', function(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) { return; }
    var anyImage = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) { processFile(f); anyImage = true; }
      }
    }
    if (anyImage) { e.preventDefault(); }
  });
}

vscode.postMessage({ type: 'ready' });