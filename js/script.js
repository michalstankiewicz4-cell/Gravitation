(function () {
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
  const LS_KEY = 'photonSim.settings.v7';
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
  const REQUIRED_ROLES = ['charge', 'mass', 'speed', 'energy', 'force', 'forceRange', 'periods'];
  const DEFAULT_VARS = [
    { role: 'charge', name: 'charge', expr: 'rand(-1, 1)' },
    { role: 'mass',   name: 'mass',   expr: 'rand(0.5, 3)' },
    { role: 'speed',  name: 'speed',  expr: '100 / mass' },
    { role: 'energy', name: 'energy', expr: '10.5' },
    { role: 'force',  name: 'force',  expr: 'abs(charge) * 5000' },
    { role: 'forceRange', name: 'forceRange', expr: '100 + abs(charge) * 100' },
    { role: 'periods', name: 'periods', expr: 'energy / 4' }
  ];
  const ROLE_FALLBACK = { charge: 0, mass: 1, speed: 50, energy: 10, force: 1000, forceRange: 100, periods: 2 };

  function normalizeVariables(arr) {
    const ok = Array.isArray(arr) && arr.length >= REQUIRED_ROLES.length
      && REQUIRED_ROLES.every(r => arr.filter(v => v && v.role === r).length === 1)
      && arr.every(v => v && typeof v.name === 'string' && typeof v.expr === 'string'
        && (v.role == null || REQUIRED_ROLES.includes(v.role)));
    if (!ok) return DEFAULT_VARS.map(v => Object.assign({}, v));
    return arr.map(v => ({ role: v.role || null, name: v.name, expr: v.expr }));
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
        compileError = `nazwa "${row.name}" jest już zajęta przez inną zmienną (lub to nazwa funkcji: ${HELPER_NAMES.join(', ')})`;
        safeName = safeName + '_' + i;
      } else {
        try {
          fn = new Function(...namesSoFar, ...HELPER_NAMES,
            '"use strict"; const v = (' + row.expr + '); ' +
            'if (typeof v !== "number" || !isFinite(v)) throw new Error("wynik nie jest liczbą"); return v;');
        } catch (e) {
          compileError = e.message || 'błąd składni';
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
          error = e.message || 'błąd wyrażenia';
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

  // ---------- photon model ----------
  let nextId = 1;
  const PHOTON_RADIUS = 1; // fixed 1px visual size
  const MAX_PHOTONS = 3000;

  function makePhoton() {
    const { results } = runCompiled(compiledVarsCache);
    const charge = clampNum(results.charge, -10, 10, 0);
    const mass = clampNum(results.mass, 0.05, 1000, 1);
    const maxSpeed = clampNum(results.speed, 0, 5000, 0);
    const energy = clampNum(results.energy, -1000, 1000, 10);
    const force = clampNum(results.force, 0, 1000000, 1000);
    const forceRange = clampNum(results.forceRange, 5, 4000, 100);
    const periods = clampNum(results.periods, -50, 50, 2);
    const angle = rand(0, Math.PI * 2);
    const initSpeed = maxSpeed; // speed is always locked to the formula value — see step()
    return {
      id: nextId++,
      x: rand(0, W), y: rand(0, H),
      vx: Math.cos(angle) * initSpeed, vy: Math.sin(angle) * initSpeed,
      charge, mass, maxSpeed, energy, force, forceRange, periods,
      radius: PHOTON_RADIUS
    };
  }

  // start with an empty board — photons only appear via the "spawn" brush
  let photons = [];

  // Live-updates every existing photon when the editor changes: each photon keeps
  // its own charge/mass/energy (its "identity"), everything else derived from them
  // (speed cap, ranges, forces) is recomputed with the current formulas. Compiling
  // once and reusing across all photons keeps this fast even at a few thousand photons.
  function refreshAllPhotons() {
    if (photons.length === 0) return;
    for (const p of photons) {
      const { results } = runCompiled(compiledVarsCache, { charge: p.charge, mass: p.mass, energy: p.energy });
      p.maxSpeed = clampNum(results.speed, 0, 5000, p.maxSpeed);
      p.energy = clampNum(results.energy, -1000, 1000, p.energy);
      p.force = clampNum(results.force, 0, 1000000, p.force);
      p.forceRange = clampNum(results.forceRange, 5, 4000, p.forceRange);
      p.periods = clampNum(results.periods, -50, 50, p.periods);
    }
  }

  let refreshTimer = null;
  function schedulePhotonRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshAllPhotons, 150);
  }

  // shared white<->blue/orange blend for a signed fraction t in [-1, 1] (0 = white)
  function blendChargeColor(t, alpha) {
    let r, g, b;
    if (t >= 0) {
      r = 255; g = Math.round(255 - t * 120); b = Math.round(255 - t * 210);
    } else {
      const s = -t;
      r = Math.round(255 - s * 210); g = Math.round(255 - s * 90); b = 255;
    }
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function colorForCharge(q, alpha) {
    // no gradient: just three flat colors — negative = cool blue, 0 = white, positive = warm orange
    return blendChargeColor(q > 0 ? 1 : q < 0 ? -1 : 0, alpha);
  }

  // ---------- color filter: how photons are colored ----------
  let colorMode = 'default'; // 'default' (flat ±/0) | 'intensity' (charge, scaled to range in play) | 'speed'
  let maxAbsChargeSeen = 1;
  function updateChargeRange() {
    let m = 0;
    for (const p of photons) { const a = Math.abs(p.charge); if (a > m) m = a; }
    maxAbsChargeSeen = m || 1; // avoid div-by-zero when every photon has charge 0
  }
  function colorForChargeIntensity(q, alpha) {
    // same white<->blue/orange blend, but normalized to whatever the strongest
    // charge currently in the sim is, instead of a fixed ±1 — so 0 is always white
    // and the most extreme photons present always reach full color, regardless of
    // what range the editor's charge formula actually produces.
    return blendChargeColor(Math.max(-1, Math.min(1, q / maxAbsChargeSeen)), alpha);
  }

  // min/max normalization looked broken for the default speed formula (100/mass):
  // most photons bunch up at the slow end with a few fast outliers stretching the
  // max, so almost everyone landed near the red end of a linear scale. Ranking by
  // percentile instead spreads the colors evenly across whatever photons are
  // actually present, regardless of how skewed the underlying speed distribution is.
  let speedRank = new Map(); // photon id -> percentile in [0,1], 1 = fastest
  function updateSpeedRange() {
    speedRank = new Map();
    const n = photons.length;
    if (n === 0) return;
    const sorted = photons.slice().sort((a, b) => a.maxSpeed - b.maxSpeed);
    for (let i = 0; i < n; i++) speedRank.set(sorted[i].id, n > 1 ? i / (n - 1) : 1);
  }
  function colorForSpeed(p, alpha) {
    // white = fastest photon currently in the sim, red = slowest
    const t = speedRank.has(p.id) ? speedRank.get(p.id) : 1;
    const g = Math.round(255 * t);
    return `rgba(255,${g},${g},${alpha})`;
  }

  function photonColor(p, alpha) {
    if (colorMode === 'intensity') return colorForChargeIntensity(p.charge, alpha);
    if (colorMode === 'speed') return colorForSpeed(p, alpha);
    return colorForCharge(p.charge, alpha);
  }

  // ---------- physics ----------
  // Force between two photons is one continuous sine wave over distance instead of
  // separate repel/attract zones — see the pairwise loop in step() for the formula.
  // HARD_CORE_* is a small, fixed (not user-editable) safety repulsion: sin(0) = 0,
  // so without this nothing would stop two photons from landing on the same point.
  const HARD_CORE_R = 1;
  const HARD_CORE_K = 4000;
  const BRUSH_RADIUS = 160;    // reach of the "przyciąganie" brush
  const BRUSH_STRENGTH = 2600; // pull strength of the "przyciąganie" brush

  let collisionCount = 0;
  let activeCollisionPairs = new Set();

  function step(dt) {
    const n = photons.length;
    if (n === 0) return;
    const ax = new Float64Array(n), ay = new Float64Array(n);

    // ---- spatial grid (keeps pairwise checks near O(n) instead of O(n^2)) ----
    // cell size must stay >= the largest forceRange in play, or the 3x3-neighborhood
    // search below could miss valid interactions. Recomputed fresh every step (not
    // ratcheted up-only) so the grid shrinks back down after a wide-range photon is
    // removed or its formula is edited down, instead of staying oversized all session.
    let maxRange = 0;
    for (let i = 0; i < n; i++) if (photons[i].forceRange > maxRange) maxRange = photons[i].forceRange;
    const GRID_CELL = Math.max(100, maxRange + 20);
    const cols = Math.max(1, Math.floor(W / GRID_CELL));
    const rows = Math.max(1, Math.floor(H / GRID_CELL));
    const cellW = W / cols, cellH = H / rows;
    const cells = new Array(cols * rows);
    for (let i = 0; i < cells.length; i++) cells[i] = [];
    for (let i = 0; i < n; i++) {
      const p = photons[i];
      const cx = Math.min(cols - 1, Math.floor(p.x / cellW));
      const cy = Math.min(rows - 1, Math.floor(p.y / cellH));
      cells[cy * cols + cx].push(i);
    }

    const newCollisionPairs = new Set();

    for (let i = 0; i < n; i++) {
      const a = photons[i];
      const cx = Math.min(cols - 1, Math.floor(a.x / cellW));
      const cy = Math.min(rows - 1, Math.floor(a.y / cellH));
      const neighborCells = new Set();
      for (let ddx = -1; ddx <= 1; ddx++) {
        for (let ddy = -1; ddy <= 1; ddy++) {
          const nx = ((cx + ddx) % cols + cols) % cols;
          const ny = ((cy + ddy) % rows + rows) % rows;
          neighborCells.add(ny * cols + nx);
        }
      }
      for (const ci of neighborCells) {
        const list = cells[ci];
        for (let k = 0; k < list.length; k++) {
          const j = list[k];
          if (j <= i) continue;
          const b = photons[j];

          let dx = wrapDelta(b.x - a.x, W);
          let dy = wrapDelta(b.y - a.y, H);
          let d = Math.sqrt(dx * dx + dy * dy);
          if (d < 0.01) {
            // random direction, but dx/dy must actually have length d for ux/uy below to stay a unit vector
            const ang = Math.random() * Math.PI * 2;
            d = 0.1;
            dx = Math.cos(ang) * d; dy = Math.sin(ang) * d;
          }

          // real collision: the two photon circles actually overlap
          if (d < a.radius + b.radius) {
            newCollisionPairs.add(a.id < b.id ? (a.id + '_' + b.id) : (b.id + '_' + a.id));
          }

          const range = (a.forceRange + b.forceRange) / 2;

          if (d >= range) continue;

          const ux = dx / d, uy = dy / d;
          let f = 0; // positive f = attract (pulls a toward b), negative = repel

          if (d < HARD_CORE_R) {
            // fixed safety net near d=0 — the sine itself gives zero force there
            const falloff = 1 - d / HARD_CORE_R;
            f = -HARD_CORE_K * falloff / (d + 2);
          } else {
            // one continuous wave out to "range": force amplitude, wave count
            // ("periods") and the range itself all come from the two photons' own
            // formulas. Same-charge pairs get the wave inverted (phaseSign), which
            // is the same as shifting it by half a period — so at any given ring,
            // opposite charges pull together while same charges push apart, and
            // that flips again at the next ring, and so on.
            const amp = (a.force + b.force) / 2;
            const periodsAvg = (a.periods + b.periods) / 2;
            const chargeProduct = a.charge * b.charge;
            const phaseSign = chargeProduct < 0 ? 1 : -1;
            const envelope = 1 - d / range; // fades to 0 at the outer edge, no hard jump
            f = phaseSign * amp * Math.sin(2 * Math.PI * periodsAvg * d / range) * envelope;
          }

          const fx = ux * f, fy = uy * f;
          ax[i] += fx; ay[i] += fy;
          ax[j] -= fx; ay[j] -= fy;
        }
      }
    }

    for (const key of newCollisionPairs) {
      if (!activeCollisionPairs.has(key)) collisionCount++;
    }
    activeCollisionPairs = newCollisionPairs;

    // "przyciąganie" brush: while held, pull matching-charge photons toward the cursor
    if (currentTool === 'attract' && mouseDown) {
      for (let i = 0; i < n; i++) {
        const p = photons[i];
        if (attractCharge === 'pos' && p.charge <= 0) continue;
        if (attractCharge === 'neg' && p.charge >= 0) continue;
        const dx = wrapDelta(curX - p.x, W);
        const dy = wrapDelta(curY - p.y, H);
        const d = Math.hypot(dx, dy);
        if (d < 1 || d > BRUSH_RADIUS) continue;
        const pull = BRUSH_STRENGTH * (1 - d / BRUSH_RADIUS);
        ax[i] += (dx / d) * pull;
        ay[i] += (dy / d) * pull;
      }
    }

    for (let i = 0; i < n; i++) {
      const p = photons[i];
      // F = m*a, so acceleration is the force divided by the photon's mass
      p.vx = p.vx + (ax[i] / p.mass) * dt;
      p.vy = p.vy + (ay[i] / p.mass) * dt;

      // foundation rule (not optional yet): speed is always exactly the value
      // from your "speed" formula (p.maxSpeed) — forces only steer direction
      const target = p.maxSpeed;
      const s = Math.hypot(p.vx, p.vy);
      if (s > 0.0001) {
        const k = target / s;
        p.vx *= k; p.vy *= k;
      } else {
        const ang = rand(0, Math.PI * 2);
        p.vx = Math.cos(ang) * target;
        p.vy = Math.sin(ang) * target;
      }

      p.x = wrap(p.x + p.vx * dt, W);
      p.y = wrap(p.y + p.vy * dt, H);
    }
  }

  // ---------- rendering ----------
  function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-camX, -camY);

    // zoomed out past one screenful: figure out which repeats ("tiles") of the
    // toroidal world are actually in view, so wrapping is visible instead of just
    // fading to background past the edge of the default screenful.
    const viewW = W / zoom, viewH = H / zoom;
    const tileMinX = Math.floor(camX / W), tileMaxX = Math.floor((camX + viewW - 0.01) / W);
    const tileMinY = Math.floor(camY / H), tileMaxY = Math.floor((camY + viewH - 0.01) / H);

    const glow = photons.length <= 500 && zoom > 0.6; // skip glow when it'd cost too many draws
    ctx.shadowBlur = glow ? 12 : 0;

    if (colorMode === 'intensity') updateChargeRange();
    else if (colorMode === 'speed') updateSpeedRange();

    for (const p of photons) {
      const isSelected = openInfoWindows.has(p.id);
      const isInList = listSelection.has(p.id);
      const color = photonColor(p, 0.95);
      if (glow) ctx.shadowColor = color;
      ctx.fillStyle = color;
      for (let tx = tileMinX; tx <= tileMaxX; tx++) {
        for (let ty = tileMinY; ty <= tileMaxY; ty++) {
          const px = p.x + tx * W, py = p.y + ty * H;
          ctx.beginPath();
          ctx.arc(px, py, p.radius, 0, Math.PI * 2);
          ctx.fill();

          if (isInList || isSelected) {
            ctx.beginPath();
            ctx.arc(px, py, p.radius + (isSelected ? 7 : 4.5), 0, Math.PI * 2);
            ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.55)';
            ctx.lineWidth = isSelected ? 2 : 1.2;
            ctx.stroke();
          }
        }
      }
    }
    ctx.shadowBlur = 0;

    if (dragging && rectActive && currentTool === 'select') {
      const r = normalizedRect();
      ctx.fillStyle = 'rgba(120,160,255,0.12)';
      ctx.strokeStyle = 'rgba(160,190,255,0.7)';
      ctx.lineWidth = 1;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    // brush cursor preview
    if (currentTool === 'attract' && curX > -1000) {
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = attractCharge === 'pos' ? 'rgba(255,170,90,0.75)'
        : attractCharge === 'neg' ? 'rgba(120,170,255,0.75)'
        : 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.arc(curX, curY, BRUSH_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (currentTool === 'spawn' && curX > -1000) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(140,255,170,0.85)';
      ctx.beginPath();
      ctx.arc(curX, curY, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  // ---------- stats panel ----------
  const statTotal = document.getElementById('statTotal');
  const statPos = document.getElementById('statPos');
  const statNeg = document.getElementById('statNeg');
  const statCollisions = document.getElementById('statCollisions');
  const statAvgSpeed = document.getElementById('statAvgSpeed');

  function updateStats() {
    let pos = 0, neg = 0, speedSum = 0;
    for (const p of photons) {
      if (p.charge > 0) pos++; else if (p.charge < 0) neg++;
      speedSum += p.maxSpeed;
    }
    statTotal.textContent = photons.length;
    statPos.textContent = pos;
    statNeg.textContent = neg;
    statCollisions.textContent = collisionCount;
    statAvgSpeed.textContent = (photons.length ? speedSum / photons.length : 0).toFixed(1) + ' px/s';
  }

  // ---------- stats panel settings: which rows are shown, persisted ----------
  const STATS_LS_KEY = 'photonSim.statVisibility.v1';
  const DEFAULT_STAT_VISIBILITY = { total: true, pos: true, neg: true, collisions: true, avgSpeed: false };
  function loadStatVisibility() {
    try {
      const raw = localStorage.getItem(STATS_LS_KEY);
      return raw ? Object.assign({}, DEFAULT_STAT_VISIBILITY, JSON.parse(raw)) : Object.assign({}, DEFAULT_STAT_VISIBILITY);
    } catch (e) { return Object.assign({}, DEFAULT_STAT_VISIBILITY); }
  }
  const statVisibility = loadStatVisibility();
  function saveStatVisibility() {
    try { localStorage.setItem(STATS_LS_KEY, JSON.stringify(statVisibility)); } catch (e) { /* ignore */ }
  }
  function applyStatVisibility() {
    document.querySelectorAll('#winStats .row[data-stat-row]').forEach(row => {
      row.classList.toggle('hidden', !statVisibility[row.dataset.statRow]);
    });
  }
  document.querySelectorAll('.stat-toggle').forEach(cb => {
    cb.checked = !!statVisibility[cb.dataset.stat];
    cb.addEventListener('change', () => {
      statVisibility[cb.dataset.stat] = cb.checked;
      saveStatVisibility();
      applyStatVisibility();
    });
  });
  applyStatVisibility();
  // drag/minimize wiring for winStatConfig lives further down, alongside the other
  // window-manager setup (makeDraggable etc. aren't ready to use this early)

  // ---------- force preview window ----------
  const winForceEl = document.getElementById('winForce');
  const forceCanvas = document.getElementById('forceCanvas');
  const fctx = forceCanvas.getContext('2d');

  // gradient halo showing the sinusoidal field as concentric rings: red = would
  // repel a same-signed charge / photon's own color = would attract an opposite
  // charge, fading with the same envelope used in step(). Shown as if meeting an
  // opposite charge (phaseSign = +1) — the same-charge case is just this inverted.
  function drawFieldHalo(cx, cy, ev, scale, baseColor) {
    const range = ev.forceRange;
    const amp = Math.max(1, ev.force);
    const periods = ev.periods;
    const maxRpx = range * scale;
    if (maxRpx <= 0) return;
    const grad = fctx.createRadialGradient(cx, cy, 0, cx, cy, maxRpx);
    const STEPS = 80; // fine steps needed to resolve the oscillation clearly
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const d = t * range;
      let stopColor;
      if (d < HARD_CORE_R) {
        stopColor = 'rgba(255,80,80,0.9)';
      } else {
        const envelope = 1 - d / range;
        const raw = Math.sin(2 * Math.PI * periods * d / range) * envelope;
        const alpha = Math.min(1, Math.abs(raw)) * 0.8;
        stopColor = raw >= 0
          ? baseColor.replace(/,[^,]*\)$/, ',' + alpha.toFixed(3) + ')')
          : 'rgba(255,80,80,' + alpha.toFixed(3) + ')';
      }
      grad.addColorStop(t, stopColor);
    }
    fctx.fillStyle = grad;
    fctx.beginPath();
    fctx.arc(cx, cy, maxRpx, 0, Math.PI * 2);
    fctx.fill();
  }

  function renderForcePreview() {
    if (winForceEl.classList.contains('minimized')) return;
    const w = forceCanvas.width, h = forceCanvas.height;
    fctx.clearRect(0, 0, w, h);
    fctx.fillStyle = '#05060a';
    fctx.fillRect(0, 0, w, h);

    // charge pinned to +1/-1, mass pinned to 1 — a stable reference, unaffected by randomness
    const pos = runCompiled(compiledVarsCache, { charge: 1, mass: 1 }).results;
    const neg = runCompiled(compiledVarsCache, { charge: -1, mass: 1 }).results;

    const cy = h / 2 - 12;
    const cxPos = w * 0.27, cxNeg = w * 0.73;
    const avail = Math.min(w / 2 - 20, cy - 10);
    const maxRange = Math.max(pos.forceRange, neg.forceRange, 1);
    const scale = avail / maxRange; // same scale for both -> proportions preserved

    drawFieldHalo(cxPos, cy, pos, scale, colorForCharge(1, 1));
    drawFieldHalo(cxNeg, cy, neg, scale, colorForCharge(-1, 1));

    fctx.fillStyle = colorForCharge(1, 1);
    fctx.beginPath(); fctx.arc(cxPos, cy, 3, 0, Math.PI * 2); fctx.fill();
    fctx.fillStyle = colorForCharge(-1, 1);
    fctx.beginPath(); fctx.arc(cxNeg, cy, 3, 0, Math.PI * 2); fctx.fill();

    fctx.fillStyle = '#c7cfe4';
    fctx.font = '11px sans-serif';
    fctx.textAlign = 'center';
    fctx.fillText('ładunek +1', cxPos, h - 34);
    fctx.fillText('zasięg ' + pos.forceRange.toFixed(0) + 'px  okresów ' + pos.periods.toFixed(2), cxPos, h - 20);
    fctx.fillText('siła ' + pos.force.toFixed(0) + '  energia ' + pos.energy.toFixed(1), cxPos, h - 6);

    fctx.fillText('ładunek -1', cxNeg, h - 34);
    fctx.fillText('zasięg ' + neg.forceRange.toFixed(0) + 'px  okresów ' + neg.periods.toFixed(2), cxNeg, h - 20);
    fctx.fillText('siła ' + neg.force.toFixed(0) + '  energia ' + neg.energy.toFixed(1), cxNeg, h - 6);
  }

  // ---------- force graph window (horizontal: force vs distance) ----------
  const winForceGraphEl = document.getElementById('winForceGraph');
  const forceGraphCanvas = document.getElementById('forceGraphCanvas');
  const gctx = forceGraphCanvas.getContext('2d');

  // same force law as step()'s pairwise loop, evaluated for a single pair so it
  // can be plotted as a curve instead of applied to real photons.
  function sinForceAt(d, range, amp, periodsAvg, chargeProduct) {
    if (d < HARD_CORE_R) {
      const falloff = 1 - d / HARD_CORE_R;
      return -HARD_CORE_K * falloff / (d + 2);
    }
    if (d >= range) return 0;
    const phaseSign = chargeProduct < 0 ? 1 : -1;
    const envelope = 1 - d / range;
    return phaseSign * amp * Math.sin(2 * Math.PI * periodsAvg * d / range) * envelope;
  }

  function renderForceGraph() {
    if (winForceGraphEl.classList.contains('minimized')) return;
    const w = forceGraphCanvas.width, h = forceGraphCanvas.height;
    gctx.clearRect(0, 0, w, h);
    gctx.fillStyle = '#05060a';
    gctx.fillRect(0, 0, w, h);

    const pos = runCompiled(compiledVarsCache, { charge: 1, mass: 1 }).results;
    const neg = runCompiled(compiledVarsCache, { charge: -1, mass: 1 }).results;

    // opposite-charge pair (+1/-1) and same-charge pair (+1/+1), each averaged
    // the same way step() averages the two photons' own values
    const range = (pos.forceRange + neg.forceRange) / 2;
    const amp = (pos.force + neg.force) / 2;
    const periodsAvg = (pos.periods + neg.periods) / 2;

    const padL = 44, padR = 14, padT = 14, padB = 28;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const maxAmp = Math.max(1, amp, HARD_CORE_K / (HARD_CORE_R + 2));
    const zeroY = padT + plotH / 2;
    const xForD = d => padL + (d / range) * plotW;
    const yForF = f => zeroY - (f / maxAmp) * (plotH / 2);

    // zero line + axes
    gctx.strokeStyle = 'rgba(255,255,255,0.25)';
    gctx.lineWidth = 1;
    gctx.beginPath();
    gctx.moveTo(padL, zeroY); gctx.lineTo(w - padR, zeroY);
    gctx.stroke();
    gctx.beginPath();
    gctx.moveTo(padL, padT); gctx.lineTo(padL, h - padB);
    gctx.stroke();

    // hard-core boundary marker
    gctx.strokeStyle = 'rgba(255,255,255,0.15)';
    gctx.setLineDash([3, 3]);
    gctx.beginPath();
    gctx.moveTo(xForD(HARD_CORE_R), padT); gctx.lineTo(xForD(HARD_CORE_R), h - padB);
    gctx.stroke();
    gctx.setLineDash([]);

    function drawCurve(chargeProduct, color) {
      gctx.strokeStyle = color;
      gctx.lineWidth = 2;
      gctx.beginPath();
      const STEPS = 200;
      for (let i = 0; i <= STEPS; i++) {
        const d = (i / STEPS) * range;
        const f = Math.max(-maxAmp, Math.min(maxAmp, sinForceAt(d, range, amp, periodsAvg, chargeProduct)));
        const x = xForD(d), y = yForF(f);
        if (i === 0) gctx.moveTo(x, y); else gctx.lineTo(x, y);
      }
      gctx.stroke();
    }
    drawCurve(-1, '#5aa9ff');  // przeciwne ładunki
    drawCurve(1, '#ff9f4a');   // ten sam ładunek

    // axis labels
    gctx.fillStyle = '#c7cfe4';
    gctx.font = '11px sans-serif';
    gctx.textAlign = 'left';
    gctx.fillText('0', padL - 4, h - padB + 14);
    gctx.textAlign = 'right';
    gctx.fillText(range.toFixed(0) + 'px', w - padR, h - padB + 14);
    gctx.textAlign = 'center';
    gctx.fillText('dystans', padL + plotW / 2, h - 6);
    gctx.save();
    gctx.translate(12, padT + plotH / 2);
    gctx.rotate(-Math.PI / 2);
    gctx.fillText('siła', 0, 0);
    gctx.restore();
    gctx.textAlign = 'left';
    gctx.fillText('przyciąga', padL + 2, padT + 10);
    gctx.fillText('odpycha', padL + 2, h - padB - 4);

    // legend
    gctx.fillStyle = '#5aa9ff';
    gctx.fillRect(w - 150, 6, 10, 10);
    gctx.fillStyle = '#c7cfe4';
    gctx.textAlign = 'left';
    gctx.fillText('przeciwne', w - 136, 15);
    gctx.fillStyle = '#ff9f4a';
    gctx.fillRect(w - 150, 20, 10, 10);
    gctx.fillStyle = '#c7cfe4';
    gctx.fillText('ten sam', w - 136, 29);
  }

  // ---------- run loop ----------
  let paused = true;
  let speedMultiplier = 1;
  let lastT = performance.now();

  function loop(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    if (!paused) step(dt * speedMultiplier);
    render();
    updateInfoPanelIfOpen();
    updateStats();
    updateZoomIndicator();
    renderForcePreview();
    renderForceGraph();
    updateReactors(dt * speedMultiplier);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- overlay controls (read simulation state only, never mutate physics) ----------
  const toggleBtn = document.getElementById('toggleBtn');
  toggleBtn.addEventListener('click', () => {
    paused = !paused;
    toggleBtn.textContent = paused ? 'Start' : 'Pauza';
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
      exprInput.title = errors[idx] || '';
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
    variables.push({ role: null, name: 'var' + n, expr: '0' });
    saveSettings();
    renderEditorRows();
  }

  function removeVar(idx) {
    if (variables[idx].role) return; // built-in rows can't be removed, only helper (role:null) ones
    variables.splice(idx, 1);
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
        <div class="var-order">
          <button class="var-up" title="Przenieś wyżej">▲</button>
          <button class="var-down" title="Przenieś niżej">▼</button>
        </div>
        <input type="text" class="var-name" spellcheck="false">
        <span>:</span>
        <input type="text" class="var-expr" spellcheck="false">
        ${isCustom ? '<button class="var-del" title="Usuń zmienną pomocniczą">✕</button>' : ''}
      `;
      const nameInput = el.querySelector('.var-name');
      const exprInput = el.querySelector('.var-expr');
      nameInput.value = row.name;
      exprInput.value = row.expr;
      if (!isCustom) nameInput.title = 'Wbudowana właściwość fotonu — nazwę można zmienić, wiersza nie można usunąć';
      el.querySelector('.var-up').disabled = idx === 0;
      el.querySelector('.var-down').disabled = idx === variables.length - 1;

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
    a.download = 'fotony-zmienne.csv';
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
    if (!rows.length) return { error: 'Pusty plik.' };
    let dataRows = rows;
    const header = rows[0].map(h => h.trim().toLowerCase());
    if (header[0] === 'role' && header[1] === 'name' && header[2] === 'expr') dataRows = rows.slice(1);
    const parsed = dataRows.map(r => ({
      role: (r[0] || '').trim() || null,
      name: (r[1] || '').trim(),
      expr: (r[2] || '').trim()
    })).filter(v => v.name);
    for (const v of parsed) {
      if (v.role && !REQUIRED_ROLES.includes(v.role)) return { error: `Nieznana rola "${v.role}" w wierszu "${v.name}".` };
    }
    for (const role of REQUIRED_ROLES) {
      const count = parsed.filter(v => v.role === role).length;
      if (count !== 1) return { error: `Wymagana dokładnie jedna zmienna o roli "${role}" (znaleziono ${count}).` };
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
      if (error) { alert('Nie udało się zaimportować CSV: ' + error); return; }
      variables = vars;
      saveSettings();
      renderEditorRows();
      flashBtn(importVarsBtn, '✓');
    };
    reader.onerror = () => alert('Nie udało się odczytać pliku.');
    reader.readAsText(file);
  });

  // ---------- selection state ----------
  // one independent floating window per selected photon, so picking a new one from
  // the list doesn't close whichever ones are already open — keyed by photon id.
  let listSelection = new Set();
  const openInfoWindows = new Map(); // photon id -> { el, titleEl, bodyEl }

  function findPhoton(id) { return photons.find(p => p.id === id); }

  function renderInfoPanel(p, w) {
    w.titleEl.textContent = 'Foton #' + p.id;
    const speed = Math.hypot(p.vx, p.vy);
    w.bodyEl.innerHTML = `
      <div class="row"><span class="k"><span class="swatch" style="background:${photonColor(p,1)}"></span>Ładunek</span><span class="v">${p.charge.toFixed(2)}</span></div>
      <div class="row"><span class="k">Szybkość (aktualna)</span><span class="v">${speed.toFixed(1)} px/s</span></div>
      <div class="row"><span class="k">Szybkość (maks.)</span><span class="v">${p.maxSpeed.toFixed(1)} px/s</span></div>
      <div class="row"><span class="k">Masa</span><span class="v">${p.mass.toFixed(2)}</span></div>
      <div class="row"><span class="k">Energia</span><span class="v">${p.energy.toFixed(2)}</span></div>
      <div class="row"><span class="k">Amplituda siły</span><span class="v">${p.force.toFixed(0)}</span></div>
      <div class="row"><span class="k">Zasięg siły</span><span class="v">${p.forceRange.toFixed(0)} px</span></div>
      <div class="row"><span class="k">Liczba okresów</span><span class="v">${p.periods.toFixed(2)}</span></div>
      <div class="row"><span class="k">Pozycja</span><span class="v">${p.x.toFixed(0)}, ${p.y.toFixed(0)}</span></div>
    `;
  }

  function closeInfoWindow(id) {
    const w = openInfoWindows.get(id);
    if (!w) return;
    if (w.el._resizeObserver) w.el._resizeObserver.disconnect();
    w.el.remove();
    openInfoWindows.delete(id);
    removeDynamicDockIcon('info-' + id);
    delete windowState['winInfo-' + id];
    saveWindowState();
    // stays in the list — just drops the "open" highlight, doesn't remove the row
    if (listSelection.has(id)) renderListBody();
  }

  function openInfoWindow(p) {
    listSelection.add(p.id); // no-op if already there; row highlight is refreshed below

    let w = openInfoWindows.get(p.id);
    if (w) {
      restoreWin(w.el, null);
      removeDynamicDockIcon('info-' + p.id);
      renderInfoPanel(p, w);
      renderListBody(); // re-render after openInfoWindows reflects the final state
      return;
    }
    const n = openInfoWindows.size;
    const el = document.createElement('div');
    el.className = 'window';
    el.id = 'winInfo-' + p.id;
    el.style.top = (60 + (n % 10) * 24) + 'px';
    el.style.right = (16 + (n % 10) * 24) + 'px';
    el.innerHTML = `
      <div class="window-header">
        <span class="info-title"></span>
        <div class="window-btns">
          <button class="win-min" title="Minimalizuj">–</button>
          <button class="win-close" title="Zamknij">✕</button>
        </div>
      </div>
      <div class="window-body"></div>
    `;
    document.body.appendChild(el);
    w = { el, titleEl: el.querySelector('.info-title'), bodyEl: el.querySelector('.window-body') };
    openInfoWindows.set(p.id, w);
    makeDraggable(el);
    el.querySelector('.win-min').addEventListener('click', () => {
      minimizeWin(el, null);
      addDynamicDockIcon('info-' + p.id, 'Foton #' + p.id, () => { restoreWin(el, null); removeDynamicDockIcon('info-' + p.id); });
    });
    el.querySelector('.win-close').addEventListener('click', () => closeInfoWindow(p.id));
    renderInfoPanel(p, w);
    renderListBody(); // re-render after openInfoWindows reflects the final state
  }

  function updateInfoPanelIfOpen() {
    for (const [id, w] of openInfoWindows) {
      const p = findPhoton(id);
      if (!p) { closeInfoWindow(id); continue; }
      renderInfoPanel(p, w);
    }
  }

  function selectPhoton(id) {
    const p = findPhoton(id);
    if (!p) return;
    openInfoWindow(p);
  }

  // removes photons from the simulation outright (not just from the selection) —
  // used by the per-row ✕ in the list window and by the Delete key
  function removePhotonsByIds(ids) {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) return;
    photons = photons.filter(p => !idSet.has(p.id));
    for (const id of idSet) closeInfoWindow(id);
  }

  // ---------- list window (rectangle selection result) ----------
  const winList = document.getElementById('winList');
  const listBody = document.getElementById('listBody');
  const listSortHeaders = document.querySelectorAll('#winList th.sortable');

  let listSort = { key: 'id', dir: 1 }; // key: 'id' | 'charge' | 'speed'
  const LIST_SORT_VALUE = {
    id: p => p.id, charge: p => p.charge, speed: p => p.maxSpeed,
    energy: p => p.energy, mass: p => p.mass, force: p => p.force, forceRange: p => p.forceRange
  };

  function updateListSortHeaders() {
    listSortHeaders.forEach(th => {
      const arrow = th.querySelector('.sort-arrow');
      arrow.textContent = th.dataset.sortKey === listSort.key ? (listSort.dir === 1 ? '▲' : '▼') : '';
    });
  }
  listSortHeaders.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (listSort.key === key) listSort.dir *= -1;
      else listSort = { key, dir: 1 };
      renderListBody();
    });
  });

  function renderListBody() {
    listBody.innerHTML = '';
    const getVal = LIST_SORT_VALUE[listSort.key];
    const ps = Array.from(listSelection).map(findPhoton).filter(Boolean)
      .sort((a, b) => (getVal(a) - getVal(b)) * listSort.dir);
    for (const p of ps) {
      const tr = document.createElement('tr');
      tr.className = 'pick' + (openInfoWindows.has(p.id) ? ' row-open' : '');
      tr.innerHTML = `<td><span class="swatch" style="background:${photonColor(p,1)}"></span>${p.id}</td><td>${p.charge.toFixed(2)}</td><td>${p.maxSpeed.toFixed(0)} px/s</td><td>${p.energy.toFixed(2)}</td><td>${p.mass.toFixed(2)}</td><td>${p.force.toFixed(0)}</td><td>${p.forceRange.toFixed(0)}</td><td><button class="var-del row-del" title="Usuń foton z symulacji">✕</button></td>`;
      tr.addEventListener('click', () => selectPhoton(p.id));
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCtxMenuAt(e.clientX, e.clientY);
      });
      tr.querySelector('.row-del').addEventListener('click', (e) => {
        e.stopPropagation(); // don't also trigger the row's own click (select) handler
        removePhotonsByIds([p.id]);
        listSelection.delete(p.id);
        showListPanel(Array.from(listSelection)); // also re-minimizes the window if that emptied the list
      });
      listBody.appendChild(tr);
    }
    updateListSortHeaders();
  }

  function showListPanel(ids) {
    listSelection = new Set(ids);
    renderListBody();
    if (ids.length) {
      restoreWin(winList, null);
      removeDynamicDockIcon('list');
    } else {
      minimizeWin(winList, null);
    }
  }

  // ---------- right-click context menu (list rows) ----------
  const ctxMenu = document.getElementById('ctxMenu');
  const ctxReactorBtn = document.getElementById('ctxReactorBtn');
  function hideCtxMenu() { ctxMenu.classList.remove('open'); }
  function showCtxMenuAt(x, y) {
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    ctxMenu.classList.add('open');
  }
  window.addEventListener('click', hideCtxMenu);
  window.addEventListener('blur', hideCtxMenu);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });
  ctxReactorBtn.addEventListener('click', () => {
    openReactor(Array.from(listSelection));
    hideCtxMenu();
  });

  // ---------- reactor windows: isolated mini-simulation of a chosen photon subset ----------
  // each is its own small toroidal world with its own photon clones (same physics
  // identity as the originals, fresh random position/direction) — completely
  // detached from the main simulation once opened, so it keeps "flying" on its own.
  const REACTOR_SIZE = 200;
  let reactorSeq = 0;
  const reactors = [];

  function makeReactorPhoton(src) {
    const angle = rand(0, Math.PI * 2);
    return {
      x: rand(0, REACTOR_SIZE), y: rand(0, REACTOR_SIZE),
      vx: Math.cos(angle) * src.maxSpeed, vy: Math.sin(angle) * src.maxSpeed,
      charge: src.charge, mass: src.mass, maxSpeed: src.maxSpeed,
      energy: src.energy, force: src.force, forceRange: src.forceRange, periods: src.periods,
      radius: PHOTON_RADIUS
    };
  }

  function closeReactor(reactor) {
    const i = reactors.indexOf(reactor);
    if (i === -1) return;
    if (reactor.el._resizeObserver) reactor.el._resizeObserver.disconnect();
    reactor.el.remove();
    reactors.splice(i, 1);
    delete windowState[reactor.el.id];
    saveWindowState();
  }

  function openReactor(ids) {
    const srcPhotons = ids.map(findPhoton).filter(Boolean);
    if (srcPhotons.length === 0) return;

    const n = reactors.length;
    const el = document.createElement('div');
    el.className = 'window reactor-window';
    el.id = 'reactor-' + (++reactorSeq);
    el.style.top = (60 + (n % 10) * 24) + 'px';
    el.style.left = (320 + (n % 10) * 24) + 'px';
    el.innerHTML = `
      <div class="window-header">
        <span>Reaktor</span>
        <div class="window-btns">
          <button class="win-min" title="Minimalizuj">–</button>
          <button class="win-close" title="Zamknij">✕</button>
        </div>
      </div>
      <div class="window-body"><canvas width="${REACTOR_SIZE}" height="${REACTOR_SIZE}"></canvas></div>
    `;
    document.body.appendChild(el);

    const canvas = el.querySelector('canvas');
    const reactor = { el, ctx: canvas.getContext('2d'), photons: srcPhotons.map(makeReactorPhoton) };
    reactors.push(reactor);

    makeDraggable(el);
    el.querySelector('.win-min').addEventListener('click', () => minimizeWin(el, null));
    el.querySelector('.win-close').addEventListener('click', () => closeReactor(reactor));
  }

  // same pairwise sine-wave force law as the main step() (see there for the physics
  // explanation), but brute-force — a reactor only ever holds a small hand-picked
  // subset of photons, so the O(n) spatial grid isn't worth the extra complexity here.
  function stepReactor(r, dt) {
    const n = r.photons.length;
    if (n === 0) return;
    const ax = new Float64Array(n), ay = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = r.photons[i];
      for (let j = i + 1; j < n; j++) {
        const b = r.photons[j];
        let dx = wrapDelta(b.x - a.x, REACTOR_SIZE);
        let dy = wrapDelta(b.y - a.y, REACTOR_SIZE);
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d < 0.01) {
          const ang = Math.random() * Math.PI * 2;
          d = 0.1; dx = Math.cos(ang) * d; dy = Math.sin(ang) * d;
        }
        const range = (a.forceRange + b.forceRange) / 2;
        if (d >= range) continue;
        const ux = dx / d, uy = dy / d;
        let f;
        if (d < HARD_CORE_R) {
          const falloff = 1 - d / HARD_CORE_R;
          f = -HARD_CORE_K * falloff / (d + 2);
        } else {
          const amp = (a.force + b.force) / 2;
          const periodsAvg = (a.periods + b.periods) / 2;
          const phaseSign = a.charge * b.charge < 0 ? 1 : -1;
          const envelope = 1 - d / range;
          f = phaseSign * amp * Math.sin(2 * Math.PI * periodsAvg * d / range) * envelope;
        }
        const fx = ux * f, fy = uy * f;
        ax[i] += fx; ay[i] += fy;
        ax[j] -= fx; ay[j] -= fy;
      }
    }
    for (let i = 0; i < n; i++) {
      const p = r.photons[i];
      p.vx += (ax[i] / p.mass) * dt;
      p.vy += (ay[i] / p.mass) * dt;
      const s = Math.hypot(p.vx, p.vy);
      if (s > 0.0001) {
        const k = p.maxSpeed / s;
        p.vx *= k; p.vy *= k;
      } else {
        const ang = rand(0, Math.PI * 2);
        p.vx = Math.cos(ang) * p.maxSpeed; p.vy = Math.sin(ang) * p.maxSpeed;
      }
      p.x = wrap(p.x + p.vx * dt, REACTOR_SIZE);
      p.y = wrap(p.y + p.vy * dt, REACTOR_SIZE);
    }
  }

  function renderReactor(r) {
    if (r.el.classList.contains('minimized')) return;
    const ctx = r.ctx;
    ctx.clearRect(0, 0, REACTOR_SIZE, REACTOR_SIZE);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, REACTOR_SIZE, REACTOR_SIZE);
    for (const p of r.photons) {
      ctx.fillStyle = photonColor(p, 0.95);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function updateReactors(dt) {
    for (const r of reactors) {
      if (!paused) stepReactor(r, dt);
      renderReactor(r);
    }
  }

  // ---------- window manager: drag + resize + minimize-to-dock, all persisted ----------
  // keyed by element id, so it covers every .window (persistent and contextual) the
  // same way — position/size are always remembered; "minimized" is only re-applied
  // on load for the persistent windows (see below), since the contextual ones
  // (info/list) are driven by selection state and have nothing to show on a fresh load.
  const WIN_LS_KEY = 'photonSim.windows.v1';
  function loadWindowState() {
    try {
      const raw = localStorage.getItem(WIN_LS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  const windowState = loadWindowState();
  function saveWindowState() {
    try { localStorage.setItem(WIN_LS_KEY, JSON.stringify(windowState)); } catch (e) { /* ignore */ }
  }
  function persistRect(win) {
    if (win.classList.contains('minimized')) return; // display:none -> zero rect
    const rect = win.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // detached from the DOM — nothing real to save
    windowState[win.id] = Object.assign({}, windowState[win.id], {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height
    });
    saveWindowState();
  }
  function persistMinimized(win, minimized) {
    windowState[win.id] = Object.assign({}, windowState[win.id], { minimized });
    saveWindowState();
  }
  function applySavedRect(win) {
    const s = windowState[win.id];
    if (!s) return;
    if (typeof s.left === 'number') { win.style.left = s.left + 'px'; win.style.right = 'auto'; }
    if (typeof s.top === 'number') { win.style.top = s.top + 'px'; win.style.bottom = 'auto'; }
    if (typeof s.width === 'number') win.style.width = s.width + 'px';
    if (typeof s.height === 'number') win.style.height = s.height + 'px';
  }

  function makeDraggable(win) {
    const header = win.querySelector('.window-header');
    let dragging = false, offX = 0, offY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const rect = win.getBoundingClientRect();
      win.style.left = rect.left + 'px';
      win.style.top = rect.top + 'px';
      win.style.right = 'auto';
      win.style.bottom = 'auto';
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      dragging = true;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let nx = e.clientX - offX;
      let ny = e.clientY - offY;
      nx = Math.max(4, Math.min(window.innerWidth - 60, nx));
      ny = Math.max(48, Math.min(window.innerHeight - 90, ny));
      win.style.left = nx + 'px';
      win.style.top = ny + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; persistRect(win); }
    });

    // catches the native corner-drag resize (CSS `resize: both` on .window). Stashed
    // on the element so windows that get permanently removed (photon info windows)
    // can disconnect it — otherwise it keeps firing (with a zero rect once detached)
    // after the window is gone.
    if (window.ResizeObserver) {
      let resizeTimer = null;
      const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => persistRect(win), 150);
      });
      ro.observe(win);
      win._resizeObserver = ro;
    }

    applySavedRect(win);
  }

  function minimizeWin(win, dockBtn) {
    win.classList.add('minimized');
    if (dockBtn) dockBtn.classList.remove('active');
    persistMinimized(win, true);
  }
  function restoreWin(win, dockBtn) {
    win.classList.remove('minimized');
    if (dockBtn) dockBtn.classList.add('active');
    persistMinimized(win, false);
  }
  function toggleWin(win, dockBtn) {
    if (win.classList.contains('minimized')) restoreWin(win, dockBtn);
    else minimizeWin(win, dockBtn);
  }

  const dock = document.getElementById('dock');
  function addDynamicDockIcon(id, label, onClick) {
    removeDynamicDockIcon(id);
    const btn = document.createElement('button');
    btn.className = 'dock-icon active';
    btn.textContent = label;
    btn.dataset.dynId = id;
    btn.addEventListener('click', onClick);
    dock.appendChild(btn);
  }
  function removeDynamicDockIcon(id) {
    const el = dock.querySelector(`.dock-icon[data-dyn-id="${id}"]`);
    if (el) el.remove();
  }

  // persistent windows: stats / editor / force preview — always have a dock icon
  const winStats = document.getElementById('winStats');
  const winEditor = document.getElementById('winEditor');
  const winForce = document.getElementById('winForce');
  const dockStats = document.getElementById('dockStats');
  const dockEditor = document.getElementById('dockEditor');
  const dockForce = document.getElementById('dockForce');
  const winForceGraph = document.getElementById('winForceGraph');
  const dockForceGraph = document.getElementById('dockForceGraph');
  const winFilter = document.getElementById('winFilter');
  const dockFilter = document.getElementById('dockFilter');

  [ [winStats, dockStats], [winEditor, dockEditor], [winForce, dockForce], [winForceGraph, dockForceGraph], [winFilter, dockFilter] ].forEach(([win, dockBtn]) => {
    makeDraggable(win);
    win.querySelector('.win-min').addEventListener('click', () => minimizeWin(win, dockBtn));
    dockBtn.addEventListener('click', () => toggleWin(win, dockBtn));
    // restore last minimized/open state — only for these persistent windows, since
    // info/list are driven by selection and start empty on a fresh load anyway
    const saved = windowState[win.id];
    if (saved && saved.minimized) minimizeWin(win, dockBtn);
  });

  // contextual window: list — dock icon only appears while minimized. Photon info
  // windows are created/wired on demand in openInfoWindow() (one per photon).

  makeDraggable(winList);
  winList.querySelector('.win-min').addEventListener('click', () => {
    minimizeWin(winList, null);
    if (listSelection.size) addDynamicDockIcon('list', 'Zaznaczone (' + listSelection.size + ')', () => { restoreWin(winList, null); removeDynamicDockIcon('list'); });
  });
  winList.querySelector('.win-close').addEventListener('click', () => {
    minimizeWin(winList, null);
    listSelection.clear();
    removeDynamicDockIcon('list');
  });

  // stats settings window: opened via the gear icon in winStats' header
  const statConfigBtn = document.getElementById('statConfigBtn');
  const winStatConfig = document.getElementById('winStatConfig');
  makeDraggable(winStatConfig);
  statConfigBtn.addEventListener('click', () => toggleWin(winStatConfig, null));
  winStatConfig.querySelector('.win-min').addEventListener('click', () => minimizeWin(winStatConfig, null));
  winStatConfig.querySelector('.win-close').addEventListener('click', () => minimizeWin(winStatConfig, null));
  // restore last open/minimized state, same as the other persistent windows
  // (default HTML state is already minimized, so only the "was open" case needs handling)
  const savedStatConfig = windowState[winStatConfig.id];
  if (savedStatConfig && savedStatConfig.minimized === false) restoreWin(winStatConfig, null);

  // ---------- clear data: wipes saved editor formulas + window layout ----------
  const clearDataBtn = document.getElementById('clearDataBtn');
  clearDataBtn.addEventListener('click', () => {
    if (!confirm('Usunąć zapisane dane (formuły edytora, rozmiar/pozycję okienek oraz ustawienia statystyk) i przywrócić ustawienia domyślne?')) return;
    try {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(WIN_LS_KEY);
      localStorage.removeItem(STATS_LS_KEY);
    } catch (e) { /* ignore (e.g. storage disabled) */ }
    location.reload();
  });

  // ---------- brush tools: zaznaczanie / przyciąganie / spawn ----------
  let currentTool = 'select';   // 'select' | 'attract' | 'spawn'
  let attractCharge = 'all';    // 'all' | 'pos' | 'neg'

  const toolButtons = document.querySelectorAll('#toolGroup .tool-btn');
  const chargeGroup = document.getElementById('chargeGroup');
  const chargeButtons = document.querySelectorAll('.charge-btn');
  const hintEl = document.getElementById('hint');

  function updateHint() {
    if (currentTool === 'select') {
      hintEl.textContent = 'Kliknij foton = szczegóły • przeciągnij prostokąt = lista fotonów';
    } else if (currentTool === 'attract') {
      const label = attractCharge === 'all' ? 'wszystkie ładunki' : (attractCharge === 'pos' ? 'ładunki dodatnie (+)' : 'ładunki ujemne (–)');
      hintEl.textContent = 'Przytrzymaj i przesuwaj kursor, aby przyciągać do niego: ' + label;
    } else {
      hintEl.textContent = 'Kliknij lub przeciągnij, aby tworzyć nowe fotony (wg edytora fotonu)';
    }
  }

  function setTool(tool) {
    currentTool = tool;
    toolButtons.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    chargeGroup.classList.toggle('hidden', tool !== 'attract');
    dragging = false; rectActive = false; mouseDown = false;
    updateHint();
  }
  toolButtons.forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

  chargeButtons.forEach(b => b.addEventListener('click', () => {
    attractCharge = b.dataset.charge;
    chargeButtons.forEach(x => x.classList.toggle('active', x === b));
    updateHint();
  }));
  updateHint();

  // ---------- color filter (winFilter): default fixed scale vs. intensity-by-charge ----------
  const colorModeButtons = document.querySelectorAll('#colorModeGroup .tool-btn');
  colorModeButtons.forEach(b => b.addEventListener('click', () => {
    colorMode = b.dataset.colorMode;
    colorModeButtons.forEach(x => x.classList.toggle('active', x === b));
    renderListBody(); // swatches in the selected-photons list are drawn once, not per frame
  }));

  // ---------- spawning (used by the "spawn" brush) ----------
  function spawnPhotonAt(x, y) {
    if (photons.length >= MAX_PHOTONS) return;
    const p = makePhoton();
    p.x = wrap(x + rand(-8, 8), W);
    p.y = wrap(y + rand(-8, 8), H);
    photons.push(p);
  }

  // ---------- mouse interaction ----------
  let dragging = false, rectActive = false, mouseDown = false;
  let startX = 0, startY = 0, curX = -9999, curY = -9999;
  let lastSpawnTime = 0;
  const DRAG_THRESHOLD = 6;
  const SPAWN_INTERVAL = 25; // ms, throttle for the spawn brush while dragging

  function normalizedRect() {
    const x = Math.min(startX, curX), y = Math.min(startY, curY);
    const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
    return { x, y, w, h };
  }

  // mouse-wheel zoom, anchored on the cursor (the world point under it stays put)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (newZoom === zoom) return;
    const wx = e.clientX / zoom + camX, wy = e.clientY / zoom + camY;
    zoom = newZoom;
    camX = wx - e.clientX / zoom;
    camY = wy - e.clientY / zoom;
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    dragging = true; rectActive = false; mouseDown = true;
    const w = screenToWorld(e.clientX, e.clientY);
    startX = curX = w.x; startY = curY = w.y;

    if (currentTool === 'spawn') {
      spawnPhotonAt(curX, curY);
      lastSpawnTime = performance.now();
    }
  });

  window.addEventListener('mousemove', (e) => {
    const w = screenToWorld(e.clientX, e.clientY);
    curX = w.x; curY = w.y;

    if (dragging && currentTool === 'select' && !rectActive && Math.hypot(curX - startX, curY - startY) > DRAG_THRESHOLD) {
      rectActive = true;
    }
    if (dragging && currentTool === 'spawn') {
      const now = performance.now();
      if (now - lastSpawnTime > SPAWN_INTERVAL) {
        spawnPhotonAt(curX, curY);
        lastSpawnTime = now;
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) { mouseDown = false; return; }
    dragging = false;
    mouseDown = false;

    if (currentTool === 'select') {
      if (rectActive) {
        const r = normalizedRect();
        const ids = [];
        for (const p of photons) {
          if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) ids.push(p.id);
        }
        showListPanel(ids);
      } else {
        // plain click: pick nearest photon under the cursor
        let best = null, bestD = Infinity;
        for (const p of photons) {
          const dx = wrapDelta(p.x - startX, W), dy = wrapDelta(p.y - startY, H);
          const d = Math.hypot(dx, dy);
          if (d < p.radius + 8 && d < bestD) { best = p; bestD = d; }
        }
        if (best) selectPhoton(best.id);
      }
    }
    rectActive = false;
  });

  // Delete key: removes every photon currently in the "Zaznaczone fotony" list from
  // the simulation. Ignored while typing in an input/textarea (e.g. editor fields).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (listSelection.size === 0) return;
    removePhotonsByIds(listSelection);
    listSelection.clear();
    showListPanel([]);
  });
})();
