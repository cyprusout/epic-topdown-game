// client/game.js
// Full client game logic for epic-topdown-game
// Requires: socket.io client script loaded in index.html
// Place this file at client/game.js and open index.html served by server.

// -----------------------------
// Initialization and Globals
// -----------------------------
const socket = io();

// Canvas & context
const canvas = document.getElementById('game-canvas') || document.getElementById('game') || document.querySelector('canvas');
const ctx = canvas.getContext('2d');

// UI elements (optional; check availability)
const castInput = document.getElementById('castInput');
const hpFill = document.querySelector('#hpBar .fill');
const manaFill = document.querySelector('#manaBar .fill');
const debugEl = document.getElementById('debug');
const bigInventoryEl = document.getElementById('bigInventory');
const helmetSlotEl = document.getElementById('helmet-slot');
const weaponSlotEl = document.getElementById('weapon-slot');

// Ensure canvas sizes
if (canvas) {
  canvas.width = canvas.width || 960;
  canvas.height = canvas.height || 640;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
}

// Local game state
let myId = null;
let players = {};         // players by id
let breakables = [];      // breakable objects
let droppedItems = [];    // items on ground
let spellsData = {};      // spells.json loaded
let projectiles = [];     // local visual projectiles
let meleeEffects = [];    // visual swing arcs
let lights = [];          // dynamic lights

// Inventory
let quickbar = new Array(5).fill(null);
let bigInventory = new Array(15).fill(null);
let helmetSlot = null;   // armor slot (helmet)
let weaponSlot = null;   // currently equipped weapon (object from spellsData or item structure)
let pickedItem = null;   // item grabbed by click (simple click-to-pick mechanism)

// Input
const input = { keys: {}, mx: 0, my: 0, mouseDown: false };
let mouseScreenX = 0, mouseScreenY = 0;

// Day-night
let timeOfDay = 0; // 0-1
const dayCycleSpeed = 0.01; // tweak for speed (higher = faster day)
function getBrightness() {
  // 0.2 (night) to 1.0 (day)
  return Math.max(0.18, 0.6 + 0.4 * Math.sin(timeOfDay * 2 * Math.PI));
}

// Weather
let weather = { type: 'clear', timer: 0, intensity: 0 };
let rainDrops = []; // prepopulated
function initRain(count = 200) {
  rainDrops = [];
  for (let i=0;i<count;i++){
    rainDrops.push({
      x: Math.random()*canvas.width,
      y: Math.random()*canvas.height,
      len: 8 + Math.random()*12,
      speed: 200 + Math.random()*300
    });
  }
}
initRain(220);

// Utility
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const nowMs = ()=>performance.now();
function angleNormalize(a){ return Math.atan2(Math.sin(a), Math.cos(a)); }

// -----------------------------
// Load spells.json from server
// -----------------------------
async function loadSpells() {
  try {
    const res = await fetch('/data/spells.json');
    if (!res.ok) throw new Error('Failed to fetch spells.json');
    spellsData = await res.json();
    console.log('Loaded spells:', Object.keys(spellsData));
  } catch (e) {
    console.warn('Could not load spells.json via fetch; will rely on server init if provided.', e);
  }
}
loadSpells();

// -----------------------------
// Socket handlers
// -----------------------------
socket.on('connect', ()=>console.log('connected', socket.id));
socket.on('init', data=>{
  myId = data.id;
  players = data.players || players;
  breakables = data.breakables || breakables;
  // server might include spells; merge
  if (data.spells) spellsData = Object.assign({}, spellsData, data.spells);
  console.log('init', data);
});
socket.on('newPlayer', p=>{ players[p.id] = p; });
socket.on('playerMoved', p=>{ if(players[p.id]) Object.assign(players[p.id], p); else players[p.id] = p; });
socket.on('playerDisconnected', id=>{ delete players[id]; });

// server-side spell or weapon events
socket.on('spellCast', evt => {
  // evt: { casterId, name, args, x, y, ... }
  spawnSpellEffect(evt);
});
socket.on('weaponUsed', evt => {
  // evt: { playerId, weapon, angle }
  handleWeaponUsed(evt);
});
socket.on('itemDropped', evt => {
  // evt: { x, y, item }
  droppedItems.push({ x: evt.x, y: evt.y, item: evt.item, id: Date.now() + Math.random() });
});
socket.on('breakableDestroyed', id=>{
  breakables = breakables.filter(b=>b.id!==id);
});
socket.on('noMana', ()=> {
  // small UI hint
  if (manaFill) {
    manaFill.style.transition = 'none';
    manaFill.style.background = 'linear-gradient(90deg,#ff9090,#ff9090)';
    setTimeout(()=>{ manaFill.style.transition = ''; manaFill.style.background = ''; }, 220);
  }
});

