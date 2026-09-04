"use strict";

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

  // ---------- main 3D view controls ----------
  // 3D is the only mode now — no toggle button, no "Attract" (disabled in the HTML;
  // it needs a flat screen<->world mapping the 3D view doesn't have). Spawn still
  // works: it always drops the new photon on the sphere's own z=0 (center) plane
  // (see spawnPhotonAt3D below), which has a well-defined inverse projection
  // regardless of rotation — see mainUnprojectCenterPlane.
  const centerViewBtn = document.getElementById('centerViewBtn');
  const meshDensitySlider = document.getElementById('meshDensity');
  const meshDensityVal = document.getElementById('meshDensityVal');
  const boundaryModeButtons = document.querySelectorAll('#boundaryModeRow .boundary-mode-btn');
  canvas.title = 'Right-drag to rotate the view';
  centerViewBtn.addEventListener('click', () => centerMainSphereView());
  meshDensitySlider.addEventListener('input', () => {
    meshDensity = Number(meshDensitySlider.value);
    meshDensityVal.textContent = meshDensity.toFixed(1) + 'x';
  });
  boundaryModeButtons.forEach(b => b.addEventListener('click', () => {
    sphereBoundaryMode = b.dataset.mode;
    boundaryModeButtons.forEach(x => x.classList.toggle('active', x === b));
  }));
  wireDragRotate(canvas, mainRot3D, () => mainViewMode === '3D');

  // ---------- spawning (used by the "spawn" brush) ----------
  function spawnPhotonAt(x, y) {
    if (photons.length >= MAX_PHOTONS) return;
    const p = makePhoton();
    p.x = wrap(x + rand(-8, 8), W);
    p.y = wrap(y + rand(-8, 8), H);
    photons.push(p);
  }

  // 3D mode's spawn always drops the new photon on the sphere's own z=0 (center)
  // plane — see mainUnprojectCenterPlane's comment for why that's the one plane a
  // rotated view can still invert a click through unambiguously.
  function spawnPhotonAt3D(x, y) {
    if (photons.length >= MAX_PHOTONS) return;
    const p = makePhoton();
    p.x = x; p.y = y; p.z = mainSphereCenter().z;
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
    if (e.button !== 0) return; // right-click is reserved for rotating the 3D view — see wireDragRotate
    dragging = true; rectActive = false; mouseDown = true;

    if (mainViewMode === '3D') {
      // raw screen pixels here, not world coords — see the mouseup handler's 3D
      // branch (mainProject3D() already returns screen pixels). Attract is
      // disabled (see the HTML — 3D has no flat mapping for it); select and
      // spawn both work — spawn via mainUnprojectCenterPlane (see its comment).
      startX = curX = e.clientX; startY = curY = e.clientY;
      if (currentTool === 'spawn') {
        const w = mainUnprojectCenterPlane(e.clientX, e.clientY);
        spawnPhotonAt3D(w.x, w.y);
        lastSpawnTime = performance.now();
      }
      return;
    }

    const w = screenToWorld(e.clientX, e.clientY);
    startX = curX = w.x; startY = curY = w.y;

    if (currentTool === 'spawn') {
      spawnPhotonAt(curX, curY);
      lastSpawnTime = performance.now();
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (mainViewMode === '3D') {
      curX = e.clientX; curY = e.clientY;
      if (dragging && currentTool === 'select' && !rectActive && Math.hypot(curX - startX, curY - startY) > DRAG_THRESHOLD) {
        rectActive = true;
      }
      if (dragging && currentTool === 'spawn') {
        const now = performance.now();
        if (now - lastSpawnTime > SPAWN_INTERVAL) {
          const w = mainUnprojectCenterPlane(curX, curY);
          spawnPhotonAt3D(w.x, w.y);
          lastSpawnTime = now;
        }
      }
      return;
    }

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

    if (mainViewMode === '3D') {
      // hit-test against each photon's rotated screen position (mainProject3D
      // already returns real screen pixels) instead of a flat world-space
      // comparison — the same forward-project-and-compare trick the reactor
      // windows already use, since there's no single flat plane to invert a
      // rotated click through. Spawn already happened in mousedown/mousemove
      // above — nothing left to do here for it.
      if (currentTool === 'select') {
        if (rectActive) {
          const lo = { x: Math.min(startX, curX), y: Math.min(startY, curY) };
          const hi = { x: Math.max(startX, curX), y: Math.max(startY, curY) };
          const ids = [];
          for (const p of photons) {
            const [sx, sy] = mainProject3D(p.x, p.y, p.z);
            if (sx >= lo.x && sx <= hi.x && sy >= lo.y && sy <= hi.y) ids.push(p.id);
          }
          showListPanel(ids);
        } else {
          let best = null, bestD = Infinity;
          for (const p of photons) {
            const [sx, sy] = mainProject3D(p.x, p.y, p.z);
            const d = Math.hypot(sx - startX, sy - startY);
            if (d < p.radius + 8 && d < bestD) { best = p; bestD = d; }
          }
          if (best) selectPhoton(best.id);
        }
      }
      rectActive = false;
      return;
    }

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
