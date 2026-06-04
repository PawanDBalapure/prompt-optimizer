// Instructions Manager — drives the #instrMgrOverlay dialog.
//
// Loaded as a sibling before panel.js, so `vscode` (acquired in panel.js) is
// referenced lazily inside event handlers, never at load time. panel.js's
// message switch delegates to the window.* handlers defined here.

(function () {
  'use strict';

  var overlay = document.getElementById('instrMgrOverlay');
  if (!overlay) { return; }

  var chip = document.getElementById('chipInstructions');
  var btnClose = document.getElementById('btnInstrClose');
  var btnRefresh = document.getElementById('btnInstrRefresh');
  var btnExport = document.getElementById('btnInstrExport');
  var btnImport = document.getElementById('btnInstrImport');
  var btnSimulate = document.getElementById('btnInstrSimulate');
  var actionNote = document.getElementById('instrActionNote');
  var tabs = Array.prototype.slice.call(overlay.querySelectorAll('.instr-tab'));
  var conflictBadge = document.getElementById('instrConflictBadge');
  var historySelect = document.getElementById('instrHistorySelect');

  // Last overview payload, used by the priority/conflict/playground tabs.
  var lastOverview = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setNote(text, kind) {
    if (!actionNote) { return; }
    actionNote.textContent = text || '';
    actionNote.classList.remove('is-error', 'is-ok');
    if (kind) { actionNote.classList.add(kind); }
  }

  function openOverlay() {
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    setNote('Loading…');
    requestOverview();
  }

  function closeOverlay() {
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
  }

  function requestOverview() {
    vscode.postMessage({ type: 'requestInstructionsOverview' });
  }

  function activateTab(name) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    overlay.querySelectorAll('.instr-pane').forEach(function (p) {
      var on = p.id === 'instrPane' + name.charAt(0).toUpperCase() + name.slice(1);
      p.classList.toggle('is-active', on);
      p.hidden = !on;
    });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function kindClass(kind) {
    return kind === 'copilot' ? 'kind-copilot'
      : kind === 'agent' ? 'kind-agent'
      : 'kind-memory';
  }

  function conflictingUnitIds(overview) {
    var ids = {};
    (overview.conflicts || []).forEach(function (c) {
      ids[c.aId] = true;
      ids[c.bId] = true;
    });
    return ids;
  }

  function renderActive(overview) {
    var host = document.getElementById('instrActiveList');
    var present = (overview.sources || []).filter(function (s) { return s.exists && s.unitCount > 0; });
    if (present.length === 0) {
      host.innerHTML = '<div class="instr-empty">No instruction files found. Use “Open” on a source below to create one.</div>';
      // Still list creatable sources.
    }
    var conflicting = conflictingUnitIds(overview);
    var unitsBySource = {};
    (overview.units || []).forEach(function (u) {
      (unitsBySource[u.sourceId] = unitsBySource[u.sourceId] || []).push(u);
    });

    var html = (overview.sources || []).map(function (s) {
      var units = unitsBySource[s.id] || [];
      var unitHtml = units.map(function (u) {
        var cls = [];
        if (u.managed) { cls.push('is-managed'); }
        if (u.disabled) { cls.push('is-disabled'); }
        if (conflicting[u.id]) { cls.push('is-conflicting'); }
        var toggle;
        if (u.managed) {
          toggle = '<span class="instr-unit-lock" title="Auto-managed block">🔒</span>';
        } else {
          toggle = '<input type="checkbox" class="instr-unit-cb" '
            + (u.disabled ? '' : 'checked ')
            + 'data-rel="' + esc(s.relPath) + '" '
            + 'data-line="' + u.line + '" '
            + 'data-text="' + esc(u.text) + '" '
            + 'title="' + (u.disabled ? 'Disabled — select to enable' : 'Enabled — clear to disable') + '">';
        }
        return '<li class="' + cls.join(' ') + '">'
          + '<label class="instr-unit">' + toggle
          + '<span class="instr-unit-text">' + esc(u.text) + '</span></label></li>';
      }).join('');
      var meta = s.exists
        ? (s.unitCount + ' rule' + (s.unitCount === 1 ? '' : 's'))
        : 'not created';
      return ''
        + '<div class="instr-source">'
        + '  <div class="instr-source-hdr" data-open="' + esc(s.relPath) + '">'
        + '    <span class="instr-source-kind ' + kindClass(s.kind) + '">' + esc(s.kind) + '</span>'
        + '    <span class="instr-source-label">' + esc(s.label) + '</span>'
        + '    <span class="instr-source-meta">P' + s.priority + ' · ' + esc(meta) + '</span>'
        + '    <button class="instr-source-open" data-open="' + esc(s.relPath) + '">Open</button>'
        + '  </div>'
        + (units.length ? '<ul class="instr-units">' + unitHtml + '</ul>' : '')
        + '</div>';
    }).join('');

    if (present.length === 0) {
      host.innerHTML = host.innerHTML + html;
    } else {
      host.innerHTML = html;
    }
  }

  function renderPriority(overview) {
    var list = document.getElementById('instrPriorityList');
    var byId = {};
    (overview.sources || []).forEach(function (s) { byId[s.id] = s; });
    var order = (overview.priorityOrder || []);
    if (order.length === 0) {
      list.innerHTML = '<li class="instr-empty">No active instruction sources yet.</li>';
      return;
    }
    list.innerHTML = order.map(function (id) {
      var s = byId[id];
      if (!s) { return ''; }
      return '<li>'
        + '<span class="instr-prio-num">P' + s.priority + '</span> '
        + esc(s.label)
        + '<span class="instr-prio-why">' + esc(s.authority) + '</span>'
        + '</li>';
    }).join('');
  }

  function renderConflicts(overview) {
    var host = document.getElementById('instrConflictList');
    var conflicts = overview.conflicts || [];
    if (conflictBadge) {
      conflictBadge.hidden = conflicts.length === 0;
      conflictBadge.textContent = String(conflicts.length);
    }
    if (conflicts.length === 0) {
      host.innerHTML = '<div class="instr-empty">✓ No contradictions detected across active instructions.</div>';
      return;
    }
    host.innerHTML = conflicts.map(function (c) {
      return ''
        + '<div class="instr-conflict">'
        + '  <div class="instr-conflict-kind">' + esc(c.kind) + ' conflict</div>'
        + '  <div class="instr-conflict-rule">' + esc(c.aText)
        + '    <div class="instr-conflict-src">' + esc(c.aSourceLabel) + '</div></div>'
        + '  <div class="instr-conflict-rule">' + esc(c.bText)
        + '    <div class="instr-conflict-src">' + esc(c.bSourceLabel) + '</div></div>'
        + '  <div class="instr-conflict-reason">' + esc(c.reason) + '</div>'
        + '  <div class="instr-conflict-res">↳ ' + esc(c.resolution) + '</div>'
        + '  <div class="instr-conflict-fix">Fix: ' + esc(c.suggestion) + '</div>'
        + '</div>';
    }).join('');
  }

  function renderPersonas(overview) {
    var host = document.getElementById('instrPersonaList');
    if (!host) { return; }
    var personas = overview.personas || [];
    if (personas.length === 0) {
      host.innerHTML = '<div class="instr-empty">No personas are bundled with this build.</div>';
      return;
    }
    var onCount = personas.filter(function (p) { return p.enabled; }).length;
    host.innerHTML =
      '<div class="instr-persona-hint">' + onCount + ' of ' + personas.length
      + ' personas enabled. Enabling installs the persona into <code>.promptoptimizer/skills/</code>.</div>'
      + personas.map(function (p) {
        var tags = (p.tags || []).map(function (t) {
          return '<span class="instr-persona-tag">' + esc(t) + '</span>';
        }).join('');
        return ''
          + '<div class="instr-persona' + (p.enabled ? ' is-on' : '') + '">'
          + '  <label class="instr-persona-row">'
          + '    <input type="checkbox" class="instr-persona-cb" ' + (p.enabled ? 'checked ' : '')
          + '      data-id="' + esc(p.id) + '" data-src="' + esc(p.sourceFile) + '">'
          + '    <span class="instr-persona-label">' + esc(p.label) + '</span>'
          + (p.readOnly ? '<span class="instr-persona-ro">read-only</span>' : '')
          + '  </label>'
          + (p.description ? '  <div class="instr-persona-desc">' + esc(p.description) + '</div>' : '')
          + (tags ? '  <div class="instr-persona-tags">' + tags + '</div>' : '')
          + '</div>';
      }).join('');
  }

  function renderHistorySelect(overview) {
    var present = (overview.sources || []).filter(function (s) { return s.exists; });
    historySelect.innerHTML = present.map(function (s) {
      return '<option value="' + esc(s.relPath) + '">' + esc(s.label) + '</option>';
    }).join('');
    document.getElementById('instrHistoryList').innerHTML =
      present.length ? '<div class="instr-empty">Select a file to load its git history.</div>'
        : '<div class="instr-empty">No instruction files to inspect.</div>';
  }

  function requestHistory() {
    if (!historySelect || !historySelect.value) { return; }
    document.getElementById('instrHistoryList').innerHTML = '<div class="instr-empty">Loading history…</div>';
    vscode.postMessage({ type: 'instructionsHistory', relPath: historySelect.value });
  }

  // ── Playground ───────────────────────────────────────────────────────────────

  function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  }

  function simulate() {
    var input = document.getElementById('instrPlaygroundInput');
    var result = document.getElementById('instrPlaygroundResult');
    if (!lastOverview) { result.innerHTML = '<div class="instr-empty">Rescan first.</div>'; return; }
    var task = (input.value || '').trim();
    if (!task) { result.innerHTML = '<div class="instr-empty">Enter a task to simulate.</div>'; return; }

    var taskTokens = {};
    tokenize(task).forEach(function (t) { taskTokens[t] = true; });

    var active = (lastOverview.units || []).filter(function (u) { return !u.managed; });
    // Relevant = unit shares a content word with the task; otherwise it is a
    // global directive that still always applies.
    var relevant = [];
    active.forEach(function (u) {
      var toks = tokenize(u.text);
      var hit = toks.some(function (t) { return taskTokens[t]; });
      if (hit) { relevant.push(u); }
    });

    var conflictsHit = (lastOverview.conflicts || []).filter(function (c) {
      var ct = tokenize(c.aText + ' ' + c.bText);
      return ct.some(function (t) { return taskTokens[t]; });
    });

    var html = '';
    html += '<div class="instr-pg-section-title">Effective instruction stack (' + active.length + ' active)</div>';
    if (relevant.length) {
      html += relevant.map(function (u) {
        return '<div class="instr-pg-check">✓ ' + esc(u.text) + ' <span class="instr-conflict-src">(' + esc(u.sourceLabel) + ')</span></div>';
      }).join('');
    } else {
      html += '<div class="instr-empty">No source rule specifically targets this task — only global directives apply.</div>';
    }

    html += '<div class="instr-pg-section-title">Conflicts that may affect this task</div>';
    if (conflictsHit.length) {
      html += conflictsHit.map(function (c) {
        return '<div class="instr-pg-warn">⚠ ' + esc(c.reason) + ' — ' + esc(c.resolution) + '</div>';
      }).join('');
    } else {
      html += '<div class="instr-pg-check">✓ None of the detected conflicts apply to this task.</div>';
    }
    result.innerHTML = html;
  }

  // ── Message handlers (called from panel.js switch) ──────────────────────────

  window.handleInstructionsOverview = function (msg) {
    if (!msg || msg.ok === false) {
      setNote((msg && msg.error) || 'Could not load instructions.', 'is-error');
      var host = document.getElementById('instrActiveList');
      if (host) { host.innerHTML = '<div class="instr-empty">' + esc((msg && msg.error) || 'Unavailable.') + '</div>'; }
      return;
    }
    lastOverview = msg.payload || {};
    setNote(
      (lastOverview.totalUnits || 0) + ' rules · ' + (lastOverview.conflicts || []).length + ' conflict(s)',
      (lastOverview.conflicts || []).length ? null : 'is-ok'
    );
    renderActive(lastOverview);
    renderPriority(lastOverview);
    renderConflicts(lastOverview);
    renderPersonas(lastOverview);
    renderHistorySelect(lastOverview);
  };

  window.handleInstructionsHistory = function (msg) {
    var host = document.getElementById('instrHistoryList');
    if (!host) { return; }
    if (!msg || msg.ok === false) {
      host.innerHTML = '<div class="instr-empty">' + esc((msg && msg.error) || 'No history available.') + '</div>';
      return;
    }
    var commits = msg.commits || [];
    if (commits.length === 0) {
      host.innerHTML = '<div class="instr-empty">No commits recorded for this file yet.</div>';
      return;
    }
    host.innerHTML = commits.map(function (c) {
      return ''
        + '<div class="instr-commit">'
        + '  <span class="instr-commit-sha">' + esc(c.sha) + '</span>'
        + '  <span class="instr-commit-subject">' + esc(c.subject) + '</span>'
        + '  <span class="instr-commit-meta">' + esc(c.author) + ' · ' + esc(c.date) + '</span>'
        + '</div>';
    }).join('');
  };

  window.handleInstructionsActionDone = function (msg) {
    if (!msg) { return; }
    if (msg.ok) {
      setNote(msg.message || 'Done.', 'is-ok');
    } else {
      setNote(msg.error || 'Action cancelled.', msg.error ? 'is-error' : null);
      // Re-sync so an optimistic checkbox state reverts to the file's truth.
      if (overlay.getAttribute('aria-hidden') === 'false') { requestOverview(); }
    }
  };

  // ── Wiring ──────────────────────────────────────────────────────────────────

  if (chip) { chip.addEventListener('click', openOverlay); }
  if (btnClose) { btnClose.addEventListener('click', closeOverlay); }
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) { closeOverlay(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.getAttribute('aria-hidden') === 'false') { closeOverlay(); }
  });

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      var name = t.getAttribute('data-tab');
      activateTab(name);
      if (name === 'history') { requestHistory(); }
    });
  });

  if (btnRefresh) { btnRefresh.addEventListener('click', function () { setNote('Rescanning…'); requestOverview(); }); }
  if (btnExport) { btnExport.addEventListener('click', function () { setNote('Exporting…'); vscode.postMessage({ type: 'exportInstructions' }); }); }
  if (btnImport) { btnImport.addEventListener('click', function () { setNote('Importing…'); vscode.postMessage({ type: 'importInstructions' }); }); }
  if (btnSimulate) { btnSimulate.addEventListener('click', simulate); }
  if (historySelect) { historySelect.addEventListener('change', requestHistory); }

  // Delegated clicks for "Open" buttons / source headers.
  document.getElementById('instrActiveList').addEventListener('click', function (e) {
    var el = e.target.closest('[data-open]');
    if (!el) { return; }
    var rel = el.getAttribute('data-open');
    if (rel) { vscode.postMessage({ type: 'openInstructionFile', relPath: rel }); }
  });

  // Select / deselect a rule → write the change back to the source file.
  document.getElementById('instrActiveList').addEventListener('change', function (e) {
    var cb = e.target.closest && e.target.closest('.instr-unit-cb');
    if (!cb) { return; }
    var rel = cb.getAttribute('data-rel');
    var line = parseInt(cb.getAttribute('data-line'), 10);
    var text = cb.getAttribute('data-text');
    if (!rel || !text) { return; }
    setNote(cb.checked ? 'Enabling rule…' : 'Disabling rule…');
    vscode.postMessage({
      type: 'toggleInstructionRule',
      relPath: rel,
      line: isNaN(line) ? undefined : line,
      ruleText: text,
      enabled: cb.checked,
    });
  });

  // Enable / disable a persona.
  var personaList = document.getElementById('instrPersonaList');
  if (personaList) {
    personaList.addEventListener('change', function (e) {
      var cb = e.target.closest && e.target.closest('.instr-persona-cb');
      if (!cb) { return; }
      setNote(cb.checked ? 'Enabling persona…' : 'Disabling persona…');
      vscode.postMessage({
        type: 'togglePersona',
        personaId: cb.getAttribute('data-id'),
        sourceFile: cb.getAttribute('data-src'),
        enabled: cb.checked,
      });
    });
  }
})();