// -----------------------------
// Input handling
// -----------------------------
window.addEventListener('keydown', e=>{
  input.keys[e.key.toLowerCase()] = true;
  if (e.key.toLowerCase() === 'e') toggleBigInventory();
});
window.addEventListener('keyup', e=>{ input.keys[e.key.toLowerCase()] = false; });

canvas && canvas.addEventListener('mousemove', e=>{
  const r = canvas.getBoundingClientRect();
  const scaleX = canvas.width / r.width, scaleY = canvas.height / r.height;
  input.mx = (e.clientX - r.left) * scaleX;
  input.my = (e.clientY - r.top) * scaleY;
  mouseScreenX = e.clientX - r.left;
  mouseScreenY = e.clientY - r.top;
});
canvas && canvas.addEventListener('mousedown', e=>{
  if (e.button === 0) { // left click -> weapon attack or pick up
    input.mouseDown = true;
    handleLeftClick();
  }
});
window.addEventListener('mouseup', e=>{ input.mouseDown = false; });

// simple UI: cast spell by pressing Enter in castInput
if (castInput) {
  castInput.addEventListener('keydown', e=>{
    if (e.key === 'Enter') {
      const txt = castInput.value.trim();
      if (txt.length) {
        socket.emit('castSpell', txt);
        // clear UI
        castInput.value = '';
      }
    }
  });
}

// Inventory click handlers (simple equip/unequip by click)
function setupInventoryUI() {
  // quickslots (assume elements with class quickslot)
  const qEls = document.querySelectorAll('.quickslot');
  qEls.forEach((el,i)=>{
    el.addEventListener('click', ()=>{
      // pick up or place
      if (pickedItem) {
        quickbar[i] = pickedItem;
        pickedItem = null;
        renderInventory();
      } else if (quickbar[i]) {
        pickedItem = quickbar[i];
        quickbar[i] = null;
        renderInventory();
      }
    });
  });
  // big inventory
  const invEls = document.querySelectorAll('.inv-slot');
  invEls.forEach((el,i)=>{
    el.addEventListener('click', ()=>{
      if (pickedItem) {
        bigInventory[i] = pickedItem;
        pickedItem = null;
        renderInventory();
      } else if (bigInventory[i]) {
        pickedItem = bigInventory[i];
        bigInventory[i] = null;
        renderInventory();
      }
    });
  });

  // helmet slot click
  if (helmetSlotEl) {
    helmetSlotEl.addEventListener('click', ()=>{
      if (pickedItem) {
        // only allow helmet items if they have type 'helmet'
        if (!pickedItem.type || pickedItem.type === 'helmet') {
          helmetSlot = pickedItem; pickedItem = null; renderInventory();
        } else {
          // not valid
          // flash
        }
      } else if (helmetSlot) { pickedItem = helmetSlot; helmetSlot = null; renderInventory(); }
    });
  }

  // weapon slot click
  if (weaponSlotEl) {
    weaponSlotEl.addEventListener('click', ()=>{
      if (pickedItem) {
        // allow melee or staff or items referencing weapon
        if (pickedItem.type === 'melee' || pickedItem.type === 'staff' || spellsData[pickedItem.name]) {
          weaponSlot = pickedItem; pickedItem = null; renderInventory();
        } else {
          // can't equip
        }
      } else if (weaponSlot) { pickedItem = weaponSlot; weaponSlot = null; renderInventory(); }
    });
  }
}
setupInventoryUI();

// Toggle big inventory
function toggleBigInventory(){ if (bigInventoryEl) bigInventoryEl.classList.toggle('hidden'); }

