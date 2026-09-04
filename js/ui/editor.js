"use strict";

  // ---------- overlay controls (read simulation state only, never mutate physics) ----------
  const toggleBtn = document.getElementById('toggleBtn');
  toggleBtn.addEventListener('click', () => {
    paused = !paused;
    toggleBtn.textContent = paused ? 'Start' : 'Pause';
  });

  const speedInput = document.getElementById('speed');
  const speedVal = document.getElementById('speedVal');
  speedInput.addEventListener('input', () => {
    speedMultiplier = parseFloat(speedInput.value);
    speedVal.textContent = speedMultiplier.toFixed(1) + 'x';
  });

  // ---------- photon editor wiring (persisted, reorderable, formula-capable) ----------
  const editorRows = document.getElementById('editorRows');

  function revalidateAll() {
    const { errors } = evaluateVariables(variables);
    const rowEls = editorRows.querySelectorAll('.var-row');
    rowEls.forEach((rowEl, idx) => {
      const exprInput = rowEl.querySelector('.var-expr');
      exprInput.classList.toggle('err', !!errors[idx]);
      exprInput.title = errors[idx] || (variables[idx].slider
        ? 'Driven by the slider below — toggle 🎚 off to type a formula instead' : '');
    });
  }

  function moveVar(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= variables.length) return;
    const tmp = variables[idx]; variables[idx] = variables[j]; variables[j] = tmp;
    saveSettings();
    renderEditorRows();
  }

  function addVar() {
    let n = variables.length + 1;
    while (variables.some(v => v.name === ('var' + n))) n++;
    variables.push({ role: null, name: 'var' + n, expr: '0', slider: false, min: 0, max: 10 });
    saveSettings();
    renderEditorRows();
  }

  function removeVar(idx) {
    if (variables[idx].role) return; // built-in rows can't be removed, only helper (role:null) ones
    variables.splice(idx, 1);
    saveSettings();
    renderEditorRows();
  }

  // switches a row between typing a formula and dragging a slider between a min/max
  // (the slider just writes a plain number literal into the same row.expr — the
  // compile/eval pipeline doesn't know or care which input mode produced it)
  function toggleVarSlider(idx) {
    const row = variables[idx];
    row.slider = !row.slider;
    if (row.slider && row.min === 0 && row.max === 10) {
      // first time this row goes into slider mode: center a range around whatever
      // plain-number value it currently holds, instead of leaving the generic 0-10
      const cur = parseFloat(row.expr);
      if (isFinite(cur)) {
        const pad = Math.max(Math.abs(cur), 1);
        row.min = cur - pad;
        row.max = cur + pad;
      }
    }
    saveSettings();
    renderEditorRows();
  }

  function renderEditorRows() {
    editorRows.innerHTML = '';
    variables.forEach((row, idx) => {
      const isCustom = !row.role;
      const el = document.createElement('div');
      el.className = 'var-row';
      el.innerHTML = `
        <div class="var-row-main">
          <div class="var-order">
            <button class="var-up" title="Move up">▲</button>
            <button class="var-down" title="Move down">▼</button>
          </div>
          <input type="text" class="var-name" spellcheck="false">
          <span>:</span>
          <input type="text" class="var-expr" spellcheck="false">
          <button class="var-slider-toggle${row.slider ? ' active' : ''}" title="Toggle slider input">🎚</button>
          ${isCustom ? '<button class="var-del" title="Delete helper variable">✕</button>' : ''}
        </div>
        <div class="var-slider-group" ${row.slider ? '' : 'hidden'}>
          <input type="number" class="var-min" step="any">
          <input type="range" class="var-range" step="any">
          <input type="number" class="var-max" step="any">
        </div>
      `;
      const nameInput = el.querySelector('.var-name');
      const exprInput = el.querySelector('.var-expr');
      const minInput = el.querySelector('.var-min');
      const maxInput = el.querySelector('.var-max');
      const rangeInput = el.querySelector('.var-range');
      nameInput.value = row.name;
      exprInput.value = row.expr;
      if (!isCustom) nameInput.title = "Built-in photon property — you can rename it, but the row can't be deleted";
      el.querySelector('.var-up').disabled = idx === 0;
      el.querySelector('.var-down').disabled = idx === variables.length - 1;

      minInput.value = row.min;
      maxInput.value = row.max;
      rangeInput.min = row.min;
      rangeInput.max = row.max;
      const curVal = parseFloat(row.expr);
      rangeInput.value = isFinite(curVal) ? curVal : (row.min + row.max) / 2;
      exprInput.readOnly = row.slider; // title is set by revalidateAll() below

      nameInput.addEventListener('input', () => {
        row.name = nameInput.value;
        saveSettings();
        revalidateAll(); // renaming can affect rows below that reference this variable
      });
      exprInput.addEventListener('input', () => {
        row.expr = exprInput.value;
        saveSettings();
        revalidateAll();
      });
      rangeInput.addEventListener('input', () => {
        exprInput.value = row.expr = rangeInput.value;
        saveSettings();
        revalidateAll();
      });
      minInput.addEventListener('change', () => {
        row.min = parseFloat(minInput.value) || 0;
        saveSettings();
        renderEditorRows();
      });
      maxInput.addEventListener('change', () => {
        row.max = parseFloat(maxInput.value) || 0;
        saveSettings();
        renderEditorRows();
      });
      el.querySelector('.var-slider-toggle').addEventListener('click', () => toggleVarSlider(idx));
      el.querySelector('.var-up').addEventListener('click', () => moveVar(idx, -1));
      el.querySelector('.var-down').addEventListener('click', () => moveVar(idx, 1));
      const delBtn = el.querySelector('.var-del');
      if (delBtn) delBtn.addEventListener('click', () => removeVar(idx));

      editorRows.appendChild(el);
    });
    revalidateAll();
  }
  renderEditorRows();
  document.getElementById('addVarBtn').addEventListener('click', addVar);

  // ---------- copy variables to clipboard (plain "name: expr" per line, no markup) ----------
  function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // fallback for contexts without the async clipboard API (e.g. a local file:// page)
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  function flashBtn(btn, symbol) {
    const original = btn.textContent;
    btn.textContent = symbol;
    setTimeout(() => { btn.textContent = original; }, 1200);
  }

  const copyVarsBtn = document.getElementById('copyVarsBtn');
  copyVarsBtn.addEventListener('click', () => {
    const text = variables.map(v => v.name + ': ' + v.expr).join('\n');
    copyTextToClipboard(text).then(() => {
      flashBtn(copyVarsBtn, '✓');
    }).catch(() => {
      flashBtn(copyVarsBtn, '✕');
    });
  });

  // ---------- export / import variables as CSV (role,name,expr) ----------
  function csvField(v) {
    return '"' + String(v).replace(/"/g, '""') + '"';
  }

  const exportVarsBtn = document.getElementById('exportVarsBtn');
  exportVarsBtn.addEventListener('click', () => {
    const rows = [['role', 'name', 'expr'], ...variables.map(v => [v.role || '', v.name, v.expr])];
    const csv = rows.map(r => r.map(csvField).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'photon-variables.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flashBtn(exportVarsBtn, '✓');
  });

  // minimal RFC4180-ish parser: handles quoted fields with embedded commas/quotes/newlines
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length > 1 || r[0] !== '');
  }

  // validates a parsed CSV against the same rules as the editor (exactly one row per
  // required role) and reports what's wrong instead of silently falling back, since
  // the user is explicitly importing a specific file and expects it to either work or fail loudly.
  function parseImportedVariables(rows) {
    if (!rows.length) return { error: 'Empty file.' };
    let dataRows = rows;
    const header = rows[0].map(h => h.trim().toLowerCase());
    if (header[0] === 'role' && header[1] === 'name' && header[2] === 'expr') dataRows = rows.slice(1);
    const parsed = dataRows.map(r => ({
      role: (r[0] || '').trim() || null,
      name: (r[1] || '').trim(),
      expr: (r[2] || '').trim(),
      slider: false, min: 0, max: 10
    })).filter(v => v.name);
    for (const v of parsed) {
      if (v.role && !REQUIRED_ROLES.includes(v.role)) return { error: `Unknown role "${v.role}" in row "${v.name}".` };
    }
    for (const role of REQUIRED_ROLES) {
      const count = parsed.filter(v => v.role === role).length;
      if (count !== 1) return { error: `Exactly one variable with role "${role}" is required (found ${count}).` };
    }
    return { vars: parsed };
  }

  const importVarsBtn = document.getElementById('importVarsBtn');
  const importVarsInput = document.getElementById('importVarsInput');
  importVarsBtn.addEventListener('click', () => importVarsInput.click());
  importVarsInput.addEventListener('change', () => {
    const file = importVarsInput.files[0];
    importVarsInput.value = ''; // reset so importing the same file again still fires 'change'
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const { vars, error } = parseImportedVariables(parseCSV(String(reader.result)));
      if (error) { alert('Failed to import CSV: ' + error); return; }
      variables = vars;
      saveSettings();
      renderEditorRows();
      flashBtn(importVarsBtn, '✓');
    };
    reader.onerror = () => alert('Failed to read the file.');
    reader.readAsText(file);
  });

