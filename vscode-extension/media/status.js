const vscode = acquireVsCodeApi();
    let currentState = null;

    const el = id => document.getElementById(id);
    const fmt = v => '$' + Number(v || 0).toFixed(5);

    function cacheInfo(status, confidence) {
      if (status === 'exact')    return { cls: 'dot-hit', label: 'exact cache hit' };
      if (status === 'semantic') return { cls: 'dot-sem', label: 'semantic (' + Math.round((confidence || 0) * 100) + '%)' };
      return { cls: 'dot-miss', label: 'cache miss' };
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
      el('alerts').querySelectorAll('[data-secret-matched]').forEach(function(alertEl) {
        if (alertEl.getAttribute('data-secret-matched').toLowerCase() === matchedText.toLowerCase()) { alertEl.remove(); }
      });
    }

    function renderState(state) {
      currentState = state;
      const m = state.metrics, a = state.analysis;
      const pct = m.raw_input_tokens > 0 ? Math.round(m.tokens_saved / m.raw_input_tokens * 100) : 0;

      el('savingsPct').textContent = pct + '%';
      el('progressFill').style.width = Math.min(pct, 100) + '%';
      el('savingsMeta').textContent = m.tokens_saved + ' tokens saved \xb7 ' + fmt(a.cost.total_cost_usd);

      const ci = cacheInfo(a.cache.status, a.cache.confidence);
      const dot = document.createElement('span');
      dot.className = 'dot ' + ci.cls;
      const cacheEl = el('infoCache');
      cacheEl.textContent = '';
      cacheEl.appendChild(dot);
      cacheEl.appendChild(document.createTextNode(' ' + ci.label));

      el('infoTokens').textContent = m.raw_input_tokens + ' \u2192 ' + m.optimized_input_tokens;
      el('infoOutput').textContent = m.estimated_output_tokens + ' tokens';
      el('infoCost').textContent = fmt(a.cost.total_cost_usd);

      el('optimizedText').textContent = state.optimized;
      el('optSection').style.display = 'block';

      const statusGrid = el('statusDiagnosticsGrid');
      statusGrid.innerHTML = '';
      const diagnostics = state.diagnostics || [];
      if (diagnostics.length === 0) {
        const li = document.createElement('li');
        li.style.color = 'var(--vscode-terminal-ansiGreen, #4ec94e)';
        li.style.fontSize = '11px';
        li.innerHTML = '<span aria-hidden="true">\u2714</span> No lint warnings detected. Optimal!';
        statusGrid.appendChild(li);
      } else {
        diagnostics.forEach(function(diag) {
          const li = document.createElement('li');
          li.style.borderBottom = '1px solid rgba(127,127,127,0.1)';
          li.style.padding = '5px 0';
          const badge = diag.severity === 'warning' ? '\u26a0\ufe0f' : '\u2139\ufe0f';
          const color = diag.severity === 'warning' ? '#f8d775' : '#70bdf6';
          li.innerHTML =
            '<span style="font-weight:600;color:' + color + '" aria-label="' + escHtml(diag.severity) + '">' +
            badge + ' [' + escHtml(diag.code) + ']</span>: ' + escHtml(diag.message) +
            '<br/><span style="font-size:11px;display:block;margin-top:3px;font-style:italic;color:var(--vscode-descriptionForeground)">' +
            '\ud83d\udca1 Suggestion: ' + escHtml(diag.fix_suggestion) + '</span>';
          statusGrid.appendChild(li);
        });
      }
      el('diagSection').style.display = 'block';

      el('promptInput').value = state.original;
      el('loading').style.display = 'none';
      el('loading').setAttribute('aria-hidden', 'true');
      el('alerts').innerHTML = '';

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
              highlightSecretInOutput(this.getAttribute('data-matched'), el('optimizedText'));
              el('optSection').style.display = 'block';
            });
            d.appendChild(btn);
          }
          el('alerts').appendChild(d);
        });
      } else {
        (state.warnings || []).forEach(function(w) {
          const d = document.createElement('div');
          d.className = 'alert-item alert-warning';
          d.textContent = '\u26a0\ufe0f  ' + w;
          el('alerts').appendChild(d);
        });
      }
      if (state.secretDetectionEnabled === false) {
        const d = document.createElement('div');
        d.className = 'alert-item alert-warning';
        d.textContent = '\uD83D\uDD15 Secret detection is disabled \u2014 enable it in settings to scan prompts for secrets.';
        el('alerts').appendChild(d);
      }
    }

    el('btnAnalyze').addEventListener('click', function() {
      const text = el('promptInput').value.trim();
      if (!text) {
        el('alerts').innerHTML = '';
        const d = document.createElement('div');
        d.className = 'alert-item alert-error';
        d.textContent = '\u2715  Enter a prompt to analyze.';
        el('alerts').appendChild(d);
        return;
      }
      el('alerts').innerHTML = '';
      el('loading').style.display = 'block';
      el('loading').setAttribute('aria-hidden', 'false');
      vscode.postMessage({ type: 'analyze', prompt: text });
    });

    el('promptInput').addEventListener('keydown', function(event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        el('btnAnalyze').click();
      } else if (event.key === 'Escape') {
        el('alerts').innerHTML = '';
        el('loading').style.display = 'none';
        el('loading').setAttribute('aria-hidden', 'true');
      }
    });

    el('btnOpenChat').addEventListener('click',  () => vscode.postMessage({ type: 'openChat' }));
    el('btnSettings').addEventListener('click',  () => vscode.postMessage({ type: 'openSettings' }));
    el('btnClose').addEventListener('click',     () => vscode.postMessage({ type: 'close' }));

    el('targetModelSelect').addEventListener('change', function() {
      vscode.postMessage({ type: 'setTargetModel', model: el('targetModelSelect').value });
    });

    el('optimizedText').addEventListener('click', function(e) {
      var btn = e.target.closest('.secret-del');
      if (btn) { removeSecretFromOutput(btn.getAttribute('data-remove'), el('optimizedText')); }
    });

    el('btnCopyOptimized').addEventListener('click', function() {
      if (!currentState || !currentState.optimized) {
        el('alerts').innerHTML = '';
        const d = document.createElement('div');
        d.className = 'alert-item alert-warning';
        d.textContent = '\u26a0\ufe0f  Analyze a prompt first.';
        el('alerts').appendChild(d);
        return;
      }
      vscode.postMessage({ type: 'copyPrompt', prompt: currentState.optimized });
    });

    el('btnSendToChat').addEventListener('click', function() {
      if (!currentState || !currentState.optimized) {
        el('alerts').innerHTML = '';
        const d = document.createElement('div');
        d.className = 'alert-item alert-warning';
        d.textContent = '\u26a0\ufe0f  Analyze a prompt first.';
        el('alerts').appendChild(d);
        return;
      }
      vscode.postMessage({ type: 'sendPrompt', prompt: currentState.optimized });
    });

    window.addEventListener('message', function(event) {
      const msg = event.data;
      switch (msg.type) {
        case 'analysisState':
          renderState(msg.payload);
          break;
        case 'targetModelPattern':
          el('targetModelSelect').value = msg.model;
          break;
        case 'error': {
          el('loading').style.display = 'none';
          el('loading').setAttribute('aria-hidden', 'true');
          el('alerts').innerHTML = '';
          const d = document.createElement('div');
          d.className = 'alert-item alert-error';
          d.textContent = '\u2715  ' + (msg.message || 'Failed to analyze.');
          el('alerts').appendChild(d);
          break;
        }
      }
    });

    vscode.postMessage({ type: 'ready' });