// -----------------------------
// Gameplay: actions
// -----------------------------
function handleLeftClick(){
  // If there's a picked item, try to drop it into world (quick throw) - else weapon attack
  if (pickedItem) {
    // drop item near player
    const me = players[myId];
    if (!me) return;
    const dropX = me.x + (Math.random()-0.5)*40;
    const dropY = me.y + (Math.random()-0.5)*40;
    socket.emit('dropItem', { x: dropX, y: dropY, item: pickedItem });
    pickedItem = null;
    renderInventory();
    return;
  }

  // weapon attack: requires weaponSlot
  if (!weaponSlot || !players[myId]) return;

  const me = players[myId];
  const dx = input.mx - canvas.width/2; // since camera centers on player we map screen coords relative
  const dy = input.my - canvas.height/2;
  // But player world pos is players[myId].x,y and camera centers there; we need angle relative to player:
  // compute world-space mouse by adding camera offset inside render loop; instead we compute angle on next frame using stored world mouse
  // We'll compute angle now by mapping mouse screen to world (we need camera pos from last render)
  const angle = lastCameraAngle || 0;
  // But simpler: compute angle using cursor world coords if available:
  const mouseWorld = screenToWorld(input.mx, input.my);
  const ang = Math.atan2(mouseWorld.y - me.y, mouseWorld.x - me.x);

  // cooldown check is handled server-side
  socket.emit('weaponAttack', { weapon: weaponSlot.name || weaponSlot.key || weaponSlot.id || weaponSlot.type, angle: ang, x: me.x, y: me.y });
}

// Helper: map screen coords to world coords (uses lastCamera)
let lastCamera = { x:0, y:0, w: canvas.width, h: canvas.height };
function screenToWorld(sx, sy){
  return { x: lastCamera.x + sx, y: lastCamera.y + sy };
}

// Handle server weaponUsed event -> create visual effects
function handleWeaponUsed(evt){
  // evt: { playerId, weapon, angle }
  const p = players[evt.playerId];
  if (!p) return;
  const weapon = spellsData[evt.weapon] || {};
  if (weapon.type === 'melee') {
    meleeEffects.push({
      x: p.x,
      y: p.y,
      angle: evt.angle,
      life: 200,
      radius: weapon.range || 50,
      color: weapon.color || '#fff',
      type: weapon.swing || 'wide',
      startTime: nowMs()
    });
  } else if (weapon.type === 'staff' || weapon.effect === 'projectile') {
    projectiles.push({
      x: p.x,
      y: p.y,
      vx: Math.cos(evt.angle) * (weapon.speed || weapon.range || 220),
      vy: Math.sin(evt.angle) * (weapon.speed || 220),
      life: (weapon.life||2) * 1000,
      color: weapon.color || '#0ff',
      owner: evt.playerId,
      type: evt.weapon
    });
  }
}

// Spawn spell visuals for server 'spellCast' events (generic)
function spawnSpellEffect(evt){
  const spell = spellsData[evt.name] || {};
  if (!spell) spellFallback(evt);
  if (spell.effect === 'projectile') {
    // create several projectiles or single depending on spell
    projectiles.push({
      x: evt.x, y: evt.y,
      vx: (Math.random()-0.5)*30 + (spell.speed||220),
      vy: (Math.random()-0.5)*30,
      life: (spell.life||1.5)*1000,
      color: spell.color || '#f42',
      type: evt.name
    });
  } else if (spell.effect === 'heal') {
    // small healing particles
    for (let i=0;i<12;i++) projectiles.push({
      x: evt.x, y: evt.y,
      vx: (Math.random()-0.5)*120, vy: (Math.random()-0.5)*120,
      life: 800, color: spell.color || '#6f6', type: evt.name
    });
  } else if (spell.effect === 'aoe') {
    for (let i=0;i<24;i++) projectiles.push({
      x: evt.x, y: evt.y,
      vx: (Math.random()-0.5)*300, vy: (Math.random()-0.5)*300,
      life: 600, color: spell.color || '#ff0', type: evt.name
    });
  } else {
    // fallback sparkle
    projectiles.push({ x: evt.x, y: evt.y, vx:0, vy:0, life:1000, color:'#fff', type:evt.name });
  }
}
function spellFallback(evt){
  // used if spellsData missing: create small effect
  projectiles.push({ x: evt.x, y: evt.y, vx:0, vy:0, life:1000, color:'#fff', type:evt.name });
}

// -----------------------------
// Pickup items by walking over them
// -----------------------------
function tryPickupItems() {
  if (!players[myId]) return;
  const p = players[myId];
  for (let i = droppedItems.length-1; i>=0; i--) {
    const d = droppedItems[i];
    const dx = d.x - p.x, dy = d.y - p.y;
    if (Math.hypot(dx,dy) < 22) {
      // pick up and add to inventory (first empty quickslot or bigInventory)
      let placed = false;
      for (let j=0;j<5;j++) if(!quickbar[j]){ quickbar[j] = { name: d.item, icon: `/items/${d.item}.png`, type: 'item' }; placed = true; break; }
      if(!placed) for (let j=0;j<15;j++) if(!bigInventory[j]){ bigInventory[j] = { name: d.item, icon: `/items/${d.item}.png`, type:'item' }; placed = true; break; }
      // notify client visuals
      droppedItems.splice(i,1);
    }
  }
}

