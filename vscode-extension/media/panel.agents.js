// ── Agent creation overlay ────────────────────────────────────────────────────
// Lets the user add a custom agent skill for the workspace directly from the
// panel: type the definition, load it from a file, or drag-and-drop a file.
// Depends on the global `vscode` (defined in panel.js, which loads last) — it is
// only referenced inside event handlers, so it is always available by call time.

var agentMgrOverlay = document.getElementById('agentMgrOverlay');
var agentNameInput  = document.getElementById('agentName');
var agentContent    = document.getElementById('agentContent');
var agentDropZone   = document.getElementById('agentDropZone');
var agentFileInput  = document.getElementById('agentFileInput');
var agentError      = document.getElementById('agentError');
var agentSavedNotice = document.getElementById('agentSavedNotice');
var agentSavedText  = document.getElementById('agentSavedText');
var btnRemoveAgent  = document.getElementById('btnRemoveAgent');

// Id of the agent created in this overlay session, so the Remove button can
// delete exactly the file we just wrote.
var lastCreatedAgentId = '';

// Keep this in sync with MAX_PROMPT_CHARS in src/webview/validator.ts.
var MAX_AGENT_CHARS = 200000;

function showAgentError(message) {
  if (!agentError) { return; }
  agentError.textContent = message;
  agentError.style.display = message ? 'block' : 'none';
}

function openAgentOverlay() {
  if (!agentMgrOverlay) { return; }
  showAgentError('');
  lastCreatedAgentId = '';
  if (agentSavedNotice) { agentSavedNotice.style.display = 'none'; }
  if (btnRemoveAgent) { btnRemoveAgent.style.display = ''; btnRemoveAgent.disabled = false; }
  agentMgrOverlay.setAttribute('aria-hidden', 'false');
  agentMgrOverlay.style.display = 'block';
  if (agentNameInput) { agentNameInput.focus(); }
}

function closeAgentOverlay() {
  if (!agentMgrOverlay) { return; }
  agentMgrOverlay.setAttribute('aria-hidden', 'true');
  agentMgrOverlay.style.display = 'none';
}

function deriveAgentNameFromFile(fileName) {
  if (!fileName) { return ''; }
  var base = fileName.replace(/\.[^.]+$/, '');
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function loadAgentFile(file) {
  if (!file) { return; }
  if (file.size > MAX_AGENT_CHARS * 2) {
    showAgentError('File is too large (max ~400 KB).');
    return;
  }
  var reader = new FileReader();
  reader.onload = function() {
    var text = String(reader.result || '');
    if (text.length > MAX_AGENT_CHARS) { text = text.slice(0, MAX_AGENT_CHARS); }
    agentContent.value = text;
    if (agentNameInput && !agentNameInput.value.trim()) {
      agentNameInput.value = deriveAgentNameFromFile(file.name);
    }
    showAgentError('');
    agentContent.dispatchEvent(new Event('input', { bubbles: true }));
  };
  reader.onerror = function() { showAgentError('Could not read the dropped file.'); };
  reader.readAsText(file);
}

// ── Wiring ────────────────────────────────────────────────────────────────────
if (agentMgrOverlay) {
  var btnAgentClose = document.getElementById('btnAgentClose');
  if (btnAgentClose) { btnAgentClose.addEventListener('click', closeAgentOverlay); }

  var btnCancelAgent = document.getElementById('btnCancelAgent');
  if (btnCancelAgent) { btnCancelAgent.addEventListener('click', closeAgentOverlay); }

  agentMgrOverlay.addEventListener('click', function(e) {
    if (e.target === agentMgrOverlay) { closeAgentOverlay(); }
  });

  var btnManageBundledAgents = document.getElementById('btnManageBundledAgents');
  if (btnManageBundledAgents) {
    btnManageBundledAgents.addEventListener('click', function() {
      closeAgentOverlay();
      vscode.postMessage({ type: 'manageAgentSkills' });
    });
  }

  var btnAgentBrowse = document.getElementById('btnAgentBrowse');
  if (btnAgentBrowse && agentFileInput) {
    btnAgentBrowse.addEventListener('click', function(e) {
      e.stopPropagation();
      agentFileInput.click();
    });
  }
  if (agentDropZone && agentFileInput) {
    agentDropZone.addEventListener('click', function() { agentFileInput.click(); });
    agentDropZone.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); agentFileInput.click(); }
    });
  }
  if (agentFileInput) {
    agentFileInput.addEventListener('change', function() {
      if (agentFileInput.files && agentFileInput.files.length > 0) {
        loadAgentFile(agentFileInput.files[0]);
      }
      agentFileInput.value = '';
    });
  }

  // Drag & drop a file onto the drop zone.
  if (agentDropZone) {
    ['dragenter', 'dragover'].forEach(function(evt) {
      agentDropZone.addEventListener(evt, function(e) {
        e.preventDefault();
        e.stopPropagation();
        agentDropZone.classList.add('drop-target');
      });
    });
    ['dragleave', 'drop'].forEach(function(evt) {
      agentDropZone.addEventListener(evt, function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (evt === 'drop') {
          var dt = e.dataTransfer;
          if (dt && dt.files && dt.files.length > 0) { loadAgentFile(dt.files[0]); }
        }
        agentDropZone.classList.remove('drop-target');
      });
    });
  }

  var btnSaveAgent = document.getElementById('btnSaveAgent');
  if (btnSaveAgent) {
    btnSaveAgent.addEventListener('click', function() {
      var name = (agentNameInput && agentNameInput.value || '').trim();
      var content = (agentContent && agentContent.value || '').trim();
      if (!name) { showAgentError('Enter an agent name.'); return; }
      if (!content) { showAgentError('Type the agent definition or load it from a file.'); return; }
      showAgentError('');
      vscode.postMessage({ type: 'createAgent', agentName: name, agentContent: content });
    });
  }

  // Close on Escape while the overlay is open.
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && agentMgrOverlay.style.display === 'block') {
      closeAgentOverlay();
    }
  });

  if (btnRemoveAgent) {
    btnRemoveAgent.addEventListener('click', function() {
      if (!lastCreatedAgentId) { return; }
      btnRemoveAgent.disabled = true;
      vscode.postMessage({ type: 'deleteAgent', agentId: lastCreatedAgentId });
    });
  }
}

// Called from the message handler in panel.js when the host replies.
function handleAgentCreated(message) {
  if (message && message.ok) {
    showAgentError('');
    lastCreatedAgentId = message.id || '';
    if (agentSavedText) {
      agentSavedText.textContent = '\u2713 Agent "' + (message.id || 'agent') + '" created';
    }
    if (agentSavedNotice) { agentSavedNotice.style.display = 'flex'; }
    if (btnRemoveAgent) { btnRemoveAgent.disabled = !lastCreatedAgentId; }
    if (agentNameInput) { agentNameInput.value = ''; }
    if (agentContent) { agentContent.value = ''; }
  } else {
    showAgentError((message && message.error) || 'Could not create the agent.');
  }
}

// Called when the host confirms (or rejects) deletion of the created agent.
function handleAgentDeleted(message) {
  if (message && message.ok) {
    lastCreatedAgentId = '';
    if (agentSavedText) { agentSavedText.textContent = '\u2717 Agent removed'; }
    if (btnRemoveAgent) { btnRemoveAgent.style.display = 'none'; }
    setTimeout(closeAgentOverlay, 900);
  } else {
    if (btnRemoveAgent) { btnRemoveAgent.disabled = false; }
    showAgentError((message && message.error) || 'Could not remove the agent.');
  }
}
