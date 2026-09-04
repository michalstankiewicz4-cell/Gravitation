"use strict";

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
      x: rand(0, W), y: rand(0, H), z: 0,
      vx: Math.cos(angle) * initSpeed, vy: Math.sin(angle) * initSpeed, vz: 0,
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

  // main simulation's mode. 3D is the only mode now (no toggle button — see
  // controls.js), so this stays '3D' permanently; kept as a named variable (rather
  // than inlining) because step()/renderMain2D() are still there, unused, in case
  // 2D ever needs to come back. Physics itself differs from the old flat, wrapping
  // torus (step()): 3D photons fly freely inside a bounded sphere (stepMain3D()).
  let mainViewMode = '3D';
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
  // neighbor. Used by the orbit-pair visualization (see visualizedGroups in panels.js).
  function currentPairForce(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz));
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

  // ---------- nucleus + atom detection ----------
  // Two-tier model, mirroring a real atom: a tightly-bound NUCLEUS (2+ photons
  // connected by the SAME stable-pair graph orbitTracker already maintains,
  // held together — same exact membership — unbroken for NUCLEUS_MIN_DURATION)
  // at the center, plus a looser ORBITAL SHELL of other photons circling that
  // nucleus's centroid at a roughly constant distance for at least
  // ORBIT_SHELL_MIN_DURATION. Only once both are satisfied does the whole thing
  // become a named "atom". Its identity is tied to the NUCLEUS specifically: the
  // shell can gain/lose members freely (each change just closes out a "version"
  // into the same atom's own history — see updateNamedAtoms), but if the nucleus
  // itself changes, that atom ends outright and a brand-new one begins.
  const NUCLEUS_MIN_DURATION = 20;     // seconds a nucleus membership must hold before it's considered stable
  const ORBIT_SHELL_MIN_DURATION = 20; // seconds an orbiting photon's distance-to-nucleus must stay stable

  const nucleusTracker = new Map(); // "id1_id2_..." (sorted) -> { members: Set, since, centroid: {x,y,z}|null }

  function nucleusKey(members) { return Array.from(members).sort((a, b) => a - b).join('_'); }

  function computeStableNucleusGroups() {
    // union-find over every currently-stable pair in orbitTracker
    const parent = new Map();
    function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
    for (const [key, rec] of orbitTracker) {
      if (rec.stableSince === null) continue;
      const [a, b] = key.split('_').map(Number);
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      union(a, b);
    }
    const groups = new Map(); // root -> Set(member ids)
    for (const id of parent.keys()) {
      const root = find(id);
      if (!groups.has(root)) groups.set(root, new Set());
      groups.get(root).add(id);
    }
    return Array.from(groups.values()).filter(g => g.size >= 2);
  }

  function groupCentroid(members) {
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const id of members) {
      const p = findPhoton(id);
      if (!p) continue;
      cx += p.x; cy += p.y; cz += p.z; n++;
    }
    return n > 0 ? { x: cx / n, y: cy / n, z: cz / n } : null;
  }

  // called once per physics step, after the pairwise loop has settled this
  // frame's orbitTracker state (see stepMain3D)
  function updateClusterTracking() {
    const groups = computeStableNucleusGroups();
    const seenKeys = new Set();
    for (const members of groups) {
      const key = nucleusKey(members);
      seenKeys.add(key);
      let rec = nucleusTracker.get(key);
      if (!rec) { rec = { members, since: simTime, centroid: null }; nucleusTracker.set(key, rec); }
      rec.centroid = groupCentroid(members);
    }
    // no longer a connected component at all — just drop it (any *named* atom
    // built on this nucleus gets closed out by updateNamedAtoms below, since it
    // won't find this key among nucleusTracker's survivors either)
    for (const key of nucleusTracker.keys()) {
      if (!seenKeys.has(key)) nucleusTracker.delete(key);
    }
    updateShellTracking();
    updateNamedAtoms();
  }

  // distance-to-nucleus-centroid stability for every photon NOT in that nucleus
  // — the exact same rolling-window/variation check as the pairwise orbitTracker
  // above (ORBIT_WINDOW/ORBIT_VARIATION_MAX), just measured against a moving
  // centroid instead of a single other photon. Only checked against nuclei that
  // have themselves already cleared NUCLEUS_MIN_DURATION — no point looking for
  // "electrons" around a "nucleus" that isn't stable yet.
  const shellTracker = new Map(); // "nucleusKey|photonId" -> { samples, stableSince, stableMinD, stableMaxD }

  function updateShellTracking() {
    for (const [nKey, nRec] of nucleusTracker) {
      if (simTime - nRec.since < NUCLEUS_MIN_DURATION || !nRec.centroid) continue;
      const c = nRec.centroid;
      for (const p of photons) {
        if (nRec.members.has(p.id)) continue;
        const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
        const shellKey = nKey + '|' + p.id;
        let rec = shellTracker.get(shellKey);
        if (!rec) { rec = { samples: [], stableSince: null, stableMinD: 0, stableMaxD: 0 }; shellTracker.set(shellKey, rec); }
        rec.samples.push({ t: simTime, d });
        while (rec.samples.length > 1 && rec.samples[0].t < simTime - ORBIT_WINDOW) rec.samples.shift();
        if (simTime - rec.samples[0].t < ORBIT_WINDOW * 0.9) { rec.stableSince = null; continue; }
        let minD = Infinity, maxD = -Infinity, sum = 0;
        for (const s of rec.samples) { if (s.d < minD) minD = s.d; if (s.d > maxD) maxD = s.d; sum += s.d; }
        const avgD = sum / rec.samples.length;
        const variation = avgD > 0 ? (maxD - minD) / avgD : 0;
        if (variation <= ORBIT_VARIATION_MAX) {
          if (rec.stableSince === null) { rec.stableSince = simTime; rec.stableMinD = d; rec.stableMaxD = d; }
          else { rec.stableMinD = Math.min(rec.stableMinD, d); rec.stableMaxD = Math.max(rec.stableMaxD, d); }
        } else {
          rec.stableSince = null;
        }
      }
    }
    // drop entries for nuclei that no longer exist at all
    for (const key of shellTracker.keys()) {
      const nKey = key.slice(0, key.lastIndexOf('|'));
      if (!nucleusTracker.has(nKey)) shellTracker.delete(key);
    }
  }

  function currentShellMembers(nKey) {
    const prefix = nKey + '|';
    const result = [];
    for (const [key, rec] of shellTracker) {
      if (!key.startsWith(prefix)) continue;
      if (rec.stableSince === null) continue;
      if (simTime - rec.stableSince < ORBIT_SHELL_MIN_DURATION) continue;
      result.push(Number(key.slice(prefix.length)));
    }
    return result;
  }

  // ---------- named atoms: a persistent identity for a stable nucleus ----------
  // keyed by the nucleus's own membership (see updateClusterTracking above), so
  // changing the ORBITAL SHELL just closes out a "version" into the same atom's
  // history, but changing the NUCLEUS always means a brand-new atom — an atom's
  // identity IS its nucleus.
  const ATOM_NAME_PARTS = ['Xen', 'Vel', 'Kry', 'Nyx', 'Or', 'Tha', 'Zar', 'Quin', 'Myr', 'Il', 'Cor', 'Ast', 'Vor', 'Lun', 'Sol'];
  function randomAtomName() {
    const a = ATOM_NAME_PARTS[Math.floor(Math.random() * ATOM_NAME_PARTS.length)];
    const b = ATOM_NAME_PARTS[Math.floor(Math.random() * ATOM_NAME_PARTS.length)].toLowerCase();
    return a + b + '-' + (Math.floor(Math.random() * 90) + 10);
  }
  function membersEqual(a, b) {
    if (a.length !== b.length) return false;
    const sa = new Set(a);
    return b.every(id => sa.has(id));
  }
  const ATOM_HISTORY_MAX = 20; // capped per-atom shell-version history
  // nucleusKey -> { name, nucleusMembers, currentShell, currentShellSince, history: [{shell,duration,endedAt}], active }
  const namedAtoms = new Map();

  function updateNamedAtoms() {
    const activeKeys = new Set();
    for (const [nKey, nRec] of nucleusTracker) {
      if (simTime - nRec.since < NUCLEUS_MIN_DURATION) continue;
      const shell = currentShellMembers(nKey);
      let atom = namedAtoms.get(nKey);
      if (!atom) {
        if (shell.length === 0) continue; // needs at least one qualifying orbiter to be born
        // back-date to whichever qualifying orbiter has been stable longest, so
        // the very first duration shown isn't understated
        let earliestSince = simTime;
        for (const id of shell) {
          const srec = shellTracker.get(nKey + '|' + id);
          if (srec && srec.stableSince !== null) earliestSince = Math.min(earliestSince, srec.stableSince);
        }
        namedAtoms.set(nKey, {
          name: randomAtomName(), nucleusMembers: Array.from(nRec.members),
          currentShell: shell, currentShellSince: earliestSince, history: [], active: true
        });
        activeKeys.add(nKey);
        continue;
      }
      activeKeys.add(nKey);
      atom.active = true;
      if (!membersEqual(atom.currentShell, shell)) {
        atom.history.unshift({ shell: atom.currentShell, duration: simTime - atom.currentShellSince, endedAt: simTime });
        atom.history.length = Math.min(atom.history.length, ATOM_HISTORY_MAX);
        atom.currentShell = shell;
        atom.currentShellSince = simTime;
      }
    }
    for (const [nKey, atom] of namedAtoms) {
      if (atom.active && !activeKeys.has(nKey)) {
        atom.history.unshift({ shell: atom.currentShell, duration: simTime - atom.currentShellSince, endedAt: simTime });
        atom.history.length = Math.min(atom.history.length, ATOM_HISTORY_MAX);
        atom.active = false;
      }
    }
  }

  // one row per named atom (active or ended) for the Logs panel — its own
  // `history` is sorted longest-first, so it's easy to see which shell version
  // held together longest around this particular nucleus. nucleusMass/
  // nucleusEnergy are summed over just the nucleus (the atom's dense "core"),
  // mass/energy are the whole atom's totals — nucleus plus whatever's
  // currently on the orbital shell — so both the core weight and the full
  // picture are available to the panel.
  function getNamedAtomRows() {
    const result = [];
    for (const [nKey, atom] of namedAtoms) {
      let nucleusMass = 0, nucleusEnergy = 0;
      for (const id of atom.nucleusMembers) { const p = findPhoton(id); if (p) { nucleusMass += p.mass; nucleusEnergy += p.energy; } }
      let shellMass = 0, shellEnergy = 0;
      for (const id of atom.currentShell) { const p = findPhoton(id); if (p) { shellMass += p.mass; shellEnergy += p.energy; } }
      const duration = atom.active ? (simTime - atom.currentShellSince) : (atom.history.length ? atom.history[0].duration : 0);
      result.push({
        key: nKey, name: atom.name, active: atom.active,
        nucleusMembers: atom.nucleusMembers, shell: atom.currentShell, duration,
        nucleusMass, nucleusEnergy, mass: nucleusMass + shellMass, energy: nucleusEnergy + shellEnergy,
        history: atom.history.slice().sort((a, b) => b.duration - a.duration)
      });
    }
    result.sort((a, b) => (b.active - a.active) || (b.duration - a.duration));
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

