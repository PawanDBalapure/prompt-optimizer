// ── Alert helpers (DOM-aware, defined here so panel.js can use them too) ────────

function clearAlerts() {
  document.getElementById('alerts').innerHTML = '';
}

function addAlert(kind, message) {
  var div = document.createElement('div');
  div.className = 'alert-item alert-' + kind;
  div.textContent = (kind === 'warning' ? '\u26a0\ufe0f  ' : '\u2715  ') + message;
  document.getElementById('alerts').appendChild(div);
}

// ── renderState — main analysis-result renderer ───────────────────────────────

function renderState(state) {
  currentState = state;

  var promptInput     = document.getElementById('promptInput');
  var resultCard      = document.getElementById('resultCard');
  var loading         = document.getElementById('loading');
  var optimizedPrompt = document.getElementById('optimizedPrompt');
  var optimizedCard   = document.getElementById('optimizedCard');
  var totalCost       = document.getElementById('totalCost');
  var tokenSavings    = document.getElementById('tokenSavings');
  var outputTokens    = document.getElementById('outputTokens');
  var cacheStatusEl   = document.getElementById('cacheStatus');
  var pricingBreakdown = document.getElementById('pricingBreakdown');
  var tokenDelta      = document.getElementById('tokenDelta');
  var contextChips    = document.getElementById('contextChips');
  var improvements    = document.getElementById('improvements');
  var alertsEl        = document.getElementById('alerts');

  promptInput.value = state.original;
  resultCard.style.display = 'block';
  resultCard.removeAttribute('aria-hidden');
  loading.style.display = 'none';
  loading.setAttribute('aria-hidden', 'true');

  clearAlerts();

  // ── Secret match alerts ────────────────────────────────────────────────────
  var secMatches = (state.secretMatches && state.secretMatches.length) ? state.secretMatches : null;
  if (secMatches) {
    secMatches.forEach(function(match) {
      var d = document.createElement('div');
      d.className = 'alert-item alert-warning';
      var inOutput = match.matched && state.optimized &&
        state.optimized.toLowerCase().indexOf(match.matched.toLowerCase()) !== -1;
      if (inOutput) { d.setAttribute('data-secret-matched', match.matched); }
      var txt = document.createElement('span');
      if (inOutput) {
        txt.textContent = '\u26a0\ufe0f  Possible secret detected: ' + match.label +
          ' \u2014 matched: \u201c' + match.matched + '\u201d. Review before sending.';
      } else if (match.matched) {
        txt.textContent = '\u26a0\ufe0f  Possible secret detected in input: ' + match.label +
          ' \u2014 matched: \u201c' + match.matched + '\u201d. Not present in optimized output.';
        d.className = 'alert-item alert-info';
      } else {
        txt.textContent = '\u26a0\ufe0f  Possible secret detected: ' + match.label + '. Review before sending.';
      }
      d.appendChild(txt);
      if (inOutput) {
        var btn = document.createElement('button');
        btn.className = 'secret-rm-btn';
        btn.textContent = 'Remove from output';
        btn.setAttribute('data-matched', match.matched);
        btn.addEventListener('click', function() {
          highlightSecretInOutput(this.getAttribute('data-matched'), optimizedPrompt);
          optimizedCard.style.display = 'block';
        });
        d.appendChild(btn);
      }
      alertsEl.appendChild(d);
    });
  } else {
    (state.warnings || []).forEach(function(w) { addAlert('warning', w); });
  }

  if (state.secretDetectionEnabled === false) {
    addAlert('warning', '\u{1F515} Secret detection is disabled \u2014 enable it in settings to scan prompts for secrets.');
  }

  // ── Metrics + cost ─────────────────────────────────────────────────────────
  var metrics  = state.metrics;
  var analysis = state.analysis;
  var savingsPct = metrics.raw_input_tokens > 0
    ? Math.round((metrics.tokens_saved / metrics.raw_input_tokens) * 100)
    : 0;

  totalCost.textContent        = formatCurrency(analysis.cost.total_cost_usd);
  tokenSavings.textContent     = metrics.tokens_saved + ' tokens (' + savingsPct + '%)';
  outputTokens.textContent     = String(metrics.estimated_output_tokens);
  cacheStatusEl.textContent    = cacheLabel(analysis.cache.status, analysis.cache.confidence);
  pricingBreakdown.textContent = 'Input ' + formatCurrency(analysis.cost.input_cost_usd) +
                                 ' + output ' + formatCurrency(analysis.cost.output_cost_usd);
  tokenDelta.textContent       = metrics.raw_input_tokens + ' \u2192 ' + metrics.optimized_input_tokens + ' tokens';

  // ── Optimized prompt ───────────────────────────────────────────────────────
  optimizedPrompt.textContent  = state.optimized;
  optimizedCard.style.display  = state.optimized ? 'block' : 'none';

  // ── Context chips ──────────────────────────────────────────────────────────
  var chipItems = [];
  if (analysis.context.active_file) { chipItems.push('Active: ' + analysis.context.active_file); }
  analysis.context.selected_files.forEach(function(f) { chipItems.push('File: ' + f); });
  analysis.context.selected_logs.forEach(function(l)  { chipItems.push('Log: '  + l); });
  chipItems.push('Open editors: ' + analysis.context.open_file_count);
  appendChips(contextChips, chipItems);

  // ── Improvement suggestions ────────────────────────────────────────────────
  appendListItems(improvements, state.improvements, 'No extra refinements suggested.');

  // ── Lint diagnostics ───────────────────────────────────────────────────────
  var diagnosticsGrid = document.getElementById('diagnosticsGrid');
  clearChildren(diagnosticsGrid);
  var diagnostics = state.diagnostics || [];

  if (diagnostics.length === 0) {
    var li = document.createElement('li');
    li.style.color = 'var(--vscode-terminal-ansiGreen, #4ec94e)';
    li.style.fontSize = '11px';
    li.innerHTML = '<span aria-hidden="true">\u2714</span> No lint warnings detected. Prompt quality score is optimal!';
    diagnosticsGrid.appendChild(li);
  } else {
    diagnostics.forEach(function(diag) {
      var li = document.createElement('li');
      li.style.borderBottom = '1px solid rgba(127,127,127,0.1)';
      li.style.padding = '5px 0';
      var badge = diag.severity === 'warning' ? '\u26a0\ufe0f' : '\u2139\ufe0f';
      var color = diag.severity === 'warning' ? '#f8d775' : '#70bdf6';
      li.innerHTML =
        '<span style="font-weight:600;color:' + color + '" aria-label="' + escHtml(diag.severity) + '">' +
        badge + ' [' + escHtml(diag.code) + ']</span>: ' + escHtml(diag.message) +
        '<br/><span style="font-size:11px;display:block;margin-top:3px;font-style:italic;' +
        'color:var(--vscode-descriptionForeground)">' +
        '\ud83d\udca1 Suggestion: ' + escHtml(diag.fix_suggestion) + '</span>';
      diagnosticsGrid.appendChild(li);
    });
  }
}