// -----------------------------
// Update & Render Loop
// -----------------------------
let lastTime = performance.now();
let fpsCounter = 0;
let lastCameraAngle = 0;

function update(dt){
  // day-night progression
  timeOfDay += dayCycleSpeed * dt/1000;
  if (timeOfDay > 1) timeOfDay -= 1;

  // weather timers
  updateWeather(dt);

  // local prediction: move local player via WASD
  if (players[myId]) {
    const p = players[myId];
    const speed = 160;
    let vx = 0, vy = 0;
    if (input.keys['w'] || input.keys['arrowup']) vy -= 1;
    if (input.keys['s'] || input.keys['arrowdown']) vy += 1;
    if (input.keys['a'] || input.keys['arrowleft']) vx -= 1;
    if (input.keys['d'] || input.keys['arrowright']) vx += 1;
    const len = Math.hypot(vx,vy);
    if (len>0){ vx = vx/len*speed; vy = vy/len*speed; }
    p.x += vx * dt/1000; p.y += vy * dt/1000;
    p.vx = vx; p.vy = vy;
    // send to server
    socket.emit('move', { x: p.x, y: p.y, vx:p.vx, vy:p.vy });
  }

  // update projectiles
  for (let i=projectiles.length-1;i>=0;i--) {
    const pr = projectiles[i];
    pr.x += (pr.vx||0)*(dt/1000);
    pr.y += (pr.vy||0)*(dt/1000);
    pr.life -= dt;
    if (pr.life <= 0) projectiles.splice(i,1);
  }

  // update melee effects lifetime
  for (let i=meleeEffects.length-1;i>=0;i--){
    const m = meleeEffects[i];
    if (nowMs() - (m.startTime||0) > m.life) meleeEffects.splice(i,1);
  }

  // update lights: player lights + projectile lights
  updateLights();

  // pickup items
  tryPickupItems();
}

function render(){
  if (!canvas) return;
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // camera centers on player
  let camX = 0, camY = 0;
  if (players[myId]) {
    camX = players[myId].x - canvas.width/2;
    camY = players[myId].y - canvas.height/2;
  }
  lastCamera.x = camX; lastCamera.y = camY;
  lastCamera.w = canvas.width; lastCamera.h = canvas.height;

  ctx.save();
  ctx.translate(-camX, -camY);

  // draw ground (simple grid)
  drawGrid(camX, camY);

  // draw breakables (with shadows)
  for (const b of breakables) drawBreakable(b);

  // draw dropped items
  for (const di of droppedItems) drawDroppedItem(di);

  // draw players and their shadows
  for (const id in players) {
    drawPlayerWithShadow(players[id]);
  }

  // draw projectiles
  for (const pr of projectiles) drawProjectile(pr);

  // draw melee effects (on top of entities)
  drawMeleeEffects();

  ctx.restore();

  // overlay: day-night darkness & dynamic lights
  drawDayNightAndLights();

  // overlay: weather
  renderWeather();

  // UI: HP/MP bars & quick inventory
  drawUI();

  if (debugEl) debugEl.textContent = `Players:${Object.keys(players).length} Proj:${projectiles.length} Drops:${droppedItems.length} Weather:${weather.type}`;
}

// -----------------------------
// Rendering helpers
// -----------------------------
function drawGrid(camX, camY) {
  const s = 32;
  const left = Math.floor(camX/s)*s - s*2;
  const top = Math.floor(camY/s)*s - s*2;
  const cols = Math.ceil(canvas.width/s)+6;
  const rows = Math.ceil(canvas.height/s)+6;
  ctx.fillStyle = '#0b1622';
  ctx.fillRect(camX, camY, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.02)';
  for (let i=0;i<cols;i++){
    for (let j=0;j<rows;j++){
      const x = left + i*s, y = top + j*s;
      ctx.strokeRect(x,y,s,s);
    }
  }
}

function drawBreakable(b){
  // shadow
  const sunX = Math.cos(timeOfDay * 2 * Math.PI);
  const sx = b.x + sunX * 10, sy = b.y + 6;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath(); ctx.ellipse(sx, sy, 14, 8, 0, 0, Math.PI*2); ctx.fill();

  // sprite (use image if available)
  const img = new Image();
  img.src = '/sprites/' + (b.sprite || 'barrel.png');
  ctx.drawImage(img, b.x - 16, b.y - 16, 32, 32);
  // optional hp bar
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(b.x-18, b.y-26, 36, 6);
  ctx.fillStyle = '#b22';
  const hpPct = Math.max(0, (b.hp||1)/ (b.maxHp||b.hp||50));
  ctx.fillRect(b.x-18, b.y-26, 36*hpPct, 6);
}

