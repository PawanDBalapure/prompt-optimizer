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

  function ensureUndoRedoButtons() {
    var canvasActions = document.querySelector('.canvas-actions.actions');
    if (canvasActions) {
      if (!document.getElementById('vBtnUndo')) {
        var undoCanvas = document.createElement('button');
        undoCanvas.id = 'vBtnUndo';
        undoCanvas.type = 'button';
        undoCanvas.title = 'Undo canvas change';
        undoCanvas.textContent = 'Undo';
        undoCanvas.disabled = true;
        canvasActions.insertBefore(undoCanvas, canvasActions.firstChild);
      }
      if (!document.getElementById('vBtnRedo')) {
        var redoCanvas = document.createElement('button');
        redoCanvas.id = 'vBtnRedo';
        redoCanvas.type = 'button';
        redoCanvas.title = 'Redo canvas change';
        redoCanvas.textContent = 'Redo';
        redoCanvas.disabled = true;
        var anchorCanvas = document.getElementById('vBtnUndo');
        if (anchorCanvas && anchorCanvas.nextSibling) {
          canvasActions.insertBefore(redoCanvas, anchorCanvas.nextSibling);
        } else {
          canvasActions.insertBefore(redoCanvas, canvasActions.firstChild);
        }
      }
    }
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
  var visiblePresets = [];
  var personaRulePresetsById = {};
  var appliedPresets = {};
  var activeRibbonPersona = '';
  var lastRibbonPersonas = [];

  function pruneAppliedPresets() {
    var existing = {};
    vNodes.forEach(function (node) {
      if (node && node.id) {
        existing[node.id] = true;
      }
    });
    Object.keys(appliedPresets).forEach(function (presetId) {
      if (!existing[appliedPresets[presetId]]) {
        delete appliedPresets[presetId];
      }
    });
  }

  function syncPresetSelectionUi() {
    pruneAppliedPresets();
    var host = document.getElementById('presetList');
    if (!host) { return; }
    host.querySelectorAll('.preset-chip[data-preset-id]').forEach(function (chip) {
      var presetId = String(chip.getAttribute('data-preset-id') || '').trim();
      chip.classList.toggle('selected', !!appliedPresets[presetId]);
    });
    host.querySelectorAll('.preset-toggle-btn[data-preset-id]').forEach(function (btn) {
      var presetId = String(btn.getAttribute('data-preset-id') || '').trim();
      var selected = !!appliedPresets[presetId];
      btn.classList.toggle('selected', selected);
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
      btn.setAttribute('title', selected ? 'Remove this rule from canvas' : 'Add this rule to canvas');
      btn.textContent = selected ? 'Deselect' : 'Select';
    });
  }

  function selectedCanvasPersonaMeta() {
    if (!vSelectedNode || vSelectedNode.type !== 'persona') {
      return null;
    }
    var linked = personaFromNode(vSelectedNode);
    if (linked && linked.personaId) {
      return linked;
    }
    var label = String(vSelectedNode.text || '').trim();
    if (!label) {
      return null;
    }
    var byLabel = lastRibbonPersonas.find(function (persona) {
      return String(persona.label || '').trim() === label;
    });
    if (!byLabel) {
      return null;
    }
    return {
      personaId: String(byLabel.id || '').trim(),
      sourceFile: String(byLabel.sourceFile || '').trim(),
      label: String(byLabel.label || byLabel.id || label),
      enabled: byLabel.enabled !== false,
    };
  }

  function selectedAgentPersonaMeta() {
    if (!activeRibbonPersona) {
      var selected = selectedCanvasPersonaMeta();
      if (selected && selected.personaId) {
        return selected;
      }
      return null;
    }
    var byLabel = lastRibbonPersonas.find(function (persona) {
      return String(persona.label || '').trim() === String(activeRibbonPersona || '').trim();
    });
    if (!byLabel) {
      var fallback = selectedCanvasPersonaMeta();
      return (fallback && fallback.personaId) ? fallback : null;
    }
    return {
      personaId: String(byLabel.id || '').trim(),
      sourceFile: String(byLabel.sourceFile || '').trim(),
      label: String(byLabel.label || byLabel.id || activeRibbonPersona),
      enabled: byLabel.enabled !== false,
    };
  }

  function setPresetContextHint(text) {
    var host = document.getElementById('presetContextHint');
    if (!host) { return; }
    host.textContent = text || '';
  }

  function resolvePersonaRuleEntries(meta) {
    if (!meta || !meta.personaId || !lastInstructionsOverview) {
      return { entries: [], sourceLabel: '', fallbackSource: '' };
    }
    var source = sourceForPersona(lastInstructionsOverview, {
      id: meta.personaId,
      sourceFile: meta.sourceFile,
    });
    var entries = [];
    var fallbackSource = '';
    if (source && source.id) {
      entries = (lastInstructionsOverview.units || []).filter(function (unit) {
        return unit.sourceId === source.id && !unit.managed && String(unit.text || '').trim().length > 0;
      }).map(function (unit) {
        return {
          text: unit.text,
          line: unit.line,
          disabled: !!unit.disabled,
          relPath: String(source.relPath || ''),
          source: 'workspace',
        };
      });
    } else {
      var lib = lastInstructionsOverview.personaRuleLibrary || {};
      entries = Array.isArray(lib[meta.personaId]) ? lib[meta.personaId].slice() : [];
      if (entries.length > 0) {
        fallbackSource = String(entries[0].source || 'bundled');
      }
    }
    var sourceLabel = '';
    if (entries.length > 0) {
      if (source && source.relPath) {
        sourceLabel = String(source.relPath);
      } else {
        sourceLabel = String((entries[0] && entries[0].relPath) || (meta.personaId + '.md'));
      }
    }
    return {
      entries: entries,
      sourceLabel: sourceLabel,
      fallbackSource: fallbackSource,
    };
  }

  function computeVisiblePresets() {
    var meta = selectedAgentPersonaMeta();
    if (!meta || !meta.personaId || !lastInstructionsOverview) {
      return {
        presets: [],
        hint: 'Select an agent persona to show rules from its definition file.',
      };
    }
    var resolved = resolvePersonaRuleEntries(meta);
    var entries = resolved.entries;
    var fallbackSource = resolved.fallbackSource;
    if (entries.length === 0) {
      return {
        presets: [],
        hint: 'No rules found in selected persona definition: ' + String(meta.label || meta.personaId) + '.',
      };
    }
    var presets = entries.map(function (unit, index) {
      var ruleText = String(unit.text || '').trim();
      return {
        id: 'agent-source-' + String(meta.personaId || 'persona') + '-rule-' + String(index + 1),
        label: trimRuleLabel(ruleText),
        ruleText: ruleText,
        relPath: String(unit.relPath || ''),
        line: unit.line,
        disabled: !!unit.disabled,
      };
    });
    if (presets.length > 0) {
      var sourceLabel = resolved.sourceLabel;
      var mode = (fallbackSource && fallbackSource !== 'workspace') ? ' (bundled fallback)' : '';
      return {
        presets: presets,
        hint: 'Showing rules from selected agent definition file: ' + sourceLabel + mode + '.',
      };
    }
    return {
      presets: [],
      hint: 'Selected agent definition file has no rules.',
    };
  }

  function refreshPresetLibrary() {
    var result = computeVisiblePresets();
    renderPresets(result.presets);
    setPresetContextHint(result.hint);
  }

  function applyPreset(preset, forceSelected) {
    if (document.querySelector('.vscode-layout')) {
      var isSelected = !!appliedPresets[preset.id];
      var shouldSelect = typeof forceSelected === 'boolean' ? forceSelected : !isSelected;
      if (!shouldSelect && isSelected) {
        var existingRid = appliedPresets[preset.id];
        vNodes = vNodes.filter(function(n) { return n.id !== existingRid; });
        vEdges = vEdges.filter(function(e) { return e.to !== existingRid && e.from !== existingRid; });
        delete appliedPresets[preset.id];
        renderVCanvas();
        recordCanvasHistory();
      } else if (shouldSelect && !isSelected) {
        var rid = 'v_' + Math.random().toString(36).slice(2, 8);
        var baseConditionNode = vNodes.find(function(n) { return n.type === 'condition'; });
        vNodes.push({ id: rid, type: 'rule', text: preset.ruleText || 'Rule text...', priority: 'Medium', x: 450, y: 50 + (Object.keys(appliedPresets).length * 60) });
        if (baseConditionNode) {
          vEdges.push({ from: baseConditionNode.id, to: rid });
        }
        appliedPresets[preset.id] = rid;
        renderVCanvas();
        recordCanvasHistory();
      }
      syncPresetSelectionUi();
    } else {
      setValue('workflowName', preset.workflowName || 'Instruction Studio Starter');
      setValue('personaLabel', preset.persona || 'Architect');
      setValue('conditionLabel', preset.condition || 'If Task=Refactor');
      setValue('priorityLabel', preset.priority || 'Medium');
      setValue('agentScopeLabel', preset.agentScope || 'Code Generation');
      setRules([preset.ruleText || 'Always run unit tests before completing changes.']);
    }
  }

  function renderPresets(presets) {
    var host = document.getElementById('presetList');
    if (!host) { return; }
    visiblePresets = Array.isArray(presets) ? presets.slice() : [];
    host.innerHTML = '';
    if (visiblePresets.length === 0) {
      return;
    }
    visiblePresets.forEach(function (preset) {
      var row = document.createElement('label');
      row.className = 'preset-item';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !preset.disabled;
      cb.addEventListener('change', function () {
        if (!preset.relPath) { return; }
        vscode.postMessage({
          type: 'toggleInstructionRule',
          relPath: preset.relPath,
          line: preset.line,
          ruleText: preset.ruleText,
          enabled: cb.checked,
        });
        // Optimistically update disabled flag so re-render stays in sync
        preset.disabled = !cb.checked;
      });

      var span = document.createElement('span');
      span.className = 'preset-rule-text';
      span.textContent = preset.label || preset.ruleText || '';

      row.appendChild(cb);
      row.appendChild(span);
      host.appendChild(row);
    });
    applyPresetSearchFilter();
  }

  function applyPresetSearchFilter() {
    var search = document.getElementById('presetSearch');
    var query = search ? String(search.value || '').toLowerCase() : '';
    document.querySelectorAll('.preset-item').forEach(function (row) {
      var span = row.querySelector('.preset-rule-text');
      var text = span ? String(span.textContent || '').toLowerCase() : '';
      row.style.display = text.includes(query) ? '' : 'none';
    });
  }

  function normalizePresetSource(presets, append) {
    if (append && Array.isArray(presets)) {
      allPresets = allPresets.concat(presets);
    } else if (Array.isArray(presets)) {
      allPresets = presets.slice();
    }
    refreshPresetLibrary();
  }

  function trimRuleLabel(text) {
    var src = String(text || '').trim().replace(/\s+/g, ' ');
    if (src.length <= 56) { return src; }
    return src.slice(0, 56).trim() + '...';
  }

  function sourceForPersona(overview, persona) {
    if (!overview || !persona) { return null; }
    var personaId = String(persona.id || '').trim();
    var sourceFile = String(persona.sourceFile || '').trim();
    var expected = '.promptoptimizer/skills/' + personaId + '.md';
    var sources = Array.isArray(overview.sources) ? overview.sources : [];
    return sources.find(function (src) {
      var relPath = String(src.relPath || '').replace(/\\/g, '/').toLowerCase();
      if (relPath === expected.toLowerCase()) { return true; }
      if (sourceFile && relPath.endsWith('/' + sourceFile.toLowerCase())) { return true; }
      return false;
    }) || null;
  }

  function buildPersonaPresetIndex(overview) {
    personaRulePresetsById = {};
    if (!overview || !Array.isArray(overview.personas) || !Array.isArray(overview.units)) {
      return;
    }
    overview.personas.forEach(function (persona) {
      var personaId = String(persona.id || '').trim();
      if (!personaId) { return; }
      var source = sourceForPersona(overview, persona);
      if (!source || !source.id) {
        personaRulePresetsById[personaId] = [];
        return;
      }
      var entries = overview.units.filter(function (unit) {
        return unit.sourceId === source.id && !unit.managed && !unit.disabled && String(unit.text || '').trim().length > 0;
      });
      personaRulePresetsById[personaId] = entries.map(function (unit, index) {
        var ruleText = String(unit.text || '').trim();
        return {
          id: 'persona-' + personaId + '-rule-' + String(index + 1),
          category: 'Persona',
          label: trimRuleLabel(ruleText),
          workflowName: 'Instruction Studio Starter',
          persona: String(persona.label || personaId),
          condition: 'Always',
          priority: 'Medium',
          agentScope: 'Code Generation',
          ruleText: ruleText,
        };
      });
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

  var lastInstructionsOverview = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setInstructionsNote(text, kind) {
    var host = document.getElementById('instrActionNote');
    if (!host) { return; }
    host.textContent = text || '';
    host.classList.remove('is-error', 'is-ok');
    if (kind) {
      host.classList.add(kind);
    }
  }

  function requestInstructionsOverview() {
    vscode.postMessage({ type: 'requestInstructionsOverview' });
  }

  function activateInstructionsTab(name) {
    document.querySelectorAll('.instr-tab').forEach(function (tab) {
      var on = tab.getAttribute('data-tab') === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.instr-pane').forEach(function (pane) {
      var on = pane.id === 'instrPane' + name.charAt(0).toUpperCase() + name.slice(1);
      pane.classList.toggle('is-active', on);
      pane.hidden = !on;
    });
    if (name === 'history') {
      requestInstructionsHistory();
    }
  }

  function instructionKindClass(kind) {
    return kind === 'copilot' ? 'kind-copilot' : kind === 'agent' ? 'kind-agent' : 'kind-memory';
  }

  function conflictingUnitIds(overview) {
    var ids = {};
    (overview.conflicts || []).forEach(function (conflict) {
      ids[conflict.aId] = true;
      ids[conflict.bId] = true;
    });
    return ids;
  }

  function renderInstructionsActive(overview) {
    var host = document.getElementById('instrActiveList');
    if (!host) { return; }
    var present = (overview.sources || []).filter(function (src) { return src.exists && src.unitCount > 0; });
    var conflicting = conflictingUnitIds(overview);
    var unitsBySource = {};
    (overview.units || []).forEach(function (unit) {
      (unitsBySource[unit.sourceId] = unitsBySource[unit.sourceId] || []).push(unit);
    });
    var html = (overview.sources || []).map(function (src) {
      var units = unitsBySource[src.id] || [];
      var unitHtml = units.map(function (unit) {
        var cls = [];
        if (unit.managed) { cls.push('is-managed'); }
        if (unit.disabled) { cls.push('is-disabled'); }
        if (conflicting[unit.id]) { cls.push('is-conflicting'); }
        var toggle = unit.managed
          ? '<span class="instr-unit-lock" title="Auto-managed block">LOCK</span>'
          : '<input type="checkbox" class="instr-unit-cb" ' + (unit.disabled ? '' : 'checked ')
            + 'data-rel="' + esc(src.relPath) + '" '
            + 'data-line="' + unit.line + '" '
            + 'data-text="' + esc(unit.text) + '">';
        return '<li class="' + cls.join(' ') + '"><label class="instr-unit">'
          + toggle + '<span class="instr-unit-text">' + esc(unit.text) + '</span></label></li>';
      }).join('');
      var meta = src.exists ? (src.unitCount + ' rule' + (src.unitCount === 1 ? '' : 's')) : 'not created';
      return '<div class="instr-source">'
        + '<div class="instr-source-hdr" data-open="' + esc(src.relPath) + '">'
        + '<span class="instr-source-kind ' + instructionKindClass(src.kind) + '">' + esc(src.kind) + '</span>'
        + '<span class="instr-source-label">' + esc(src.label) + '</span>'
        + '<span class="instr-source-meta">P' + src.priority + ' · ' + esc(meta) + '</span>'
        + '<button class="instr-source-open" type="button" data-open="' + esc(src.relPath) + '">Open</button>'
        + '</div>'
        + (units.length ? '<ul class="instr-units">' + unitHtml + '</ul>' : '')
        + '</div>';
    }).join('');
    host.innerHTML = present.length === 0
      ? '<div class="instr-empty">No instruction files found yet.</div>' + html
      : html;
  }

  function renderInstructionsPriority(overview) {
    var list = document.getElementById('instrPriorityList');
    if (!list) { return; }
    var byId = {};
    (overview.sources || []).forEach(function (src) { byId[src.id] = src; });
    var order = overview.priorityOrder || [];
    list.innerHTML = order.length === 0
      ? '<li class="instr-empty">No active instruction sources yet.</li>'
      : order.map(function (id) {
          var src = byId[id];
          if (!src) { return ''; }
          return '<li><span class="instr-prio-num">P' + src.priority + '</span> ' + esc(src.label)
            + '<span class="instr-prio-why">' + esc(src.authority) + '</span></li>';
        }).join('');
  }

  function renderInstructionsConflicts(overview) {
    var host = document.getElementById('instrConflictList');
    var badge = document.getElementById('instrConflictBadge');
    if (!host) { return; }
    var conflicts = overview.conflicts || [];
    if (badge) {
      badge.hidden = conflicts.length === 0;
      badge.textContent = String(conflicts.length);
    }
    if (conflicts.length === 0) {
      host.innerHTML = '<div class="instr-empty">No source-level contradictions detected.</div>';
      return;
    }
    host.innerHTML = conflicts.map(function (conflict) {
      return '<div class="instr-conflict">'
        + '<div class="instr-conflict-kind">' + esc(conflict.kind) + ' conflict</div>'
        + '<div class="instr-conflict-rule">' + esc(conflict.aText) + '<div class="instr-conflict-src">' + esc(conflict.aSourceLabel) + '</div></div>'
        + '<div class="instr-conflict-rule">' + esc(conflict.bText) + '<div class="instr-conflict-src">' + esc(conflict.bSourceLabel) + '</div></div>'
        + '<div class="instr-conflict-reason">' + esc(conflict.reason) + '</div>'
        + '<div class="instr-conflict-res">' + esc(conflict.resolution) + '</div>'
        + '<div class="instr-conflict-fix">Fix: ' + esc(conflict.suggestion) + '</div>'
        + '</div>';
    }).join('');
  }

  function renderInstructionsPersonas(overview) {
    var host = document.getElementById('instrPersonaList');
    if (!host) { return; }
    var personas = overview.personas || [];
    if (personas.length === 0) {
      host.innerHTML = '<div class="instr-empty">No bundled personas found.</div>';
      return;
    }
    var onCount = personas.filter(function (persona) { return persona.enabled; }).length;
    host.innerHTML = '<div class="instr-persona-hint">' + onCount + ' of ' + personas.length + ' bundled personas enabled.</div>'
      + personas.map(function (persona) {
          var tags = (persona.tags || []).map(function (tag) { return '<span class="instr-persona-tag">' + esc(tag) + '</span>'; }).join('');
          return '<div class="instr-persona' + (persona.enabled ? ' is-on' : '') + '">'
            + '<label class="instr-persona-row">'
            + '<input type="checkbox" class="instr-persona-cb" ' + (persona.enabled ? 'checked ' : '')
            + 'data-id="' + esc(persona.id) + '" data-src="' + esc(persona.sourceFile) + '">'
            + '<span class="instr-persona-label">' + esc(persona.label) + '</span>'
            + (persona.readOnly ? '<span class="instr-persona-ro">read-only</span>' : '')
            + '</label>'
            + (persona.description ? '<div class="instr-persona-desc">' + esc(persona.description) + '</div>' : '')
            + (tags ? '<div class="instr-persona-tags">' + tags + '</div>' : '')
            + '</div>';
        }).join('');
  }

  function renderInstructionsHistorySelect(overview) {
    var select = document.getElementById('instrHistorySelect');
    var host = document.getElementById('instrHistoryList');
    if (!select || !host) { return; }
    var present = (overview.sources || []).filter(function (src) { return src.exists; });
    select.innerHTML = present.map(function (src) {
      return '<option value="' + esc(src.relPath) + '">' + esc(src.label) + '</option>';
    }).join('');
    host.innerHTML = present.length
      ? '<div class="instr-empty">Select a file to load git history.</div>'
      : '<div class="instr-empty">No instruction files to inspect.</div>';
  }

  function requestInstructionsHistory() {
    var select = document.getElementById('instrHistorySelect');
    var host = document.getElementById('instrHistoryList');
    if (!select || !host || !select.value) { return; }
    host.innerHTML = '<div class="instr-empty">Loading history…</div>';
    vscode.postMessage({ type: 'instructionsHistory', relPath: select.value });
  }

  function tokenizeInstructionsText(text) {
    return text.toLowerCase().match(/[a-z0-9]{4,}/g) || [];
  }

  function simulateInstructionsTask() {
    var input = document.getElementById('instrPlaygroundInput');
    var result = document.getElementById('instrPlaygroundResult');
    if (!input || !result) { return; }
    if (!lastInstructionsOverview) {
      result.innerHTML = '<div class="instr-empty">Refresh instructions first.</div>';
      return;
    }
    var task = String(input.value || '').trim();
    if (!task) {
      result.innerHTML = '<div class="instr-empty">Enter a task to simulate.</div>';
      return;
    }
    var taskTokens = {};
    tokenizeInstructionsText(task).forEach(function (token) { taskTokens[token] = true; });
    var active = (lastInstructionsOverview.units || []).filter(function (unit) { return !unit.managed && !unit.disabled; });
    var relevant = active.filter(function (unit) {
      return tokenizeInstructionsText(unit.text).some(function (token) { return taskTokens[token]; });
    });
    var conflictsHit = (lastInstructionsOverview.conflicts || []).filter(function (conflict) {
      return tokenizeInstructionsText(conflict.aText + ' ' + conflict.bText).some(function (token) { return taskTokens[token]; });
    });
    var html = '<div class="instr-pg-section-title">Effective instruction stack (' + active.length + ' active)</div>';
    html += relevant.length
      ? relevant.map(function (unit) {
          return '<div class="instr-pg-check">' + esc(unit.text) + ' <span class="instr-conflict-src">(' + esc(unit.sourceLabel) + ')</span></div>';
        }).join('')
      : '<div class="instr-empty">No specific instruction source directly targets this task.</div>';
    html += '<div class="instr-pg-section-title">Conflicts that may affect this task</div>';
    html += conflictsHit.length
      ? conflictsHit.map(function (conflict) {
          return '<div class="instr-pg-warn">' + esc(conflict.reason) + ' — ' + esc(conflict.resolution) + '</div>';
        }).join('')
      : '<div class="instr-pg-check">No detected source conflicts apply to this task.</div>';
    result.innerHTML = html;
  }

  function handleInstructionsOverviewMessage(msg) {
    if (!msg || msg.ok === false) {
      setInstructionsNote((msg && msg.error) || 'Could not load instructions.', 'is-error');
      var activeHost = document.getElementById('instrActiveList');
      if (activeHost) {
        activeHost.innerHTML = '<div class="instr-empty">' + esc((msg && msg.error) || 'Unavailable.') + '</div>';
      }
      return;
    }
    lastInstructionsOverview = msg.payload || {};
    setInstructionsNote(
      String(lastInstructionsOverview.totalUnits || 0) + ' rules · ' + String((lastInstructionsOverview.conflicts || []).length) + ' conflict(s)',
      (lastInstructionsOverview.conflicts || []).length ? null : 'is-ok'
    );
    renderInstructionsActive(lastInstructionsOverview);
    renderInstructionsPriority(lastInstructionsOverview);
    renderInstructionsConflicts(lastInstructionsOverview);
    renderInstructionsPersonas(lastInstructionsOverview);
    renderInstructionsHistorySelect(lastInstructionsOverview);
    renderPersonaRibbonTabs(lastInstructionsOverview.personas || []);
    buildPersonaPresetIndex(lastInstructionsOverview);
    refreshPresetLibrary();
  }

  function handleInstructionsHistoryMessage(msg) {
    var host = document.getElementById('instrHistoryList');
    if (!host) { return; }
    if (!msg || msg.ok === false) {
      host.innerHTML = '<div class="instr-empty">' + esc((msg && msg.error) || 'No history available.') + '</div>';
      return;
    }
    var commits = msg.commits || [];
    host.innerHTML = commits.length === 0
      ? '<div class="instr-empty">No commits recorded for this file yet.</div>'
      : commits.map(function (commit) {
          return '<div class="instr-commit">'
            + '<span class="instr-commit-sha">' + esc(commit.sha) + '</span>'
            + '<span class="instr-commit-subject">' + esc(commit.subject) + '</span>'
            + '<span class="instr-commit-meta">' + esc(commit.author) + ' · ' + esc(commit.date) + '</span>'
            + '</div>';
        }).join('');
  }

  function handleInstructionsActionDone(msg) {
    if (!msg) { return; }
    if (msg.ok) {
      setInstructionsNote(msg.message || 'Done.', 'is-ok');
    } else {
      setInstructionsNote(msg.error || 'Action cancelled.', msg.error ? 'is-error' : null);
      requestInstructionsOverview();
    }
  }

  function setupInstructionsManager() {
    document.querySelectorAll('.instr-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var name = tab.getAttribute('data-tab') || 'active';
        activateInstructionsTab(name);
      });
    });
    var btnRefresh = document.getElementById('btnInstrRefresh');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', function () {
        setInstructionsNote('Rescanning…');
        requestInstructionsOverview();
      });
    }
    var btnExport = document.getElementById('btnInstrExport');
    if (btnExport) {
      btnExport.addEventListener('click', function () {
        setInstructionsNote('Exporting…');
        vscode.postMessage({ type: 'exportInstructions' });
      });
    }
    var btnImport = document.getElementById('btnInstrImport');
    if (btnImport) {
      btnImport.addEventListener('click', function () {
        setInstructionsNote('Importing…');
        vscode.postMessage({ type: 'importInstructions' });
      });
    }
    var btnSimulate = document.getElementById('btnInstrSimulate');
    if (btnSimulate) {
      btnSimulate.addEventListener('click', simulateInstructionsTask);
    }
    var historySelect = document.getElementById('instrHistorySelect');
    if (historySelect) {
      historySelect.addEventListener('change', requestInstructionsHistory);
    }
    var activeList = document.getElementById('instrActiveList');
    if (activeList) {
      activeList.addEventListener('click', function (event) {
        var el = event.target.closest ? event.target.closest('[data-open]') : null;
        if (!el) { return; }
        var rel = el.getAttribute('data-open');
        if (rel) {
          vscode.postMessage({ type: 'openInstructionFile', relPath: rel });
        }
      });
      activeList.addEventListener('change', function (event) {
        var cb = event.target.closest ? event.target.closest('.instr-unit-cb') : null;
        if (!cb) { return; }
        var rel = cb.getAttribute('data-rel');
        var line = parseInt(cb.getAttribute('data-line'), 10);
        var text = cb.getAttribute('data-text');
        if (!rel || !text) { return; }
        setInstructionsNote(cb.checked ? 'Enabling rule…' : 'Disabling rule…');
        vscode.postMessage({
          type: 'toggleInstructionRule',
          relPath: rel,
          line: isNaN(line) ? undefined : line,
          ruleText: text,
          enabled: cb.checked,
        });
      });
    }
    var personaList = document.getElementById('instrPersonaList');
    if (personaList) {
      personaList.addEventListener('change', function (event) {
        var cb = event.target.closest ? event.target.closest('.instr-persona-cb') : null;
        if (!cb) { return; }
        setInstructionsNote(cb.checked ? 'Enabling persona…' : 'Disabling persona…');
        vscode.postMessage({
          type: 'togglePersona',
          personaId: cb.getAttribute('data-id'),
          sourceFile: cb.getAttribute('data-src'),
          enabled: cb.checked,
        });
      });
    }
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
        recordCanvasHistory();
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

  function selectRibbonPersona(name) {
    var personaName = String(name || '').trim();
    if (!personaName) { return; }
    activeRibbonPersona = personaName;
    document.querySelectorAll('.ribbon-tab[data-action="selectRibbonPersona"]').forEach(function (tab) {
      var on = String(tab.getAttribute('data-persona') || '').trim() === activeRibbonPersona;
      tab.classList.toggle('active', on);
    });
    refreshPresetLibrary();
  }

  function personaFromNode(node) {
    if (!node || node.type !== 'persona') { return null; }
    var pid = String(node.personaId || '').trim();
    var src = String(node.sourceFile || '').trim();
    if (pid && src) {
      return { personaId: pid, sourceFile: src, label: String(node.text || pid), enabled: node.personaEnabled !== false };
    }
    var byLabel = lastRibbonPersonas.find(function (p) {
      return String(p.label || '').trim() === String(node.text || '').trim();
    });
    if (!byLabel) { return null; }
    return {
      personaId: String(byLabel.id || '').trim(),
      sourceFile: String(byLabel.sourceFile || '').trim(),
      label: String(byLabel.label || byLabel.id || ''),
      enabled: byLabel.enabled !== false,
    };
  }

  function syncPersonaNodes(personas) {
    var byId = {};
    (personas || []).forEach(function (p) {
      byId[String(p.id || '').trim()] = p;
    });
    vNodes.forEach(function (node) {
      if (node.type !== 'persona') { return; }
      var pid = String(node.personaId || '').trim();
      if (!pid || !byId[pid]) { return; }
      node.personaEnabled = byId[pid].enabled !== false;
    });
  }

  function renderPersonaRibbonTabs(personas) {
    var host = document.getElementById('personaRibbonTabs');
    if (!host) { return; }
    var list = Array.isArray(personas) ? personas.slice() : [];
    if (list.length === 0) {
      list = [{ id: 'sdlc-architect', label: 'SDLC Architect', enabled: true }];
    }
    lastRibbonPersonas = list.slice();
    syncPersonaNodes(list);
    host.innerHTML = '';
    list.forEach(function (persona, index) {
      var label = String(persona.label || persona.id || '').trim();
      if (!label) { return; }
      var tab = document.createElement('div');
      tab.className = 'ribbon-tab';
      tab.setAttribute('data-action', 'selectRibbonPersona');
      tab.setAttribute('data-persona', label);
      tab.setAttribute('data-persona-id', String(persona.id || ''));
      tab.setAttribute('data-source-file', String(persona.sourceFile || ''));
      tab.setAttribute('data-enabled', persona.enabled === false ? 'false' : 'true');
      tab.draggable = true;
      tab.textContent = label;
      if ((!activeRibbonPersona && index === 0) || activeRibbonPersona === label) {
        tab.classList.add('active');
        activeRibbonPersona = label;
      }
      host.appendChild(tab);
    });
  }

  function setupPersonaRibbon() {
    var ribbon = document.querySelector('.persona-ribbon');
    var tabsHost = document.getElementById('personaRibbonTabs');
    var overlay = document.getElementById('personaOverlay');
    var overlayToggle = document.getElementById('personaOverlayToggle');
    var overlayClose = document.getElementById('personaOverlayClose');
    if (!ribbon || !tabsHost || !overlay) { return; }

    function setPersonaOverlayOpen(open) {
      overlay.hidden = !open;
      if (open) {
        setCanvasNotice('Drag persona cards from overlay and drop onto canvas.', 'ok');
      }
    }

    tabsHost.addEventListener('dragstart', function (event) {
      var tab = event.target && event.target.closest ? event.target.closest('.ribbon-tab[data-action="selectRibbonPersona"]') : null;
      if (!tab || !event.dataTransfer) { return; }
      var payload = {
        personaId: String(tab.getAttribute('data-persona-id') || '').trim(),
        sourceFile: String(tab.getAttribute('data-source-file') || '').trim(),
        label: String(tab.getAttribute('data-persona') || tab.textContent || '').trim(),
        enabled: String(tab.getAttribute('data-enabled') || 'true') !== 'false',
      };
      event.dataTransfer.setData('application/x-po-persona', JSON.stringify(payload));
      event.dataTransfer.setData('text/plain', payload.label || 'Persona');
      event.dataTransfer.effectAllowed = 'copy';
      setCanvasNotice('Drop persona into canvas to add a persona node.', 'ok');
      document.body.classList.add('dragging-persona-active');
    });

    tabsHost.addEventListener('dragend', function (event) {
      document.body.classList.remove('dragging-persona-active');
    });

    tabsHost.addEventListener('click', function (event) {
      var tab = event.target.closest ? event.target.closest('.ribbon-tab[data-action="selectRibbonPersona"]') : null;
      if (!tab) { return; }
      event.preventDefault();
      setCanvasNotice('Personas are drag-only here. Drag a persona card and drop it onto the canvas.', 'ok');
    });

    if (overlayToggle) {
      overlayToggle.addEventListener('click', function () {
        setPersonaOverlayOpen(true);
      });
    }
    if (overlayClose) {
      overlayClose.addEventListener('click', function () {
        setPersonaOverlayOpen(false);
      });
    }

    ribbon.addEventListener('click', function (event) {
      var btn = event.target.closest ? event.target.closest('.ribbon-btn') : null;
      if (!btn) { return; }
      var action = btn.getAttribute('data-action');
      if (action === 'ribbonNew') {
        vNodes = [{ id: 'v_1', type: 'persona', text: activeRibbonPersona || 'SDLC Architect', priority: 'Medium', x: 20, y: 50 }];
        vEdges = [];
        vSelectedNode = null;
        vSelectedEdge = null;
        updateVInspector();
        updateSelectedLinkInspector();
        renderVCanvas();
        recordCanvasHistory();
        return;
      }
      if (action === 'ribbonClone') {
        if (vSelectedNode) {
          var newN = Object.assign({}, vSelectedNode, { id: 'v_' + Math.random().toString(36).slice(2, 8), x: vSelectedNode.x + 20, y: vSelectedNode.y + 20 });
          vNodes.push(newN);
          renderVCanvas();
          recordCanvasHistory();
        }
        return;
      }
      if (action === 'ribbonEdit') {
        var inspect = document.getElementById('vInspectText');
        if (inspect) { inspect.focus(); }
        return;
      }
      if (action === 'ribbonSync') {
        var importUrl = document.getElementById('importUrl');
        var urlValue = importUrl ? String(importUrl.value || '').trim() : '';
        if (urlValue) {
          vscode.postMessage({ type: 'fetchRulesFromUrl', url: urlValue });
        } else {
          var gitResult = document.getElementById('gitTraceResult');
          if (gitResult) { gitResult.textContent = 'Provide URL in External Rules input first.'; }
        }
      }
    });
  }

  document.querySelectorAll('button[data-action], select[data-action]').forEach((button) => {
    button.addEventListener('click', (e) => {
      // Avoid triggering for select if it binds via change
      if (button.tagName === 'SELECT') return; 
      const action = button.getAttribute('data-action');
      if (!action) { return; }
      if (action === 'loadCopilotInstructions') {
        vscode.postMessage({ type: 'loadCopilotInstructions' });
        return;
      }
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
    presetSearch.addEventListener('input', applyPresetSearchFilter);
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
      normalizePresetSource(data.presets || [], data.append === true);
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
    if (data.type === 'instructionsOverview') {
      handleInstructionsOverviewMessage(data);
    }
    if (data.type === 'instructionsHistory') {
      handleInstructionsHistoryMessage(data);
    }
    if (data.type === 'instructionsActionDone') {
      handleInstructionsActionDone(data);
      if (data.ok) {
        requestInstructionsOverview();
      }
    }
    if (data.type === 'canvasGraph') {
      applyCanvasGraph(data);
    }
  });

  // --- VCanvas Engine ---
  var CANVAS_HISTORY_LIMIT = 240;
  var CANVAS_HISTORY_STORAGE_KEY = 'instructionStudioCanvasHistoryV1';
  var vNodes = [
    { id: 'v_1', type: 'persona', text: 'SDLC Architect', priority: 'High', x: 20, y: 50 },
    { id: 'v_2', type: 'condition', text: 'If writing code', priority: 'High', x: 250, y: 50 },
    { id: 'v_3', type: 'rule', text: 'Read .promptoptimizer/skills/sdlc-architect.md. Follow everything written there. Do not write any code until you have read and understood the entire file.', priority: 'Critical', x: 500, y: 50 }
  ];
  var vEdges = [{ from: 'v_1', to: 'v_2' }, { from: 'v_2', to: 'v_3' }];
  var vPan = { x: 0, y: 0, scale: 1 };
  var vMinimap = null;
  var vSelectedNode = null;
  var vDraggingNode = null;
  var vDragStartX = 0, vDragStartY = 0, vOrigX = 0, vOrigY = 0;
  var vDraggedNodeChanged = false;
  var vIsPanning = false, vPanStartX = 0, vPanStartY = 0;
  var vIsLinking = false, vLinkFrom = null;
  var vSelectedEdge = null;
  var vCanvasNoticeTimer = null;
  var vUndoStack = [];
  var vRedoStack = [];
  var vHistoryCommitTimer = null;

  function clonePlain(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function captureCanvasSnapshot() {
    return {
      nodes: clonePlain(vNodes),
      edges: clonePlain(vEdges),
      pan: clonePlain(vPan),
      selectedNodeId: vSelectedNode ? vSelectedNode.id : null,
      selectedEdge: vSelectedEdge ? clonePlain(vSelectedEdge) : null,
    };
  }

  function snapshotsEqual(a, b) {
    return JSON.stringify(a || null) === JSON.stringify(b || null);
  }

  /**
   * Applies a canvasGraph message (nodes + edges from copilot-instructions.md)
   * onto the live canvas, resets pan/selection, and records history.
   * Called both on first load and when the user clicks "From Copilot Instructions".
   */
  function fitCanvasToViewport() {
    var host = document.getElementById('vCanvasContainer');
    if (!host || vNodes.length === 0) { return; }
    
    // Find visible nodes
    var visibleNodes = vNodes.filter(function(n) { return n.__visible !== false; });
    if (visibleNodes.length === 0) { visibleNodes = vNodes; }

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    visibleNodes.forEach(function(n) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    });

    // Add padding around elements
    var extraPad = 40;
    var graphW = (maxX - minX) + extraPad * 2;
    var graphH = (maxY - minY) + extraPad * 2;
    if (graphW <= 0) graphW = 100;
    if (graphH <= 0) graphH = 100;

    var viewW = host.clientWidth;
    var viewH = host.clientHeight;
    if (viewW <= 0) viewW = 800; // sensible fallback
    if (viewH <= 0) viewH = 500;

    var scaleX = viewW / graphW;
    var scaleY = viewH / graphH;
    var nextScale = Math.max(0.15, Math.min(scaleX, scaleY, 1.2)); // cap max zoom for singular elements to 1.2
    
    // Center the scaled bounding box inside viewport
    var graphCenterX = minX + (maxX - minX) / 2;
    var graphCenterY = minY + (maxY - minY) / 2;
    
    vPan.scale = nextScale;
    vPan.x = (viewW / 2) - graphCenterX * nextScale;
    vPan.y = (viewH / 2) - graphCenterY * nextScale;

    renderVCanvas();
    persistCanvasState();
  }

  function applyCanvasGraph(data) {
    var incoming = Array.isArray(data.nodes) ? data.nodes : [];
    if (incoming.length === 0) {
      setCanvasNotice(data.notice || 'No instructions to draw.', 'error');
      return;
    }
    vNodes = incoming.map(function (n) {
      return {
        id: String(n.id || 'ci_' + Math.random().toString(36).slice(2, 8)),
        type: String(n.type || 'rule'),
        text: String(n.text || ''),
        priority: String(n.priority || 'Medium'),
        collapsed: !!n.collapsed,
        x: Number(n.x) || 20,
        y: Number(n.y) || 50,
      };
    });
    vEdges = Array.isArray(data.edges) ? data.edges.map(function (e) {
      return { from: String(e.from || ''), to: String(e.to || '') };
    }) : [];
    vPan = { x: 0, y: 0, scale: 1 };
    vSelectedNode = null;
    vSelectedEdge = null;
    updateVInspector();
    updateSelectedLinkInspector();
    renderVCanvas();
    recordCanvasHistory();
    if (data.notice) {
      setCanvasNotice(data.notice, 'ok');
    }
  }

  function updateVNodeRules() {
    var nodeRulesContainer = document.getElementById('vSelectedNodeRules');
    var nodeRulesCard = document.getElementById('vSelectedNodeRulesCard');
    if (!nodeRulesContainer || !nodeRulesCard) return;
    
    if (!vSelectedNode) {
      nodeRulesCard.style.display = 'none';
      return;
    }
    // vSelectedNode holds the selected node object (see mousedown handler), so
    // resolve its id before looking it up in vNodes.
    var selectedId = (vSelectedNode && typeof vSelectedNode === 'object')
      ? vSelectedNode.id
      : vSelectedNode;
    var n = vNodes.find(function(nn) { return nn.id === selectedId; });
    if (!n) {
      nodeRulesCard.style.display = 'none';
      return;
    }
    
    nodeRulesCard.style.display = 'block';
    var childRulesHtml = '<div style="font-weight: 600; margin-bottom: 4px;">Node Rules</div><ul style="padding-left:16px; margin: 0; font-size: 11px; word-break: break-word;">';
    var hasRules = false;

    if (n.type === 'persona') {
      var personaMeta = personaFromNode(n);
      var personaResolved = resolvePersonaRuleEntries(personaMeta);
      if (personaResolved.entries.length > 0) {
        var sourceSuffix = personaResolved.sourceLabel
          ? ' <span style="opacity:.7;">(' + esc(personaResolved.sourceLabel) + ')</span>'
          : '';
        childRulesHtml = '<div style="font-weight: 600; margin-bottom: 4px;">Persona Rules' + sourceSuffix + '</div><ul style="padding-left:16px; margin: 0; font-size: 11px; word-break: break-word;">';
        personaResolved.entries.forEach(function (entry) {
          var txt = String(entry.text || '').trim();
          if (!txt) { return; }
          var disabled = entry.disabled === true;
          childRulesHtml += '<li style="margin-bottom: 4px;' + (disabled ? ' opacity:.6; text-decoration: line-through;' : '') + '">' + esc(txt) + '</li>';
          hasRules = true;
        });
        childRulesHtml += '</ul>';
      }
    }

    if (hasRules) {
      if (nodeRulesContainer.innerHTML !== childRulesHtml) {
         nodeRulesContainer.innerHTML = childRulesHtml;
      }
      return;
    }
    
    var findRules = function(parentId) {
      var children = vEdges.filter(function(e) { return e.from === parentId; }).map(function(e) { return e.to; });
      for (var i = 0; i < children.length; i++) {
        var childId = children[i];
        var childNode = vNodes.find(function(nn) { return nn.id === childId; });
        if (childNode) {
          if (childNode.type === 'rule' || childNode.type === 'file') {
            var safeText = (childNode.text || childNode.label || '').replace(/</g, "&lt;").replace(/>/g, "&gt;");
            var itemCls = childNode.type === 'file' ? 'font-weight: 600; list-style-type: none; margin-top: 6px; margin-left: -10px; color: var(--vscode-focusBorder, #007fd4);' : 'margin-bottom: 4px;';
            childRulesHtml += '<li style="' + itemCls + '">' + safeText + '</li>';
            hasRules = true;
          }
          findRules(childId);
        }
      }
    };
    
    if (n.type === 'rule') {
      var safeText = (n.text || n.label || '').replace(/</g, "&lt;").replace(/>/g, "&gt;");
      childRulesHtml += '<li style="margin-bottom: 4px;">' + safeText + '</li>';
      hasRules = true;
    } else {
      findRules(n.id);
    }
    
    childRulesHtml += '</ul>';
    if (!hasRules) {
      childRulesHtml = '<div style="font-weight: 600; margin-bottom: 4px;">Node Rules</div><p class="muted-hint" style="margin:0;">No rules found.</p>';
    }
    
    // Only update if changed to avoid breaking selection/scroll
    if (nodeRulesContainer.innerHTML !== childRulesHtml) {
       nodeRulesContainer.innerHTML = childRulesHtml;
    }
  }

  setInterval(updateVNodeRules, 250);

  function readPersistedCanvasState() {
    var state = vscode.getState();
    if (state && state.canvasHistory && state.canvasHistory.current) {
      return state.canvasHistory;
    }
    try {
      var raw = localStorage.getItem(CANVAS_HISTORY_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function persistCanvasState() {
    var state = vscode.getState() || {};
    state.canvasHistory = {
      current: captureCanvasSnapshot(),
      undoStack: clonePlain(vUndoStack),
      redoStack: clonePlain(vRedoStack),
    };
    vscode.setState(state);
    try {
      localStorage.setItem(CANVAS_HISTORY_STORAGE_KEY, JSON.stringify(state.canvasHistory));
    } catch {
      // Ignore storage failures.
    }
  }

  function updateCanvasHistoryButtons() {
    var undoBtn = document.getElementById('vBtnUndo');
    var redoBtn = document.getElementById('vBtnRedo');
    var canUndo = vUndoStack.length > 1;
    var canRedo = vRedoStack.length > 0;
    if (undoBtn) {
      undoBtn.disabled = !canUndo;
    }
    if (redoBtn) {
      redoBtn.disabled = !canRedo;
    }
  }

  function applyCanvasSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) { return; }
    vNodes = clonePlain(snapshot.nodes);
    vEdges = clonePlain(snapshot.edges);
    vPan = snapshot.pan ? clonePlain(snapshot.pan) : { x: 0, y: 0, scale: 1 };
    vSelectedNode = snapshot.selectedNodeId
      ? (vNodes.find(function (node) { return node.id === snapshot.selectedNodeId; }) || null)
      : null;
    vSelectedEdge = snapshot.selectedEdge ? clonePlain(snapshot.selectedEdge) : null;
    updateVInspector();
    updateSelectedLinkInspector();
    renderVCanvas();
    persistCanvasState();
    updateCanvasHistoryButtons();
  }

  function recordCanvasHistory() {
    if (vHistoryCommitTimer) {
      clearTimeout(vHistoryCommitTimer);
      vHistoryCommitTimer = null;
    }
    var current = captureCanvasSnapshot();
    if (vUndoStack.length > 0 && snapshotsEqual(vUndoStack[vUndoStack.length - 1], current)) {
      persistCanvasState();
      updateCanvasHistoryButtons();
      return;
    }
    vUndoStack.push(current);
    if (vUndoStack.length > CANVAS_HISTORY_LIMIT) {
      vUndoStack = vUndoStack.slice(vUndoStack.length - CANVAS_HISTORY_LIMIT);
    }
    vRedoStack = [];
    persistCanvasState();
    updateCanvasHistoryButtons();
  }

  function scheduleCanvasHistoryCommit() {
    if (vHistoryCommitTimer) {
      clearTimeout(vHistoryCommitTimer);
    }
    vHistoryCommitTimer = setTimeout(function () {
      vHistoryCommitTimer = null;
      recordCanvasHistory();
    }, 350);
  }

  function undoCanvas() {
    if (vUndoStack.length <= 1) { return; }
    var current = vUndoStack.pop();
    if (current) {
      vRedoStack.push(current);
    }
    applyCanvasSnapshot(vUndoStack[vUndoStack.length - 1]);
    setCanvasNotice('Undo applied.', 'ok');
  }

  function redoCanvas() {
    if (vRedoStack.length === 0) { return; }
    var next = vRedoStack.pop();
    if (!next) { return; }
    vUndoStack.push(clonePlain(next));
    applyCanvasSnapshot(next);
    setCanvasNotice('Redo applied.', 'ok');
  }

  function initializeCanvasHistory() {
    var persisted = readPersistedCanvasState();
    if (persisted && persisted.current) {
      vUndoStack = Array.isArray(persisted.undoStack) ? clonePlain(persisted.undoStack) : [];
      vRedoStack = Array.isArray(persisted.redoStack) ? clonePlain(persisted.redoStack) : [];
      applyCanvasSnapshot(persisted.current);
      if (vUndoStack.length === 0 || !snapshotsEqual(vUndoStack[vUndoStack.length - 1], captureCanvasSnapshot())) {
        vUndoStack.push(captureCanvasSnapshot());
      }
    } else {
      vUndoStack = [captureCanvasSnapshot()];
      vRedoStack = [];
      persistCanvasState();
    }
    updateCanvasHistoryButtons();
  }

  function isTypingTarget(target) {
    if (!target || !target.tagName) { return false; }
    var tag = String(target.tagName).toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') { return true; }
    if (target.isContentEditable) { return true; }
    return false;
  }

  function setupCanvasKeyboardShortcuts() {
    window.addEventListener('keydown', function (event) {
      if (event.defaultPrevented) { return; }
      if (isTypingTarget(event.target)) { return; }
      var isModifier = !!(event.ctrlKey || event.metaKey);
      if (!isModifier || event.altKey) { return; }
      var key = String(event.key || '').toLowerCase();
      if (key === 'z' && event.shiftKey) {
        event.preventDefault();
        redoCanvas();
        return;
      }
      if (key === 'z') {
        event.preventDefault();
        undoCanvas();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        redoCanvas();
      }
    });
  }

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
    node.collapsed = !!node.collapsed;
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

    var memo = {};
    var checkVisible = function(nid, visited) {
      if (memo[nid] !== undefined) return memo[nid];
      if (visited[nid]) return false;
      visited[nid] = true;
      var incoming = vEdges.filter(function(e) { return e.to === nid; });
      if (incoming.length === 0) {
        var finalAns = true;
        memo[nid] = finalAns;
        return finalAns;
      }
      var ans = incoming.some(function(e) {
        var pNode = vNodes.find(function(rn) { return rn.id === e.from; });
        if (!pNode || pNode.collapsed) return false;
        var newObj = {};
        for (var k in visited) newObj[k] = visited[k];
        return checkVisible(e.from, newObj);
      });
      memo[nid] = ans;
      return ans;
    };
    
    var childCountCache = {};
    vEdges.forEach(function(e) {
      childCountCache[e.from] = (childCountCache[e.from] || 0) + 1;
    });

    viewport.innerHTML = '';
    vNodes.forEach(function (n) {
      n.__visible = checkVisible(n.id, {});
      if (!n.__visible) return;

      ensureNodeDefaults(n);
      var el = document.createElement('div');
      var typeClass = String(n.type || '').trim();
      el.className = 'vcanvas-node ' + typeClass + (vSelectedNode && vSelectedNode.id === n.id ? ' selected' : '');
      el.dataset.nodeid = n.id;
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';

      if (childCountCache[n.id] > 0) {
        var collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'vcanvas-collapse-btn';
        collapseBtn.setAttribute('data-collapse-toggle', n.id);
        collapseBtn.textContent = n.collapsed ? '+' : '-';
        collapseBtn.title = n.collapsed ? 'Expand children' : 'Collapse children';
        collapseBtn.setAttribute('aria-label', n.collapsed ? 'Expand children' : 'Collapse children');
        collapseBtn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        collapseBtn.addEventListener('pointerdown', function(e) { e.stopPropagation(); });
        el.appendChild(collapseBtn);
      }

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
        vDraggedNodeChanged = false;
        vDragStartX = e.clientX; vDragStartY = e.clientY;
        vOrigX = n.x; vOrigY = n.y;
        updateVInspector();
        updateSelectedLinkInspector();
        renderVCanvas();
        refreshPresetLibrary();
        e.stopPropagation();
      });

      viewport.appendChild(el);
    });

    syncPresetSelectionUi();

    // Sync minimap overlay component bounds
    if (vMinimap) {
      var container = document.getElementById('vCanvasContainer');
      vMinimap.synchronize(vNodes, vPan, container, vEdges);
    }

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
      if (fromN && toN && fromN.__visible && toN.__visible) {
        var fromW = fromN.w || 100;
        var fromH = fromN.h || 30;
        var toH = toN.h || 30;
        var x1 = (fromN.x + fromW) * vPan.scale + vPan.x;
        var y1 = (fromN.y + fromH / 2) * vPan.scale + vPan.y;
        var x2 = toN.x * vPan.scale + vPan.x;
        var y2 = (toN.y + toH / 2) * vPan.scale + vPan.y;
        var isSelected = vSelectedEdge && vSelectedEdge.from === e.from && vSelectedEdge.to === e.to;
        html += '<path data-edge-index="' + index + '" class="vcanvas-edge' + (isSelected ? ' selected' : '') + '" marker-end="url(#arrow)" d="M ' + x1 + ' ' + y1 + ' C ' + (x1+15) + ' ' + y1 + ', ' + (x2-15) + ' ' + y2 + ', ' + x2 + ' ' + y2 + '" />';
      }
    });
    if (vIsLinking && vLinkFrom) {
      var fromN = vNodes.find(function(x) { return x.id === vLinkFrom; });
      if (fromN) {
        var fromW = fromN.w || 100;
        var fromH = fromN.h || 30;
        var x1 = (fromN.x + fromW) * vPan.scale + vPan.x;
        var y1 = (fromN.y + fromH / 2) * vPan.scale + vPan.y;
        html += '<path class="vcanvas-edge drawing" marker-end="url(#arrow)" d="M ' + x1 + ' ' + y1 + ' C ' + (x1+15) + ' ' + y1 + ', ' + (mouseX-15) + ' ' + mouseY + ', ' + mouseX + ' ' + mouseY + '" />';
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

    container.addEventListener('dragover', function (event) {
      var dt = event.dataTransfer;
      if (!dt) { return; }
      var types = dt.types || [];
      var personaDrag = Array.prototype.indexOf.call(types, 'application/x-po-persona') >= 0;
      if (!personaDrag) { return; }
      event.preventDefault();
      dt.dropEffect = 'copy';
    });

    container.addEventListener('drop', function (event) {
      var dt = event.dataTransfer;
      if (!dt) { return; }
      var raw = dt.getData('application/x-po-persona');
      if (!raw) { return; }
      event.preventDefault();
      var payload = null;
      try { payload = JSON.parse(raw); } catch { payload = null; }
      if (!payload || !payload.label) {
        setCanvasNotice('Invalid persona payload.', 'error');
        return;
      }
      var rect = container.getBoundingClientRect();
      var x = (event.clientX - rect.left - vPan.x) / vPan.scale;
      var y = (event.clientY - rect.top - vPan.y) / vPan.scale;
      vNodes.push({
        id: 'v_' + Math.random().toString(36).slice(2, 8),
        type: 'persona',
        text: String(payload.label || 'Persona'),
        priority: 'Medium',
        personaId: String(payload.personaId || ''),
        sourceFile: String(payload.sourceFile || ''),
        personaEnabled: payload.enabled !== false,
        x: x,
        y: y,
      });
      renderVCanvas();
      recordCanvasHistory();
      setCanvasNotice('Persona node added to canvas.', 'ok');
    });

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
      refreshPresetLibrary();
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
        if (dx !== 0 || dy !== 0) {
          vDraggedNodeChanged = true;
        }
        renderVCanvas();
      } else if (vIsLinking) {
        var rect = container.getBoundingClientRect();
        drawVEdges(e.clientX - rect.left, e.clientY - rect.top);
      }
    });

    container.addEventListener('mouseup', function(e) {
      var wasActionActive = vIsLinking || vIsPanning || vDraggingNode;
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
          recordCanvasHistory();
        } else {
          if (invalidReason.indexOf('Conflicting rules') === 0) {
            renderConflicts([{ severity: 'error', message: invalidReason }]);
          }
          setCanvasNotice(invalidReason, 'error');
        }
      }
      if (vDraggingNode && vDraggedNodeChanged) {
        recordCanvasHistory();
      }
      vIsPanning = false;
      vDraggingNode = null;
      vDraggedNodeChanged = false;
      vIsLinking = false;
      vLinkFrom = null;
      if (wasActionActive) {
        renderVCanvas();
      }
    });

    container.addEventListener('wheel', function(e) {
      e.preventDefault();
      var z = e.deltaY > 0 ? 0.9 : 1.1;
      vPan.scale = Math.max(0.2, Math.min(vPan.scale * z, 3));
      renderVCanvas();
      persistCanvasState();
    });

    container.addEventListener('click', function(event) {
      var toggle = event.target && event.target.closest ? event.target.closest('[data-collapse-toggle]') : null;
      if (!toggle) { return; }
      var nodeId = String(toggle.getAttribute('data-collapse-toggle') || '').trim();
      if (!nodeId) { return; }
      var node = vNodes.find(function (item) { return item.id === nodeId; });
      if (!node) { return; }
      node.collapsed = !node.collapsed;
      fitCanvasToViewport(); // Auto fit viewport to max nodes on click toggle
      recordCanvasHistory();
      setCanvasNotice(node.collapsed ? 'Children hidden.' : 'Children shown.', 'ok');
      event.preventDefault();
      event.stopPropagation();
    }, true);

    var btnAddPersona = document.getElementById('vBtnAddPersona');
    if (btnAddPersona) btnAddPersona.addEventListener('click', function() { addVNode('persona', 'New Persona'); });
    var btnAddCond = document.getElementById('vBtnAddCond');
    if (btnAddCond) btnAddCond.addEventListener('click', function() { addVNode('condition', 'If ...'); });
    var btnAddRule = document.getElementById('vBtnAddRule');
    if (btnAddRule) btnAddRule.addEventListener('click', function() { addVNode('rule', 'New Rule'); });
    var btnUndo = document.getElementById('vBtnUndo');
    if (btnUndo) btnUndo.addEventListener('click', undoCanvas);
    var btnRedo = document.getElementById('vBtnRedo');
    if (btnRedo) btnRedo.addEventListener('click', redoCanvas);

    var btnCollapseAll = document.getElementById('vBtnCollapseAll');
    var btnExpandAll = document.getElementById('vBtnExpandAll');
    if (btnCollapseAll) {
      btnCollapseAll.addEventListener('click', function() {
        var hasChildren = {};
        vEdges.forEach(function(e) { hasChildren[e.from] = true; });
        vNodes.forEach(function(n) {
          if (hasChildren[n.id]) { n.collapsed = true; }
        });
        btnCollapseAll.style.display = 'none';
        if (btnExpandAll) btnExpandAll.style.display = 'inline-block';
        fitCanvasToViewport(); // Auto fit viewport to max nodes on collapse all
        recordCanvasHistory();
      });
    }
    if (btnExpandAll) {
      btnExpandAll.addEventListener('click', function() {
        vNodes.forEach(function(n) { n.collapsed = false; });
        btnExpandAll.style.display = 'none';
        if (btnCollapseAll) btnCollapseAll.style.display = 'inline-block';
        fitCanvasToViewport(); // Auto fit viewport to max nodes on expand all
        recordCanvasHistory();
      });
    }

    var btnFitCanvas = document.getElementById('vBtnFitCanvas');
    if (btnFitCanvas) {
      btnFitCanvas.addEventListener('click', fitCanvasToViewport);
    }

    var btnToggleFullscreen = document.getElementById('vBtnToggleFullscreen');
    if (btnToggleFullscreen) {
      btnToggleFullscreen.addEventListener('click', function() {
        var layout = document.querySelector('.vscode-layout');
        if (!layout) { return; }
        var isFS = layout.classList.contains('canvas-fullscreen');
        if (isFS) {
          layout.classList.remove('canvas-fullscreen');
          btnToggleFullscreen.textContent = '⛶ Fullscreen';
          btnToggleFullscreen.title = 'Switch to fullscreen view';
        } else {
          layout.classList.add('canvas-fullscreen');
          btnToggleFullscreen.textContent = '🗗 Restore View';
          btnToggleFullscreen.title = 'Restore standard layout state';
        }
        
        // Trigger responsive layout/minimap adjustments
        setTimeout(function() {
          renderVCanvas();
        }, 100);
      });
    }

    var btnDelNode = document.getElementById('vBtnDeleteNode');
    if (btnDelNode) btnDelNode.addEventListener('click', function() {
      if (vSelectedNode) {
        vNodes = vNodes.filter(function(n) { return n.id !== vSelectedNode.id; });
        vEdges = vEdges.filter(function(e) { return e.from !== vSelectedNode.id && e.to !== vSelectedNode.id; });
        vSelectedNode = null;
        vSelectedEdge = null;
        updateVInspector();
        updateSelectedLinkInspector();
        fitCanvasToViewport(); // Auto fit viewport to max nodes on remove
        recordCanvasHistory();
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
      recordCanvasHistory();
    });

    var inputInspectText = document.getElementById('vInspectText');
    if (inputInspectText) inputInspectText.addEventListener('input', function() {
      if (vSelectedNode) {
        vSelectedNode.text = inputInspectText.value;
        renderVCanvas();
        scheduleCanvasHistoryCommit();
      }
    });
    if (inputInspectText) inputInspectText.addEventListener('blur', function() {
      if (vSelectedNode) {
        recordCanvasHistory();
      }
    });

    var inputInspectPriority = document.getElementById('vInspectPriority');
    if (inputInspectPriority) inputInspectPriority.addEventListener('change', function() {
      if (vSelectedNode) {
        vSelectedNode.priority = String(inputInspectPriority.value || 'Medium');
        recordCanvasHistory();
      }
    });

    var inspectPersonaEnabled = document.getElementById('vInspectPersonaEnabled');
    if (inspectPersonaEnabled) inspectPersonaEnabled.addEventListener('change', function () {
      if (!vSelectedNode || vSelectedNode.type !== 'persona') { return; }
      var meta = personaFromNode(vSelectedNode);
      if (!meta || !meta.personaId || !meta.sourceFile) {
        setCanvasNotice('This persona node is not linked to an SDLC persona definition.', 'error');
        inspectPersonaEnabled.checked = vSelectedNode.personaEnabled !== false;
        return;
      }
      vSelectedNode.personaEnabled = !!inspectPersonaEnabled.checked;
      vscode.postMessage({
        type: 'togglePersona',
        personaId: meta.personaId,
        sourceFile: meta.sourceFile,
        enabled: !!inspectPersonaEnabled.checked,
      });
      setInstructionsNote(inspectPersonaEnabled.checked ? 'Enabling persona…' : 'Disabling persona…');
      setCanvasNotice(inspectPersonaEnabled.checked ? 'Persona enabled.' : 'Persona disabled.', 'ok');
      recordCanvasHistory();
      renderPersonaRibbonTabs(lastRibbonPersonas.map(function (p) {
        if (String(p.id || '') === meta.personaId) {
          var copy = Object.assign({}, p);
          copy.enabled = !!inspectPersonaEnabled.checked;
          return copy;
        }
        return p;
      }));
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
    fitCanvasToViewport(); // Auto fit viewport to max nodes on add
    recordCanvasHistory();
  }

  function updateVInspector() {
    var panel = document.getElementById('vCanvasInspector');
    var textI = document.getElementById('vInspectText');
    var typeI = document.getElementById('vInspectType');
    var priorityI = document.getElementById('vInspectPriority');
    var personaWrap = document.getElementById('vPersonaToggleWrap');
    var personaEnabled = document.getElementById('vInspectPersonaEnabled');
    var personaMeta = document.getElementById('vInspectPersonaMeta');
    if (!panel || !textI || !typeI || !priorityI || !personaWrap || !personaEnabled || !personaMeta) return;
    if (vSelectedNode) {
      ensureNodeDefaults(vSelectedNode);
      panel.classList.remove('hidden');
      textI.value = vSelectedNode.text || '';
      typeI.value = vSelectedNode.type;
      priorityI.value = vSelectedNode.priority || 'Medium';
      textI.disabled = false;
      priorityI.disabled = false;
      if (vSelectedNode.type === 'persona') {
        var linked = personaFromNode(vSelectedNode);
        personaWrap.style.display = 'grid';
        personaEnabled.checked = vSelectedNode.personaEnabled !== false;
        if (linked && linked.personaId && linked.sourceFile) {
          personaEnabled.disabled = false;
          personaMeta.textContent = 'Linked: ' + linked.label + ' (' + linked.personaId + ')';
        } else {
          personaEnabled.disabled = true;
          personaMeta.textContent = 'Unlinked persona node (drag from top SDLC personas to link).';
        }
      } else {
        personaWrap.style.display = 'none';
      }
    } else {
      textI.value = '';
      typeI.value = 'persona';
      priorityI.value = 'Medium';
      textI.disabled = true;
      priorityI.disabled = true;
      personaWrap.style.display = 'none';
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
  setupPersonaRibbon();
  renderPersonaRibbonTabs([]);
  ensureUndoRedoButtons();
  initializeCanvasHistory();
  setupInstructionsManager();
  setupVCanvas();
  
  // Setup the Graph Minimap focusing mechanics
  if (globalThis.MinimapEngine) {
    var minContainer = document.getElementById('vMinimapContainer');
    if (minContainer) {
      minContainer.style.display = 'block';
      vMinimap = new globalThis.MinimapEngine({
        minimapContainerId: 'vMinimapContainer',
        focusRectId: 'vMinimapFocus',
        viewportLayerId: 'vNodesLayer',
        minimapSize: { width: 150, height: 150 },
        onViewportChange: function(vx, vy) {
          vPan.x = vx;
          vPan.y = vy;
          
          // Re-render coordinate viewport
          var viewport = document.getElementById('vNodesLayer');
          if (viewport) {
            viewport.style.transform = 'translate(' + vPan.x + 'px, ' + vPan.y + 'px) scale(' + vPan.scale + ')';
          }
          drawVEdges(0,0);
        }
      });
      // Initial render sync
      vMinimap.synchronize(vNodes, vPan, document.getElementById('vCanvasContainer'), vEdges);
    }
  }

  setupResizableLayout();
  setupBottomPanelToggle();
  setupCanvasKeyboardShortcuts();
  updateSelectedLinkInspector();
  renderAiSuggestion();
  renderInsights(null);
  renderReplaySelect();
  renderReplayStep();
  refreshPresetLibrary();
})();
