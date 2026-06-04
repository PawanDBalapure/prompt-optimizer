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
// Model complexity weights used in the credit formula. These can be
// overridden by host-provided config (see setCreditForecastConfig).
var CREDIT_MODEL_WEIGHTS = { gpt: 2, claude: 2.5, gemini: 2, deepseek: 3, grok: 3, local: 0 };
var CREDIT_MODEL_LABELS = { gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok', local: 'Local' };

// Latest plan/volume config pushed by the host. Defaults mirror Copilot Pro.
var creditForecastConfig = {
  plan: 'pro',
  planLabel: 'Copilot Pro',
  monthlyAllowance: 300,
  requestsPerDay: 20,
  overagePrice: 0.04,
  baseInputRate: 0.001,
  baseOutputRate: 0.002,
  fixedExecutionOverhead: 1,
  defaultInputTokens: 800,
  defaultOutputTokens: 400,
  modelWeights: CREDIT_MODEL_WEIGHTS,
};

function setCreditForecastConfig(cfg) {
  if (cfg && typeof cfg === 'object') {
    creditForecastConfig = {
      plan: cfg.plan || 'pro',
      planLabel: cfg.planLabel || 'Copilot Pro',
      monthlyAllowance: Number(cfg.monthlyAllowance) || 0,
      requestsPerDay: Number(cfg.requestsPerDay) || 0,
      overagePrice: Number(cfg.overagePrice) || 0,
      baseInputRate: Number(cfg.baseInputRate) || 0,
      baseOutputRate: Number(cfg.baseOutputRate) || 0,
      fixedExecutionOverhead: Number(cfg.fixedExecutionOverhead) || 0,
      defaultInputTokens: Math.max(0, Math.round(Number(cfg.defaultInputTokens) || 0)),
      defaultOutputTokens: Math.max(0, Math.round(Number(cfg.defaultOutputTokens) || 0)),
      modelWeights: cfg.modelWeights && typeof cfg.modelWeights === 'object'
        ? cfg.modelWeights
        : CREDIT_MODEL_WEIGHTS,
    };
  }
  renderCostForecast(currentState || null);
}

function renderCostForecast(analysisState) {
  var body  = document.getElementById('costForecastBody');
  var foot  = document.getElementById('costForecastFooterTotal');
  var badge = document.getElementById('costForecastTotal');
  if (!body || !foot || !badge) { return; }

  var cfg = creditForecastConfig;
  var modelSel = document.getElementById('targetModelSelect');
  var model = (modelSel && modelSel.value) || 'gpt';
  var modelWeights = cfg.modelWeights || CREDIT_MODEL_WEIGHTS;
  var wm = Object.prototype.hasOwnProperty.call(modelWeights, model)
    ? Number(modelWeights[model]) : 1;
  if (!(wm >= 0)) { wm = 1; }
  var modelLabel = CREDIT_MODEL_LABELS[model] || model;

  // Prefer live analyzed tokens; fall back to configured defaults.
  var state = analysisState || (typeof currentState === 'object' ? currentState : null);
  var metrics = state && state.metrics ? state.metrics : null;
  var hasMeasuredIn = metrics && Number(metrics.optimized_input_tokens) > 0;
  var hasMeasuredOut = metrics && Number(metrics.estimated_output_tokens) > 0;
  var tin = metrics && Number(metrics.optimized_input_tokens) > 0
    ? Number(metrics.optimized_input_tokens)
    : cfg.defaultInputTokens;
  var tout = metrics && Number(metrics.estimated_output_tokens) > 0
    ? Number(metrics.estimated_output_tokens)
    : cfg.defaultOutputTokens;

  var rin = Math.max(0, Number(cfg.baseInputRate) || 0);
  var rout = Math.max(0, Number(cfg.baseOutputRate) || 0);
  var fe = Math.max(0, Number(cfg.fixedExecutionOverhead) || 0);

  // Local model is fully included: avoid charging fixed overhead.
  if (model === 'local') { fe = 0; }

  // C = ceil((Tin*Rin*Wm) + (Tout*Rout*Wm) + Fe)
  var perRequestCredits = Math.ceil((tin * rin * wm) + (tout * rout * wm) + fe);

  var allowance      = cfg.monthlyAllowance;
  var requestsPerDay = cfg.requestsPerDay;
  // ~22 working days per month for the projection.
  var requestsPerMonth = Math.round(requestsPerDay * 22);
  var creditsPerMonth  = requestsPerMonth * perRequestCredits;
  var remaining        = Math.max(0, allowance - creditsPerMonth);
  var overageCredits   = Math.max(0, creditsPerMonth - allowance);
  var overageCost      = overageCredits * cfg.overagePrice;

  var formulaLabel = 'C = ceil((Tin*Rin*Wm) + (Tout*Rout*Wm) + Fe)';
  var tokenSourceMeasured = (hasMeasuredIn || hasMeasuredOut);

  function sectionRow(title) {
    return { section: true, title: title };
  }

  var rows = [
    sectionRow('Current Prompt Measurement'),
    {
      label: 'Token source',
      value: tokenSourceMeasured ? 'Using current prompt analysis tokens' : 'Using configured fallback token defaults',
      badge: {
        text: tokenSourceMeasured ? 'Measured' : 'Fallback',
        tone: tokenSourceMeasured ? 'ok' : 'warn'
      }
    },
    { label: 'Target model',                    value: modelLabel + ' (Wm=' + wm + ')' },
    { label: 'Tin / Tout tokens',               value: String(tin) + ' / ' + String(tout) },
    { label: 'Rin / Rout base rates',           value: String(rin) + ' / ' + String(rout) },
    { label: 'Fixed execution (Fe)',            value: String(fe) },
    { label: 'Formula',                         value: formulaLabel },
    { label: 'Current prompt credits (C)',      value: String(perRequestCredits) },
    sectionRow('Projection'),
    { label: 'Plan',                           value: cfg.planLabel },
    { label: 'Included credits / mo',          value: String(allowance) },
    { label: 'Estimated requests / day',       value: String(requestsPerDay) },
    { label: 'Projected requests / mo',        value: String(requestsPerMonth) },
    { label: 'Credits / request (C)',          value: String(perRequestCredits) },
    { label: 'Projected credits / mo',         value: String(creditsPerMonth) },
    { label: 'Remaining included / mo',        value: String(remaining) },
    { label: 'Overage credits / mo',           value: String(overageCredits) },
    { label: 'Overage cost / mo',              value: formatCurrency(overageCost) },
  ];

  while (body.firstChild) { body.removeChild(body.firstChild); }
  rows.forEach(function(row) {
    var tr = document.createElement('tr');
    if (row.section) {
      var tdSection = document.createElement('td');
      tdSection.colSpan = 2;
      tdSection.textContent = row.title;
      tdSection.style.fontWeight = '600';
      tdSection.style.paddingTop = '8px';
      tdSection.style.paddingBottom = '4px';
      tdSection.style.borderTop = '1px solid rgba(127,127,127,0.2)';
      tdSection.style.color = 'var(--vscode-foreground)';
      tr.appendChild(tdSection);
      body.appendChild(tr);
      return;
    }
    var tdLabel = document.createElement('td'); tdLabel.textContent = row.label;
    var tdValue = document.createElement('td');
    if (row.badge) {
      var valueBadge = document.createElement('span');
      valueBadge.textContent = row.badge.text;
      valueBadge.style.display = 'inline-block';
      valueBadge.style.fontSize = '11px';
      valueBadge.style.fontWeight = '600';
      valueBadge.style.padding = '1px 8px';
      valueBadge.style.marginRight = '8px';
      valueBadge.style.borderRadius = '999px';
      valueBadge.style.border = '1px solid ' + (row.badge.tone === 'ok'
        ? 'var(--vscode-testing-iconPassed, var(--vscode-charts-green, rgba(46, 160, 67, 0.8)))'
        : 'var(--vscode-testing-iconFailed, var(--vscode-charts-yellow, rgba(191, 135, 0, 0.8)))');
      valueBadge.style.color = (row.badge.tone === 'ok'
        ? 'var(--vscode-testing-iconPassed, var(--vscode-charts-green, #2ea043))'
        : 'var(--vscode-testing-iconFailed, var(--vscode-charts-yellow, #bf8700))');
      tdValue.appendChild(valueBadge);

      var valueText = document.createElement('span');
      valueText.textContent = row.value;
      tdValue.appendChild(valueText);
    } else {
      tdValue.textContent = row.value;
    }
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
