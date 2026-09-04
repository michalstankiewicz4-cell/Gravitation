"use strict";

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

