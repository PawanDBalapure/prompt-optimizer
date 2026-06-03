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

  // ── Partial cache reuse banner ─────────────────────────────────────────────
  var reused = analysis.cache && analysis.cache.reused_segments;
  if (reused && reused.length) {
    var savedTokens = analysis.cache.reused_tokens_saved || 0;
    addAlert(
      'info',
      '\u267b\ufe0f  ' + reused.length + ' context block' + (reused.length === 1 ? '' : 's') +
        ' reused from cache (~' + savedTokens + ' tokens saved). Referenced in the optimized prompt instead of resent: ' +
        reused.map(function(seg) { return seg.label; }).join(', '),
    );
  }

  // ── Context chips ──────────────────────────────────────────────────────────
  var chipItems = [];
  if (analysis.context.active_file) { chipItems.push('Active: ' + analysis.context.active_file); }
  analysis.context.selected_files.forEach(function(f) { chipItems.push('File: ' + f); });
  analysis.context.selected_logs.forEach(function(l)  { chipItems.push('Log: '  + l); });
  chipItems.push('Open editors: ' + analysis.context.open_file_count);
  appendChips(contextChips, chipItems);

  // ── Improvement suggestions ────────────────────────────────────────────────
  appendListItems(improvements, state.improvements, 'No extra refinements suggested.');
  var improvementsCountEl = document.getElementById('improvementsCount');
  var refinementsAccordion = document.getElementById('refinementsAccordion');
  var improvementsCount = (state.improvements && state.improvements.length) || 0;
  if (improvementsCountEl) {
    improvementsCountEl.textContent = String(improvementsCount);
    improvementsCountEl.classList.toggle('po-count-zero', improvementsCount === 0);
    improvementsCountEl.setAttribute(
      'aria-label',
      improvementsCount + ' refinement' + (improvementsCount === 1 ? '' : 's'),
    );
  }
  if (refinementsAccordion) {
    refinementsAccordion.open = false;
  }

  // ── Forecast cost details (estimates only) ────────────────────────────────
  renderCostForecast(state);

  // ── Lint diagnostics ───────────────────────────────────────────────────────
  var diagnosticsGrid = document.getElementById('diagnosticsGrid');
  clearChildren(diagnosticsGrid);
  var diagnostics = state.diagnostics || [];
  var diagnosticsCountEl = document.getElementById('diagnosticsCount');
  var diagnosticsAccordion = document.getElementById('diagnosticsAccordion');
  if (diagnosticsCountEl) {
    diagnosticsCountEl.textContent = String(diagnostics.length);
    diagnosticsCountEl.classList.toggle('po-count-zero', diagnostics.length === 0);
    var hasWarn = diagnostics.some(function(d) { return d.severity === 'warning'; });
    diagnosticsCountEl.classList.toggle('po-count-warn', hasWarn);
    diagnosticsCountEl.setAttribute(
      'aria-label',
      diagnostics.length + ' lint diagnostic' + (diagnostics.length === 1 ? '' : 's'),
    );
  }
  if (diagnosticsAccordion) {
    diagnosticsAccordion.open = false;
  }

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

// ── Forecast cost rendering ───────────────────────────────────────────────────
// Renders the input/output/total breakdown into the accordion table.  The
// figures come straight from the engine's pricing module (see
// src/engine/pricing.ts) — they are estimates, not billed amounts.
// Premium-request (credit) multiplier per target model. A multiplier of 1
// means one optimized request consumes one premium request; 0 means the model
// is fully included and never draws from the premium allowance.
var CREDIT_MODEL_MULTIPLIERS = { gpt: 1, claude: 1, gemini: 1, local: 0 };
var CREDIT_MODEL_LABELS = { gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', local: 'Local' };

// Latest plan/volume config pushed by the host. Defaults mirror Copilot Pro.
var creditForecastConfig = {
  plan: 'pro',
  planLabel: 'Copilot Pro',
  monthlyAllowance: 300,
  requestsPerDay: 20,
  overagePrice: 0.04,
};

function setCreditForecastConfig(cfg) {
  if (cfg && typeof cfg === 'object') {
    creditForecastConfig = {
      plan: cfg.plan || 'pro',
      planLabel: cfg.planLabel || 'Copilot Pro',
      monthlyAllowance: Number(cfg.monthlyAllowance) || 0,
      requestsPerDay: Number(cfg.requestsPerDay) || 0,
      overagePrice: Number(cfg.overagePrice) || 0,
    };
  }
  renderCostForecast();
}

function renderCostForecast() {
  var body  = document.getElementById('costForecastBody');
  var foot  = document.getElementById('costForecastFooterTotal');
  var badge = document.getElementById('costForecastTotal');
  if (!body || !foot || !badge) { return; }

  var cfg = creditForecastConfig;
  var modelSel = document.getElementById('targetModelSelect');
  var model = (modelSel && modelSel.value) || 'gpt';
  var multiplier = CREDIT_MODEL_MULTIPLIERS.hasOwnProperty(model)
    ? CREDIT_MODEL_MULTIPLIERS[model] : 1;
  var modelLabel = CREDIT_MODEL_LABELS[model] || model;

  var allowance      = cfg.monthlyAllowance;
  var requestsPerDay = cfg.requestsPerDay;
  // ~22 working days per month for the projection.
  var requestsPerMonth = Math.round(requestsPerDay * 22);
  var creditsPerMonth  = requestsPerMonth * multiplier;
  var remaining        = Math.max(0, allowance - creditsPerMonth);
  var overageRequests  = Math.max(0, creditsPerMonth - allowance);
  var overageCost      = overageRequests * cfg.overagePrice;

  var creditsPerRequestLabel = multiplier === 0
    ? 'Included (0 credits)'
    : (multiplier + (multiplier === 1 ? ' credit' : ' credits') + ' / request');

  var rows = [
    { label: 'Plan',                          value: cfg.planLabel },
    { label: 'Included premium requests / mo', value: String(allowance) },
    { label: 'Target model',                  value: modelLabel + ' — ' + creditsPerRequestLabel },
    { label: 'Estimated requests / day',      value: String(requestsPerDay) },
    { label: 'Projected requests / mo',       value: String(requestsPerMonth) },
    { label: 'Premium requests used / mo',    value: String(creditsPerMonth) },
    { label: 'Remaining included / mo',       value: String(remaining) },
    { label: 'Overage requests / mo',         value: String(overageRequests) },
    { label: 'Overage cost / mo',             value: formatCurrency(overageCost) },
  ];

  while (body.firstChild) { body.removeChild(body.firstChild); }
  rows.forEach(function(row) {
    var tr = document.createElement('tr');
    var tdLabel = document.createElement('td'); tdLabel.textContent = row.label;
    var tdValue = document.createElement('td'); tdValue.textContent = row.value;
    tdValue.style.textAlign = 'right';
    tr.appendChild(tdLabel);
    tr.appendChild(tdValue);
    body.appendChild(tr);
  });

  foot.textContent = formatCurrency(overageCost);
  if (overageCost > 0) {
    badge.textContent = formatCurrency(overageCost);
    badge.classList.remove('po-count-zero');
  } else {
    badge.textContent = 'Included';
    badge.classList.add('po-count-zero');
  }
}
