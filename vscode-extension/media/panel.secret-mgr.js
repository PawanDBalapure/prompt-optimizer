// ── Secret Manager overlay (depends on helpers loaded before this file) ────────

var secretMgrOverlay   = document.getElementById('secretMgrOverlay');
var secretEnabledChk   = document.getElementById('secretEnabled');
var builtinPatternList = document.getElementById('builtinPatternList');
var customPatternList  = document.getElementById('customPatternList');
var addPatternForm     = document.getElementById('addPatternForm');
var patternLabelInput  = document.getElementById('patternLabel');
var patternModeSelect  = document.getElementById('patternMode');
var patternValueInput  = document.getElementById('patternValue');
var patternError       = document.getElementById('patternError');
var savedNotice        = document.getElementById('savedNotice');

function updatePatternValueInput() {
  var mode = normalizeSecretPatternMode(patternModeSelect.value);
  patternValueInput.placeholder = SECRET_PATTERN_MODE_PLACEHOLDERS[mode] || SECRET_PATTERN_MODE_PLACEHOLDERS.regex;
}

function renderCustomPatterns() {
  customPatternList.innerHTML = '';
  if (currentCustomPatterns.length === 0) {
    var empty = document.createElement('li');
    empty.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 0;';
    empty.textContent = 'No custom patterns yet.';
    customPatternList.appendChild(empty);
    return;
  }
  currentCustomPatterns.forEach(function(p, idx) {
    var div = document.createElement('div');
    div.className = 'custom-item';
    var info = document.createElement('div');
    info.className = 'ci-info';
    var lbl = document.createElement('div');
    lbl.className = 'ci-label';
    lbl.textContent = p.label || 'Pattern ' + (idx + 1);
    var rx = document.createElement('div');
    rx.className = 'ci-regex';
    rx.textContent = (SECRET_PATTERN_MODE_LABELS[normalizeSecretPatternMode(p.matchMode)] || 'Regex') + ' \xb7 ' + p.pattern;
    info.appendChild(lbl);
    info.appendChild(rx);
    div.appendChild(info);
    var delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.title = 'Remove this pattern';
    delBtn.setAttribute('aria-label', 'Remove pattern: ' + (p.label || p.pattern));
    delBtn.textContent = '\u00D7';
    delBtn.addEventListener('click', function() {
      currentCustomPatterns.splice(idx, 1);
      renderCustomPatterns();
    });
    div.appendChild(delBtn);
    customPatternList.appendChild(div);
  });
}

// Called from the message handler in panel.js when 'secretSettingsState' arrives.
function openSecretSettingsState(message) {
  currentCustomPatterns = (message.customPatterns || [])
    .map(normalizeCustomPatternEntry)
    .filter(function(item) { return !!item; });
  secretEnabledChk.checked = !!message.enabled;
  builtinPatternList.innerHTML = '';
  (message.builtinLabels || []).forEach(function(label) {
    var li = document.createElement('li');
    li.textContent = label;
    builtinPatternList.appendChild(li);
  });
  renderCustomPatterns();
  addPatternForm.style.display = 'none';
  updatePatternValueInput();
  savedNotice.style.display = 'none';
  secretMgrOverlay.setAttribute('aria-hidden', 'false');
  secretMgrOverlay.style.display = 'block';
}

// ── Event wiring ───────────────────────────────────────────────────────────────

document.getElementById('btnSecretClose').addEventListener('click', function() {
  secretMgrOverlay.setAttribute('aria-hidden', 'true');
  secretMgrOverlay.style.display = 'none';
});

secretMgrOverlay.addEventListener('click', function(e) {
  if (e.target === secretMgrOverlay) {
    secretMgrOverlay.setAttribute('aria-hidden', 'true');
    secretMgrOverlay.style.display = 'none';
  }
});

document.getElementById('btnAddPattern').addEventListener('click', function() {
  addPatternForm.style.display = 'flex';
  patternLabelInput.value = '';
  patternModeSelect.value = 'regex';
  patternValueInput.value = '';
  patternError.style.display = 'none';
  updatePatternValueInput();
  patternLabelInput.focus();
});

patternModeSelect.addEventListener('change', updatePatternValueInput);

document.getElementById('btnCancelPattern').addEventListener('click', function() {
  addPatternForm.style.display = 'none';
});

document.getElementById('btnSavePattern').addEventListener('click', function() {
  var mode  = normalizeSecretPatternMode(patternModeSelect.value);
  var value = patternValueInput.value.trim();
  if (!value) {
    patternError.textContent = 'Pattern value is required.';
    patternError.style.display = 'block';
    return;
  }
  if (mode === 'regex') {
    try { new RegExp(value, 'i'); } catch(e) {
      patternError.textContent = 'Invalid regex: ' + e.message;
      patternError.style.display = 'block';
      return;
    }
  }
  patternError.style.display = 'none';
  var lbl = patternLabelInput.value.trim();
  currentCustomPatterns.push({ label: lbl || undefined, pattern: value, matchMode: mode });
  renderCustomPatterns();
  addPatternForm.style.display = 'none';
});

document.getElementById('btnSaveSecretSettings').addEventListener('click', function() {
  // vscode is declared in panel.js (main, loads after this file) but is
  // already available on window by the time any click handler fires.
  vscode.postMessage({
    type: 'saveSecretSettings',
    enabled: secretEnabledChk.checked,
    customPatterns: currentCustomPatterns,
  });
});

document.getElementById('btnCancelSecretSettings').addEventListener('click', function() {
  secretMgrOverlay.setAttribute('aria-hidden', 'true');
  secretMgrOverlay.style.display = 'none';
});
