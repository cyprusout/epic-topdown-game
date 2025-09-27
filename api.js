// const db = require('./db.js');
exports.public = function (app) {
  app.get("/hello", (req, res) => {
    res.json({ message: "Hello World" });
  });
};

exports.private = function (app) {
  app.get("/hello2", (req, res) => {
    res.json({
      message: "Hello " + req.session.google_data.given_name,
    });
  });
};

exports.onLogin = function (session) {};

/* session.google_data

{
  iss: 'https://accounts.google.com',
  azp: '1016767921529-7km6ac8h3cud3256dqjqha6neiufn2om.apps.googleusercontent.com',
  aud: '1016767921529-7km6ac8h3cud3256dqjqha6neiufn2om.apps.googleusercontent.com',
  sub: '103589682456946370010',
  email: 'southwickmatthias@gmail.com',
  email_verified: true,
  nbf: 1723080904,
  name: 'Matthias Southwick',
  picture: 'https://lh3.googleusercontent.com/a/ACg8ocLjdsGc7uC2mmthGuvrPpmV2AFT2U_EdiXxon8tX5QwbR7m8VYkeA=s96-c',
  given_name: 'Matthias',
  family_name: 'Southwick',
  iat: 1723081204,
  exp: 1723084804,
  jti: 'ad27c4b889a0eb48b6ce4cf6690fca739892ca88'
}

*/
/* session.microsoft_data: {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
  userPrincipalName: 'Southwickmatthias@gmail.com',
  id: '4a1639e4ad5f1ca5',
  displayName: 'Matthias Southwick',
  surname: 'Southwick',
  givenName: 'Matthias',
  preferredLanguage: 'en-US',
  mail: null,
  mobilePhone: null,
  jobTitle: null,
  officeLocation: null,
  businessPhones: []
}

*/

// --- Game server Socket.IO integration ---
const fs = require('fs');
const path = require('path');

/**
 * Attach game Socket.IO handlers.
 * Loads spells and breakables from the project's data folder and
 * registers the Socket.IO events (connection, move, weaponAttack, etc.).
 *
 * @param {import('socket.io').Server} io
 */
exports.attachGame = function (io) {
  // Load data
  const dataDir = path.join(__dirname, 'data');
  let spells = [];
  let breakables = [];

  try {
    spells = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'spells.json')));
  } catch (e) {
    try { spells = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'spells.json'))); } catch (e2) { spells = {}; }
  }

  try {
    breakables = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'breakables.json')));
  } catch (e) {
    try { breakables = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'breakables.json'))); } catch (e2) { breakables = []; }
  }

  let players = {};

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
};
