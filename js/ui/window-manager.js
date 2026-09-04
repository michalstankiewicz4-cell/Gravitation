"use strict";

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

