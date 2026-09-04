"use strict";

  // ---------- canvas / world setup ----------
  const canvas = document.getElementById('sim');
  const ctx = canvas.getContext('2d');

  let W = 0, H = 0;
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W;
    canvas.height = H;
  }
  resize();
  window.addEventListener('resize', resize);

  // ---------- toroidal helpers (the "obwarzanek": edges wrap around) ----------
  function wrap(v, max) {
    v = v % max;
    if (v < 0) v += max;
    return v;
  }
  function wrapDelta(d, max) {
    d = d % max;
    if (d > max / 2) d -= max;
    if (d < -max / 2) d += max;
    return d;
  }
  function rand(min, max) { return min + Math.random() * (max - min); }

  // ---------- camera: mouse-wheel zoom ----------
  // zoom 1 = the default view (world fills the screen 1:1). Camera zoom can go both
  // ways from there: in, to inspect small clusters closely, or out, to see more of
  // the toroidal world at once. camX/camY is the world point that lands at screen
  // (0,0); left un-wrapped (can be any real number) so the tile loop in render() can
  // treat the world as a plane tiled every W/H, which is what makes the wraparound
  // visible when zoomed out.
  let zoom = 1, camX = 0, camY = 0;
  const MIN_ZOOM = 0.35, MAX_ZOOM = 8;

  function screenToWorld(sx, sy) {
    return { x: wrap(sx / zoom + camX, W), y: wrap(sy / zoom + camY, H) };
  }

  // log scale so the indicator has even resolution across the whole 0.35x-8x range,
  // instead of the top half of the range (1x-8x) squeezing into a sliver of the bar
  const zoomLabelEl = document.getElementById('zoomLabel');
  const zoomFillEl = document.getElementById('zoomFill');
  const zoomLogSpan = Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM);
  function zoomToFraction(z) { return (Math.log(z) - Math.log(MIN_ZOOM)) / zoomLogSpan; }
  document.getElementById('zoomDefaultTick').style.bottom = (zoomToFraction(1) * 100) + '%';
  function updateZoomIndicator() {
    zoomLabelEl.textContent = zoom.toFixed(zoom < 1 ? 2 : 1) + '×';
    zoomFillEl.style.height = (zoomToFraction(zoom) * 100) + '%';
  }
  updateZoomIndicator();

  // ---------- persisted settings: photon editor variables + rules ----------
  const LS_KEY = 'photonSim.settings.v10'; // v10: added the phaseShift role
  // each row: { role, name, expr }. Rows with a "role" feed directly into the photon
  // (charge / mass / maxSpeed / energy / force / forceRange / periods) — exactly one
  // row per required role, and role never changes. Rows with role:null are helper/
  // intermediate variables: they don't feed the photon directly, they just exist so a
  // later row's expr can reference them by name. "name" and "expr" are freely
  // editable, array order = evaluation order (a row can only reference names defined
  // above it).
  //
  // Physics model: instead of separate repel/attract zones, the force between two
  // photons is one continuous sinusoidal wave over distance — f(d) = force * sin(2π *
  // periods * d / forceRange) * (1 - d/forceRange), sign-flipped for same-charge pairs.
  // That gives naturally repeating attract/repel "shells" out to forceRange, controlled
  // by how many wave "periods" fit in it — see step() for the exact formula.
  const REQUIRED_ROLES = ['charge', 'mass', 'speed', 'energy', 'force', 'forceRange', 'periods', 'waveOffset', 'phaseShift'];
  const DEFAULT_VARS = [
    { role: 'charge', name: 'charge', expr: 'rand(-1, 1)' },
    { role: 'mass',   name: 'mass',   expr: 'rand(0.5, 3)' },
    { role: 'speed',  name: 'speed',  expr: '100 / mass' },
    { role: 'energy', name: 'energy', expr: '9' },
    { role: 'force',  name: 'force',  expr: 'abs(charge) * 5000' },
    { role: 'forceRange', name: 'forceRange', expr: 'abs(charge) * 50' },
    // helper: how many wave periods energy gets divided into below — tune this
    // instead of the literal divisor to control period count independently
    { role: null, name: 'pcount', expr: '3' },
    { role: 'periods', name: 'periods', expr: 'energy / pcount' },
    // shifts the pairwise force wave up before it's rescaled back (see waveTerm()):
    // 0 = classic wave (can attract same charge in some shells), 1 = never flips sign
    { role: 'waveOffset', name: 'waveOffset', expr: '1' },
    // horizontal counterpart to waveOffset: slides the wave sideways along distance,
    // in units of one full period (0.5 = shift by half a period, wraps every 1.0)
    { role: 'phaseShift', name: 'phaseShift', expr: '0' }
  ];
  const ROLE_FALLBACK = { charge: 0, mass: 1, speed: 50, energy: 10, force: 1000, forceRange: 100, periods: 2, waveOffset: 0, phaseShift: 0 };

  function normalizeVariables(arr) {
    const ok = Array.isArray(arr) && arr.length >= REQUIRED_ROLES.length
      && REQUIRED_ROLES.every(r => arr.filter(v => v && v.role === r).length === 1)
      && arr.every(v => v && typeof v.name === 'string' && typeof v.expr === 'string'
        && (v.role == null || REQUIRED_ROLES.includes(v.role)));
    return (ok ? arr : DEFAULT_VARS).map(v => ({
      role: v.role || null, name: v.name, expr: v.expr,
      // optional slider input mode: lets a row's number be dragged between min/max
      // instead of typed as a formula — expr still just holds the resulting literal
      slider: !!v.slider,
      min: typeof v.min === 'number' && isFinite(v.min) ? v.min : 0,
      max: typeof v.max === 'number' && isFinite(v.max) ? v.max : 10
    }));
  }
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  const saved = loadSettings();
  let variables = normalizeVariables(saved && saved.variables);
  // no rules yet — foundation first. Nothing besides your own variables/formulas
  // is allowed to change a photon's speed until we build rules on top of this.

  function saveSettings() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ variables }));
    } catch (e) { /* ignore (e.g. storage disabled) */ }
    compiledVarsCache = compileVariables(variables);
    schedulePhotonRefresh(); // apply the edit to every existing photon, not just new spawns
  }

  function sanitizeIdentifier(name) {
    let s = String(name || '').trim().replace(/[^a-zA-Z0-9_]/g, '_');
    if (!s) return null;
    if (/^[0-9]/.test(s)) s = '_' + s;
    return s;
  }

  // helper functions available inside every expression field, besides other variables
  const HELPER_NAMES = ['rand', 'abs', 'min', 'max', 'sqrt', 'pow', 'round', 'floor', 'ceil'];
  const HELPER_FNS = [rand, Math.abs, Math.min, Math.max, Math.sqrt, Math.pow, Math.round, Math.floor, Math.ceil];

  // Compiles each row's expression into a reusable function once. Split out from
  // running so a live refresh across many photons only pays the (relatively
  // expensive) `new Function` compile cost once per edit, not once per photon.
  function compileVariables(vars) {
    const namesSoFar = [];
    const usedNames = new Set(HELPER_NAMES); // reserved: colliding with a helper is also a naming conflict
    return vars.map((row, i) => {
      let safeName = sanitizeIdentifier(row.name) || ('v' + i);
      let fn = null, compileError = null;
      if (usedNames.has(safeName)) {
        // new Function() would throw "Duplicate parameter name" here, which would
        // also poison every row below it (they'd all inherit the clashing name via
        // namesSoFar). Instead: flag only this row, and rename it internally so
        // later rows keep compiling — the earlier row keeps the name for real use.
        compileError = `name "${row.name}" is already taken by another variable (or it's a function name: ${HELPER_NAMES.join(', ')})`;
        safeName = safeName + '_' + i;
      } else {
        try {
          fn = new Function(...namesSoFar, ...HELPER_NAMES,
            '"use strict"; const v = (' + row.expr + '); ' +
            'if (typeof v !== "number" || !isFinite(v)) throw new Error("result is not a number"); return v;');
        } catch (e) {
          compileError = e.message || 'syntax error';
        }
      }
      usedNames.add(safeName);
      const compiled = { row, safeName, fn, compileError, argNames: namesSoFar.slice() };
      namesSoFar.push(safeName);
      return compiled;
    });
  }

  // Runs already-compiled rows in order. "overrides" lets a role's value be pinned
  // to an existing photon's own charge/mass instead of re-evaluating its formula —
  // used for the live refresh, so photons keep their identity while everything
  // derived from it (speed, ranges, forces) recomputes with the current formulas.
  function runCompiled(compiled, overrides) {
    const scope = {};
    const results = {};
    const errors = {};
    for (let i = 0; i < compiled.length; i++) {
      const { row, safeName, fn, compileError, argNames } = compiled[i];
      let value, error = compileError;
      if (overrides && row.role && Object.prototype.hasOwnProperty.call(overrides, row.role)) {
        value = overrides[row.role];
      } else if (fn) {
        try {
          value = fn(...argNames.map(n => scope[n]), ...HELPER_FNS);
        } catch (e) {
          value = row.role ? ROLE_FALLBACK[row.role] : 0;
          error = e.message || 'expression error';
        }
      } else {
        value = row.role ? ROLE_FALLBACK[row.role] : 0;
      }
      scope[safeName] = value;
      if (row.role) results[row.role] = value; // helper rows (role:null) only live in scope
      errors[i] = error;
    }
    return { results, errors };
  }

  // convenience one-shot evaluation (compiles + runs once) — fine for single uses
  // like spawning one photon or validating the editor; refreshAllPhotons() below
  // uses compileVariables/runCompiled directly to avoid recompiling per photon.
  function evaluateVariables(vars, overrides) {
    return runCompiled(compileVariables(vars), overrides);
  }

  // shared compiled cache, rebuilt in saveSettings() whenever variables change —
  // used by refreshAllPhotons() and the force-preview window so neither has to
  // recompile the formulas on every photon / every animation frame.
  let compiledVarsCache = compileVariables(variables);

  function clampNum(v, lo, hi, fallback) {
    if (typeof v !== 'number' || !isFinite(v)) return fallback;
    return Math.max(lo, Math.min(hi, v));
  }

