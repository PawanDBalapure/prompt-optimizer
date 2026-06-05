(function () {
  const vscode = acquireVsCodeApi();
  var customPersonas = [];
  var rules = [];
  var aiSuggestion = null;
  var replaySessions = [];
  var replayActiveSessionId = null;
  var replayStepIndex = 0;
  var ruleModel = (typeof globalThis !== 'undefined' && globalThis.InstructionStudioRuleModel)
    ? globalThis.InstructionStudioRuleModel
    : null;
  var fallbackRuleText = 'Always run unit tests before completing changes.';

  function normalizeRules(nextRules) {
    if (ruleModel && typeof ruleModel.normalizeRuleItems === 'function') {
      return ruleModel.normalizeRuleItems(nextRules, fallbackRuleText);
    }
    var rows = Array.isArray(nextRules)
      ? nextRules.map(function (x) {
          if (x && typeof x === 'object') {
            return {
              text: String(x.text || x.label || '').trim(),
              enabled: x.enabled !== false && x.active !== false,
            };
          }
          return { text: String(x || '').trim(), enabled: true };
        }).filter(function (x) { return x.text.length > 0; })
      : [];
    if (rows.length === 0) {
      rows = [{ text: fallbackRuleText, enabled: true }];
    }
    return rows;
  }

  function toGraphRuleSpecs(nextRules) {
    if (ruleModel && typeof ruleModel.toGraphRuleSpecs === 'function') {
      return ruleModel.toGraphRuleSpecs(nextRules, fallbackRuleText);
    }
    return normalizeRules(nextRules).map(function (r) {
      return { text: r.text, active: r.enabled !== false };
    });
  }

  function ensureRuleFallback() {
    rules = normalizeRules(rules);
  }

  function setRules(nextRules) {
    rules = normalizeRules(nextRules);
    renderRules();
  }

  function renderRules() {
    var host = document.getElementById('ruleList');
    if (!host) { return; }
    ensureRuleFallback();
    host.innerHTML = '';
    rules.forEach(function (rule, index) {
      var row = document.createElement('div');
      row.className = 'rule-row';
      row.draggable = true;
      row.dataset.ruleIndex = String(index);
      row.addEventListener('dragstart', function (event) {
        if (!event.dataTransfer) { return; }
        event.dataTransfer.setData('text/plain', String(index));
      });
      row.addEventListener('dragover', function (event) {
        event.preventDefault();
      });
      row.addEventListener('drop', function (event) {
        event.preventDefault();
        if (!event.dataTransfer) { return; }
        var src = Number(event.dataTransfer.getData('text/plain'));
        var dst = index;
        if (!Number.isFinite(src) || src === dst || src < 0 || src >= rules.length) { return; }
        var moved = rules.splice(src, 1)[0];
        rules.splice(dst, 0, moved);
        renderRules();
      });
      if (rule.enabled === false) {
        row.classList.add('disabled');
      }

      var toggleWrap = document.createElement('label');
      toggleWrap.className = 'rule-toggle';
      var toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = rule.enabled !== false;
      toggle.title = 'Enable or disable this rule for compile/conflict checks';
      toggle.addEventListener('change', function () {
        rules[index].enabled = toggle.checked;
        renderRules();
      });
      var toggleText = document.createElement('span');
      toggleText.textContent = toggle.checked ? 'On' : 'Off';
      toggleWrap.appendChild(toggle);
      toggleWrap.appendChild(toggleText);

      var input = document.createElement('input');
      input.type = 'text';
      input.value = rule.text;
      input.placeholder = 'Rule text';
      input.addEventListener('input', function () {
        rules[index].text = String(input.value || '').trim();
      });

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.disabled = rules.length <= 1;
      remove.addEventListener('click', function () {
        if (rules.length <= 1) { return; }
        rules.splice(index, 1);
        renderRules();
      });

      row.appendChild(toggleWrap);
      row.appendChild(input);
      row.appendChild(remove);
      host.appendChild(row);
    });
  }

  function setValue(id, nextValue) {
    var el = document.getElementById(id);
    if (!el) { return; }
    el.value = nextValue;
  }

  var allPresets = [];
  var appliedPresets = {};

  function applyPreset(preset, btn) {
    if (document.querySelector('.vscode-layout')) {
      if (btn && appliedPresets[preset.id]) {
        var existingRid = appliedPresets[preset.id];
        vNodes = vNodes.filter(function(n) { return n.id !== existingRid; });
        vEdges = vEdges.filter(function(e) { return e.to !== existingRid && e.from !== existingRid; });
        delete appliedPresets[preset.id];
        btn.classList.remove('selected');
        renderVCanvas();
      } else {
        var rid = 'v_' + Math.random().toString(36).slice(2, 8);
        var baseConditionNode = vNodes.find(function(n) { return n.type === 'condition'; });
        vNodes.push({ id: rid, type: 'rule', text: preset.ruleText || 'Rule text...', x: 450, y: 50 + (Object.keys(appliedPresets).length * 60) });
        if (baseConditionNode) {
          vEdges.push({ from: baseConditionNode.id, to: rid });
        }
        if (btn) {
          appliedPresets[preset.id] = rid;
          btn.classList.add('selected');
        }
        renderVCanvas();
      }
    } else {
      setValue('workflowName', preset.workflowName || 'Instruction Studio Starter');
      setValue('personaLabel', preset.persona || 'Architect');
      setValue('conditionLabel', preset.condition || 'If Task=Refactor');
      setValue('priorityLabel', preset.priority || 'Medium');
      setValue('agentScopeLabel', preset.agentScope || 'Code Generation');
      setRules([preset.ruleText || 'Always run unit tests before completing changes.']);
    }
  }

  function renderPresets(presets, append) {
    var host = document.getElementById('presetList');
    if (!host) { return; }
    
    if (append && Array.isArray(presets)) {
      allPresets = allPresets.concat(presets);
    } else if (Array.isArray(presets)) {
      allPresets = presets;
    }
    
    host.innerHTML = '';
    if (allPresets.length === 0) {
      host.textContent = 'No presets available.';
      return;
    }
    allPresets.forEach(function (preset) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-chip';
      if (appliedPresets[preset.id]) {
        btn.classList.add('selected');
      }
      btn.textContent = (preset.category ? preset.category + ': ' : '') + (preset.label || preset.id || 'Preset');
      btn.addEventListener('click', function () {
        applyPreset(preset, btn);
      });
      host.appendChild(btn);
    });
  }

  function renderCustomPersonas(personas) {
    customPersonas = Array.isArray(personas) ? personas.slice() : [];
    var select = document.getElementById('customPersonaSelect');
    if (!select) { return; }
    select.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = customPersonas.length > 0 ? 'Select a saved persona' : 'No saved personas';
    select.appendChild(placeholder);
    customPersonas.forEach(function (persona) {
      var option = document.createElement('option');
      option.value = persona.id || '';
      option.textContent = persona.label || persona.id || 'Custom Persona';
      select.appendChild(option);
    });
    select.onchange = function () {
      var selectedId = select.value;
      if (!selectedId) { return; }
      var selected = customPersonas.find(function (p) { return p.id === selectedId; });
      if (selected) {
        applyPreset(selected);
      }
    };
  }

  function renderTrace(rows) {
    var host = document.getElementById('traceList');
    if (!host) { return; }
    host.innerHTML = '';
    if (!Array.isArray(rows) || rows.length === 0) {
      host.textContent = 'No compile events yet.';
      return;
    }
    rows.forEach(function (row) {
      var item = document.createElement('div');
      item.className = 'trace-item';
      var title = document.createElement('strong');
      title.textContent = row.workflowName + ' · ' + row.persona + ' · v' + row.versionIndex;
      var meta = document.createElement('small');
      meta.textContent = row.timestamp + ' · ' + row.condition + ' · ' + row.priority + ' · ' + row.agentScope;
      var body = document.createElement('div');
      body.textContent = row.ruleText || '';
      var stats = document.createElement('small');
      stats.className = 'trace-rule-state';
      var active = Number(row.activeRuleCount || 0);
      var inactive = Number(row.inactiveRuleCount || 0);
      stats.textContent = 'Rules: ' + active + ' active / ' + inactive + ' disabled';
      item.appendChild(title);
      item.appendChild(meta);
      item.appendChild(body);
      item.appendChild(stats);
      host.appendChild(item);
    });
  }

  function renderTraceAnalytics(analytics) {
    var host = document.getElementById('traceAnalytics');
    if (!host) { return; }
    host.innerHTML = '';
    if (!analytics || typeof analytics !== 'object') {
      host.textContent = '';
      return;
    }
    var rows = [
      'Compiles: ' + String(analytics.compileCount || 0),
      'Top persona: ' + (analytics.topPersona ? (analytics.topPersona.name + ' (' + analytics.topPersona.count + ')') : 'n/a'),
      'Top rule prefix: ' + (analytics.topRulePrefix ? (analytics.topRulePrefix.prefix + ' (' + analytics.topRulePrefix.count + ')') : 'n/a'),
    ];
    rows.forEach(function (txt) {
      var pill = document.createElement('div');
      pill.className = 'trace-pill';
      pill.textContent = txt;
      host.appendChild(pill);
    });
  }

  function renderInsights(insights) {
    var host = document.getElementById('insightsPanel');
    if (!host) { return; }
    host.innerHTML = '';
    if (!insights || typeof insights !== 'object') {
      host.textContent = 'No insights yet. Compile a graph to generate dashboard data.';
      return;
    }
    var lines = [
      'Compiles: ' + String(insights.compileCount || 0),
      'Rules: ' + String(insights.activeRules || 0) + ' active / ' + String(insights.inactiveRules || 0) + ' disabled',
      'Conflicts: ' + String(insights.conflictingRules || 0),
      'Effectiveness: ' + String((insights.effectiveness && insights.effectiveness.score) || 0) + '%',
    ];
    lines.forEach(function (line) {
      var div = document.createElement('div');
      div.className = 'insight-line';
      div.textContent = line;
      host.appendChild(div);
    });
    var topRules = Array.isArray(insights.mostUsedRules) ? insights.mostUsedRules : [];
    if (topRules.length > 0) {
      var list = document.createElement('ul');
      list.className = 'insight-list';
      topRules.forEach(function (r) {
        var li = document.createElement('li');
        li.textContent = String(r.rule || '') + ' (' + String(r.count || 0) + ')';
        list.appendChild(li);
      });
      host.appendChild(list);
    }
  }

  function renderAiSuggestion() {
    var host = document.getElementById('aiSuggestion');
    if (!host) { return; }
    host.innerHTML = '';
    if (!aiSuggestion) {
      host.textContent = 'No suggestion yet.';
      return;
    }
    if (aiSuggestion.error) {
      host.textContent = String(aiSuggestion.error);
      return;
    }
    var oldText = document.createElement('div');
    oldText.className = 'diff-line old';
    oldText.textContent = '- ' + String(aiSuggestion.original || '');
    var newText = document.createElement('div');
    newText.className = 'diff-line new';
    newText.textContent = '+ ' + String(aiSuggestion.proposed || '');
    var actions = document.createElement('div');
    actions.className = 'actions compact-actions';
    var accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = 'Accept Change';
    accept.addEventListener('click', function () {
      if (vSelectedNode && vSelectedNode.type === 'rule') {
        vSelectedNode.text = String(aiSuggestion.proposed || '').trim();
        updateVInspector();
        renderVCanvas();
      } else if (rules[0]) {
        rules[0].text = String(aiSuggestion.proposed || '').trim();
        renderRules();
      }
      aiSuggestion = null;
      renderAiSuggestion();
    });
    var reject = document.createElement('button');
    reject.type = 'button';
    reject.textContent = 'Reject Change';
    reject.addEventListener('click', function () {
      aiSuggestion = null;
      renderAiSuggestion();
    });
    actions.appendChild(accept);
    actions.appendChild(reject);
    host.appendChild(oldText);
    host.appendChild(newText);
    host.appendChild(actions);
  }

  function renderReplaySelect() {
    var select = document.getElementById('replaySessionSelect');
    if (!select) { return; }
    select.innerHTML = '';
    if (!Array.isArray(replaySessions) || replaySessions.length === 0) {
      var none = document.createElement('option');
      none.value = '';
      none.textContent = 'No replay sessions';
      select.appendChild(none);
      return;
    }
    replaySessions.forEach(function (session) {
      var option = document.createElement('option');
      option.value = session.sessionId || '';
      option.textContent = (session.workflowName || 'Workflow') + ' · ' + (session.timestamp || '');
      if (option.value === replayActiveSessionId) {
        option.selected = true;
      }
      select.appendChild(option);
    });
  }

  function activeReplaySession() {
    if (!Array.isArray(replaySessions)) { return null; }
    return replaySessions.find(function (s) { return s.sessionId === replayActiveSessionId; }) || replaySessions[0] || null;
  }

  function renderReplayStep() {
    var host = document.getElementById('replayStep');
    if (!host) { return; }
    host.innerHTML = '';
    var session = activeReplaySession();
    if (!session || !Array.isArray(session.steps) || session.steps.length === 0) {
      host.textContent = 'No replay steps available.';
      return;
    }
    replayStepIndex = Math.max(0, Math.min(replayStepIndex, session.steps.length - 1));
    var step = session.steps[replayStepIndex];
    var title = document.createElement('strong');
    title.textContent = '[' + String(step.type || 'step').toUpperCase() + '] ' + String(step.title || '');
    var detail = document.createElement('div');
    detail.textContent = String(step.detail || '');
    var meta = document.createElement('small');
    meta.textContent = String(step.timestamp || '') + ' · step ' + String(replayStepIndex + 1) + '/' + String(session.steps.length);
    host.appendChild(title);
    host.appendChild(detail);
    host.appendChild(meta);
  }

  function renderConflicts(conflicts) {
    var host = document.getElementById('conflictWarnings');
    if (!host) { return; }
    host.innerHTML = '';
    if (!Array.isArray(conflicts) || conflicts.length === 0) {
      return;
    }
    conflicts.forEach(function (c) {
      var item = document.createElement('div');
      item.className = 'conflict-item' + (c.severity === 'error' ? ' error' : '');
      item.textContent = '[' + String(c.severity || 'warning').toUpperCase() + '] ' + String(c.message || 'Conflict');
      host.appendChild(item);
    });
  }

  function value(id, fallback) {
    var el = document.getElementById(id);
    if (!el) { return fallback; }
    return String(el.value || fallback).trim() || fallback;
  }

  function buildGraphFromForm() {
    var workflowName = value('workflowName', 'Instruction Studio Starter');
    var persona = value('personaLabel', 'Architect');
    var condition = value('conditionLabel', 'If Task=Refactor');
    var priority = value('priorityLabel', 'Medium');
    var scope = value('agentScopeLabel', 'Code Generation');
    var activeRules = toGraphRuleSpecs(rules);

    var nodes = [
      { id: 'persona-main', type: 'persona', label: persona },
      { id: 'condition-main', type: 'condition', label: condition },
      { id: 'priority-main', type: 'priority', label: priority },
      { id: 'scope-main', type: 'agentScope', label: scope },
    ];
    var edges = [
      { from: 'persona-main', to: 'condition-main' },
      { from: 'condition-main', to: 'priority-main' },
      { from: 'priority-main', to: 'scope-main' },
    ];

    activeRules.forEach(function (rule, idx) {
      var id = 'rule-main-' + (idx + 1);
      nodes.push({ id: id, type: 'rule', text: rule.text, active: rule.active });
      edges.push({ from: 'scope-main', to: id });
    });

    return {
      workflowName: workflowName,
      nodes: nodes,
      edges: edges,
    };
  }

  function send(type, graph) {
    var payload = { type: type };
    if (graph) {
      payload.graph = graph;
    }
    vscode.postMessage(payload);
  }

  function buildPersonaPayloadFromForm() {
    ensureRuleFallback();
    var firstRule = (rules[0] && rules[0].text) || 'Add a custom rule.';
    var label = value('customPersonaLabel', value('personaLabel', 'Custom Persona'));
    return {
      label: label,
      workflowName: value('workflowName', 'Instruction Studio Starter'),
      persona: value('personaLabel', 'Custom Persona'),
      condition: value('conditionLabel', 'Always'),
      priority: value('priorityLabel', 'Medium'),
      agentScope: value('agentScopeLabel', 'Code Generation'),
      ruleText: firstRule,
    };
  }

  document.querySelectorAll('.ribbon-tab[data-action="selectRibbonPersona"]').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.ribbon-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var strongName = String(tab.getAttribute('data-persona') || tab.textContent || '').trim();
      if (document.querySelector('.vscode-layout')) {
        var pNode = vNodes.find(function(n) { return n.type === 'persona'; });
        if (pNode) {
          pNode.text = strongName;
          renderVCanvas();
        }
      }
    });
  });

  document.querySelectorAll('.ribbon-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      const action = btn.getAttribute('data-action');
      if (action === 'ribbonNew') {
        vNodes = [{ id: 'v_1', type: 'persona', text: 'New Persona', x: 20, y: 50 }];
        vEdges = [];
        vSelectedNode = null;
        updateVInspector();
        renderVCanvas();
        return;
      }
      if (action === 'ribbonClone') {
        if (vSelectedNode) {
          var newN = Object.assign({}, vSelectedNode, { id: 'v_' + Math.random().toString(36).slice(2, 8), x: vSelectedNode.x + 20, y: vSelectedNode.y + 20 });
          vNodes.push(newN);
          renderVCanvas();
        }
        return;
      }
      if (action === 'ribbonEdit') {
        var inspect = document.getElementById('vInspectText');
        if (inspect) inspect.focus();
        return;
      }
      if (action === 'ribbonSync') {
        var importUrl = document.getElementById('importUrl');
        var urlValue = importUrl ? String(importUrl.value || '').trim() : '';
        if (urlValue) {
          vscode.postMessage({ type: 'fetchRulesFromUrl', url: urlValue });
        } else {
          var gitResult = document.getElementById('gitTraceResult');
          if (gitResult) gitResult.textContent = 'Provide URL in External Rules input first.';
        }
        return;
      }
    });
  });

  document.querySelectorAll('button[data-action], select[data-action]').forEach((button) => {
    button.addEventListener('click', (e) => {
      // Avoid triggering for select if it binds via change
      if (button.tagName === 'SELECT') return; 
      const action = button.getAttribute('data-action');
      if (!action) { return; }
      if (action === 'createStarterScaffold' || action === 'compileFormGraph') {
        send(action, buildGraphFromForm());
        return;
      }
      if (action === 'compileCanvasGraph') {
        send('compileFormGraph', buildGraphFromVCanvas());
        return;
      }
      if (action === 'aiImproveRule' || action === 'aiSimplifyRule' || action === 'aiExpandRule' || action === 'aiFindConflicts' || action === 'aiFindDuplicates') {
        var mode = action === 'aiImproveRule'
          ? 'improve'
          : action === 'aiSimplifyRule'
            ? 'simplify'
            : action === 'aiExpandRule'
              ? 'expand'
              : action === 'aiFindConflicts'
                ? 'find-conflicts'
                : 'find-duplicates';
        var targetText = '';
        if (vSelectedNode && vSelectedNode.type === 'rule') {
          targetText = vSelectedNode.text;
        } else if (rules[0]) {
          targetText = rules[0].text;
        }
        vscode.postMessage({ type: 'aiRefineRule', mode: mode, text: targetText });
        return;
      }
      if (action === 'aiGeneratePersona') {
        vscode.postMessage({ type: 'aiGeneratePersona' });
        return;
      }
      if (action === 'loadReplay') {
        var replaySelect = document.getElementById('replaySessionSelect');
        var sid = replaySelect ? String(replaySelect.value || '').trim() : '';
        vscode.postMessage({ type: 'loadReplay', sessionId: sid || undefined });
        return;
      }
      if (action === 'replayPrev' || action === 'replayNext') {
        var session = activeReplaySession();
        if (!session || !Array.isArray(session.steps) || session.steps.length === 0) { return; }
        replayStepIndex += action === 'replayPrev' ? -1 : 1;
        replayStepIndex = Math.max(0, Math.min(replayStepIndex, session.steps.length - 1));
        renderReplayStep();
        return;
      }
      if (action === 'stageTraceFull' || action === 'stageTraceSummary' || action === 'stageTraceExclude') {
        var traceMode = action === 'stageTraceFull' ? 'full' : action === 'stageTraceSummary' ? 'summary' : 'exclude';
        vscode.postMessage({ type: 'stageTrace', traceMode: traceMode });
        return;
      }
      if (action === 'saveCustomPersona') {
        var payload = { type: action, persona: buildPersonaPayloadFromForm() };
        vscode.postMessage(payload);
        return;
      }
      if (action === 'deleteCustomPersona') {
        var select = document.getElementById('customPersonaSelect');
        var selectedId = select ? String(select.value || '').trim() : '';
        if (!selectedId) { return; }
        vscode.postMessage({ type: action, id: selectedId });
        return;
      }
      if (action === 'fetchRulesFromUrl') {
        var importUrl = document.getElementById('importUrl');
        var urlValue = importUrl ? String(importUrl.value || '').trim() : '';
        if (urlValue) {
          vscode.postMessage({ type: 'fetchRulesFromUrl', url: urlValue });
        }
        return;
      }
      send(action);
    });
  });

  var popRepoSelect = document.getElementById('popularRepos');
  if (popRepoSelect) {
    popRepoSelect.addEventListener('change', function(e) {
       var val = e.target.value;
       if (val) {
         vscode.postMessage({ type: 'loadPopularRepo', repo: val });
       }
    });
  }

  var presetSearch = document.getElementById('presetSearch');
  if (presetSearch) {
    presetSearch.addEventListener('input', function(e) {
      var query = (e.target.value || '').toLowerCase();
      document.querySelectorAll('.preset-chip').forEach(function(chip) {
        var match = chip.textContent.toLowerCase().includes(query);
        chip.style.display = match ? '' : 'none';
      });
    });
  }

  var addRuleBtn = document.getElementById('addRuleBtn');
  if (addRuleBtn) {
    addRuleBtn.addEventListener('click', function () {
      rules.push({ text: 'Add a rule...', enabled: true });
      renderRules();
    });
  }

  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type === 'presets') {
      renderPresets(data.presets || [], data.append === true);
    }
    if (data.type === 'customPersonas') {
      renderCustomPersonas(data.personas || []);
    }
    if (data.type === 'traceRows') {
      renderTrace(data.rows || []);
    }
    if (data.type === 'traceAnalytics') {
      renderTraceAnalytics(data.analytics || null);
    }
    if (data.type === 'conflicts') {
      renderConflicts(data.conflicts || []);
    }
    if (data.type === 'insights') {
      renderInsights(data.insights || null);
    }
    if (data.type === 'replay') {
      replaySessions = Array.isArray(data.sessions) ? data.sessions : [];
      replayActiveSessionId = data.activeSessionId || (replaySessions[0] && replaySessions[0].sessionId) || null;
      replayStepIndex = 0;
      renderReplaySelect();
      renderReplayStep();
    }
    if (data.type === 'aiSuggestion') {
      aiSuggestion = data.suggestion || { error: data.error || '' };
      renderAiSuggestion();
    }
    if (data.type === 'personaSuggestion' && data.suggestion) {
      applyPreset(data.suggestion);
    }
    if (data.type === 'gitTraceResult') {
      var gitResult = document.getElementById('gitTraceResult');
      if (gitResult) {
        gitResult.textContent = String(data.message || '');
      }
    }
  });

  // --- VCanvas Engine ---
  var vNodes = [
    { id: 'v_1', type: 'persona', text: 'Architect', priority: 'High', x: 20, y: 50 },
    { id: 'v_2', type: 'condition', text: 'If Task=Refactor', priority: 'Medium', x: 250, y: 50 },
    { id: 'v_3', type: 'rule', text: 'Always run unit tests.', priority: 'Medium', x: 500, y: 50 }
  ];
  var vEdges = [{ from: 'v_1', to: 'v_2' }, { from: 'v_2', to: 'v_3' }];
  var vPan = { x: 0, y: 0, scale: 1 };
  var vSelectedNode = null;
  var vDraggingNode = null;
  var vDragStartX = 0, vDragStartY = 0, vOrigX = 0, vOrigY = 0;
  var vIsPanning = false, vPanStartX = 0, vPanStartY = 0;
  var vIsLinking = false, vLinkFrom = null;
  var vSelectedEdge = null;
  var vCanvasNoticeTimer = null;

  function setCanvasNotice(message, kind) {
    var host = document.getElementById('vCanvasNotice');
    if (!host) { return; }
    if (vCanvasNoticeTimer) {
      clearTimeout(vCanvasNoticeTimer);
      vCanvasNoticeTimer = null;
    }
    host.textContent = String(message || '').trim();
    host.classList.remove('error');
    host.classList.remove('ok');
    if (kind === 'error') {
      host.classList.add('error');
    } else if (kind === 'ok') {
      host.classList.add('ok');
    }
    if (host.textContent) {
      vCanvasNoticeTimer = setTimeout(function () {
        host.textContent = '';
        host.classList.remove('error');
        host.classList.remove('ok');
        vCanvasNoticeTimer = null;
      }, 2200);
    }
  }

  function linkValidationMessage(fromId, toId) {
    if (!fromId) { return 'Start from an output edge.'; }
    if (!toId) { return 'Drop onto a target node or input edge.'; }
    if (fromId === toId) { return 'Cannot connect a node to itself.'; }
    var fromNode = vNodes.find(function (n) { return n.id === fromId; });
    var toNode = vNodes.find(function (n) { return n.id === toId; });
    if (!fromNode || !toNode) { return 'Invalid source or target node.'; }
    if (fromNode.type === 'rule') { return 'Rule nodes cannot have outgoing links.'; }
    if (createsDirectedCycle(fromId, toId)) { return 'Cyclical link is not allowed.'; }
    var conflictMessage = detectConflictingRulesForProposedLink(fromId, toId);
    if (conflictMessage) { return conflictMessage; }
    var duplicate = vEdges.some(function (e) { return e.from === fromId && e.to === toId; });
    if (duplicate) { return 'This connection already exists.'; }
    return '';
  }

  function canLinkNodes(fromId, toId) {
    return linkValidationMessage(fromId, toId) === '';
  }

  function ensureNodeDefaults(node) {
    if (!node || typeof node !== 'object') { return; }
    if (!node.priority) {
      node.priority = 'Medium';
    }
  }

  function createsDirectedCycle(fromId, toId) {
    if (!fromId || !toId) { return false; }
    var adjacency = {};
    vEdges.concat([{ from: fromId, to: toId }]).forEach(function (edge) {
      if (!adjacency[edge.from]) {
        adjacency[edge.from] = [];
      }
      adjacency[edge.from].push(edge.to);
    });
    var seen = {};
    var stack = [toId];
    while (stack.length > 0) {
      var current = stack.pop();
      if (current === fromId) {
        return true;
      }
      if (seen[current]) { continue; }
      seen[current] = true;
      (adjacency[current] || []).forEach(function (nextId) {
        if (!seen[nextId]) {
          stack.push(nextId);
        }
      });
    }
    return false;
  }

  function tokenizeRuleText(text) {
    var stop = {
      the: true, and: true, or: true, then: true, with: true, from: true, into: true,
      this: true, that: true, must: true, should: true, always: true, never: true,
      not: true, do: true, dont: true, shouldnt: true, mustnt: true, ensure: true,
      rule: true, use: true
    };
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(function (w) { return w && !stop[w] && w.length > 2; });
  }

  function rulePolarity(text) {
    var src = String(text || '').toLowerCase();
    if (/\b(never|must not|do not|don't|should not|cannot|can't)\b/.test(src)) {
      return 'negative';
    }
    if (/\b(always|must|should|required|ensure)\b/.test(src)) {
      return 'positive';
    }
    return 'neutral';
  }

  function detectConflictingRulesForProposedLink(fromId, toId) {
    var testEdges = vEdges.concat([{ from: fromId, to: toId }]);
    var queue = [fromId, toId];
    var seen = {};
    var connected = {};

    while (queue.length > 0) {
      var current = queue.shift();
      if (!current || seen[current]) { continue; }
      seen[current] = true;
      connected[current] = true;
      testEdges.forEach(function (edge) {
        if (edge.from === current && !seen[edge.to]) {
          queue.push(edge.to);
        }
        if (edge.to === current && !seen[edge.from]) {
          queue.push(edge.from);
        }
      });
    }

    var candidateRules = vNodes.filter(function (n) {
      return connected[n.id] && n.type === 'rule' && String(n.text || '').trim().length > 0;
    });

    for (var i = 0; i < candidateRules.length; i += 1) {
      for (var j = i + 1; j < candidateRules.length; j += 1) {
        var a = candidateRules[i];
        var b = candidateRules[j];
        var aPol = rulePolarity(a.text);
        var bPol = rulePolarity(b.text);
        if (aPol === 'neutral' || bPol === 'neutral' || aPol === bPol) {
          continue;
        }
        var aTokens = tokenizeRuleText(a.text);
        var bTokenSet = {};
        tokenizeRuleText(b.text).forEach(function (token) { bTokenSet[token] = true; });
        var overlap = aTokens.filter(function (token) { return !!bTokenSet[token]; });
        if (overlap.length >= 2) {
          return 'Conflicting rules detected in this flow.';
        }
      }
    }
    return '';
  }

  function selectedEdgeText(edge) {
    if (!edge) {
      return 'No link selected.';
    }
    return 'Selected link: ' + String(edge.from || '') + ' → ' + String(edge.to || '');
  }

  function updateSelectedLinkInspector() {
    var host = document.getElementById('vSelectedLinkText');
    var button = document.getElementById('vBtnDeleteLink');
    if (!host || !button) { return; }
    host.textContent = selectedEdgeText(vSelectedEdge);
    button.disabled = !vSelectedEdge;
  }

  function setSelectedEdge(nextEdge) {
    vSelectedEdge = nextEdge ? { from: nextEdge.from, to: nextEdge.to } : null;
    if (vSelectedEdge) {
      vSelectedNode = null;
      var nodePanel = document.getElementById('vCanvasInspector');
      if (nodePanel) {
        nodePanel.classList.remove('hidden');
      }
    }
    updateVInspector();
    updateSelectedLinkInspector();
    renderVCanvas();
  }

  function renderVCanvas() {
    var viewport = document.getElementById('vNodesLayer');
    if (!viewport) return;
    viewport.style.transform = 'translate(' + vPan.x + 'px, ' + vPan.y + 'px) scale(' + vPan.scale + ')';

    viewport.innerHTML = '';
    vNodes.forEach(function (n) {
      ensureNodeDefaults(n);
      var el = document.createElement('div');
      el.className = 'vcanvas-node ' + (vSelectedNode && vSelectedNode.id === n.id ? 'selected' : '');
      el.dataset.nodeid = n.id;
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';

      if (n.type !== 'persona') {
        var inPort = document.createElement('div');
        inPort.className = 'vcanvas-port in';
        inPort.dataset.node = n.id;
        el.appendChild(inPort);
      }
      if (n.type !== 'rule') {
        var outPort = document.createElement('div');
        outPort.className = 'vcanvas-port out';
        outPort.dataset.node = n.id;
        el.appendChild(outPort);
      }

      var content = document.createElement('div');
      content.className = 'vcanvas-node-content';
      content.textContent = n.text || n.type;
      el.appendChild(content);

      el.addEventListener('mousedown', function (e) {
        if (e.target.classList.contains('vcanvas-port')) return;
        vSelectedNode = n;
        vSelectedEdge = null;
        vDraggingNode = n;
        vDragStartX = e.clientX; vDragStartY = e.clientY;
        vOrigX = n.x; vOrigY = n.y;
        updateVInspector();
        updateSelectedLinkInspector();
        renderVCanvas();
        e.stopPropagation();
      });

      viewport.appendChild(el);
    });

    // Update dynamic node geometry before drawing edges
    setTimeout(function() {
      var elements = document.querySelectorAll('.vcanvas-node');
      elements.forEach(function(el) {
        var id = el.dataset.nodeid;
        var n = vNodes.find(function(x) { return x.id === id; });
        if (n) {
          n.w = el.offsetWidth;
          n.h = el.offsetHeight;
        }
      });
      drawVEdges(0,0);
    }, 0);
  }

  function drawVEdges(mouseX, mouseY) {
    var svg = document.getElementById('vEdgesLayer');
    if (!svg) return;
    var html = '';
    vEdges.forEach(function(e, index) {
      var fromN = vNodes.find(function(x) { return x.id === e.from; });
      var toN = vNodes.find(function(x) { return x.id === e.to; });
      if (fromN && toN) {
        var fromW = fromN.w || 100;
        var fromH = fromN.h || 30;
        var toH = toN.h || 30;
        var x1 = (fromN.x + fromW) * vPan.scale + vPan.x;
        var y1 = (fromN.y + fromH / 2) * vPan.scale + vPan.y;
        var x2 = toN.x * vPan.scale + vPan.x;
        var y2 = (toN.y + toH / 2) * vPan.scale + vPan.y;
        var isSelected = vSelectedEdge && vSelectedEdge.from === e.from && vSelectedEdge.to === e.to;
        html += '<path data-edge-index="' + index + '" class="vcanvas-edge' + (isSelected ? ' selected' : '') + '" marker-end="url(#arrow)" d="M ' + x1 + ' ' + y1 + ' C ' + (x1+40) + ' ' + y1 + ', ' + (x2-40) + ' ' + y2 + ', ' + x2 + ' ' + y2 + '" />';
      }
    });
    if (vIsLinking && vLinkFrom) {
      var fromN = vNodes.find(function(x) { return x.id === vLinkFrom; });
      if (fromN) {
        var fromW = fromN.w || 100;
        var fromH = fromN.h || 30;
        var x1 = (fromN.x + fromW) * vPan.scale + vPan.x;
        var y1 = (fromN.y + fromH / 2) * vPan.scale + vPan.y;
        html += '<path class="vcanvas-edge drawing" marker-end="url(#arrow)" d="M ' + x1 + ' ' + y1 + ' C ' + (x1+40) + ' ' + y1 + ', ' + (mouseX-40) + ' ' + mouseY + ', ' + mouseX + ' ' + mouseY + '" />';
      }
    }
    svg.innerHTML = html;
    svg.querySelectorAll('.vcanvas-edge').forEach(function (path) {
      path.addEventListener('click', function (event) {
        event.stopPropagation();
        var idx = Number(path.getAttribute('data-edge-index'));
        if (!Number.isFinite(idx) || !vEdges[idx]) { return; }
        setSelectedEdge(vEdges[idx]);
      });
    });
  }

  function setupVCanvas() {
    var container = document.getElementById('vCanvasContainer');
    if (!container) return;

    container.addEventListener('mousedown', function(e) {
      if (e.target && e.target.closest && e.target.closest('.vcanvas-edge')) {
        return;
      }
      if (e.target.classList.contains('out')) {
        vIsLinking = true;
        vLinkFrom = e.target.dataset.node;
        setCanvasNotice('Linking: release on a destination node.', 'ok');
        e.stopPropagation();
        return;
      }
      if (e.target.closest('.vcanvas-node')) return;
      vSelectedNode = null;
      updateVInspector();
      vIsPanning = true;
      vPanStartX = e.clientX - vPan.x;
      vPanStartY = e.clientY - vPan.y;
      renderVCanvas();
    });

    container.addEventListener('mousemove', function(e) {
      if (vIsPanning) {
        vPan.x = e.clientX - vPanStartX;
        vPan.y = e.clientY - vPanStartY;
        renderVCanvas();
      } else if (vDraggingNode) {
        var dx = (e.clientX - vDragStartX) / vPan.scale;
        var dy = (e.clientY - vDragStartY) / vPan.scale;
        vDraggingNode.x = vOrigX + dx;
        vDraggingNode.y = vOrigY + dy;
        renderVCanvas();
      } else if (vIsLinking) {
        var rect = container.getBoundingClientRect();
        drawVEdges(e.clientX - rect.left, e.clientY - rect.top);
      }
    });

    container.addEventListener('mouseup', function(e) {
      if (vIsLinking) {
        var targetPort = e.target && e.target.closest ? e.target.closest('.vcanvas-port.in') : null;
        var targetNodeEl = e.target && e.target.closest ? e.target.closest('.vcanvas-node') : null;
        var toNode = '';
        if (targetPort && targetPort.dataset) {
          toNode = String(targetPort.dataset.node || '').trim();
        } else if (targetNodeEl && targetNodeEl.dataset) {
          toNode = String(targetNodeEl.dataset.nodeid || '').trim();
        }
        var invalidReason = linkValidationMessage(vLinkFrom, toNode);
        if (!invalidReason) {
          vEdges.push({ from: vLinkFrom, to: toNode });
          setSelectedEdge({ from: vLinkFrom, to: toNode });
          renderConflicts([]);
          setCanvasNotice('Connection created.', 'ok');
        } else {
          if (invalidReason.indexOf('Conflicting rules') === 0) {
            renderConflicts([{ severity: 'error', message: invalidReason }]);
          }
          setCanvasNotice(invalidReason, 'error');
        }
      }
      vIsPanning = false;
      vDraggingNode = null;
      vIsLinking = false;
      vLinkFrom = null;
      renderVCanvas();
    });

    container.addEventListener('wheel', function(e) {
      e.preventDefault();
      var z = e.deltaY > 0 ? 0.9 : 1.1;
      vPan.scale = Math.max(0.2, Math.min(vPan.scale * z, 3));
      renderVCanvas();
    });

    var btnAddPersona = document.getElementById('vBtnAddPersona');
    if (btnAddPersona) btnAddPersona.addEventListener('click', function() { addVNode('persona', 'New Persona'); });
    var btnAddCond = document.getElementById('vBtnAddCond');
    if (btnAddCond) btnAddCond.addEventListener('click', function() { addVNode('condition', 'If ...'); });
    var btnAddRule = document.getElementById('vBtnAddRule');
    if (btnAddRule) btnAddRule.addEventListener('click', function() { addVNode('rule', 'New Rule'); });

    var btnDelNode = document.getElementById('vBtnDeleteNode');
    if (btnDelNode) btnDelNode.addEventListener('click', function() {
      if (vSelectedNode) {
        vNodes = vNodes.filter(function(n) { return n.id !== vSelectedNode.id; });
        vEdges = vEdges.filter(function(e) { return e.from !== vSelectedNode.id && e.to !== vSelectedNode.id; });
        vSelectedNode = null;
        vSelectedEdge = null;
        updateVInspector();
        updateSelectedLinkInspector();
        renderVCanvas();
      }
    });

    var btnDelLink = document.getElementById('vBtnDeleteLink');
    if (btnDelLink) btnDelLink.addEventListener('click', function () {
      if (!vSelectedEdge) { return; }
      vEdges = vEdges.filter(function (edge) {
        return !(edge.from === vSelectedEdge.from && edge.to === vSelectedEdge.to);
      });
      vSelectedEdge = null;
      updateSelectedLinkInspector();
      renderVCanvas();
      setCanvasNotice('Link removed.', 'ok');
    });

    var inputInspectText = document.getElementById('vInspectText');
    if (inputInspectText) inputInspectText.addEventListener('input', function() {
      if (vSelectedNode) {
        vSelectedNode.text = inputInspectText.value;
        renderVCanvas();
      }
    });

    var inputInspectPriority = document.getElementById('vInspectPriority');
    if (inputInspectPriority) inputInspectPriority.addEventListener('change', function() {
      if (vSelectedNode) {
        vSelectedNode.priority = String(inputInspectPriority.value || 'Medium');
      }
    });

    renderVCanvas();
  }

  function setupBottomPanelToggle() {
    var panel = document.getElementById('bottomWorkbenchPanel');
    var toggle = document.getElementById('panelCollapseToggle');
    var panelSplitter = document.getElementById('panelSplitter');
    if (!panel || !toggle) { return; }

    var setCollapsed = function (collapsed) {
      panel.classList.toggle('collapsed', collapsed);
      if (panelSplitter) {
        panelSplitter.classList.toggle('disabled', collapsed);
      }
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.setAttribute('title', collapsed ? 'Expand panel' : 'Collapse panel');
      toggle.textContent = collapsed ? '▸' : '▾';
    };

    toggle.addEventListener('click', function () {
      setCollapsed(!panel.classList.contains('collapsed'));
    });
    setCollapsed(false);
  }

  function setupResizableLayout() {
    var layout = document.querySelector('.vscode-layout');
    var sidebar = document.querySelector('.vscode-sidebar');
    var panel = document.getElementById('bottomWorkbenchPanel');
    var sideSplitter = document.getElementById('sidebarSplitter');
    var panelSplitter = document.getElementById('panelSplitter');
    if (!layout || !sidebar || !panel || !sideSplitter || !panelSplitter) { return; }

    var clamp = function (value, min, max) {
      return Math.max(min, Math.min(value, max));
    };

    var applyLayout = function (sidebarWidth, panelHeight) {
      if (Number.isFinite(sidebarWidth)) {
        layout.style.setProperty('--studio-sidebar-width', String(sidebarWidth) + 'px');
      }
      if (Number.isFinite(panelHeight)) {
        layout.style.setProperty('--studio-panel-height', String(panelHeight) + 'px');
      }
    };

    var saveLayout = function () {
      var current = vscode.getState() || {};
      var sidebarWidth = Math.round(parseFloat(getComputedStyle(sidebar).width));
      var panelHeight = Math.round(parseFloat(getComputedStyle(panel).height));
      current.studioLayout = { sidebarWidth: sidebarWidth, panelHeight: panelHeight };
      vscode.setState(current);
    };

    var saved = vscode.getState();
    if (saved && saved.studioLayout) {
      var sw = Number(saved.studioLayout.sidebarWidth);
      var ph = Number(saved.studioLayout.panelHeight);
      applyLayout(sw, ph);
    }

    if (vSelectedEdge) {
      updateSelectedLinkInspector();
    }

    sideSplitter.addEventListener('mousedown', function (event) {
      event.preventDefault();
      var startX = event.clientX;
      var startWidth = parseFloat(getComputedStyle(sidebar).width) || 280;
      var maxWidth = Math.floor(window.innerWidth * 0.6);
      document.body.classList.add('resizing');

      var onMove = function (moveEvent) {
        var delta = startX - moveEvent.clientX;
        var next = clamp(startWidth + delta, 220, maxWidth);
        applyLayout(next, NaN);
      };
      var onUp = function () {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing');
        saveLayout();
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    panelSplitter.addEventListener('mousedown', function (event) {
      if (panel.classList.contains('collapsed')) { return; }
      event.preventDefault();
      var startY = event.clientY;
      var startHeight = parseFloat(getComputedStyle(panel).height) || 230;
      var maxHeight = Math.floor(window.innerHeight * 0.65);
      document.body.classList.add('resizing');
      document.body.classList.add('horizontal');

      var onMove = function (moveEvent) {
        var delta = startY - moveEvent.clientY;
        var next = clamp(startHeight + delta, 120, maxHeight);
        applyLayout(NaN, next);
      };
      var onUp = function () {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing');
        document.body.classList.remove('horizontal');
        saveLayout();
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  function addVNode(type, text) {
    vNodes.push({
      id: 'v_' + Math.random().toString(36).slice(2, 8),
      type: type,
      text: text,
      priority: 'Medium',
      x: -vPan.x / vPan.scale + 50,
      y: -vPan.y / vPan.scale + 50
    });
    renderVCanvas();
  }

  function updateVInspector() {
    var panel = document.getElementById('vCanvasInspector');
    var textI = document.getElementById('vInspectText');
    var typeI = document.getElementById('vInspectType');
    var priorityI = document.getElementById('vInspectPriority');
    if (!panel || !textI || !typeI || !priorityI) return;
    if (vSelectedNode) {
      ensureNodeDefaults(vSelectedNode);
      panel.classList.remove('hidden');
      textI.value = vSelectedNode.text || '';
      typeI.value = vSelectedNode.type;
      priorityI.value = vSelectedNode.priority || 'Medium';
      textI.disabled = false;
      priorityI.disabled = false;
    } else {
      textI.value = '';
      typeI.value = 'persona';
      priorityI.value = 'Medium';
      textI.disabled = true;
      priorityI.disabled = true;
      panel.classList.toggle('hidden', !vSelectedEdge);
    }
  }

  function buildGraphFromVCanvas() {
    return {
      workflowName: 'Canvas Generated Workflow',
      nodes: vNodes.map(function(n) {
        ensureNodeDefaults(n);
        return { id: n.id, type: n.type, label: n.text, text: n.text, priority: n.priority, active: true };
      }),
      edges: vEdges.map(function(e) {
        return { from: e.from, to: e.to };
      })
    };
  }
  // --- End VCanvas Engine ---

  send('ready');
  ensureRuleFallback();
  renderRules();
  setupVCanvas();
  setupResizableLayout();
  setupBottomPanelToggle();
  updateSelectedLinkInspector();
  renderAiSuggestion();
  renderInsights(null);
  renderReplaySelect();
  renderReplayStep();
})();
