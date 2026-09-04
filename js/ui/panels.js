"use strict";

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

  // ---------- Logs panel: orbit pairs (updateOrbitTracking()) and nucleus+shell
  // atoms (updateClusterTracking()), both in stepMain3D() ----------
  const orbitsList = document.getElementById('orbitsList');
  let orbitsPanelTimer = 0;
  const ORBITS_PANEL_REFRESH = 0.5; // seconds of real time between DOM rebuilds — duration only needs whole-second resolution anyway
  const ORBIT_HISTORY_SHOWN = 5;    // most-recent ended orbits shown below the active ones

  // group keys (sorted, underscore-joined member ids — "idA_idB" for a pair,
  // "id1_id2_..." for an atom's nucleus+shell) whose force preview + connecting
  // line are drawn on the main canvas every frame (see drawOrbitVisualizations3D()),
  // toggled by each row's "eye" button, auto-dropped once the group actually
  // stops holding together (not just once it dips below the stability bar —
  // see pruneVisualizedGroups)
  const visualizedGroups = new Set();

  function orbitRangeText(minD, maxD) { return minD.toFixed(0) + '–' + maxD.toFixed(0) + 'px'; }
  function atomMembersText(members, nucleusSet) {
    return members.map(id => '#' + id + (nucleusSet.has(id) ? '★' : '')).join(', ');
  }

  // named atoms whose shell-version history is currently shown expanded —
  // keyed by nucleus key, persists across the panel's own periodic innerHTML
  // rebuilds below
  const expandedFusions = new Set();

  function updateOrbitsPanel(realDt) {
    pruneVisualizedGroups();
    orbitsPanelTimer += realDt;
    if (orbitsPanelTimer < ORBITS_PANEL_REFRESH) return;
    orbitsPanelTimer = 0;

    const activePairs = getStableOrbits().slice(0, 8);
    const endedPairs = Array.from(orbitHistoryByPair.values())
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, ORBIT_HISTORY_SHOWN);
    const atoms = getNamedAtomRows();
    if (!activePairs.length && !endedPairs.length && !atoms.length) {
      orbitsList.innerHTML = '<div class="field-hint">Nothing stable detected yet.</div>';
      return;
    }

    function actionButtons(key) {
      const vizOn = visualizedGroups.has(key);
      return `<span class="orbit-actions">
          <button class="orbit-action-btn orbit-center-btn" title="Zoom in so this reads clearly">⌖</button>
          <button class="orbit-action-btn orbit-viz-btn${vizOn ? ' active' : ''}" title="Show force preview + connecting line on the map, until it breaks up">👁</button>
        </span>`;
    }

    let html = activePairs.map(o => {
      const key = orbitPairKey({ id: o.idA }, { id: o.idB });
      return `
      <div class="row orbit-row" data-members="${o.idA},${o.idB}" data-key="${key}" title="Click to select this pair">
        <span class="k">#${o.idA} ↔ #${o.idB} <span class="orbit-range">${orbitRangeText(o.minD, o.maxD)}</span></span>
        <span class="v">${formatDuration(o.duration)}</span>
        ${actionButtons(key)}
      </div>`;
    }).join('');
    if (endedPairs.length) {
      html += '<div class="field-hint" style="margin:6px 0 2px">Recently ended</div>';
      html += endedPairs.map(o => `
        <div class="row orbit-row ended" data-members="${o.idA},${o.idB}" title="Click to select this pair">
          <span class="k">#${o.idA} ↔ #${o.idB} <span class="orbit-range">${orbitRangeText(o.minD, o.maxD)}</span></span>
          <span class="v">(ended) ${formatDuration(o.duration)}</span>
        </div>`).join('');
    }
    if (atoms.length) {
      html += '<div class="field-hint" style="margin:6px 0 2px">Atoms (nucleus ★ + orbital shell) — click a name for its shell history</div>';
      html += atoms.map(a => {
        // viz toggle is keyed by the nucleus alone (its identity), not the exact
        // current shell snapshot, so the preview keeps showing through shell
        // membership changes — the render side (drawOrbitVisualizations3D) looks
        // up the live shell itself via currentShellMembers(key)
        const allMembers = a.nucleusMembers.concat(a.shell);
        const key = a.key;
        const nucleusSet = new Set(a.nucleusMembers);
        const expanded = expandedFusions.has(a.key);
        const props = `nucleus ${a.nucleusMembers.length}, orbit ${a.shell.length}, `
          + `nucleus mass ${a.nucleusMass.toFixed(2)}, mass ${a.mass.toFixed(2)}, energy ${a.energy.toFixed(2)}`;
        let row = `
      <div class="row orbit-row fusion${a.active ? '' : ' ended'}" data-members="${allMembers.join(',')}" data-key="${key}" data-core="${a.key}" title="Click to expand its shell history">
        <span class="k"><span class="fusion-expand${expanded ? ' open' : ''}">▸</span> ${a.name} <span class="orbit-range">${props}</span></span>
        <span class="v">${a.active ? '' : '(ended) '}${formatDuration(a.duration)}</span>
        ${actionButtons(key)}
      </div>`;
        if (expanded) {
          row += `<div class="fusion-history">` + (a.history.length
            ? a.history.map(v => `
              <div class="row"><span class="k">${atomMembersText(v.shell, nucleusSet)}</span><span class="v">${formatDuration(v.duration)}</span></div>`).join('')
            : '<div class="field-hint">No earlier shell versions yet.</div>') + `</div>`;
        }
        return row;
      }).join('');
    }
    orbitsList.innerHTML = html;
  }

  // a visualized group keeps showing while it's still tracked at all (still in
  // orbitTracker for a pair, nucleusTracker for an atom's nucleus), not just
  // while past the display thresholds — so it survives the normal wobble in/out
  // of stability, and only clears once the group truly stops holding together,
  // or a member is removed. Atom keys are nucleus-only (see the atoms.map()
  // above), so a 2-member key can match either a plain pair or a 2-member
  // nucleus — checking both trackers covers either case.
  function pruneVisualizedGroups() {
    for (const key of visualizedGroups) {
      const ids = key.split('_').map(Number);
      if (ids.some(id => !findPhoton(id))) { visualizedGroups.delete(key); continue; }
      const stillTracked = orbitTracker.has(key) || nucleusTracker.has(key);
      if (!stillTracked) visualizedGroups.delete(key);
    }
  }

  // zooms in on a group of photons (a pair, or a >2-member fusion), rotating
  // first so the line from the sphere's own center through the group's centroid
  // points straight at the viewer. The camera's pivot always stays on the
  // sphere's center (mainProject3D rotates/scales everything around that point,
  // never around an arbitrary recentered spot) — but by aiming that fixed
  // pivot's viewing axis at the group first, its distance from center shows up
  // entirely as depth instead of as a screen-space offset, so the zoom
  // afterwards keeps it centered instead of pushing it toward the edge.
  const ORBIT_ZOOM_TARGET_PX = 140; // desired on-screen radius of the group (centroid to farthest member)
  // capped well below the global MAX_ZOOM (8): zoom this far in and the sphere's
  // own curvature over the patch you can see gets imperceptible — the boundary
  // wireframe spreads out so far it's off-screen in every direction, so a tight
  // group ends up looking like it's floating in open space instead of inside a
  // bounded sphere (even though the physics/wrap boundary is still fully in
  // effect — it's purely a "the horizon looks flat when you stand on it" artifact
  // of zooming in on any sphere). Staying under this keeps some visible curve.
  const ORBIT_MAX_ZOOM = 3;
  function centerCameraOnMembers(ids) {
    const members = ids.map(findPhoton).filter(Boolean);
    if (members.length === 0) return;
    const c = mainSphereCenter();
    let mx = 0, my = 0, mz = 0;
    for (const p of members) { mx += p.x; my += p.y; mz += p.z; }
    mx /= members.length; my /= members.length; mz /= members.length;

    const relX = mx - c.x, relY = my - c.y, relZ = mz - c.z;
    const horizR = Math.hypot(relX, relY);
    mainRot3D.y = Math.atan2(relX, relY);
    mainRot3D.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.atan2(horizR, relZ)));

    // "spread" = farthest member from the centroid — for a pair this is exactly
    // half their separation, so the zoom formula matches the old pair-only math
    let maxSpread = 1;
    for (const p of members) maxSpread = Math.max(maxSpread, Math.hypot(p.x - mx, p.y - my, p.z - mz));
    zoom = Math.max(MIN_ZOOM, Math.min(ORBIT_MAX_ZOOM, ORBIT_ZOOM_TARGET_PX / (maxSpread * 2)));
  }

  // event delegation: rows are rebuilt wholesale on every refresh above, so a
  // single listener on the (never-replaced) container beats re-binding per row.
  // Atom rows toggle their shell-version history on click (see expandedFusions);
  // pair rows still select into the main "Selected photons" list, as before.
  // data-key (viz toggle identity) and data-members (framing/selection set) are
  // kept separate — for an atom they differ (nucleus-only vs nucleus+shell).
  orbitsList.addEventListener('click', (e) => {
    const centerBtn = e.target.closest('.orbit-center-btn');
    const vizBtn = e.target.closest('.orbit-viz-btn');
    const row = e.target.closest('.orbit-row');
    if (!row) return;
    const ids = row.dataset.members.split(',').map(Number);
    const key = row.dataset.key;
    if (centerBtn) {
      e.stopPropagation();
      centerCameraOnMembers(ids);
      return;
    }
    if (vizBtn) {
      e.stopPropagation();
      if (visualizedGroups.has(key)) visualizedGroups.delete(key);
      else visualizedGroups.add(key);
      vizBtn.classList.toggle('active', visualizedGroups.has(key));
      return;
    }
    if (row.classList.contains('fusion')) {
      const core = row.dataset.core;
      if (expandedFusions.has(core)) expandedFusions.delete(core);
      else expandedFusions.add(core);
      orbitsPanelTimer = ORBITS_PANEL_REFRESH; // force an immediate rebuild instead of waiting for the next tick
      return;
    }
    showListPanel(ids);
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
    if (visualizedGroups.size === 0) return;
    for (const key of visualizedGroups) {
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

  // 3D counterpart of drawOrbitVisualizations() above — same physics (real 3D
  // distance now, see currentPairForce), same per-photon field shells as the
  // selected-photon "shell view" (drawFieldShells3D, shared with reactor windows).
  // Pairs: the pair's own real range/amp/chargeProduct (not a fixed "opposite test
  // charge" reference) plus a connecting line between them. Atoms (nucleusTracker
  // keys): shells around just the core (innermost/"first ring" of the nucleus),
  // using its own field, with spoke lines out to every other nucleus member AND
  // whatever's currently on its orbital shell (fetched live via
  // currentShellMembers, since the viz key is nucleus-only and the shell keeps
  // changing) — there's no single well-defined "mutual force" for a whole group
  // the way there is for a pair.
  function drawOrbitVisualizations3D(targetCtx, project) {
    if (visualizedGroups.size === 0) return;
    for (const key of visualizedGroups) {
      const nRec = nucleusTracker.get(key);
      const ids = nRec ? Array.from(nRec.members).concat(currentShellMembers(key)) : key.split('_').map(Number);
      const members = ids.map(findPhoton).filter(Boolean);
      if (members.length < 2) continue;

      if (members.length === 2) {
        const [a, b] = members;
        const { range, f, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct } = currentPairForce(a, b);
        const intensity = range > 0 ? Math.max(0, Math.min(1, Math.abs(f) / (amp || 1))) : 0;
        const color = (f >= 0 ? ORBIT_ATTRACT_COLOR : ORBIT_REPEL_COLOR).replace('ALPHA', (0.35 + 0.5 * intensity).toFixed(2));

        drawFieldShells3D(targetCtx, a.x, a.y, a.z, range, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct, project, colorForCharge(a.charge, 1));
        drawFieldShells3D(targetCtx, b.x, b.y, b.z, range, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct, project, colorForCharge(b.charge, 1));

        const [ax, ay] = project(a.x, a.y, a.z);
        const [bx, by] = project(b.x, b.y, b.z);
        targetCtx.strokeStyle = color;
        targetCtx.lineWidth = 1.5 + 2.5 * intensity;
        targetCtx.beginPath();
        targetCtx.moveTo(ax, ay);
        targetCtx.lineTo(bx, by);
        targetCtx.stroke();
        continue;
      }

      // core = innermost NUCLEUS member specifically (not just whoever's nearest
      // to the combined centroid) — an orbiting shell photon should never stand
      // in as the "core" just because of where it happens to be right now
      const coreCandidates = nRec ? members.filter(p => nRec.members.has(p.id)) : members;
      const c = nRec && nRec.centroid ? nRec.centroid : (() => {
        let cx = 0, cy = 0, cz = 0;
        for (const p of coreCandidates) { cx += p.x; cy += p.y; cz += p.z; }
        return { x: cx / coreCandidates.length, y: cy / coreCandidates.length, z: cz / coreCandidates.length };
      })();
      let core = coreCandidates[0], bestD = Infinity;
      for (const p of coreCandidates) {
        const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
        if (d < bestD) { bestD = d; core = p; }
      }

      drawFieldShells3D(targetCtx, core.x, core.y, core.z, core.forceRange, core.force, core.periods, core.waveOffset, core.phaseShift, -1, project, photonColor(core, 1));

      const [coreX, coreY] = project(core.x, core.y, core.z);
      targetCtx.strokeStyle = 'rgba(255,210,80,0.6)';
      targetCtx.lineWidth = 1.5;
      for (const p of members) {
        if (p === core) continue;
        const [px, py] = project(p.x, p.y, p.z);
        targetCtx.beginPath();
        targetCtx.moveTo(coreX, coreY);
        targetCtx.lineTo(px, py);
        targetCtx.stroke();
      }
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
    if (!paused) { if (mainViewMode === '3D') stepMain3D(dt * speedMultiplier); else step(dt * speedMultiplier); }
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

