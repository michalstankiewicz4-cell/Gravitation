"use strict";

  // ---------- rendering ----------
  function renderMain2D() {
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

  // full 3D render path (the only mode now — see mainViewMode's comment in
  // photon.js): the sphere boundary (drawSphereWireframe) plus every photon's real
  // (x, y, z) projected through mainProject3D() — no ctx.scale/translate here
  // (mainProject3D already returns actual screen pixels) and no toroidal
  // tile-repeat loop (the sphere is a bounded volume, not a wrapping plane).
  // "Attract" is disabled (see the HTML) since it fundamentally needs a flat
  // screen<->world mapping a rotated 3D view doesn't have; select and spawn both
  // work (spawn via mainUnprojectCenterPlane — see the mousedown/mousemove/mouseup
  // handlers). Rotate the view itself with a right-mouse-button drag; zoom still
  // works (mouse wheel), just as a plain scale around the sphere's own center.
  function renderMain3D() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, W, H);

    if (colorMode === 'intensity') updateChargeRange();
    else if (colorMode === 'speed') updateSpeedRange();

    ctx.save();
    drawSphereWireframe(ctx, mainSphereCenter(), mainSphereRadius(), mainProject3D, meshDensity);
    drawSphereMarkers(ctx, mainSphereCenter(), mainSphereRadius(), mainProject3D);

    const glow = glowEnabled && photons.length <= 500;
    ctx.shadowBlur = glow ? 12 : 0;

    // painter's algorithm: sort by rotated depth so nearer photons occlude farther
    // ones — with a real volume (not a flat plane) this is now essential, not just
    // a nice-to-have for a handful of tile-repeats.
    const items = photons.map(p => {
      const [sx, sy, depth] = mainProject3D(p.x, p.y, p.z);
      return { p, sx, sy, depth, isSelected: openInfoWindows.has(p.id), isInList: listSelection.has(p.id) };
    });
    items.sort((a, b) => a.depth - b.depth);

    for (const it of items) {
      const color = photonColor(it.p, 0.95);
      if (glow) ctx.shadowColor = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(it.sx, it.sy, it.p.radius * zoom, 0, Math.PI * 2);
      ctx.fill();
      if (it.isInList || it.isSelected) {
        ctx.beginPath();
        ctx.arc(it.sx, it.sy, (it.p.radius + (it.isSelected ? 7 : 4.5)) * zoom, 0, Math.PI * 2);
        ctx.strokeStyle = it.isSelected ? '#ffffff' : 'rgba(255,255,255,0.55)';
        ctx.lineWidth = it.isSelected ? 2 : 1.2;
        ctx.stroke();
      }
    }
    // "shell view": concentric force rings around whichever photons are currently
    // being inspected (open info window) — see drawFieldShells3D's own comment
    for (const it of items) {
      if (it.isSelected) {
        const p = it.p;
        drawFieldShells3D(ctx, p.x, p.y, p.z, p.forceRange, p.force, p.periods, p.waveOffset, p.phaseShift, -1, mainProject3D, photonColor(p, 1));
      }
    }
    // orbit-pair force preview + connecting line — the 3D counterpart of the
    // (now-unused, 2D-only) drawOrbitVisualizations()
    drawOrbitVisualizations3D(ctx, mainProject3D);
    ctx.shadowBlur = 0;
    ctx.restore();

    // select-rectangle overlay, drawn in raw screen-pixel space — 3D-mode dragging
    // tracks the cursor directly (see the mousedown/mousemove/mouseup handlers),
    // not a world position, since there's no single flat plane under a rotated view
    if (dragging && rectActive && currentTool === 'select') {
      const x = Math.min(startX, curX), y = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h2 = Math.abs(curY - startY);
      ctx.fillStyle = 'rgba(120,160,255,0.12)';
      ctx.strokeStyle = 'rgba(160,190,255,0.7)';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, w, h2);
      ctx.strokeRect(x, y, w, h2);
    }
  }

  function render() {
    if (mainViewMode === '3D') renderMain3D();
    else renderMain2D();
  }

