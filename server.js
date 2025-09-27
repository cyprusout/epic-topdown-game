const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// Serve static files
app.use(express.static(path.join(__dirname, '../client')));

// Load data
let spells = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/spells.json')));
let breakables = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/breakables.json')));

let players = {};
let projectiles = [];

// Socket.IO events
io.on('connection', socket => {
  console.log(`Player connected: ${socket.id}`);
  
  players[socket.id] = {
    id: socket.id,
    x: Math.random()*600+100,
    y: Math.random()*400+100,
    hp: 100,
    mana: 100,
    sprite: '/sprites/player.png'
  };
  
  // Send initial data
  socket.emit('init', { id: socket.id, players, breakables, spells });

  // Broadcast new player
  socket.broadcast.emit('newPlayer', players[socket.id]);

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });

  // Movement
  socket.on('move', data => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  // Weapon attack
  socket.on('weaponAttack', data => {
    const player = players[socket.id];
    if (!player) return;
    const weapon = spells[data.weapon];
    if (!weapon) return;

    const swingAngle = {
      'short': Math.PI/6,
      'wide': Math.PI/3,
      'long': Math.PI/2
    }[weapon.swing] || Math.PI/4;

    // Hit breakables
    breakables.forEach(obj => {
      const dx = obj.x - player.x;
      const dy = obj.y - player.y;
      const distance = Math.hypot(dx, dy);
      const angleToObj = Math.atan2(dy, dx);
      let delta = angleToObj - data.angle;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      if (distance <= weapon.range && Math.abs(delta) <= swingAngle) {
        obj.hp -= weapon.damage;
        if (obj.hp <= 0) {
          if (obj.drops && obj.drops.length>0){
            const droppedItem = obj.drops[Math.floor(Math.random()*obj.drops.length)];
            io.emit('itemDropped', { x: obj.x, y: obj.y, item: droppedItem });
          }
          breakables = breakables.filter(b=>b.id!==obj.id);
          io.emit('breakableDestroyed', obj.id);
        }
      }
    });

    io.emit('weaponUsed', { playerId: player.id, weapon: weapon.name, angle: data.angle });
  });
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
