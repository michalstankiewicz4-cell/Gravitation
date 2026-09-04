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
    const waveOffset = clampNum(results.waveOffset, 0, 1, 0);
    const phaseShift = clampNum(results.phaseShift, -1000, 1000, 0);
    const angle = rand(0, Math.PI * 2);
    const initSpeed = maxSpeed; // speed is always locked to the formula value — see step()
    return {
      id: nextId++,
      x: rand(0, W), y: rand(0, H),
      vx: Math.cos(angle) * initSpeed, vy: Math.sin(angle) * initSpeed,
      charge, mass, maxSpeed, energy, force, forceRange, periods, waveOffset, phaseShift,
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
      p.waveOffset = clampNum(results.waveOffset, 0, 1, p.waveOffset);
      p.phaseShift = clampNum(results.phaseShift, -1000, 1000, p.phaseShift);
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
  let glowEnabled = false; // shadowBlur halo around photons, off by default (visual only, no physics effect)

  // main simulation's own 2D/2.5D toggle — same tilted field-height visualization
  // as the reactor windows (see the "2.5D view" section below render()), applied to
  // the whole world instead of a hand-picked subset.
  let mainViewMode = '2D'; // '2D' | '2.5D'
  // which charges contribute to the main 2.5D field mesh — same idea as each
  // reactor window's own +/- field-filter buttons (see r.fieldFilter), surfaced
  // in the Filter panel since it's a filter on what's visible, not on physics
  let mainFieldFilter = { pos: true, neg: true };
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

  // force model: the raw sine alternates sign every half period, so even
  // same-charge pairs attract in some distance bands (phaseSign only flips which
  // half of the wave is which). waveOffset (a per-photon role, like periods or
  // force — see DEFAULT_VARS) shifts the wave up before rescaling it back to a
  // comparable range — at 0 it's the untouched classic wave; at 1 the trough just
  // touches zero, so the sign never flips (like charges always repel, opposite
  // charges always attract); values in between make the flip rarer without banning
  // it outright. Shared by step(), the reactor, and both force previews.
  // phaseShift is waveOffset's horizontal counterpart: waveOffset moves the wave up
  // (asymmetric — widens one lobe, narrows the other), phaseShift slides it sideways
  // along distance instead, in units of one full period (0.5 = shift by half a period).
  function waveTerm(d, range, periods, offset, phaseShift) {
    const raw = Math.sin(2 * Math.PI * (periods * d / range + phaseShift));
    return (raw + offset) / (1 + offset);
  }

  // single source of truth for the pairwise force — used by step(), the reactor,
  // and both force-preview panels, so a fix here applies everywhere at once.
  // The hard-core repulsion is ADDED on top of the wave (not swapped in as a
  // separate branch), and fades to exactly 0 at d = HARD_CORE_R, so there's no
  // jump at that boundary even when HARD_CORE_R is a large fraction of a very
  // small forceRange (previously the two branches didn't agree at the seam).
  function pairForce(d, range, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct) {
    if (d >= range) return 0;
    const phaseSign = chargeProduct < 0 ? 1 : -1;
    const envelope = 1 - d / range; // fades to 0 at the outer edge, no hard jump
    let f = phaseSign * amp * waveTerm(d, range, periodsAvg, offsetAvg, phaseShiftAvg) * envelope;
    if (d < HARD_CORE_R) {
      const falloff = 1 - d / HARD_CORE_R;
      f += -HARD_CORE_K * falloff / (d + 2);
    }
    return f;
  }
  const BRUSH_RADIUS = 160;    // reach of the "attract" brush
  const BRUSH_STRENGTH = 2600; // pull strength of the "attract" brush

  // current force between two specific photons, right now — same formula as the
  // pairwise step in step() above, just for one named pair instead of every
  // neighbor. Used by the orbit-pair visualization (see visualizedOrbitPairs).
  function currentPairForce(a, b) {
    const dx = wrapDelta(b.x - a.x, W), dy = wrapDelta(b.y - a.y, H);
    const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
    const range = (a.forceRange + b.forceRange) / 2;
    const amp = (a.force + b.force) / 2;
    const periodsAvg = (a.periods + b.periods) / 2;
    const offsetAvg = (a.waveOffset + b.waveOffset) / 2;
    const phaseShiftAvg = (a.phaseShift + b.phaseShift) / 2;
    const chargeProduct = a.charge * b.charge;
    const f = pairForce(d, range, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct);
    // f: + = attract, - = repel (0 once d >= range). The rest are the exact
    // averaged parameters that produced it, handed back so a caller (e.g.
    // drawFieldHalo) can redraw the same physics at other distances too, instead
    // of only ever getting this one instantaneous f.
    return { d, range, f, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct };
  }

  let collisionCount = 0;
  let activeCollisionPairs = new Set();

  // ---------- orbit detection ----------
  // a pair counts as a "stable orbit" when their distance stays within
  // ORBIT_VARIATION_MAX of its own average over a rolling ORBIT_WINDOW-second
  // history of continuous interaction. Since every photon's speed is always
  // locked to its own formula (see step() below), a pair that keeps a near-
  // constant separation while both keep moving is, by construction, circling
  // (or otherwise dancing around) a shared point — a reasonable proxy for
  // "stable orbit" without having to reconstruct an actual orbital plane.
  let simTime = 0; // accumulated sim seconds — frozen while paused, scaled by the speed multiplier
  const ORBIT_WINDOW = 3;           // seconds of continuous-interaction history required
  const ORBIT_VARIATION_MAX = 0.15; // max (maxD-minD)/avgD over that window to call it "stable"
  const ORBIT_HISTORY_MAX = 20;     // capped log of past (ended) orbits, one slot per pair
  // "idA_idB" (idA<idB) -> { samples: [{t,d}], stableSince, stableMinD, stableMaxD }
  const orbitTracker = new Map();
  // one entry per pair, not one per end event — a pair that flickers in and out of
  // "stable" (e.g. drifting right at the edge of its interaction range) would
  // otherwise spam a fresh history row every time it briefly re-stabilizes. Keyed
  // the same way as orbitTracker: "idA_idB" -> { idA, idB, duration, minD, maxD, endedAt }
  const orbitHistoryByPair = new Map();

  function orbitPairKey(a, b) { return a.id < b.id ? a.id + '_' + b.id : b.id + '_' + a.id; }

  // an orbit that was stable and just destabilized (or stopped interacting
  // altogether) gets logged here so the panel can still show how it went —
  // "(ended)" + how long it lasted + the min/max separation while it lasted.
  // Only kept if it beats this pair's previous best — see orbitHistoryByPair above.
  function finalizeOrbitEnd(key, rec) {
    if (rec.stableSince === null) return;
    const duration = simTime - rec.stableSince;
    const existing = orbitHistoryByPair.get(key);
    if (existing && existing.duration >= duration) return;
    const [idA, idB] = key.split('_').map(Number);
    orbitHistoryByPair.set(key, { idA, idB, duration, minD: rec.stableMinD, maxD: rec.stableMaxD, endedAt: simTime });
    if (orbitHistoryByPair.size > ORBIT_HISTORY_MAX) {
      let oldestKey = null, oldestT = Infinity;
      for (const [k, v] of orbitHistoryByPair) { if (v.endedAt < oldestT) { oldestT = v.endedAt; oldestKey = k; } }
      if (oldestKey !== null) orbitHistoryByPair.delete(oldestKey);
    }
  }

  function updateOrbitTracking(a, b, d, seenPairs) {
    const key = orbitPairKey(a, b);
    seenPairs.add(key);
    let rec = orbitTracker.get(key);
    if (!rec) { rec = { samples: [], stableSince: null, stableMinD: 0, stableMaxD: 0 }; orbitTracker.set(key, rec); }
    rec.samples.push({ t: simTime, d });
    while (rec.samples.length > 1 && rec.samples[0].t < simTime - ORBIT_WINDOW) rec.samples.shift();

    // not enough continuous history yet to judge — treat as not-yet-stable
    if (simTime - rec.samples[0].t < ORBIT_WINDOW * 0.9) {
      if (rec.stableSince !== null) finalizeOrbitEnd(key, rec);
      rec.stableSince = null;
      return;
    }

    let minD = Infinity, maxD = -Infinity, sum = 0;
    for (const s of rec.samples) { if (s.d < minD) minD = s.d; if (s.d > maxD) maxD = s.d; sum += s.d; }
    const avgD = sum / rec.samples.length;
    const variation = avgD > 0 ? (maxD - minD) / avgD : 0;
    if (variation <= ORBIT_VARIATION_MAX) {
      if (rec.stableSince === null) { rec.stableSince = simTime; rec.stableMinD = d; rec.stableMaxD = d; }
      else { rec.stableMinD = Math.min(rec.stableMinD, d); rec.stableMaxD = Math.max(rec.stableMaxD, d); }
    } else {
      if (rec.stableSince !== null) finalizeOrbitEnd(key, rec);
      rec.stableSince = null;
    }
  }

  function getStableOrbits() {
    const result = [];
    for (const [key, rec] of orbitTracker) {
      if (rec.stableSince === null) continue;
      const [idA, idB] = key.split('_').map(Number);
      if (!findPhoton(idA) || !findPhoton(idB)) continue;
      result.push({ idA, idB, duration: simTime - rec.stableSince, minD: rec.stableMinD, maxD: rec.stableMaxD });
    }
    result.sort((a, b) => b.duration - a.duration);
    return result;
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  // roman numerals for labeling orbits on the force graph (I, II, III, ...) — only
  // ever called with small counts (a handful of simultaneous orbits at most)
  const ROMAN_TABLE = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  function toRoman(n) {
    let s = '';
    for (const [v, r] of ROMAN_TABLE) { while (n >= v) { s += r; n -= v; } }
    return s;
  }

  function step(dt) {
    const n = photons.length;
    if (n === 0) return;
    simTime += dt;
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
    const seenOrbitPairs = new Set();

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

          updateOrbitTracking(a, b, d, seenOrbitPairs);

          const ux = dx / d, uy = dy / d;
          // one continuous wave out to "range" (force amplitude, wave count
          // "periods", and the range itself all come from the two photons' own
          // formulas) plus a hard-core repulsion near d=0 — see pairForce(). Same-
          // charge pairs get the wave inverted (phaseSign), which is the same as
          // shifting it by half a period — so at any given ring, opposite charges
          // pull together while same charges push apart, and that flips again at
          // the next ring, and so on.
          const amp = (a.force + b.force) / 2;
          const periodsAvg = (a.periods + b.periods) / 2;
          const offsetAvg = (a.waveOffset + b.waveOffset) / 2;
          const phaseShiftAvg = (a.phaseShift + b.phaseShift) / 2;
          const chargeProduct = a.charge * b.charge;
          const f = pairForce(d, range, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct); // + = attract, - = repel

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

    // pairs that stopped interacting this frame are no longer a candidate orbit —
    // drop their history instead of letting it stitch back together after a gap
    // (finalizing first so a pair that was stable still lands in orbitHistory)
    for (const [key, rec] of orbitTracker) {
      if (!seenOrbitPairs.has(key)) {
        finalizeOrbitEnd(key, rec);
        orbitTracker.delete(key);
      }
    }

    // "attract" brush: while held, pull matching-charge photons toward the cursor
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

  // ---------- main 2.5D view ----------
  // Same tilted height-field look as the reactor windows (see fieldTerm/VIEW_* above
  // renderReactor25D), but applied to the whole, possibly-large main world. The tilt
  // warp is applied to the WORLD y-coordinate itself, around H/2, before the existing
  // ctx.scale(zoom)/translate(-camX,-camY) transform in render() — so it rides along
  // with zoom, pan, and the toroidal tile-wrap loop for free, no separate projection
  // math needed for those.
  // two-tier grid: a dim line every 50 world px, a brighter one every 100px — like
  // graph paper, so the eye has a "real" square to gauge scale/warp against. Shared
  // with the reactor windows' mesh (renderReactor25D) for the same look.
  //
  // IMPORTANT: this visible line spacing is kept separate from the sampling
  // resolution used to actually compute the warp (see meshDensity below). Sampling
  // only as often as the visible lines (i.e. one sample every 50px) was tried and
  // looked broken — each grid point then has to answer for a whole 50px neighborhood
  // of fast-moving photons, so it swings in big discrete steps between frames
  // instead of deflecting smoothly ("skacze" instead of bending). Sampling stays
  // fine-grained (see MESH_SAMPLE_CELL_BASE); only the choice of which of those fine
  // lines get *stroked* is sparse, at the 50/100px spacing.
  const MESH_LINE_MAJOR = 'rgba(255,255,255,0.28)';
  const MESH_LINE_MINOR = 'rgba(255,255,255,0.10)';
  const MESH_MINOR_SPACING = 50;  // world px between visible grid lines
  const MESH_MAJOR_SPACING = 100; // world px between the brighter lines (every 2nd)
  const MESH_SAMPLE_CELL_BASE = 12.5; // world px between height samples at meshDensity=1 — this is what actually needs to be dense for a smooth-looking bend
  // live density knob (see the "Grid density" slider, shown while a 2.5D view is
  // active) — 1 = the base density above; scales the sampling fineness (not the
  // visible line spacing) of both the main mesh and every reactor window's mesh
  let meshDensity = 1;

  function worldTiltY(wy, h) {
    return H / 2 + (wy - H / 2) * VIEW_TILT - h * VIEW_HEIGHT_SCALE;
  }

  // height also nudges the WORLD x-coordinate a little, so a bump displaces grid
  // points sideways as well as up — without this, a mesh line running in the y
  // direction (constant x) never has anything to shift it horizontally, so it stays
  // a dead-straight vertical line no matter how tall the bump under it is (only the
  // x-varying lines through the same bump would show the wave). The mild x-shift
  // makes the warp read consistently in both mesh directions instead of one.
  function worldTiltX(wx, h) {
    return wx + h * VIEW_HEIGHT_SCALE_X;
  }

  // bins photons into a grid sized to the largest forceRange in play (same idea as
  // step()'s physics grid) so fieldHeightAtBinned() only has to scan nearby photons
  // instead of the whole (possibly thousands-strong) photon list per query.
  function buildFieldBins(list, worldW, worldH) {
    let maxRange = 0;
    for (const p of list) if (p.forceRange > maxRange) maxRange = p.forceRange;
    const cell = Math.max(50, maxRange + 20);
    const cols = Math.max(1, Math.floor(worldW / cell));
    const rows = Math.max(1, Math.floor(worldH / cell));
    const cellW = worldW / cols, cellH = worldH / rows;
    const bins = new Array(cols * rows);
    for (let i = 0; i < bins.length; i++) bins[i] = [];
    for (const p of list) {
      const cx = Math.min(cols - 1, Math.floor(p.x / cellW));
      const cy = Math.min(rows - 1, Math.floor(p.y / cellH));
      bins[cy * cols + cx].push(p);
    }
    return { bins, cols, rows, cellW, cellH, worldW, worldH };
  }

  function fieldHeightAtBinned(wx, wy, bin) {
    const { bins, cols, rows, cellW, cellH, worldW, worldH } = bin;
    const cx = Math.min(cols - 1, Math.floor(wrap(wx, worldW) / cellW));
    const cy = Math.min(rows - 1, Math.floor(wrap(wy, worldH) / cellH));
    let h = 0;
    for (let ddx = -1; ddx <= 1; ddx++) {
      for (let ddy = -1; ddy <= 1; ddy++) {
        const nx = ((cx + ddx) % cols + cols) % cols;
        const ny = ((cy + ddy) % rows + rows) % rows;
        const list = bins[ny * cols + nx];
        for (let k = 0; k < list.length; k++) {
          const p = list[k];
          if (p.charge >= 0 ? !mainFieldFilter.pos : !mainFieldFilter.neg) continue;
          const dx = wrapDelta(wx - p.x, worldW);
          const dy = wrapDelta(wy - p.y, worldH);
          const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
          h += fieldTerm(d, p);
        }
      }
    }
    return Math.max(-VIEW_HEIGHT_CLAMP, Math.min(VIEW_HEIGHT_CLAMP, h));
  }

  // strokes a smooth curve through a row/column of grid points instead of a
  // straight-segment polyline — quadratic-curving through each point's midpoint
  // to its neighbor (a standard canvas smoothing trick) so a dense mesh reads as
  // a continuous, fluid surface rather than a faceted wireframe of flat panels.
  function strokeSmoothGridLine(c, pts) {
    const n = pts.length;
    if (n < 2) return;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    if (n === 2) {
      c.lineTo(pts[1][0], pts[1][1]);
    } else {
      for (let i = 1; i < n - 1; i++) {
        const [x, y] = pts[i];
        const [nx, ny] = pts[i + 1];
        c.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
      }
      const [lx, ly] = pts[n - 1];
      c.quadraticCurveTo(pts[n - 2][0], pts[n - 2][1], lx, ly);
    }
    c.stroke();
  }

  // raw field height can swing a lot from one frame to the next (photons are fast,
  // and the force wave packs several periods into a short range — see fieldTerm),
  // which read as the mesh visibly jerking/popping rather than deforming smoothly.
  // Easing each grid point's displayed height toward its new target instead of
  // snapping to it low-pass-filters that in time, independent of the cause — the
  // mesh still tracks the field, just fluidly instead of jumping every frame.
  const MESH_HEIGHT_SMOOTH = 0.25; // fraction of the way to the new target per frame
  let mainMeshH = null, mainMeshCols = -1, mainMeshRows = -1;

  // drawn only for the primary (untiled) world copy — at typical zoom levels that's
  // the only one visible anyway, and it keeps mesh cost independent of zoom-out level.
  function drawMainFieldMesh(bin) {
    const cell = MESH_SAMPLE_CELL_BASE / meshDensity;
    const cols = Math.max(2, Math.round(W / cell));
    const rows = Math.max(2, Math.round(H / cell));
    if (cols !== mainMeshCols || rows !== mainMeshRows) {
      mainMeshCols = cols; mainMeshRows = rows;
      mainMeshH = new Float64Array((cols + 1) * (rows + 1)); // reset on resize; a few frames to ease in is fine
    }
    const cellW = W / cols, cellH = H / rows;
    // which fine sample lines fall on a visible 50px/100px world boundary
    const minorStep = Math.max(1, Math.round(MESH_MINOR_SPACING / cellW));
    const majorStep = minorStep * Math.round(MESH_MAJOR_SPACING / MESH_MINOR_SPACING);
    const minorStepY = Math.max(1, Math.round(MESH_MINOR_SPACING / cellH));
    const majorStepY = minorStepY * Math.round(MESH_MAJOR_SPACING / MESH_MINOR_SPACING);
    const pts = [];
    for (let gy = 0; gy <= rows; gy++) {
      const pRow = [];
      for (let gx = 0; gx <= cols; gx++) {
        const wx = gx * cellW, wy = gy * cellH;
        const idx = gy * (cols + 1) + gx;
        const target = fieldHeightAtBinned(wx, wy, bin);
        mainMeshH[idx] += (target - mainMeshH[idx]) * MESH_HEIGHT_SMOOTH;
        const h = mainMeshH[idx];
        pRow.push([worldTiltX(wx, h), worldTiltY(wy, h)]);
      }
      pts.push(pRow);
    }

    // smooth curves, no fill — sampled at MESH_SAMPLE_CELL_BASE spacing (dense) so
    // the bend itself stays fluid, but only every minorStep/majorStep-th line is
    // actually stroked, at the fixed 50px/100px visible spacing (see the comment
    // above MESH_MINOR_SPACING for why sampling and drawing are split like this)
    ctx.lineWidth = 0.75;
    for (let gy = 0; gy <= rows; gy++) {
      if (gy % minorStepY !== 0) continue;
      ctx.strokeStyle = gy % majorStepY === 0 ? MESH_LINE_MAJOR : MESH_LINE_MINOR;
      strokeSmoothGridLine(ctx, pts[gy]);
    }
    for (let gx = 0; gx <= cols; gx++) {
      if (gx % minorStep !== 0) continue;
      ctx.strokeStyle = gx % majorStep === 0 ? MESH_LINE_MAJOR : MESH_LINE_MINOR;
      const col = [];
      for (let gy = 0; gy <= rows; gy++) col.push(pts[gy][gx]);
      strokeSmoothGridLine(ctx, col);
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

    const glow = glowEnabled && photons.length <= 500 && zoom > 0.6; // skip glow when it'd cost too many draws
    ctx.shadowBlur = glow ? 12 : 0;

    if (colorMode === 'intensity') updateChargeRange();
    else if (colorMode === 'speed') updateSpeedRange();

    const view25D = mainViewMode === '2.5D';
    const fieldBin = view25D ? buildFieldBins(photons, W, H) : null;
    if (view25D) drawMainFieldMesh(fieldBin);

    for (const p of photons) {
      const isSelected = openInfoWindows.has(p.id);
      const isInList = listSelection.has(p.id);
      const color = photonColor(p, 0.95);
      if (glow) ctx.shadowColor = color;
      const h = view25D ? fieldHeightAtBinned(p.x, p.y, fieldBin) : 0;
      for (let tx = tileMinX; tx <= tileMaxX; tx++) {
        for (let ty = tileMinY; ty <= tileMaxY; ty++) {
          const px = p.x + tx * W;
          const rawPy = p.y + ty * H;
          // photons stay on one flat level — only the grid mesh warps with the
          // field; the stalk is just a visual indicator of the local deviation,
          // drawn only for the primary tile, and never moves the ball itself
          const py = view25D ? worldTiltY(rawPy, 0) : rawPy;

          if (view25D && tx === 0 && ty === 0) {
            ctx.strokeStyle = 'rgba(255,255,255,0.25)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(px, worldTiltY(rawPy, h));
            ctx.stroke();
          }

          ctx.fillStyle = color;
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

    drawOrbitVisualizations();

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

  // ---------- orbits panel: pairs flagged by updateOrbitTracking() in step() ----------
  const orbitsList = document.getElementById('orbitsList');
  let orbitsPanelTimer = 0;
  const ORBITS_PANEL_REFRESH = 0.5; // seconds of real time between DOM rebuilds — duration only needs whole-second resolution anyway
  const ORBIT_HISTORY_SHOWN = 5;    // most-recent ended orbits shown below the active ones

  // pair keys ("idA_idB") whose force preview + connecting line are drawn on the
  // main canvas every frame (see drawOrbitVisualizations() in render()) — toggled
  // by each row's "eye" button, auto-dropped once the pair actually separates
  // (stops interacting at all, not just "stable" — see pruneVisualizedOrbitPairs)
  const visualizedOrbitPairs = new Set();

  function orbitRangeText(minD, maxD) { return minD.toFixed(0) + '–' + maxD.toFixed(0) + 'px'; }

  function updateOrbitsPanel(realDt) {
    pruneVisualizedOrbitPairs();
    orbitsPanelTimer += realDt;
    if (orbitsPanelTimer < ORBITS_PANEL_REFRESH) return;
    orbitsPanelTimer = 0;

    const active = getStableOrbits().slice(0, 8);
    const ended = Array.from(orbitHistoryByPair.values())
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, ORBIT_HISTORY_SHOWN);
    if (!active.length && !ended.length) {
      orbitsList.innerHTML = '<div class="field-hint">No stable orbiting pairs detected yet.</div>';
      return;
    }

    let html = active.map(o => {
      const key = orbitPairKey({ id: o.idA }, { id: o.idB });
      const vizOn = visualizedOrbitPairs.has(key);
      return `
      <div class="row orbit-row" data-a="${o.idA}" data-b="${o.idB}" title="Click to select this pair">
        <span class="k">#${o.idA} ↔ #${o.idB} <span class="orbit-range">${orbitRangeText(o.minD, o.maxD)}</span></span>
        <span class="v">${formatDuration(o.duration)}</span>
        <span class="orbit-actions">
          <button class="orbit-action-btn orbit-center-btn" title="Center the map on this pair">⌖</button>
          <button class="orbit-action-btn orbit-viz-btn${vizOn ? ' active' : ''}" title="Show force preview + connecting line on the map, until they separate">👁</button>
        </span>
      </div>`;
    }).join('');
    if (ended.length) {
      html += '<div class="field-hint" style="margin:6px 0 2px">Recently ended</div>';
      html += ended.map(o => `
        <div class="row orbit-row ended" data-a="${o.idA}" data-b="${o.idB}" title="Click to select this pair">
          <span class="k">#${o.idA} ↔ #${o.idB} <span class="orbit-range">${orbitRangeText(o.minD, o.maxD)}</span></span>
          <span class="v">(ended) ${formatDuration(o.duration)}</span>
        </div>`).join('');
    }
    orbitsList.innerHTML = html;
  }

  // a visualized pair keeps showing while they're still interacting at all (still
  // in orbitTracker), not just while "stable" — so it survives the normal wobble
  // in/out of stability, and only clears once step() actually drops the pair for
  // being out of force range (see step()'s orbitTracker cleanup) or a photon is deleted
  function pruneVisualizedOrbitPairs() {
    for (const key of visualizedOrbitPairs) {
      const [idA, idB] = key.split('_').map(Number);
      if (!orbitTracker.has(key) || !findPhoton(idA) || !findPhoton(idB)) visualizedOrbitPairs.delete(key);
    }
  }

  // pans the camera (no zoom change) so this pair's current midpoint lands in the
  // center of the viewport — a one-off recenter, not a continuous follow
  function centerCameraOnPair(idA, idB) {
    const a = findPhoton(idA), b = findPhoton(idB);
    if (!a || !b) return;
    const dx = wrapDelta(b.x - a.x, W), dy = wrapDelta(b.y - a.y, H);
    const midX = wrap(a.x + dx / 2, W), midY = wrap(a.y + dy / 2, H);
    camX = midX - (W / zoom) / 2;
    camY = midY - (H / zoom) / 2;
  }

  // event delegation: rows are rebuilt wholesale on every refresh above, so a
  // single listener on the (never-replaced) container beats re-binding per row
  orbitsList.addEventListener('click', (e) => {
    const centerBtn = e.target.closest('.orbit-center-btn');
    const vizBtn = e.target.closest('.orbit-viz-btn');
    const row = e.target.closest('.orbit-row');
    if (!row) return;
    const idA = Number(row.dataset.a), idB = Number(row.dataset.b);
    if (centerBtn) {
      e.stopPropagation();
      centerCameraOnPair(idA, idB);
      return;
    }
    if (vizBtn) {
      e.stopPropagation();
      const key = orbitPairKey({ id: idA }, { id: idB });
      if (visualizedOrbitPairs.has(key)) visualizedOrbitPairs.delete(key);
      else visualizedOrbitPairs.add(key);
      vizBtn.classList.toggle('active', visualizedOrbitPairs.has(key));
      return;
    }
    showListPanel([idA, idB]);
  });

  // force preview + connecting line for every pair toggled on via the Orbits
  // panel's eye button — drawn each frame in world space (called from inside
  // render()'s zoom/pan transform), so it pans and zooms with everything else.
  // Only drawn for the primary tile: orbiting pairs are always close together
  // (within forceRange of each other), so the wrapped-short-path line below never
  // needs the toroidal tile-repeat treatment the photons themselves get.
  const ORBIT_ATTRACT_COLOR = 'rgba(69,130,255,ALPHA)';  // same blue as "opposite charges" elsewhere
  const ORBIT_REPEL_COLOR = 'rgba(255,153,45,ALPHA)';    // same orange as "same charge" elsewhere
  function drawOrbitVisualizations() {
    if (visualizedOrbitPairs.size === 0) return;
    for (const key of visualizedOrbitPairs) {
      const [idA, idB] = key.split('_').map(Number);
      const a = findPhoton(idA), b = findPhoton(idB);
      if (!a || !b) continue;
      const { range, f, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct } = currentPairForce(a, b);
      const dx = wrapDelta(b.x - a.x, W), dy = wrapDelta(b.y - a.y, H);
      const bx = a.x + dx, by = a.y + dy; // b's position mirrored to the short path from a, so the line never crosses the whole map on a wrap
      const intensity = range > 0 ? Math.max(0, Math.min(1, Math.abs(f) / (amp || 1))) : 0;
      const color = (f >= 0 ? ORBIT_ATTRACT_COLOR : ORBIT_REPEL_COLOR).replace('ALPHA', (0.35 + 0.5 * intensity).toFixed(2));

      // exact same gradient-ring halo as the standalone "Force preview" panel
      // (see drawFieldHalo), but with these two photons' own real, current
      // parameters and chargeProduct — not the panel's fixed +1/-1 reference —
      // and drawn at world scale 1:1 (ctx is already zoom/pan-transformed), so the
      // rings sit at their true forceRange distance instead of an approximation
      drawFieldHalo(ctx, a.x, a.y, range, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct, 1, colorForCharge(a.charge, 1));
      drawFieldHalo(ctx, b.x, b.y, range, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct, 1, colorForCharge(b.charge, 1));

      // connecting line on top, thicker/brighter the stronger the current force
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 + 2.5 * intensity;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
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
  // repel a same-signed charge / baseColor = would attract an opposite charge,
  // fading with the same envelope used in step(). Generic over which canvas/scale/
  // chargeProduct it's drawn with — used both by the Force preview panel (its own
  // canvas, a fixed +1/-1 reference pair, pixel scale) and by the Orbits panel's
  // per-pair map overlay (main canvas, the pair's own real parameters, world scale
  // 1:1 — see drawOrbitVisualizations) so both read the exact same physics.
  function drawFieldHalo(targetCtx, cx, cy, range, amp, periods, offset, phaseShift, chargeProduct, scale, baseColor) {
    const maxRpx = range * scale;
    if (maxRpx <= 0) return;
    const grad = targetCtx.createRadialGradient(cx, cy, 0, cx, cy, maxRpx);
    const STEPS = 80; // fine steps needed to resolve the oscillation clearly
    const safeAmp = Math.max(1, amp);
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const d = t * range;
      // raw>0 means attract (shown in baseColor), raw<0 means repel (shown red) —
      // includes the hard-core term so the ring colors transition smoothly through
      // d=HARD_CORE_R instead of snapping
      const raw = pairForce(d, range, safeAmp, periods, offset, phaseShift, chargeProduct) / safeAmp;
      const alpha = Math.min(1, Math.abs(raw)) * 0.8;
      const stopColor = raw >= 0
        ? baseColor.replace(/,[^,]*\)$/, ',' + alpha.toFixed(3) + ')')
        : 'rgba(255,80,80,' + alpha.toFixed(3) + ')';
      grad.addColorStop(t, stopColor);
    }
    targetCtx.fillStyle = grad;
    targetCtx.beginPath();
    targetCtx.arc(cx, cy, maxRpx, 0, Math.PI * 2);
    targetCtx.fill();
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

    drawFieldHalo(fctx, cxPos, cy, pos.forceRange, pos.force, pos.periods, pos.waveOffset, pos.phaseShift, -1, scale, colorForCharge(1, 1));
    drawFieldHalo(fctx, cxNeg, cy, neg.forceRange, neg.force, neg.periods, neg.waveOffset, neg.phaseShift, -1, scale, colorForCharge(-1, 1));

    fctx.fillStyle = colorForCharge(1, 1);
    fctx.beginPath(); fctx.arc(cxPos, cy, 3, 0, Math.PI * 2); fctx.fill();
    fctx.fillStyle = colorForCharge(-1, 1);
    fctx.beginPath(); fctx.arc(cxNeg, cy, 3, 0, Math.PI * 2); fctx.fill();

    fctx.fillStyle = '#c7cfe4';
    fctx.font = '11px sans-serif';
    fctx.textAlign = 'center';
    fctx.fillText('charge +1', cxPos, h - 34);
    fctx.fillText('range ' + pos.forceRange.toFixed(0) + 'px  periods ' + pos.periods.toFixed(2), cxPos, h - 20);
    fctx.fillText('force ' + pos.force.toFixed(0) + '  energy ' + pos.energy.toFixed(1), cxPos, h - 6);

    fctx.fillText('charge -1', cxNeg, h - 34);
    fctx.fillText('range ' + neg.forceRange.toFixed(0) + 'px  periods ' + neg.periods.toFixed(2), cxNeg, h - 20);
    fctx.fillText('force ' + neg.force.toFixed(0) + '  energy ' + neg.energy.toFixed(1), cxNeg, h - 6);
  }

  // ---------- force graph window (horizontal: force vs distance) ----------
  const winForceGraphEl = document.getElementById('winForceGraph');
  const forceGraphCanvas = document.getElementById('forceGraphCanvas');
  const gctx = forceGraphCanvas.getContext('2d');


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
    const offsetAvg = (pos.waveOffset + neg.waveOffset) / 2;
    const phaseShiftAvg = (pos.phaseShift + neg.phaseShift) / 2;

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

    // period tick marks: one per full wave cycle, labeled with distance in px.
    // Skipped near the very edges so labels don't collide with the "0"/range labels,
    // and text is dropped (ticks stay) once periods are packed too tightly to read.
    const periodsMag = Math.abs(periodsAvg);
    if (periodsMag > 0) {
      const periodPx = range / periodsMag;
      const tickScreenSpacing = xForD(periodPx) - xForD(0);
      const showLabels = tickScreenSpacing >= 26;
      gctx.strokeStyle = 'rgba(255,255,255,0.12)';
      gctx.setLineDash([2, 3]);
      gctx.fillStyle = '#8b93ad';
      gctx.font = '9px sans-serif';
      gctx.textAlign = 'center';
      const maxTicks = Math.min(Math.floor(periodsMag), 200); // safety cap
      for (let k = 1; k <= maxTicks; k++) {
        const d = k * periodPx;
        if (d > range * 0.98) break; // too close to the right edge / "range px" label
        if (d < range * 0.02) continue; // too close to the "0" label
        const x = xForD(d);
        gctx.beginPath();
        gctx.moveTo(x, padT); gctx.lineTo(x, h - padB);
        gctx.stroke();
        if (showLabels) gctx.fillText(d.toFixed(0), x, h - padB + 14);
      }
      gctx.setLineDash([]);
      gctx.textAlign = 'left'; // restore default used just below
    }

    function drawCurve(chargeProduct, color) {
      gctx.strokeStyle = color;
      gctx.lineWidth = 2;
      gctx.beginPath();
      const STEPS = 200;
      for (let i = 0; i <= STEPS; i++) {
        const d = (i / STEPS) * range;
        const f = Math.max(-maxAmp, Math.min(maxAmp, pairForce(d, range, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct)));
        const x = xForD(d), y = yForF(f);
        if (i === 0) gctx.moveTo(x, y); else gctx.lineTo(x, y);
      }
      gctx.stroke();
    }
    drawCurve(-1, '#5aa9ff');  // opposite charges
    drawCurve(1, '#ff9f4a');   // same charge

    // axis labels
    gctx.fillStyle = '#c7cfe4';
    gctx.font = '11px sans-serif';
    gctx.textAlign = 'left';
    gctx.fillText('0', padL - 4, h - padB + 14);
    gctx.textAlign = 'right';
    gctx.fillText(range.toFixed(0) + 'px', w - padR, h - padB + 14);
    gctx.textAlign = 'center';
    gctx.fillText('distance', padL + plotW / 2, h - 6);
    gctx.save();
    gctx.translate(12, padT + plotH / 2);
    gctx.rotate(-Math.PI / 2);
    gctx.fillText('force', 0, 0);
    gctx.restore();
    gctx.textAlign = 'left';
    gctx.fillText('attracts', padL + 2, padT + 10);
    gctx.fillText('repels', padL + 2, h - padB - 4);

    // legend
    gctx.fillStyle = '#5aa9ff';
    gctx.fillRect(w - 150, 6, 10, 10);
    gctx.fillStyle = '#c7cfe4';
    gctx.textAlign = 'left';
    gctx.fillText('opposite', w - 136, 15);
    gctx.fillStyle = '#ff9f4a';
    gctx.fillRect(w - 150, 20, 10, 10);
    gctx.fillStyle = '#c7cfe4';
    gctx.fillText('same charge', w - 136, 29);

    // mark currently-active stable orbits (see getStableOrbits() in step()) at the
    // distance they're actually holding — a live tie-in between "the force curve
    // says this distance should be a stable shell" and "yes, something's parked there"
    const orbits = getStableOrbits().slice(0, 8);
    gctx.font = '10px sans-serif';
    gctx.textAlign = 'center';
    const labelY = padT + 9; // just inside the top edge, above where the curves usually sit
    orbits.forEach((o, i) => {
      const d = (o.minD + o.maxD) / 2;
      if (d > range) return; // outside this chart's ±1-charge reference scale
      const x = xForD(d);
      gctx.strokeStyle = 'rgba(255,210,80,0.8)';
      gctx.setLineDash([2, 2]);
      gctx.lineWidth = 1;
      gctx.beginPath();
      gctx.moveTo(x, padT);
      gctx.lineTo(x, h - padB);
      gctx.stroke();
      gctx.setLineDash([]);

      // small solid backing behind the numeral so it stays legible over the curves
      const label = toRoman(i + 1);
      const labelW = gctx.measureText(label).width;
      gctx.fillStyle = 'rgba(5,6,10,0.85)';
      gctx.fillRect(x - labelW / 2 - 2, labelY - 8, labelW + 4, 11);
      gctx.fillStyle = 'rgba(255,210,80,0.95)';
      gctx.fillText(label, x, labelY);
    });
    gctx.textAlign = 'left';
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
    updateOrbitsPanel(dt);
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

  // ---------- selection state ----------
  // one independent floating window per selected photon, so picking a new one from
  // the list doesn't close whichever ones are already open — keyed by photon id.
  let listSelection = new Set();
  const openInfoWindows = new Map(); // photon id -> { el, titleEl, bodyEl }

  function findPhoton(id) { return photons.find(p => p.id === id); }

  function renderInfoPanel(p, w) {
    w.titleEl.textContent = 'Photon #' + p.id;
    const speed = Math.hypot(p.vx, p.vy);
    w.bodyEl.innerHTML = `
      <div class="row"><span class="k"><span class="swatch" style="background:${photonColor(p,1)}"></span>Charge</span><span class="v">${p.charge.toFixed(2)}</span></div>
      <div class="row"><span class="k">Speed (current)</span><span class="v">${speed.toFixed(1)} px/s</span></div>
      <div class="row"><span class="k">Speed (max)</span><span class="v">${p.maxSpeed.toFixed(1)} px/s</span></div>
      <div class="row"><span class="k">Mass</span><span class="v">${p.mass.toFixed(2)}</span></div>
      <div class="row"><span class="k">Energy</span><span class="v">${p.energy.toFixed(2)}</span></div>
      <div class="row"><span class="k">Force amplitude</span><span class="v">${p.force.toFixed(0)}</span></div>
      <div class="row"><span class="k">Force range</span><span class="v">${p.forceRange.toFixed(0)} px</span></div>
      <div class="row"><span class="k">Periods</span><span class="v">${p.periods.toFixed(2)}</span></div>
      <div class="row"><span class="k">Wave offset</span><span class="v">${p.waveOffset.toFixed(2)}</span></div>
      <div class="row"><span class="k">Phase shift</span><span class="v">${p.phaseShift.toFixed(2)}</span></div>
      <div class="row"><span class="k">Position</span><span class="v">${p.x.toFixed(0)}, ${p.y.toFixed(0)}</span></div>
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
          <button class="win-min" title="Minimize">–</button>
          <button class="win-close" title="Close">✕</button>
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
      addDynamicDockIcon('info-' + p.id, 'Photon #' + p.id, () => { restoreWin(el, null); removeDynamicDockIcon('info-' + p.id); });
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
      tr.innerHTML = `<td><span class="swatch" style="background:${photonColor(p,1)}"></span>${p.id}</td><td>${p.charge.toFixed(2)}</td><td>${p.maxSpeed.toFixed(0)} px/s</td><td>${p.energy.toFixed(2)}</td><td>${p.mass.toFixed(2)}</td><td>${p.force.toFixed(0)}</td><td>${p.forceRange.toFixed(0)}</td><td><button class="var-del row-del" title="Remove photon from the simulation">✕</button></td>`;
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
    // only photons with a currently open info window — listSelection also holds
    // rows that stayed listed after their window was closed (kept on purpose so the
    // list preserves history), which isn't "currently selected" for this purpose
    openReactor(Array.from(openInfoWindows.keys()));
    hideCtxMenu();
  });

  // ---------- reactor windows: isolated mini-simulation of a chosen photon subset ----------
  // each is its own small toroidal world with its own photon clones (same physics
  // identity as the originals, fresh random position/direction) — completely
  // detached from the main simulation once opened, so it keeps "flying" on its own.
  const REACTOR_SIZE = 200;
  const TRAIL_MAX = 120; // points kept per photon before the oldest end fades off
  let reactorSeq = 0;
  const reactors = [];

  function makeReactorPhoton(src) {
    const angle = rand(0, Math.PI * 2);
    return {
      // keeps the original photon's id so selecting a reactor clone selects the
      // real, still-live photon back in the main sim — see the reactor canvas'
      // click/drag handlers in openReactor(), which feed these ids straight into
      // selectPhoton()/showListPanel(), reusing the exact same list/info windows.
      id: src.id,
      x: rand(0, REACTOR_SIZE), y: rand(0, REACTOR_SIZE),
      vx: Math.cos(angle) * src.maxSpeed, vy: Math.sin(angle) * src.maxSpeed,
      charge: src.charge, mass: src.mass, maxSpeed: src.maxSpeed,
      energy: src.energy, force: src.force, forceRange: src.forceRange, periods: src.periods,
      waveOffset: src.waveOffset, phaseShift: src.phaseShift, radius: PHOTON_RADIUS, trail: []
    };
  }

  function closeReactor(reactor) {
    const i = reactors.indexOf(reactor);
    if (i === -1) return;
    if (reactor.el._resizeObserver) reactor.el._resizeObserver.disconnect();
    if (reactor.sel && reactor.sel.cleanup) reactor.sel.cleanup();
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
        <span>Reactor</span>
        <div class="window-btns">
          <button class="reactor-view" title="Toggle 2D / 2.5D view">2D</button>
          <button class="reactor-field-toggle active" data-sign="1" title="Toggle field from positive-charge photons">+</button>
          <button class="reactor-field-toggle active" data-sign="-1" title="Toggle field from negative-charge photons">−</button>
          <button class="reactor-clear" title="Clear trails">🧹</button>
          <button class="win-min" title="Minimize">–</button>
          <button class="win-close" title="Close">✕</button>
        </div>
      </div>
      <div class="window-body"><canvas width="${REACTOR_SIZE}" height="${REACTOR_SIZE}"></canvas></div>
    `;
    document.body.appendChild(el);

    const canvas = el.querySelector('canvas');
    const reactor = { el, ctx: canvas.getContext('2d'), photons: srcPhotons.map(makeReactorPhoton), mode: '2D', fieldFilter: { pos: true, neg: true } };
    reactors.push(reactor);

    makeDraggable(el);
    el.querySelector('.win-min').addEventListener('click', () => minimizeWin(el, null));
    el.querySelector('.win-close').addEventListener('click', () => closeReactor(reactor));
    el.querySelector('.reactor-clear').addEventListener('click', () => {
      reactor.photons.forEach(p => { p.trail.length = 0; });
    });
    const viewBtn = el.querySelector('.reactor-view');
    viewBtn.addEventListener('click', () => {
      reactor.mode = reactor.mode === '2D' ? '2.5D' : '2D';
      viewBtn.textContent = reactor.mode;
      viewBtn.classList.toggle('active', reactor.mode === '2.5D');
    });
    el.querySelectorAll('.reactor-field-toggle').forEach(btn => {
      const key = btn.dataset.sign === '1' ? 'pos' : 'neg';
      btn.addEventListener('click', () => {
        reactor.fieldFilter[key] = !reactor.fieldFilter[key];
        btn.classList.toggle('active', reactor.fieldFilter[key]);
      });
    });

    canvas.title = 'Click a photon = details • drag a rectangle = photon list';
    wireReactorSelection(reactor, canvas);
  }

  // click/drag select on a reactor's own canvas, mirroring the main canvas' "select"
  // brush (see the mousedown/mousemove/mouseup block near the bottom of the file).
  // Reactor photons carry the original photon's id (see makeReactorPhoton), so the
  // ids collected here feed straight into the existing selectPhoton()/showListPanel()
  // — same info windows, same list window, no reactor-specific UI needed.
  function wireReactorSelection(reactor, canvas) {
    const sel = reactor.sel = { dragging: false, active: false, x0: 0, y0: 0, x1: 0, y1: 0 };

    function pointFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (REACTOR_SIZE / rect.width),
        y: (e.clientY - rect.top) * (REACTOR_SIZE / rect.height)
      };
    }

    function onMouseDown(e) {
      sel.dragging = true; sel.active = false;
      const pt = pointFromEvent(e);
      sel.x0 = sel.x1 = pt.x; sel.y0 = sel.y1 = pt.y;
      e.preventDefault();
    }
    function onMouseMove(e) {
      if (!sel.dragging) return;
      const pt = pointFromEvent(e);
      sel.x1 = pt.x; sel.y1 = pt.y;
      if (!sel.active && Math.hypot(sel.x1 - sel.x0, sel.y1 - sel.y0) > DRAG_THRESHOLD) sel.active = true;
    }
    function onMouseUp() {
      if (!sel.dragging) return;
      sel.dragging = false;
      if (sel.active) {
        const lo = { x: Math.min(sel.x0, sel.x1), y: Math.min(sel.y0, sel.y1) };
        const hi = { x: Math.max(sel.x0, sel.x1), y: Math.max(sel.y0, sel.y1) };
        const ids = [];
        for (const p of reactor.photons) {
          const [sx, sy] = reactorPhotonScreenPos(reactor, p);
          if (sx >= lo.x && sx <= hi.x && sy >= lo.y && sy <= hi.y) ids.push(p.id);
        }
        showListPanel(ids);
      } else {
        let best = null, bestD = Infinity;
        for (const p of reactor.photons) {
          const [sx, sy] = reactorPhotonScreenPos(reactor, p);
          const d = Math.hypot(sx - sel.x0, sy - sel.y0);
          if (d < p.radius + 6 && d < bestD) { best = p; bestD = d; }
        }
        if (best) selectPhoton(best.id);
      }
      sel.active = false;
    }

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    sel.cleanup = () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
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
        const amp = (a.force + b.force) / 2;
        const periodsAvg = (a.periods + b.periods) / 2;
        const offsetAvg = (a.waveOffset + b.waveOffset) / 2;
        const phaseShiftAvg = (a.phaseShift + b.phaseShift) / 2;
        const chargeProduct = a.charge * b.charge;
        const f = pairForce(d, range, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct);
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

      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > TRAIL_MAX) p.trail.shift();
    }
  }

  // screen-space position of a photon's ball as actually drawn, in either view mode
  // (2.5D keeps balls on a flat level — see renderReactor25D) — shared by rendering
  // and by the click/drag hit-testing in wireReactorSelection() so "what you see is
  // what you can select" holds in both modes.
  function reactorPhotonScreenPos(r, p) {
    return r.mode === '2.5D' ? reactorProject(p.x, p.y, 0) : [p.x, p.y];
  }

  function drawReactorSelectionOverlay(r) {
    const ctx = r.ctx;
    for (const p of r.photons) {
      const isSelected = openInfoWindows.has(p.id);
      const isInList = listSelection.has(p.id);
      if (!isSelected && !isInList) continue;
      const [sx, sy] = reactorPhotonScreenPos(r, p);
      ctx.beginPath();
      ctx.arc(sx, sy, p.radius + (isSelected ? 5 : 3), 0, Math.PI * 2);
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.stroke();
    }
    const sel = r.sel;
    if (sel && sel.dragging && sel.active) {
      const x = Math.min(sel.x0, sel.x1), y = Math.min(sel.y0, sel.y1);
      const w = Math.abs(sel.x1 - sel.x0), h = Math.abs(sel.y1 - sel.y0);
      ctx.fillStyle = 'rgba(120,160,255,0.12)';
      ctx.strokeStyle = 'rgba(160,190,255,0.7)';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
  }

  function renderReactor2D(r) {
    const ctx = r.ctx;
    ctx.clearRect(0, 0, REACTOR_SIZE, REACTOR_SIZE);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, REACTOR_SIZE, REACTOR_SIZE);
    for (const p of r.photons) {
      if (p.trail.length > 1) {
        ctx.strokeStyle = photonColor(p, 0.35);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.trail[0].x, p.trail[0].y);
        for (let i = 1; i < p.trail.length; i++) {
          const prev = p.trail[i - 1], pt = p.trail[i];
          // a big jump means the photon wrapped around the edge — start a new
          // segment there instead of drawing a line straight across the box
          if (Math.abs(pt.x - prev.x) > REACTOR_SIZE / 2 || Math.abs(pt.y - prev.y) > REACTOR_SIZE / 2) {
            ctx.moveTo(pt.x, pt.y);
          } else {
            ctx.lineTo(pt.x, pt.y);
          }
        }
        ctx.stroke();
      }
      ctx.fillStyle = photonColor(p, 0.95);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    drawReactorSelectionOverlay(r);
  }

  // ---------- 2.5D view: a wireframe mesh warped by the same force wave that
  // governs the photons, viewed from a tilted angle so the undulation reads as
  // height. Purely a visualization — physics (stepReactor()/step()) is untouched.
  // Shared by both the reactor windows and the main simulation's own 2.5D toggle
  // (see mainViewMode / drawMainFieldMesh() below).
  const REACTOR_GRID_N_BASE = 56; // reactor mesh cells per axis at meshDensity=1 (reactor is a fixed small canvas)
  const REACTOR_GRID_N_MIN = 10, REACTOR_GRID_N_MAX = 160; // clamp so the density slider can't make it degenerate or too costly
  // was 0.55 (squishing the flat plane into a band around the vertical center) —
  // that meant the board/reactor only ever rendered into the middle ~55% of the
  // canvas height, leaving the rest empty, with anything near the world's Y edges
  // squeezed toward that same band while still needing its full range to fit,
  // reading as balls "sticking out" past the grid. 1 = no artificial squish, the
  // flat (h=0) plane maps 1:1 onto the canvas; the 3D look now comes only from the
  // height-based vertical/sideways offset (worldTiltY/worldTiltX), not this.
  const VIEW_TILT = 1;
  const VIEW_HEIGHT_SCALE = 16;   // px of screen rise per unit of field height
  const VIEW_HEIGHT_SCALE_X = 8;  // px of sideways shift per unit of field height (see worldTiltX)
  const VIEW_HEIGHT_CLAMP = 3;    // caps the field sum so overlapping photons don't fly off-canvas

  // one photon's contribution to the field height at distance d — same wave shape
  // (waveTerm) and envelope as the real pairwise force, signed by charge. Not a real
  // physical potential, just a visual stand-in for "how wavy the field is here".
  function fieldTerm(d, p) {
    if (d >= p.forceRange) return 0;
    const envelope = 1 - d / p.forceRange;
    const sign = p.charge >= 0 ? 1 : -1;
    return sign * waveTerm(d, p.forceRange, p.periods, p.waveOffset, p.phaseShift) * envelope;
  }

  function reactorFieldHeight(wx, wy, photons, filter) {
    let h = 0;
    for (const p of photons) {
      if (p.charge >= 0 ? !filter.pos : !filter.neg) continue;
      const dx = wrapDelta(wx - p.x, REACTOR_SIZE);
      const dy = wrapDelta(wy - p.y, REACTOR_SIZE);
      const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
      h += fieldTerm(d, p);
    }
    return Math.max(-VIEW_HEIGHT_CLAMP, Math.min(VIEW_HEIGHT_CLAMP, h));
  }

  // ball position and the deviation stalk both use this — purely vertical, so the
  // stalk always drops straight down onto the (sideways-warped) mesh below it
  function reactorProject(wx, wy, h) {
    return [wx, REACTOR_SIZE / 2 + (wy - REACTOR_SIZE / 2) * VIEW_TILT - h * VIEW_HEIGHT_SCALE];
  }

  // mesh grid points only: same vertical tilt as reactorProject, plus the sideways
  // nudge from worldTiltX so the mesh itself warps in both directions (rhomboid-
  // looking bumps) — see worldTiltX's comment for why the vertical-only version
  // above can't show that on its own
  function reactorProjectMesh(wx, wy, h) {
    const [, y] = reactorProject(wx, wy, h);
    return [worldTiltX(wx, h), y];
  }

  function renderReactor25D(r) {
    const ctx = r.ctx;
    ctx.clearRect(0, 0, REACTOR_SIZE, REACTOR_SIZE);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, REACTOR_SIZE, REACTOR_SIZE);

    const n = Math.round(Math.min(REACTOR_GRID_N_MAX, Math.max(REACTOR_GRID_N_MIN, REACTOR_GRID_N_BASE * meshDensity)));
    const cell = REACTOR_SIZE / n;
    // eased per-cell heights, persisted on the reactor itself (see MESH_HEIGHT_SMOOTH's
    // comment above drawMainFieldMesh — same jerk-vs-fluid fix, one buffer per window).
    // Re-sized (losing the eased state, same as a resize) whenever the density
    // slider changes n out from under this window.
    if (!r.meshH || r.meshN !== n) { r.meshH = new Float64Array((n + 1) * (n + 1)); r.meshN = n; }
    const pts = [];
    for (let gy = 0; gy <= n; gy++) {
      const pRow = [];
      for (let gx = 0; gx <= n; gx++) {
        const wx = gx * cell, wy = gy * cell;
        const idx = gy * (n + 1) + gx;
        const target = reactorFieldHeight(wx, wy, r.photons, r.fieldFilter);
        r.meshH[idx] += (target - r.meshH[idx]) * MESH_HEIGHT_SMOOTH;
        pRow.push(reactorProjectMesh(wx, wy, r.meshH[idx]));
      }
      pts.push(pRow);
    }

    // smooth curves, no fill — a dense mesh of fluid lines reads the warp shape
    // more clearly than a faceted polyline or a solid heatmap would at this spacing.
    // Every 2nd line drawn brighter, same two-tier look as drawMainFieldMesh.
    ctx.lineWidth = 0.75;
    for (let gy = 0; gy <= n; gy++) {
      ctx.strokeStyle = gy % 2 === 0 ? MESH_LINE_MAJOR : MESH_LINE_MINOR;
      strokeSmoothGridLine(ctx, pts[gy]);
    }
    for (let gx = 0; gx <= n; gx++) {
      ctx.strokeStyle = gx % 2 === 0 ? MESH_LINE_MAJOR : MESH_LINE_MINOR;
      const col = [];
      for (let gy = 0; gy <= n; gy++) col.push(pts[gy][gx]);
      strokeSmoothGridLine(ctx, col);
    }

    // photons stay on one flat level — only the stalk moves up/down to show the
    // local field deviation, so the balls themselves don't bounce around
    for (const p of r.photons) {
      const ownSignVisible = p.charge >= 0 ? r.fieldFilter.pos : r.fieldFilter.neg;
      const h = reactorFieldHeight(p.x, p.y, r.photons, r.fieldFilter);
      const [bx, by] = reactorProject(p.x, p.y, 0);
      if (ownSignVisible) {
        const [tx, ty] = reactorProject(p.x, p.y, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }
      ctx.fillStyle = photonColor(p, 0.95);
      ctx.beginPath();
      ctx.arc(bx, by, p.radius + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    drawReactorSelectionOverlay(r);
  }

  function renderReactor(r) {
    if (r.el.classList.contains('minimized')) return;
    if (r.mode === '2.5D') renderReactor25D(r);
    else renderReactor2D(r);
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
  const winOrbits = document.getElementById('winOrbits');
  const dockOrbits = document.getElementById('dockOrbits');

  [ [winStats, dockStats], [winEditor, dockEditor], [winForce, dockForce], [winForceGraph, dockForceGraph], [winFilter, dockFilter], [winOrbits, dockOrbits] ].forEach(([win, dockBtn]) => {
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
    if (listSelection.size) addDynamicDockIcon('list', 'Selected (' + listSelection.size + ')', () => { restoreWin(winList, null); removeDynamicDockIcon('list'); });
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
    if (!confirm('Delete saved data (editor formulas, window size/position, and stats settings) and restore the defaults?')) return;
    try {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(WIN_LS_KEY);
      localStorage.removeItem(STATS_LS_KEY);
    } catch (e) { /* ignore (e.g. storage disabled) */ }
    location.reload();
  });

  // ---------- brush tools: select / attract / spawn ----------
  let currentTool = 'select';   // 'select' | 'attract' | 'spawn'
  let attractCharge = 'all';    // 'all' | 'pos' | 'neg'

  const toolButtons = document.querySelectorAll('#toolGroup .tool-btn');
  const chargeGroup = document.getElementById('chargeGroup');
  const chargeButtons = document.querySelectorAll('.charge-btn');
  const hintEl = document.getElementById('hint');

  function updateHint() {
    if (currentTool === 'select') {
      hintEl.textContent = 'Click a photon = details • drag a rectangle = photon list';
    } else if (currentTool === 'attract') {
      const label = attractCharge === 'all' ? 'all charges' : (attractCharge === 'pos' ? 'positive charges (+)' : 'negative charges (–)');
      hintEl.textContent = 'Hold and move the cursor to attract toward it: ' + label;
    } else {
      hintEl.textContent = 'Click or drag to create new photons (per the photon editor)';
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

  const glowToggle = document.getElementById('glowToggle');
  glowToggle.checked = glowEnabled;
  glowToggle.addEventListener('change', () => { glowEnabled = glowToggle.checked; });

  // which charges feed the main view's 2.5D field mesh (mainFieldFilter) — mirrors
  // each reactor window's own +/- field toggle, scoped to #fieldFilterGroup so it
  // doesn't get swept up by the unrelated (unscoped) .charge-btn wiring above
  const fieldFilterButtons = document.querySelectorAll('#fieldFilterGroup .field-filter-btn');
  fieldFilterButtons.forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.sign === 'pos' ? 'pos' : 'neg';
    mainFieldFilter[key] = !mainFieldFilter[key];
    b.classList.toggle('active', mainFieldFilter[key]);
  }));

  // ---------- main 2D/2.5D view toggle ----------
  const mainViewToggleBtn = document.getElementById('mainViewToggle');
  const meshDensityRow = document.getElementById('meshDensityRow');
  const meshDensitySlider = document.getElementById('meshDensity');
  const meshDensityVal = document.getElementById('meshDensityVal');
  mainViewToggleBtn.addEventListener('click', () => {
    mainViewMode = mainViewMode === '2D' ? '2.5D' : '2D';
    mainViewToggleBtn.textContent = mainViewMode;
    mainViewToggleBtn.classList.toggle('active', mainViewMode === '2.5D');
    meshDensityRow.classList.toggle('hidden', mainViewMode !== '2.5D');
  });
  meshDensitySlider.addEventListener('input', () => {
    meshDensity = Number(meshDensitySlider.value);
    meshDensityVal.textContent = meshDensity.toFixed(1) + 'x';
  });

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

  // Delete key: removes every photon currently in the "Selected photons" list from
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