function drawDroppedItem(di){
  const sunX = Math.cos(timeOfDay * 2 * Math.PI);
  const sx = di.x + sunX * 6, sy = di.y + 4;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.ellipse(sx, sy, 8, 4, 0, 0, Math.PI*2); ctx.fill();

  const img = new Image();
  img.src = '/items/' + (di.item || 'coin') + '.png';
  ctx.drawImage(img, di.x - 10, di.y - 10, 20, 20);
}

function drawPlayerWithShadow(pl){
  // shadow offset by sun direction
  const sunX = Math.cos(timeOfDay * 2 * Math.PI);
  const offsetX = sunX * 12;
  const offsetY = 6;
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath(); ctx.ellipse(pl.x + offsetX, pl.y + offsetY, 14, 8, 0, 0, Math.PI*2); ctx.fill();

  // player sprite
  const img = new Image();
  img.src = pl.sprite || '/sprites/player.png';
  ctx.drawImage(img, pl.x - 16, pl.y - 16, 32, 32);

  // name and hp bar
  ctx.fillStyle = '#000';
  ctx.fillRect(pl.x - 20, pl.y - 28, 40, 6);
  ctx.fillStyle = '#b22';
  ctx.fillRect(pl.x - 20, pl.y - 28, 40 * ((pl.hp||100)/ (pl.maxHp||100)), 6);
  ctx.fillStyle = '#fff';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(pl.name || (pl.id && pl.id.slice(0,6)), pl.x, pl.y - 36);
}

function drawProjectile(pr){
  // small shadow for projectile
  const sunX = Math.cos(timeOfDay * 2 * Math.PI);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath(); ctx.ellipse(pr.x + sunX*4, pr.y + 3, 6, 3, 0, 0, Math.PI*2); ctx.fill();

  ctx.fillStyle = pr.color || (spellsData[pr.type]?.color) || '#ffd';
  ctx.beginPath(); ctx.arc(pr.x, pr.y, 4, 0, Math.PI*2); ctx.fill();
}

