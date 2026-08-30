// Pixelowa woda w menzurce, sterowana myszką.
// Fizyka: woda to szereg pionowych słupków (kolumn) sprzężonych ze sobą jak
// fala płytkiej wody — sąsiednie słupki "ciągną" się nawzajem do wspólnego
// poziomu, co daje rozchodzące się i wygasające fale. Ruch/przyspieszenie
// naczynia (siła pozorna, jak w przyspieszającym wagonie) przechyla ten
// poziom w locie, a nagłe zatrzymanie (np. uderzenie o stół) wstrząsa całą
// powierzchnią naraz. Renderowana jest jako gruboziarnista siatka pikseli.
(function () {
  "use strict";

  const canvas = document.getElementById('sim');
  const ctx = canvas.getContext('2d');

  let W = 0, H = 0, tableY = 0;
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W;
    canvas.height = H;
    tableY = H - 90;
    container.x = Math.min(Math.max(container.x, 0), Math.max(0, W - outerW));
    if (!dragging) container.y = Math.min(container.y, tableY - outerH);
  }

  // ---------- geometria naczynia ----------
  const CS = 4;           // rozmiar piksela wody
  const COLS = 30;
  const ROWS = 84;
  const WALL = 6;          // grubość szkła (kosmetyczna)
  const BOTTOM = 8;
  const interiorW = COLS * CS;
  const interiorH = ROWS * CS;
  const outerW = interiorW + WALL * 2;
  const outerH = interiorH + BOTTOM;

  const container = {
    x: 0, y: 0,
    prevX: 0, prevY: 0,
    prevVX: 0, prevVY: 0,
    vyFall: 0,
  };

  // ---------- woda: pole wysokości słupków (w jednostkach wierszy) ----------
  const heights = new Float32Array(COLS);
  const velocity = new Float32Array(COLS);
  const REST_ROWS = ROWS * 0.55;

  function resetWater() {
    heights.fill(REST_ROWS);
    velocity.fill(0);
    splashes.length = 0;
    foam.length = 0;
  }

  const SPREAD = 0.16;      // jak szybko fala rozchodzi się do sąsiadów
  const K_SPRING = 0.02;    // przywraca średni poziom do stanu spoczynku (stabilizuje przy długim wymuszeniu)
  const K_DAMP = 0.05;      // odejmowane tłumienie prędkości (stała czasowa niezależna od czasu trwania wymuszenia)
  const TILT_COEFF = 0.09;  // jak mocno przyspieszenie boczne przechyla wodę
  const BOUNCE_COEFF = 0.5; // jak mocno pionowy wstrząs podbija całą powierzchnię
  const FORCE_MAX = 3;      // ogranicznik siły pozornej na klatkę (chroni przed skokami dt/teleportacji myszki)
  const MAX_V = 6;
  const MAX_SLOPE = 3;      // graniczna różnica wysokości (wiersze) między sąsiadami
  const AVALANCHE_RATE = 0.6; // jaka część nadwyżki nachylenia "osuwa się" w jednej klatce

  let frame = 0;

  function simulateWater(dt, dvx, dvy, worldVX, worldVY) {
    const mid = (COLS - 1) / 2;
    const tiltAccel = Math.max(-FORCE_MAX, Math.min(FORCE_MAX, -dvx * TILT_COEFF));
    // uwaga na znak: przy przyspieszaniu w górę (dvy<0) woda "zostaje w tyle"
    // (opada), a dopiero przy nagłym zatrzymaniu (dvy>0) wybija do góry
    const bounceBoost = Math.max(-FORCE_MAX, Math.min(FORCE_MAX, dvy * BOUNCE_COEFF));

    for (let c = 0; c < COLS; c++) {
      const hl = c > 0 ? heights[c - 1] : heights[c];
      const hr = c < COLS - 1 ? heights[c + 1] : heights[c];
      // sprężyste przywracanie do poziomu spoczynku + rozchodzenie fali do sąsiadów +
      // odejmowane tłumienie: razem ograniczają odpowiedź nawet przy długo trwającym
      // wymuszeniu (np. swobodny spadek naczynia), gdzie samo mnożnikowe tłumienie
      // bliskie 1 prowadziłoby do rezonansowego narastania prędkości
      let accel = K_SPRING * (REST_ROWS - heights[c]) - K_DAMP * velocity[c];
      accel += SPREAD * (hl + hr - 2 * heights[c]);
      accel += tiltAccel * (c - mid) + bounceBoost;
      velocity[c] = Math.max(-MAX_V, Math.min(MAX_V, velocity[c] + accel * dt));
    }
    for (let c = 0; c < COLS; c++) {
      heights[c] += velocity[c] * dt;
    }

    // Liniowe równanie fali (powyżej) daje tylko gładkie, sinusoidalne kształty.
    // Żeby fala mogła się "łamać" na boki, ograniczamy maksymalne nachylenie
    // powierzchni: nadwyżka gwałtownie osuwa się do sąsiedniej kolumny (jak w
    // modelu usypującego się piasku) zamiast płynnie propagować, co daje ostrzejszy,
    // mniej regularny kształt i pryska pianą w miejscu załamania.
    for (let c = 0; c < COLS - 1; c++) {
      const diff = heights[c] - heights[c + 1];
      if (diff > MAX_SLOPE) {
        const amt = (diff - MAX_SLOPE) * AVALANCHE_RATE * dt;
        heights[c] -= amt;
        heights[c + 1] += amt;
        velocity[c + 1] += amt * 0.4;
        velocity[c] -= amt * 0.15;
        spawnFoam(c + 1, amt);
      } else if (diff < -MAX_SLOPE) {
        const amt = (-diff - MAX_SLOPE) * AVALANCHE_RATE * dt;
        heights[c + 1] -= amt;
        heights[c] += amt;
        velocity[c] += amt * 0.4;
        velocity[c + 1] -= amt * 0.15;
        spawnFoam(c, amt);
      }
    }

    for (let c = 0; c < COLS; c++) {
      if (heights[c] > ROWS) {
        spill(c, heights[c] - ROWS, worldVX, worldVY);
        heights[c] = ROWS;
        if (velocity[c] > 0) velocity[c] = 0;
      } else if (heights[c] < 0) {
        heights[c] = 0;
        if (velocity[c] < 0) velocity[c] = 0;
      }
    }
  }

  // ---------- piana w miejscu załamania fali (w układzie naczynia) ----------
  const foam = [];

  function spawnFoam(col, amt) {
    if (amt < 0.15) return;
    const n = Math.min(3, Math.ceil(amt));
    const fx = WALL + col * CS + CS / 2;
    const fy = (ROWS - heights[col]) * CS;
    for (let i = 0; i < n; i++) {
      foam.push({
        x: fx + (Math.random() - 0.5) * CS,
        y: fy,
        vx: (Math.random() - 0.5) * 1.5,
        vy: -Math.random() * 1.2,
        life: 0.35 + Math.random() * 0.25,
      });
    }
    if (foam.length > 150) foam.splice(0, foam.length - 150);
  }

  function updateFoam(dt) {
    for (let k = foam.length - 1; k >= 0; k--) {
      const p = foam[k];
      p.vy += 0.15 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt * 0.033;
      if (p.life <= 0) foam.splice(k, 1);
    }
  }

  // ---------- rozpryski w przestrzeni ekranu (przelanie przez brzeg) ----------
  const splashes = [];
  const GRAVITY_PX = 0.55;

  function spill(col, overflowRows, worldVX, worldVY) {
    const wx = container.x + WALL + col * CS + CS / 2;
    const wy = container.y;
    splashes.push({
      x: wx, y: wy,
      vx: worldVX + (Math.random() - 0.5) * 2,
      vy: worldVY - overflowRows * 1.2 - 1,
      life: 1.4 + Math.random() * 0.6,
    });
    if (splashes.length > 200) splashes.shift();
  }

  function updateSplashes(dt) {
    for (let k = splashes.length - 1; k >= 0; k--) {
      const p = splashes[k];
      p.vy += GRAVITY_PX * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y > tableY - 2) { p.y = tableY - 2; p.vy *= -0.35; p.vx *= 0.7; }
      p.life -= dt * 0.0167; // dt jest w jednostkach klatek (~16.67ms)
      if (p.life <= 0 || p.x < -20 || p.x > W + 20) splashes.splice(k, 1);
    }
  }

  // ---------- naczynie: przeciąganie / swobodny spadek ----------
  let dragging = false, dragOffX = 0, dragOffY = 0;
  const mouse = { x: 0, y: 0 };

  function pointerPos(e) {
    const t = e.touches && e.touches[0];
    return { x: t ? t.clientX : e.clientX, y: t ? t.clientY : e.clientY };
  }

  function onDown(e) {
    const p = pointerPos(e);
    if (p.x >= container.x && p.x <= container.x + outerW &&
        p.y >= container.y && p.y <= container.y + outerH) {
      dragging = true;
      dragOffX = p.x - container.x;
      dragOffY = p.y - container.y;
    }
  }
  function onMove(e) { const p = pointerPos(e); mouse.x = p.x; mouse.y = p.y; }
  function onUp() { dragging = false; }

  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', e => { onDown(e); onMove(e); }, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: true });
  window.addEventListener('touchend', onUp);
  canvas.addEventListener('dblclick', resetWater);

  function updateContainer(dt) {
    if (dragging) {
      container.x = mouse.x - dragOffX;
      container.y = mouse.y - dragOffY;
      container.vyFall = 0;
    } else if (container.y + outerH < tableY) {
      container.vyFall += 0.9 * dt;
      container.y += container.vyFall * dt;
    } else {
      container.y = tableY - outerH;
      container.vyFall = (Math.abs(container.vyFall) > 1) ? container.vyFall * -0.25 : 0;
    }

    const vX = (container.x - container.prevX) / dt;
    const vY = (container.y - container.prevY) / dt;
    // zmiana prędkości naczynia w tej klatce — używana bezpośrednio jako impuls
    // na wodę (siła pozorna), bez dzielenia przez dt: to unika ogromnych, sztucznych
    // "przyspieszeń" przy krótkich klatkach i lepiej znosi skokowe ruchy myszki
    const dvx = vX - container.prevVX;
    const dvy = vY - container.prevVY;

    container.prevX = container.x; container.prevY = container.y;
    container.prevVX = vX; container.prevVY = vY;
    return { dvx, dvy, worldVX: vX, worldVY: vY };
  }

  // ---------- render ----------
  function drawGlass() {
    const x = container.x, y = container.y;
    const r = 12;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + outerH - r);
    ctx.arcTo(x, y + outerH, x + r, y + outerH, r);
    ctx.lineTo(x + outerW - r, y + outerH);
    ctx.arcTo(x + outerW, y + outerH, x + outerW, y + outerH - r, r);
    ctx.lineTo(x + outerW, y);
    ctx.fillStyle = 'rgba(180,220,255,0.035)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 5, y + 4);
    ctx.lineTo(x + 5, y + outerH - 10);
    ctx.stroke();

    // podziałka
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    for (let row = 0; row < ROWS; row += 10) {
      const ty = y + row * CS;
      const long = (row % 20 === 0);
      ctx.lineWidth = long ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(x + outerW - WALL, ty);
      ctx.lineTo(x + outerW - WALL - (long ? 10 : 6), ty);
      ctx.stroke();
    }
  }

  function drawWater() {
    const ix0 = container.x + WALL, iy0 = container.y;
    for (let col = 0; col < COLS; col++) {
      const filledRows = Math.round(heights[col]);
      if (filledRows <= 0) continue;
      const topRow = ROWS - filledRows;
      const px = ix0 + col * CS;

      ctx.fillStyle = '#a9e6ff';
      ctx.fillRect(px, iy0 + topRow * CS, CS, CS);

      if (filledRows > 1) {
        ctx.fillStyle = ((col + (frame >> 3)) % 2 === 0) ? '#2f8fe0' : '#2678bd';
        ctx.fillRect(px, iy0 + (topRow + 1) * CS, CS, (filledRows - 1) * CS);
      }
    }
  }

  function drawSplashes() {
    ctx.fillStyle = '#2f8fe0';
    for (const p of splashes) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }

  function drawFoam() {
    ctx.fillStyle = '#e8f6ff';
    for (const p of foam) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
      ctx.fillRect(container.x + p.x - 1, container.y + p.y - 1, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, W, H);

    const g = ctx.createLinearGradient(0, tableY, 0, H);
    g.addColorStop(0, 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, tableY, W, H - tableY);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.moveTo(0, tableY); ctx.lineTo(W, tableY); ctx.stroke();

    drawSplashes();
    drawGlass();
    drawWater();
    drawFoam();
  }

  let lastT = performance.now();
  function animate(t) {
    let dt = (t - lastT) / 16.6667;
    lastT = t;
    dt = Math.max(0.2, Math.min(dt, 2.5));
    frame++;

    const { dvx, dvy, worldVX, worldVY } = updateContainer(dt);
    simulateWater(dt, dvx, dvy, worldVX, worldVY);
    updateSplashes(dt);
    updateFoam(dt);
    render();

    requestAnimationFrame(animate);
  }

  resize();
  window.addEventListener('resize', resize);
  container.x = W / 2 - outerW / 2;
  container.y = tableY - outerH;
  container.prevX = container.x; container.prevY = container.y;
  resetWater();
  requestAnimationFrame(animate);
})();
