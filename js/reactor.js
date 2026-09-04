"use strict";

  // ---------- reactor windows: isolated mini-simulation of a chosen photon subset ----------
  // each is its own small toroidal world with its own photon clones (same physics
  // identity as the originals, fresh random position/direction) — completely
  // detached from the main simulation once opened, so it keeps "flying" on its own.
  const REACTOR_SIZE = 200;
  const TRAIL_MAX = 120; // points kept per photon before the oldest end fades off
  const REACTOR_SPHERE_CENTER = { x: REACTOR_SIZE / 2, y: REACTOR_SIZE / 2, z: 0 };
  const REACTOR_SPHERE_RADIUS = REACTOR_SIZE / 2 * 0.85;
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
      x: rand(0, REACTOR_SIZE), y: rand(0, REACTOR_SIZE), z: 0,
      vx: Math.cos(angle) * src.maxSpeed, vy: Math.sin(angle) * src.maxSpeed, vz: 0,
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
    if (reactor.rotCleanup) reactor.rotCleanup();
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
          <button class="reactor-view" title="Toggle 2D / 3D view">2D</button>
          <button class="reactor-clear" title="Clear trails">🧹</button>
          <button class="win-min" title="Minimize">–</button>
          <button class="win-close" title="Close">✕</button>
        </div>
      </div>
      <div class="window-body"><canvas width="${REACTOR_SIZE}" height="${REACTOR_SIZE}"></canvas></div>
    `;
    document.body.appendChild(el);

    const canvas = el.querySelector('canvas');
    const reactor = {
      el, ctx: canvas.getContext('2d'), photons: srcPhotons.map(makeReactorPhoton), mode: '2D',
      rot3D: { x: DEFAULT_ROT3D.x, y: DEFAULT_ROT3D.y }
    };
    reactors.push(reactor);

    makeDraggable(el);
    el.querySelector('.win-min').addEventListener('click', () => minimizeWin(el, null));
    el.querySelector('.win-close').addEventListener('click', () => closeReactor(reactor));
    el.querySelector('.reactor-clear').addEventListener('click', () => {
      reactor.photons.forEach(p => { p.trail.length = 0; });
    });
    const viewBtn = el.querySelector('.reactor-view');
    viewBtn.addEventListener('click', () => {
      reactor.mode = reactor.mode === '2D' ? '3D' : '2D';
      viewBtn.textContent = reactor.mode;
      viewBtn.classList.toggle('active', reactor.mode === '3D');
      canvas.title = reactor.mode === '3D'
        ? 'Click a photon = details • drag a rectangle = photon list • right-drag to rotate'
        : 'Click a photon = details • drag a rectangle = photon list';
      // scatter into the reactor's own sphere the first time it goes 3D — otherwise
      // every photon sits flat on z=0 (2D mode never touches z) and never leaves it,
      // since two same-z photons only ever push each other within that same plane
      if (reactor.mode === '3D') {
        scatterIntoSphere(reactor.photons, REACTOR_SPHERE_CENTER, REACTOR_SPHERE_RADIUS);
      }
    });
    reactor.rotCleanup = wireDragRotate(canvas, reactor.rot3D, () => reactor.mode === '3D');

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
      if (e.button !== 0) return; // right-click is reserved for rotating the 3D view — see wireDragRotate
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

  // same pairwise force law extended to 3D (see stepMain3D's comment for why),
  // bounded by the reactor's own small sphere (applyBoundary) instead of the flat
  // toroidal wrap stepReactor() uses. Still brute-force — a reactor only ever holds
  // a small hand-picked subset of photons, so a spatial grid isn't worth it here.
  function stepReactor3D(r, dt) {
    const n = r.photons.length;
    if (n === 0) return;
    const ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = r.photons[i];
      for (let j = i + 1; j < n; j++) {
        const b = r.photons[j];
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 0.01) {
          const dir = randomVelocity3D(0.1);
          dx = dir.vx; dy = dir.vy; dz = dir.vz; d = 0.1;
        }
        const range = (a.forceRange + b.forceRange) / 2;
        if (d >= range) continue;
        const ux = dx / d, uy = dy / d, uz = dz / d;
        const amp = (a.force + b.force) / 2;
        const periodsAvg = (a.periods + b.periods) / 2;
        const offsetAvg = (a.waveOffset + b.waveOffset) / 2;
        const phaseShiftAvg = (a.phaseShift + b.phaseShift) / 2;
        const chargeProduct = a.charge * b.charge;
        const f = pairForce(d, range, amp, periodsAvg, offsetAvg, phaseShiftAvg, chargeProduct);
        const fx = ux * f, fy = uy * f, fz = uz * f;
        ax[i] += fx; ay[i] += fy; az[i] += fz;
        ax[j] -= fx; ay[j] -= fy; az[j] -= fz;
      }
    }
    // collected rather than spliced out mid-loop, same reasoning as stepMain3D
    const despawned = new Set();
    for (let i = 0; i < n; i++) {
      const p = r.photons[i];
      p.vx += (ax[i] / p.mass) * dt;
      p.vy += (ay[i] / p.mass) * dt;
      p.vz += (az[i] / p.mass) * dt;
      const s = Math.hypot(p.vx, p.vy, p.vz);
      if (s > 0.0001) {
        const k = p.maxSpeed / s;
        p.vx *= k; p.vy *= k; p.vz *= k;
      } else {
        const v = randomVelocity3D(p.maxSpeed);
        p.vx = v.vx; p.vy = v.vy; p.vz = v.vz;
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      // despawning a reactor clone only removes it from this reactor's own little
      // simulation — the original photon back in the main sim is untouched
      if (applyBoundary(p, REACTOR_SPHERE_CENTER, REACTOR_SPHERE_RADIUS)) { despawned.add(p); continue; }

      p.trail.push({ x: p.x, y: p.y, z: p.z });
      if (p.trail.length > TRAIL_MAX) p.trail.shift();
    }
    if (despawned.size) r.photons = r.photons.filter(p => !despawned.has(p));
  }

  // screen-space position of a photon's ball as actually drawn, in either view mode
  // — shared by rendering and by the click/drag hit-testing in wireReactorSelection()
  // so "what you see is what you can select" holds in both modes.
  function reactorPhotonScreenPos(r, p) {
    if (r.mode === '3D') { const [sx, sy] = reactorProject3D(p.x, p.y, p.z, r.rot3D); return [sx, sy]; }
    return [p.x, p.y];
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

  // ---------- 3D view: real 3D physics, viewed through a fully rotatable
  // orthographic projection. See stepMain3D()'s comment above for the physics side
  // (stepReactor3D() below is the same idea, bounded by the reactor's own small
  // sphere instead of the main one) — this part is purely the camera/rendering math,
  // shared by every reactor window and the main simulation's own 3D toggle.
  const ROTATE_SPEED = 0.01;      // radians of rotation per pixel of right-drag
  const PITCH_LIMIT = 1.45;       // clamp (~83°) so the view can't flip past vertical and disorient
  // identity rotation — at {x:0, y:0} project3D is a no-op, which lines up the
  // compass markers (drawSphereMarkers) exactly on-axis: N top, S bottom, W left,
  // E right (see project3D's own comment for the axis convention).
  const DEFAULT_ROT3D = { x: 0, y: 0 };
  let mainRot3D = { x: DEFAULT_ROT3D.x, y: DEFAULT_ROT3D.y }; // main view's own rotation state (see mainProject3D above)

  // orthographic (no perspective divide — avoids near-plane clipping entirely,
  // which a bounded sphere viewed from an arbitrary camera angle would otherwise
  // make painful) rotation: yaw first spins the x/y plane around, then pitch folds
  // the yawed "depth" axis down against z. x, y, z are already centered on the
  // rotation origin (the sphere's center). Returns rotated {x, y, z} — z is used as
  // a depth key for painter's-algorithm sorting (see renderReactor3D /
  // renderMain3D), not drawn directly.
  function project3D(x, y, z, rot) {
    const cyaw = Math.cos(rot.y), syaw = Math.sin(rot.y);
    const x1 = x * cyaw - y * syaw;
    const y1 = x * syaw + y * cyaw;
    const cpitch = Math.cos(rot.x), spitch = Math.sin(rot.x);
    const y2 = y1 * cpitch - z * spitch;
    const z2 = y1 * spitch + z * cpitch;
    return { x: x1, y: y2, z: z2 };
  }

  // right-mouse-button drag rotates `rot` in place, only while getEnabled() is
  // true — left-button dragging is left completely alone (still select-rectangle
  // on the reactor / whichever brush tool on the main canvas), so this never
  // conflicts with the existing click/drag interactions on either canvas. Returns
  // a cleanup function that removes all the listeners it added.
  function wireDragRotate(canvas, rot, getEnabled) {
    let dragging = false, lastX = 0, lastY = 0;
    function onContextMenu(e) { if (getEnabled()) e.preventDefault(); }
    function onMouseDown(e) {
      if (e.button !== 2 || !getEnabled()) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      e.preventDefault();
    }
    function onMouseMove(e) {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      rot.y += dx * ROTATE_SPEED;
      rot.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, rot.x - dy * ROTATE_SPEED));
    }
    function onMouseUp() { dragging = false; }
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }

  // rotates a real (x, y, z) reactor-space point around the reactor's own center.
  // Returns [screenX, screenY, depth].
  function reactorProject3D(x, y, z, rot) {
    const p = project3D(x - REACTOR_SIZE / 2, y - REACTOR_SIZE / 2, z, rot);
    return [REACTOR_SIZE / 2 + p.x, REACTOR_SIZE / 2 - p.y, p.z];
  }

  function renderReactor3D(r) {
    const ctx = r.ctx;
    ctx.clearRect(0, 0, REACTOR_SIZE, REACTOR_SIZE);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, REACTOR_SIZE, REACTOR_SIZE);

    const project = (x, y, z) => reactorProject3D(x, y, z, r.rot3D);
    drawSphereWireframe(ctx, REACTOR_SPHERE_CENTER, REACTOR_SPHERE_RADIUS, project, meshDensity);
    drawSphereMarkers(ctx, REACTOR_SPHERE_CENTER, REACTOR_SPHERE_RADIUS, project);

    // painter's algorithm: sort by rotated depth so nearer photons draw over
    // farther ones — with a real volume and free rotation, a naive draw-in-array-
    // order would look wrong from most angles instead of just occasionally.
    const items = r.photons.map(p => {
      const [sx, sy, depth] = project(p.x, p.y, p.z);
      return { p, sx, sy, depth };
    });
    items.sort((a, b) => a.depth - b.depth);
    for (const it of items) {
      ctx.fillStyle = photonColor(it.p, 0.95);
      ctx.beginPath();
      ctx.arc(it.sx, it.sy, it.p.radius + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // "shell view": concentric force rings around whichever photons are currently
    // being inspected (open info window) — see drawFieldShells3D's own comment
    for (const it of items) {
      if (openInfoWindows.has(it.p.id)) {
        const p = it.p;
        drawFieldShells3D(ctx, p.x, p.y, p.z, p.forceRange, p.force, p.periods, p.waveOffset, p.phaseShift, -1, project, photonColor(p, 1));
      }
    }
    drawReactorSelectionOverlay(r);
  }

  function renderReactor(r) {
    if (r.el.classList.contains('minimized')) return;
    if (r.mode === '3D') renderReactor3D(r);
    else renderReactor2D(r);
  }

  function updateReactors(dt) {
    for (const r of reactors) {
      if (!paused) { if (r.mode === '3D') stepReactor3D(r, dt); else stepReactor(r, dt); }
      renderReactor(r);
    }
  }

