"use strict";

  // ---------- main 3D view: real 3D physics ----------
  // In 3D mode, physics itself changes: photons fly freely inside a bounded sphere
  // (stepMain3D() below) instead of the flat, wrapping torus (step()) — this isn't
  // just an alternate view of the same simulation. The sphere is centered on the
  // world and sized to fit the viewport; mainProject3D() rotates a real (x, y, z)
  // position around that center and returns actual screen pixels directly — there's
  // no toroidal wraparound to tile here, so this render path is simpler than 2D's
  // ctx.scale/translate + tile-repeat machinery.
  const WIREFRAME_LINE_MAJOR = 'rgba(255,255,255,0.28)';
  const WIREFRAME_LINE_MINOR = 'rgba(255,255,255,0.10)';
  // "Grid density" slider (shown while a 3D view is active) — 1 = the base lat/long
  // line count below; scales how many wireframe lines the sphere boundary is drawn
  // with, for both the main sphere and every reactor window's own sphere.
  let meshDensity = 1;

  function mainSphereCenter() { return { x: W / 2, y: H / 2, z: 0 }; }
  function mainSphereRadius() { return Math.min(W, H) / 2 * 0.85; }

  // rotates a real world point around the sphere's center and projects it straight
  // to screen pixels. project3D/mainRot3D are defined later (shared with the
  // reactor windows) but this only runs per-frame, long after the whole script has
  // finished loading.
  function mainProject3D(x, y, z) {
    const c = mainSphereCenter();
    const p = project3D(x - c.x, y - c.y, z - c.z, mainRot3D);
    return [c.x + p.x * zoom, c.y - p.y * zoom, p.z];
  }

  // inverse of mainProject3D(), but only for points known to lie on the sphere's
  // own z=0 (center) plane — the only case solvable without also knowing depth.
  // That's exactly the plane the "spawn" brush uses in 3D mode (see spawnPhotonAt3D
  // in controls.js), so a click always drops a new photon at the sphere's own
  // equatorial plane, at whatever (x, y) the cursor is currently pointing at —
  // regardless of how the view is rotated.
  function mainUnprojectCenterPlane(sx, sy) {
    const c = mainSphereCenter();
    const x1 = (sx - c.x) / zoom;
    const y2 = (c.y - sy) / zoom;
    const cpitch = Math.cos(mainRot3D.x);
    const y1 = Math.abs(cpitch) > 1e-6 ? y2 / cpitch : 0;
    const cyaw = Math.cos(mainRot3D.y), syaw = Math.sin(mainRot3D.y);
    // yaw's rotation matrix is orthogonal, so its inverse is just its transpose
    const x = x1 * cyaw + y1 * syaw;
    const y = -x1 * syaw + y1 * cyaw;
    return { x: c.x + x, y: c.y + y };
  }

  // resets zoom so the whole sphere is back in view — mainSphereRadius() is always
  // 0.85 of the viewport's shorter half, so zoom=1 already frames it with margin;
  // this only matters after the user has zoomed in with the mouse wheel and lost
  // sight of the boundary. Also resets rotation to the compass-aligned default (N
  // top, S bottom, W left, E right — see DEFAULT_ROT3D/drawSphereMarkers), undoing
  // whatever the right-drag has done. Mutated in place, not reassigned — mainRot3D
  // is the exact object reference wireDragRotate() was handed at setup, so a fresh
  // object here would silently stop responding to further drags.
  function centerMainSphereView() {
    zoom = 1;
    mainRot3D.x = 0;
    mainRot3D.y = 0;
  }

  // how the sphere's boundary behaves once a photon reaches it — shared by the main
  // sim and every reactor window's own 3D physics (see applyBoundary below).
  //  'wrap'   (default): teleport through to the antipodal point, same velocity —
  //           the natural 3D analogue of the flat sim's toroidal wraparound
  //  'bounce': reflect velocity off the boundary, like an elastic wall
  //  'off':    no boundary force at all — a photon that actually crosses it despawns
  //            (see the caller: stepMain3D()/stepReactor3D() remove whatever this
  //            returns true for) rather than being left to fly on forever unseen
  let sphereBoundaryMode = 'wrap';

  // returns true if `p` just left the sphere in 'off' mode, meaning the caller
  // should remove it — every other case is handled in place (p is mutated) and
  // returns false.
  function applyBoundary(p, center, radius) {
    const rx = p.x - center.x, ry = p.y - center.y, rz = p.z - center.z;
    const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (dist <= radius) return false;
    if (sphereBoundaryMode === 'off') return true;
    if (sphereBoundaryMode === 'bounce') {
      const nx = rx / dist, ny = ry / dist, nz = rz / dist;
      const vDotN = p.vx * nx + p.vy * ny + p.vz * nz;
      if (vDotN > 0) { p.vx -= 2 * vDotN * nx; p.vy -= 2 * vDotN * ny; p.vz -= 2 * vDotN * nz; }
      p.x = center.x + nx * radius; p.y = center.y + ny * radius; p.z = center.z + nz * radius;
      return false;
    }
    // 'wrap': point-reflect the position through the center, keeping velocity as-is
    // — the same vector, now aimed inward from the diametrically opposite boundary
    // point, so the photon appears to fly straight through to the far side
    p.x = center.x - rx; p.y = center.y - ry; p.z = center.z - rz;
    return false;
  }

  // uniform-random point strictly inside a sphere of the given radius, centered at
  // the origin — rejection sampling (simple, unbiased, cheap at this radius scale)
  function randomPointInSphere(radius) {
    let x, y, z;
    do { x = rand(-1, 1); y = rand(-1, 1); z = rand(-1, 1); } while (x * x + y * y + z * z > 1);
    return { x: x * radius, y: y * radius, z: z * radius };
  }

  // uniform-random direction on the unit sphere, scaled to the given speed — used
  // both for a momentarily-stationary photon's post-collision kick and for
  // scattering photons into 3D the first time a view switches into a sphere
  function randomVelocity3D(speed) {
    const u = rand(-1, 1), theta = rand(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    return { vx: r * Math.cos(theta) * speed, vy: r * Math.sin(theta) * speed, vz: u * speed };
  }

  // scatters every photon in the list to a random position inside the sphere with a
  // random 3D velocity at its own locked speed — called once when a view switches
  // into 3D, so photons that were flat on z=0 (2D mode never touches z) actually
  // fill the volume instead of sitting on a flat disc through the sphere's equator.
  function scatterIntoSphere(list, center, radius) {
    for (const p of list) {
      const pt = randomPointInSphere(radius);
      p.x = center.x + pt.x; p.y = center.y + pt.y; p.z = center.z + pt.z;
      const v = randomVelocity3D(p.maxSpeed);
      p.vx = v.vx; p.vy = v.vy; p.vz = v.vz;
    }
  }

  // same pairwise sine-wave force law as step() (see there for the physics
  // explanation) extended to 3D, plus the sphere boundary (applyBoundary) in place
  // of step()'s toroidal wrap. Uses a 3D spatial grid — brute force would be
  // O(n^2) at the main sim's photon counts, exactly the problem step()'s own 2D
  // grid already solves; this is that same idea with a third axis.
  function stepMain3D(dt) {
    const n = photons.length;
    if (n === 0) return;
    simTime += dt;
    const center = mainSphereCenter(), radius = mainSphereRadius();
    const ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n);

    let maxRange = 0;
    for (let i = 0; i < n; i++) if (photons[i].forceRange > maxRange) maxRange = photons[i].forceRange;
    const cell = Math.max(50, maxRange + 20);
    const cols = Math.max(1, Math.ceil((radius * 2 + cell) / cell));
    const minX = center.x - radius - cell / 2;
    const minY = center.y - radius - cell / 2;
    const minZ = center.z - radius - cell / 2;
    const cells = new Array(cols * cols * cols);
    for (let i = 0; i < cells.length; i++) cells[i] = [];
    const cellCoord = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = photons[i];
      const cx = Math.max(0, Math.min(cols - 1, Math.floor((p.x - minX) / cell)));
      const cy = Math.max(0, Math.min(cols - 1, Math.floor((p.y - minY) / cell)));
      const cz = Math.max(0, Math.min(cols - 1, Math.floor((p.z - minZ) / cell)));
      cellCoord[i] = [cx, cy, cz];
      cells[(cx * cols + cy) * cols + cz].push(i);
    }

    const newCollisionPairs = new Set();
    const seenOrbitPairs = new Set();

    for (let i = 0; i < n; i++) {
      const a = photons[i];
      const [cx, cy, cz] = cellCoord[i];
      for (let ddx = -1; ddx <= 1; ddx++) {
        const nx = cx + ddx; if (nx < 0 || nx >= cols) continue;
        for (let ddy = -1; ddy <= 1; ddy++) {
          const ny = cy + ddy; if (ny < 0 || ny >= cols) continue;
          for (let ddz = -1; ddz <= 1; ddz++) {
            const nz = cz + ddz; if (nz < 0 || nz >= cols) continue;
            const list = cells[(nx * cols + ny) * cols + nz];
            for (let k = 0; k < list.length; k++) {
              const j = list[k];
              if (j <= i) continue;
              const b = photons[j];

              let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
              let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (d < 0.01) {
                const dir = randomVelocity3D(0.1);
                dx = dir.vx; dy = dir.vy; dz = dir.vz; d = 0.1;
              }

              if (d < a.radius + b.radius) {
                newCollisionPairs.add(a.id < b.id ? (a.id + '_' + b.id) : (b.id + '_' + a.id));
              }

              const range = (a.forceRange + b.forceRange) / 2;
              if (d >= range) continue;

              updateOrbitTracking(a, b, d, seenOrbitPairs);

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
        }
      }
    }

    for (const key of newCollisionPairs) {
      if (!activeCollisionPairs.has(key)) collisionCount++;
    }
    activeCollisionPairs = newCollisionPairs;
    for (const [key, rec] of orbitTracker) {
      if (!seenOrbitPairs.has(key)) { finalizeOrbitEnd(key, rec); orbitTracker.delete(key); }
    }
    updateClusterTracking(); // nucleus + orbital-shell "atom" tracking — see its own comment in photon.js

    // collected rather than removed in place — splicing mid-loop would desync the
    // indices step() and the pairwise loop above already relied on this frame
    const despawned = [];
    for (let i = 0; i < n; i++) {
      const p = photons[i];
      p.vx += (ax[i] / p.mass) * dt;
      p.vy += (ay[i] / p.mass) * dt;
      p.vz += (az[i] / p.mass) * dt;

      const target = p.maxSpeed;
      const s = Math.hypot(p.vx, p.vy, p.vz);
      if (s > 0.0001) {
        const k = target / s;
        p.vx *= k; p.vy *= k; p.vz *= k;
      } else {
        const v = randomVelocity3D(target);
        p.vx = v.vx; p.vy = v.vy; p.vz = v.vz;
      }

      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (applyBoundary(p, center, radius)) despawned.push(p.id);
    }
    if (despawned.length) removePhotonsByIds(despawned);
  }

  // dense lat/long wireframe of the sphere itself — the visible "container" boundary
  // that replaces the flat mesh's field-height visualization now that photons live
  // in a real volume instead of on a flat, height-mapped plane. `project` is
  // whichever projection (mainProject3D, or a specific reactor's) the caller wants
  // this drawn through, so one function serves both the main view and every reactor.
  function drawSphereWireframe(ctxTarget, center, radius, project, density) {
    const LAT = Math.max(4, Math.round(6 * density));
    const LON = Math.max(6, Math.round(10 * density));
    const SEG = 40;
    ctxTarget.lineWidth = 0.75;
    for (let i = 1; i < LAT; i++) {
      const theta = Math.PI * i / LAT;
      const ringR = radius * Math.sin(theta), y = radius * Math.cos(theta);
      ctxTarget.strokeStyle = i === Math.round(LAT / 2) ? WIREFRAME_LINE_MAJOR : WIREFRAME_LINE_MINOR;
      ctxTarget.beginPath();
      for (let j = 0; j <= SEG; j++) {
        const phi = 2 * Math.PI * j / SEG;
        const [sx, sy] = project(center.x + ringR * Math.cos(phi), center.y + y, center.z + ringR * Math.sin(phi));
        if (j === 0) ctxTarget.moveTo(sx, sy); else ctxTarget.lineTo(sx, sy);
      }
      ctxTarget.stroke();
    }
    for (let i = 0; i < LON; i++) {
      const phi = Math.PI * i / LON;
      ctxTarget.strokeStyle = i === 0 ? WIREFRAME_LINE_MAJOR : WIREFRAME_LINE_MINOR;
      ctxTarget.beginPath();
      for (let j = 0; j <= SEG; j++) {
        const theta = Math.PI * j / SEG;
        const x = radius * Math.sin(theta) * Math.cos(phi);
        const y = radius * Math.cos(theta);
        const z = radius * Math.sin(theta) * Math.sin(phi);
        const [sx, sy] = project(center.x + x, center.y + y, center.z + z);
        if (j === 0) ctxTarget.moveTo(sx, sy); else ctxTarget.lineTo(sx, sy);
      }
      ctxTarget.stroke();
    }
  }

  // small "compass rose" reference on the sphere: poles along the wireframe's own
  // N/S axis (the same y axis the lat rings are built around above) and the
  // equator's x extremes for W/E, plus a crosshair at the sphere's own center —
  // fixed points in the sphere's own (unrotated) space, so as the camera orbits
  // it via right-drag they swing around correctly with it, giving a stable frame
  // of reference the way a globe's printed graticule does.
  function drawSphereMarkers(ctxTarget, center, radius, project) {
    const points = [
      { dx: 0, dy: radius, dz: 0, label: 'N' },
      { dx: 0, dy: -radius, dz: 0, label: 'S' },
      { dx: radius, dy: 0, dz: 0, label: 'E' },
      { dx: -radius, dy: 0, dz: 0, label: 'W' }
    ];
    ctxTarget.font = '10px sans-serif';
    ctxTarget.textAlign = 'center';
    for (const pt of points) {
      const [sx, sy, depth] = project(center.x + pt.dx, center.y + pt.dy, center.z + pt.dz);
      const alpha = depth >= 0 ? 0.95 : 0.4; // dim the far-side marker as a depth cue
      ctxTarget.fillStyle = `rgba(255,210,80,${alpha})`;
      ctxTarget.beginPath();
      ctxTarget.arc(sx, sy, 2.5, 0, Math.PI * 2);
      ctxTarget.fill();
      ctxTarget.fillText(pt.label, sx, sy - 8);
    }
    // center crosshair — mostly a sanity check that the view really is centered
    // on the sphere's own middle, regardless of the current rotation
    const [cx, cy] = project(center.x, center.y, center.z);
    ctxTarget.strokeStyle = 'rgba(255,255,255,0.5)';
    ctxTarget.lineWidth = 1;
    ctxTarget.beginPath();
    ctxTarget.moveTo(cx - 4, cy); ctxTarget.lineTo(cx + 4, cy);
    ctxTarget.moveTo(cx, cy - 4); ctxTarget.lineTo(cx, cy + 4);
    ctxTarget.stroke();
    ctxTarget.textAlign = 'left';
  }

  // one concentric ring of a photon's own force "shell", drawn as three orthogonal
  // great circles (not a full lat/long globe — cheap enough to repeat per shell
  // per selected photon) so it still reads as a sphere from any angle.
  function drawGreatCircle3D(ctxTarget, cx, cy, cz, r, project, plane, seg) {
    ctxTarget.beginPath();
    for (let j = 0; j <= seg; j++) {
      const t = 2 * Math.PI * j / seg;
      let x = 0, y = 0, z = 0;
      if (plane === 'xy') { x = r * Math.cos(t); y = r * Math.sin(t); }
      else if (plane === 'xz') { x = r * Math.cos(t); z = r * Math.sin(t); }
      else { y = r * Math.cos(t); z = r * Math.sin(t); }
      const [sx, sy] = project(cx + x, cy + y, cz + z);
      if (j === 0) ctxTarget.moveTo(sx, sy); else ctxTarget.lineTo(sx, sy);
    }
    ctxTarget.stroke();
  }

  // "shell view": the same concentric attract/repel bands the 2D Force preview
  // panel draws as flat rings (see drawFieldHalo), rendered as actual 3D shells
  // around one point in space. Same parameterization as drawFieldHalo (range, amp,
  // periods, offset, phaseShift, chargeProduct, a baseColor for the attract side —
  // repel is always the same red) so both stay in sync with a single physics
  // source of truth (pairForce). Two callers: the "selected photon" shell view
  // (chargeProduct -1, as if a lone opposite-charge test particle were probing
  // outward — see render.js/reactor.js) and the Orbits panel's per-pair 3D preview
  // (the pair's own real averaged parameters and chargeProduct — see
  // drawOrbitVisualizations3D). Only ever drawn for a handful of photons someone's
  // actually inspecting, never for the whole sim at once (far too much clutter/cost).
  function drawFieldShells3D(ctxTarget, cx, cy, cz, range, amp, periods, offset, phaseShift, chargeProduct, project, baseColor) {
    if (!(range > 0)) return;
    const SHELLS = 6, SEG = 28;
    const safeAmp = Math.max(1, amp);
    for (let s = 1; s <= SHELLS; s++) {
      const d = (s / SHELLS) * range;
      const f = pairForce(d, range, safeAmp, periods, offset, phaseShift, chargeProduct) / safeAmp;
      const alpha = Math.min(1, Math.abs(f)) * 0.5;
      if (alpha < 0.04) continue;
      ctxTarget.strokeStyle = f >= 0
        ? baseColor.replace(/,[^,]*\)$/, ',' + alpha.toFixed(3) + ')')
        : `rgba(255,80,80,${alpha.toFixed(3)})`;
      ctxTarget.lineWidth = 0.75;
      drawGreatCircle3D(ctxTarget, cx, cy, cz, d, project, 'xy', SEG);
      drawGreatCircle3D(ctxTarget, cx, cy, cz, d, project, 'xz', SEG);
      drawGreatCircle3D(ctxTarget, cx, cy, cz, d, project, 'yz', SEG);
    }
  }

