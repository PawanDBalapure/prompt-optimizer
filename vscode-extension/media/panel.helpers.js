// Shared mutable state (var → window property, visible to all sibling scripts).
var currentState = null;
var currentCustomPatterns = [];

// ── Pure utility functions ────────────────────────────────────────────────────

function formatCurrency(value) {
  return '$' + Number(value || 0).toFixed(5);
}

function cacheLabel(status, confidence) {
  if (status === 'exact')    { return 'exact cache hit'; }
  if (status === 'semantic') { return 'semantic match (' + Math.round((confidence || 0) * 100) + '%)'; }
  return 'cache miss';
}

function clearChildren(node) {
  while (node.firstChild) { node.removeChild(node.firstChild); }
}

function appendListItems(node, items, emptyLabel) {
  clearChildren(node);
  if (!items || items.length === 0) {
    var li = document.createElement('li');
    li.textContent = emptyLabel;
    node.appendChild(li);
    return;
  }
  items.forEach(function(item) {
    var li = document.createElement('li');
    li.textContent = item;
    node.appendChild(li);
  });
}

function appendChips(node, items) {
  clearChildren(node);
  items.forEach(function(item) {
    var li = document.createElement('li');
    li.className = 'chip';
    li.textContent = item;
    node.appendChild(li);
  });
  if (items.length === 0) {
    var li = document.createElement('li');
    li.className = 'chip';
    li.textContent = 'No extra context selected';
    node.appendChild(li);
  }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

function buildSecretHighlightHtml(text, matchedText) {
  var lower = text.toLowerCase();
  var lowerMatch = matchedText.toLowerCase();
  var result = '';
  var pos = 0;
  while (pos < text.length) {
    var idx = lower.indexOf(lowerMatch, pos);
    if (idx === -1) { result += escHtml(text.slice(pos)); break; }
    result += escHtml(text.slice(pos, idx));
    var actual = text.slice(idx, idx + matchedText.length);
    result += '<mark class="secret-mark" tabindex="0">' + escHtml(actual) +
      '<span class="secret-del-wrap"><button class="secret-del" data-remove="' + escHtml(matchedText) +
      '" title="\u00d7 Remove this text from the output">\u00d7\u2009Remove this text</button></span></mark>';
    pos = idx + matchedText.length;
  }
  return result;
}

function highlightSecretInOutput(matchedText, outputEl) {
  if (!matchedText || !currentState) { return; }
  var text = currentState.optimized || '';
  if (text.toLowerCase().indexOf(matchedText.toLowerCase()) === -1) { return; }
  outputEl.innerHTML = buildSecretHighlightHtml(text, matchedText);
  var firstMark = outputEl.querySelector('.secret-mark');
  if (firstMark) { firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' }); firstMark.focus(); }
}

function removeSecretFromOutput(matchedText, outputEl) {
  if (!matchedText || !currentState) { return; }
  var text = currentState.optimized || '';
  var lower = text.toLowerCase();
  var lowerMatch = matchedText.toLowerCase();
  var newText = '';
  var pos = 0;
  while (pos < text.length) {
    var idx = lower.indexOf(lowerMatch, pos);
    if (idx === -1) { newText += text.slice(pos); break; }
    newText += text.slice(pos, idx);
    pos = idx + matchedText.length;
  }
  currentState.optimized = newText;
  outputEl.textContent = newText;
  document.getElementById('alerts').querySelectorAll('[data-secret-matched]').forEach(function(el) {
    if (el.getAttribute('data-secret-matched').toLowerCase() === matchedText.toLowerCase()) { el.remove(); }
  });
}

function normalizeSecretPatternMode(value) {
  return Object.prototype.hasOwnProperty.call(SECRET_PATTERN_MODE_LABELS, value) ? value : 'regex';
}

function normalizeCustomPatternEntry(entry) {
  if (!entry || typeof entry !== 'object') { return null; }
  var pattern = typeof entry.pattern === 'string' ? entry.pattern.trim() : '';
  if (!pattern) { return null; }
  var label = typeof entry.label === 'string' ? entry.label.trim() : '';
  return {
    label: label || undefined,
    pattern: pattern,
    matchMode: normalizeSecretPatternMode(entry.matchMode),
  };
}