// melee arc rendering
function drawMeleeEffects(){
  const now = nowMs();
  for (let i=meleeEffects.length-1;i>=0;i--){
    const s = meleeEffects[i];
    const elapsed = now - s.startTime;
    const t = elapsed / s.life;
    if (t > 1) { meleeEffects.splice(i,1); continue; }
    const alpha = 1 - t;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = s.color || '#fff';
    ctx.lineWidth = 4;
    if (s.type === 'short') {
      ctx.beginPath(); ctx.arc(0,0,s.radius, -Math.PI/12, Math.PI/12); ctx.stroke();
    } else if (s.type === 'wide') {
      ctx.beginPath(); ctx.arc(0,0,s.radius, -Math.PI/3, Math.PI/3); ctx.stroke();
    } else if (s.type === 'long') {
      ctx.beginPath(); ctx.arc(0,0,s.radius, -Math.PI/2, Math.PI/2); ctx.stroke();
    } else {
      // projectile/staff style
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(s.radius, 0); ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// -----------------------------
// Lighting & Day-Night overlay
// -----------------------------
function updateLights(){
  lights = [];
  // player light (if any)
  if (players[myId]) {
    lights.push({
      x: players[myId].x,
      y: players[myId].y,
      radius: 120,
      color: 'rgba(255,220,180,0.6)'
    });
  }
  // projectile lights
  for (const pr of projectiles) {
    if (pr.type && (pr.type.includes('fire') || pr.type === 'fireball')) {
      lights.push({ x: pr.x, y: pr.y, radius: 60, color: 'rgba(255,120,40,0.5)' });
    } else if (pr.color) {
      lights.push({ x: pr.x, y: pr.y, radius: 40, color: pr.color });
    }
  }
}

function drawDayNightAndLights(){
  // base darkness based on time of day
  const brightness = getBrightness(); // 0.2..1
  ctx.fillStyle = `rgba(0,0,0,${1 - brightness})`;
  ctx.fillRect(0,0,canvas.width,canvas.height);

  // overlay dynamic lights by cutting holes in darkness
  ctx.globalCompositeOperation = 'destination-out';
  for (const l of lights) {
    // radial gradient for softer edges
    const grad = ctx.createRadialGradient(l.x - lastCamera.x, l.y - lastCamera.y, 0, l.x - lastCamera.x, l.y - lastCamera.y, l.radius);
    grad.addColorStop(0, l.color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(l.x - lastCamera.x, l.y - lastCamera.y, l.radius, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// -----------------------------
// Weather: fog & rain
// -----------------------------
function updateWeather(dt) {
  weather.timer -= dt;
  if (weather.timer <= 0) {
    const r = Math.random();
    if (r < 0.2) {
      weather.type = 'fog';
      weather.intensity = 0.25 + Math.random()*0.5;
      weather.timer = 8000 + Math.random()*12000;
    } else if (r < 0.6) {
      weather.type = 'rain';
      weather.intensity = 0.4 + Math.random()*0.6;
      weather.timer = 6000 + Math.random()*16000;
      initRain(200 + Math.floor(Math.random()*200));
    } else {
      weather.type = 'clear';
      weather.intensity = 0;
      weather.timer = 4000 + Math.random()*8000;
    }
  }
}

function renderWeather(){
  if (weather.type === 'fog') {
    // translucent fog overlay that slowly moves
    ctx.save();
    ctx.globalAlpha = 0.08 * weather.intensity;
    const fogColor = `rgba(220,220,255,${0.06 * weather.intensity})`;
    ctx.fillStyle = fogColor;
    // soft rectangles / noise
    const off = (performance.now()/1000) * 20;
    for (let i=0;i<50;i++){
      ctx.beginPath();
      const x = ((i*73) % (canvas.width+400)) - 200 + (off % 200);
      const y = (i*47) % canvas.height;
      ctx.ellipse(x, y, 120, 40, 0, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.restore();
  } else if (weather.type === 'rain') {
    ctx.save();
    ctx.strokeStyle = `rgba(180,200,255,${0.08 * weather.intensity})`;
    ctx.lineWidth = 1;
    const dt = 1/60;
    for (const drop of rainDrops) {
      ctx.beginPath();
      const sx = drop.x;
      const sy = drop.y;
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 2, sy + drop.len);
      ctx.stroke();
      drop.y += drop.speed * (dt) * weather.intensity;
      if (drop.y > canvas.height) drop.y = -drop.len;
    }
    ctx.restore();
  }
}

// -----------------------------
// UI rendering (HP/MP and inventory quickbar)
// -----------------------------
function drawUI(){
  // HP/Mana bars
  if (hpFill && players[myId]) hpFill.style.width = `${Math.max(0, (players[myId].hp||0)/ (players[myId].maxHp||100))*100}%`;
  if (manaFill && players[myId]) manaFill.style.width = `${Math.max(0, (players[myId].mana||0)/ (players[myId].maxMana||100))*100}%`;

  // Quickbar UI (draw on DOM elements if present)
  const qEls = document.querySelectorAll('.quickslot');
  qEls.forEach((el,i)=>{
    if (quickbar[i]) el.innerHTML = `<img src="${quickbar[i].icon || '/items/'+quickbar[i].name+'.png'}" style="width:100%;height:100%"/>`;
    else el.innerHTML = '';
  });
  // helmet slot and weapon slot DOM update
  if (helmetSlotEl) helmetSlotEl.innerHTML = helmetSlot ? `<img src="${helmetSlot.icon||('/items/'+helmetSlot.name+'.png')}" style="width:100%;height:100%"/>` : '<span>Helmet</span>';
  if (weaponSlotEl) weaponSlotEl.innerHTML = weaponSlot ? `<img src="${weaponSlot.icon||('/sprites/'+(weaponSlot.name||weaponSlot)+'.png')}" style="width:100%;height:100%"/>` : '<span>Weapon</span>';
}

// -----------------------------
// Main loop
// -----------------------------
function mainLoop(ts){
  const dt = ts - lastTime;
  lastTime = ts;
  update(dt);
  render();
  requestAnimationFrame(mainLoop);
}
requestAnimationFrame(mainLoop);

// -----------------------------
// Helpers & debugging
// -----------------------------
function spawnTestProjectile(x,y){
  projectiles.push({ x,y,vx: Math.random()*200-100,vy: Math.random()*200-100,life:800,color:'#ff5',type:'test' });
}

// Public functions you can call from console
window._G = {
  players, projectiles, meleeEffects, spawnTestProjectile, quickbar, bigInventory
};

console.log('game.js loaded');
