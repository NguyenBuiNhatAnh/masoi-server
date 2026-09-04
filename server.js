/**
 * MA SÓI REALTIME - BACKEND
 * Node.js + Express + Socket.io
 * State giữ toàn bộ trong bộ nhớ (in-memory), 1 phòng duy nhất cho 8 tài khoản cố định.
 */
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Ma Soi server is running'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ------------------------- CONST -------------------------
const FIXED_USERNAMES = [
  'nguyenbuinhatanh',
  'doanxuanhoangha',
  'letranphuctoan',
  'lediemquynhnhu',
  'tangbaongoc',
  'vunhuhuelan',
  'hoangphuonglinh',
  'nguyenhoangkhanhlinh',
];

const ROLE_META = {
  villager: { label: 'Dân làng', team: 'villager' },
  werewolf: { label: 'Ma Sói', team: 'wolf' },
  cursed: { label: 'Kẻ bị nguyền rủa', team: 'villager' },
  seer: { label: 'Tiên tri', team: 'villager' },
  witch: { label: 'Phù thủy', team: 'villager' },
  hunter: { label: 'Thợ săn', team: 'villager' },
  doppelganger: { label: 'Người nhân bản', team: 'villager' },
  guard: { label: 'Bảo vệ', team: 'villager' },
};
const SPECIAL_ROLES = ['cursed', 'seer', 'witch', 'hunter', 'guard', 'doppelganger'];

// ------------------------- ROOM STATE -------------------------
let room = {
  hostUsername: null,
  sockets: {},  // username -> socket.id
  online: {},   // username -> bool
  config: null, // { villagerCount, wolfCount, enabledSpecialRoles: [] }
  game: null,   // game state object, null until started
};

function freshRoom() {
  room = { hostUsername: null, sockets: {}, online: {}, config: null, game: null, voiceOn: {} };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function emitTo(username, event, payload) {
  const sid = room.sockets[username];
  if (sid) io.to(sid).emit(event, payload);
}

function broadcastLobby() {
  io.emit('lobby_update', {
    users: FIXED_USERNAMES,
    online: room.online,
    hostUsername: room.hostUsername,
    config: room.config,
    gameStarted: !!room.game && room.game.status !== 'ended',
    voiceOn: room.voiceOn
  });
}

// ------------------------- GAME HELPERS -------------------------
function g() { return room.game; }
function team(u) { return ROLE_META[g().players[u].role].team; }
function alivePlayers() { return Object.keys(g().players).filter((u) => g().players[u].alive); }
function aliveWithRole(role) { return alivePlayers().filter((u) => g().players[u].role === role); }

function checkWinCondition() {
  const alive = alivePlayers();
  const wolves = alive.filter((u) => team(u) === 'wolf');
  const villagers = alive.filter((u) => team(u) === 'villager');
  if (wolves.length === 0) return 'villagers';
  if (wolves.length >= villagers.length) return 'wolves';
  return null;
}

function buildRoleList(cfg) {
  let roles = [];
  for (let i = 0; i < cfg.villagerCount; i++) roles.push('villager');
  for (let i = 0; i < cfg.wolfCount; i++) roles.push('werewolf');
  let remaining = 8 - roles.length;
  if (remaining < 0) throw new Error('Tổng số dân + sói vượt quá 8');
  const enabled = shuffle(cfg.enabledSpecialRoles.filter((r) => SPECIAL_ROLES.includes(r)));
  const specialToUse = enabled.slice(0, remaining);
  roles.push(...specialToUse);
  const stillRemaining = remaining - specialToUse.length;
  for (let i = 0; i < stillRemaining; i++) roles.push('villager');
  return shuffle(roles);
}

// ------------------------- NIGHT FLOW -------------------------
function buildNightSteps() {
  const steps = [];
  const state = g();
  const hunterAlive = aliveWithRole('hunter');
  if (hunterAlive.length && !state.players[hunterAlive[0]].hunterHasPicked) steps.push('hunter');
  const doppelAlive = aliveWithRole('doppelganger');
  if (doppelAlive.length && !state.players[doppelAlive[0]].doppelHasPicked) steps.push('doppelganger');
  if (aliveWithRole('guard').length) steps.push('guard');
  if (aliveWithRole('werewolf').length) steps.push('wolves');
  if (aliveWithRole('seer').length) steps.push('seer');
  const witchAlive = aliveWithRole('witch');
  if (witchAlive.length) {
    const w = state.players[witchAlive[0]];
    if (!w.witchHealUsed || !w.witchKillUsed) steps.push('witch');
  }
  return steps;
}

function startNight() {
  const state = g();
  state.status = 'night';
  state.nightStep = null;
  state.wolfVotes = {};
  state.wolfTarget = null;
  state.witchAction = null;
  state.guardChosenTarget = null;
  state.turnPayloadByUser = {};
  state.pendingSteps = buildNightSteps();
  broadcastPhaseUpdate();
  advanceNightStep();
}

function advanceNightStep() {
  const state = g();
  state.turnPayloadByUser = {};
  if (state.pendingSteps.length === 0) {
    resolveNight();
    return;
  }
  state.nightStep = state.pendingSteps.shift();
  sendTurnNotice(state.nightStep);
}

function sendTurnNotice(step) {
  const state = g();
  const alive = alivePlayers();

  if (step === 'hunter') {
    const u = aliveWithRole('hunter')[0];
    const payload = {
      step, round: state.round, options: alive.filter((x) => x !== u),
      message: 'Chọn một người để "kéo theo" nếu bạn chết sau này.'
    };
    state.turnPayloadByUser[u] = payload;
    emitTo(u, 'your_turn', payload);
  } else if (step === 'doppelganger') {
    const u = aliveWithRole('doppelganger')[0];
    const payload = {
      step, round: state.round, options: alive.filter((x) => x !== u),
      message: 'Chọn một người để nhân bản.'
    };
    state.turnPayloadByUser[u] = payload;
    emitTo(u, 'your_turn', payload);
  } else if (step === 'guard') {
    const u = aliveWithRole('guard')[0];
    const forbidden = state.players[u].guardLastTarget;
    const payload = {
      step, round: state.round, options: alive, forbiddenTarget: forbidden,
      message: 'Chọn một người để bảo vệ đêm nay.'
    };
    state.turnPayloadByUser[u] = payload;
    emitTo(u, 'your_turn', payload);
  } else if (step === 'wolves') {
    const wolves = aliveWithRole('werewolf');
    const targets = alive.filter((x) => team(x) !== 'wolf');
    wolves.forEach((u) => {
      const payload = {
        step, round: state.round, options: targets, teammates: wolves,
        votes: state.wolfVotes, message: 'Cùng bàn bạc và chọn một người để cắn (phải đồng thuận).'
      };
      state.turnPayloadByUser[u] = payload;
      emitTo(u, 'your_turn', payload);
    });
  } else if (step === 'seer') {
    const u = aliveWithRole('seer')[0];
    const payload = {
      step, round: state.round, options: alive.filter((x) => x !== u),
      message: 'Chọn một người để soi phe.'
    };
    state.turnPayloadByUser[u] = payload;
    emitTo(u, 'your_turn', payload);
  } else if (step === 'witch') {
    const u = aliveWithRole('witch')[0];
    const p = state.players[u];
    const payload = {
      step, round: state.round, options: alive,
      canHeal: !p.witchHealUsed, canKill: !p.witchKillUsed,
      message: 'Bạn có thể cứu, giết, hoặc không làm gì. Bạn KHÔNG biết đêm nay có ai bị cắn hay không.'
    };
    state.turnPayloadByUser[u] = payload;
    emitTo(u, 'your_turn', payload);
  }
}

function resolveNight() {
  const state = g();

  // lưu lại target bảo vệ đêm nay cho người bảo vệ (để tuần sau không được chọn lại)
  const guardUsers = aliveWithRole('guard');
  if (guardUsers.length) {
    state.players[guardUsers[0]].guardLastTarget = state.guardChosenTarget || null;
  }

  const deaths = new Set();
  let convertedUsername = null;

  if (state.wolfTarget) {
    const targetPlayer = state.players[state.wolfTarget];
    if (targetPlayer.role === 'cursed') {
      // Bị nguyền -> biến thành sói, không chết, không bị chặn bởi bảo vệ/phù thủy
      targetPlayer.role = 'werewolf';
      targetPlayer.wasCursed = true;
      convertedUsername = state.wolfTarget;
    } else {
      const protectedByGuard = state.guardChosenTarget === state.wolfTarget;
      const savedByWitch = state.witchAction && state.witchAction.type === 'heal'
        && state.witchAction.target === state.wolfTarget;
      if (!protectedByGuard && !savedByWitch) deaths.add(state.wolfTarget);
    }
  }

  if (state.witchAction && state.witchAction.type === 'kill') {
    deaths.add(state.witchAction.target); // phù thủy giết: bảo vệ không chặn được
  }

  // Thợ săn: nếu người bị nối chết trong đêm này, người bị kéo theo chắc chắn chết
  applyHunterDrag(deaths);

  // Thợ săn bị vote chết đêm/ngày trước đó: người bị kéo theo chết vào sáng nay
  if (state.pendingHunterExecuteDrag) {
    const dragT = state.pendingHunterExecuteDrag;
    if (state.players[dragT] && state.players[dragT].alive) deaths.add(dragT);
    state.pendingHunterExecuteDrag = null;
  }

  for (const d of deaths) state.players[d].alive = false;

  refreshDoppelPending();

  state.lastNightDeaths = Array.from(deaths);
  state.lastConverted = convertedUsername;

  if (convertedUsername) {
    emitTo(convertedUsername, 'cursed_converted', {
      message: 'Bạn đã bị Ma Sói cắn... và biến thành Ma Sói! Từ đêm sau bạn sẽ tham gia cắn người cùng bầy sói.',
    });
  }

  broadcastNightSummary();

  const winner = checkWinCondition();
  if (winner) { endGame(winner); return; }

  startDayVote();
}

function applyHunterDrag(deathSet) {
  const state = g();
  for (const dead of Array.from(deathSet)) {
    const p = state.players[dead];
    if (p.role === 'hunter' && p.hunterHasPicked && p.hunterDragTarget) {
      const dragT = p.hunterDragTarget;
      if (state.players[dragT] && state.players[dragT].alive) deathSet.add(dragT);
    }
  }
}

function refreshDoppelPending() {
  const state = g();
  for (const u of Object.keys(state.players)) {
    const p = state.players[u];
    if (p.role === 'doppelganger' && p.alive && p.doppelHasPicked && !p.doppelInherited && !p.pendingInheritRole) {
      const shadow = state.players[p.doppelShadowTarget];
      if (shadow && !shadow.alive) {
        p.pendingInheritRole = shadow.role;
        p.pendingInheritFrom = p.doppelShadowTarget;
      }
    }
  }
}

function deliverPendingDoppelInherits() {
  const state = g();
  for (const u of Object.keys(state.players)) {
    const p = state.players[u];
    if (p.alive && p.pendingInheritRole) {
      p.role = p.pendingInheritRole;
      p.doppelInherited = true;
      p.pendingInheritRole = null;
      p.pendingInheritFrom = null;
      emitTo(u, 'doppel_inherit', {
        role: p.role,
        label: ROLE_META[p.role].label,
        team: ROLE_META[p.role].team,
        message: `Người bạn nhân bản đã chết. Bạn giờ đây trở thành ${ROLE_META[p.role].label}!`,
      });
    }
  }
}

function broadcastPhaseUpdate() {
  const state = g();
  io.emit('phase_update', {
    status: state.status,
    round: state.round,
    aliveCount: alivePlayers().length,
  });
}

function broadcastNightSummary() {
  const state = g();
  io.emit('night_summary', {
    round: state.round,
    deathCount: state.lastNightDeaths.length,
    deaths: state.lastNightDeaths,
  });
}

// ------------------------- DAY FLOW -------------------------
function startDayVote() {
  const state = g();
  state.status = 'day_vote';
  state.dayVotes = {};
  state.accusedUsername = null;
  broadcastPhaseUpdate();
  io.emit('day_vote_open', { alive: alivePlayers(), round: state.round });
}

function tallyDayVotes() {
  const state = g();
  const counts = {};
  for (const v of Object.values(state.dayVotes)) counts[v] = (counts[v] || 0) + 1;
  const abstainCount = counts['abstain'] || 0;
  let top = null, topCount = -1, tie = false;
  for (const [k, c] of Object.entries(counts)) {
    if (k === 'abstain') continue;
    if (c > topCount) { top = k; topCount = c; tie = false; }
    else if (c === topCount) tie = true;
  }
  if (!top || tie || topCount <= abstainCount) {
    io.emit('day_vote_result', { willExecute: false, target: null });
    goToNextNight();
    return;
  }
  state.accusedUsername = top;
  io.emit('day_vote_result', { willExecute: true, target: top });
  startExecuteVote(top);
}

function startExecuteVote(target) {
  const state = g();
  state.status = 'day_execute';
  state.executeVotes = {};
  broadcastPhaseUpdate();
  io.emit('execute_vote_open', { target, round: state.round });
}

function tallyExecuteVotes() {
  const state = g();
  let kill = 0, spare = 0;
  for (const v of Object.values(state.executeVotes)) (v === 'kill' ? kill++ : spare++);
  const target = state.accusedUsername;
  let deaths = [];
  if (kill > spare) {
    state.players[target].alive = false;
    deaths.push(target);

    // Thợ săn bị vote chết: KHÔNG kéo người bị nối chết ngay (tránh lộ ngay là thợ săn).
    // Người bị nối sẽ chết vào đêm kế tiếp (khi resolveNight() chạy, tức sáng hôm sau).
    const tp = state.players[target];
    if (tp.role === 'hunter' && tp.hunterHasPicked && tp.hunterDragTarget) {
      state.pendingHunterExecuteDrag = tp.hunterDragTarget;
    }

    refreshDoppelPending();
  }
  io.emit('execute_result', { executed: deaths.length > 0, deaths });

  const winner = checkWinCondition();
  if (winner) { endGame(winner); return; }
  goToNextNight();
}

function goToNextNight() {
  const state = g();
  state.round += 1;
  deliverPendingDoppelInherits();
  startNight();
}

function endGame(winner) {
  const state = g();
  state.status = 'ended';
  state.winner = winner;
  io.emit('game_over', {
    winner,
    reveal: Object.fromEntries(Object.entries(state.players).map(([u, p]) => (
      [u, { role: p.role, label: ROLE_META[p.role].label, alive: p.alive }]
    ))),
  });
}

// ------------------------- SYNC ON (RE)CONNECT -------------------------
function syncStateToUser(username) {
  const state = room.game;
  if (!state) return;
  const p = state.players[username];
  if (!p) return;
  emitTo(username, 'your_role', { role: p.role, label: ROLE_META[p.role].label, team: ROLE_META[p.role].team });
  broadcastPhaseUpdate();
  if (state.status === 'day_vote') {
    emitTo(username, 'day_vote_open', { alive: alivePlayers(), round: state.round });
  } else if (state.status === 'day_execute') {
    emitTo(username, 'execute_vote_open', { target: state.accusedUsername, round: state.round });
  } else if (state.status === 'ended') {
    endGame(state.winner);
  }
  if (state.turnPayloadByUser && state.turnPayloadByUser[username]) {
    emitTo(username, 'your_turn', state.turnPayloadByUser[username]);
  }
}

// ------------------------- SOCKET HANDLERS -------------------------
io.on('connection', (socket) => {
  socket.on('login', ({ username }) => {
    if (!FIXED_USERNAMES.includes(username)) {
      socket.emit('login_result', { ok: false, message: 'Tên đăng nhập không hợp lệ.' });
      return;
    }
    room.sockets[username] = socket.id;
    room.online[username] = true;
    if (!room.hostUsername) room.hostUsername = username;
    socket.data.username = username;
    socket.emit('login_result', { ok: true, username, isHost: room.hostUsername === username });
    syncStateToUser(username);
    broadcastLobby();
  });

  socket.on('host_set_config', (cfg) => {
    const u = socket.data.username;
    if (!u || u !== room.hostUsername || room.game) return;
    const villagerCount = Math.max(0, parseInt(cfg.villagerCount, 10) || 0);
    const wolfCount = Math.max(1, parseInt(cfg.wolfCount, 10) || 1);
    const enabledSpecialRoles = Array.isArray(cfg.enabledSpecialRoles)
      ? cfg.enabledSpecialRoles.filter((r) => SPECIAL_ROLES.includes(r)) : [];
    if (villagerCount + wolfCount > 8) {
      socket.emit('error_message', { message: 'Tổng số dân + sói không được vượt quá 8.' });
      return;
    }
    room.config = { villagerCount, wolfCount, enabledSpecialRoles };
    broadcastLobby();
  });

  socket.on('host_start_game', () => {
    const u = socket.data.username;
    if (!u || u !== room.hostUsername) return;
    if (!room.config) { socket.emit('error_message', { message: 'Chủ phòng chưa thiết lập cấu hình.' }); return; }
    const allOnline = FIXED_USERNAMES.every((name) => room.online[name]);
    if (!allOnline) { socket.emit('error_message', { message: 'Cần đủ 8 người online mới bắt đầu được.' }); return; }

    let roles;
    try { roles = buildRoleList(room.config); }
    catch (e) { socket.emit('error_message', { message: e.message }); return; }

    const players = {};
    FIXED_USERNAMES.forEach((name, i) => {
      players[name] = {
        role: roles[i], alive: true, wasCursed: false,
        guardLastTarget: null,
        hunterHasPicked: false, hunterDragTarget: null,
        doppelHasPicked: false, doppelShadowTarget: null, doppelInherited: false,
        pendingInheritRole: null, pendingInheritFrom: null,
        witchHealUsed: false, witchKillUsed: false,
      };
    });

    room.game = {
      status: 'night', round: 1, players,
      nightStep: null, pendingSteps: [],
      wolfVotes: {}, wolfTarget: null,
      witchAction: null, guardChosenTarget: null,
      dayVotes: {}, executeVotes: {}, accusedUsername: null,
      turnPayloadByUser: {}, winner: null, lastNightDeaths: [], lastConverted: null,
      pendingHunterExecuteDrag: null,
    };

    io.emit('game_started');
    FIXED_USERNAMES.forEach((name) => {
      emitTo(name, 'your_role', {
        role: players[name].role, label: ROLE_META[players[name].role].label, team: ROLE_META[players[name].role].team,
      });
    });
    startNight();
  });

  // ---------- Night actions ----------
  socket.on('action_hunter', ({ target }) => {
    const u = socket.data.username; const state = room.game;
    if (!state || state.status !== 'night' || state.nightStep !== 'hunter') return;
    if (aliveWithRole('hunter')[0] !== u) return;
    if (target === u || !state.players[target] || !state.players[target].alive) return;
    state.players[u].hunterHasPicked = true;
    state.players[u].hunterDragTarget = target;
    advanceNightStep();
  });

  socket.on('action_doppelganger', ({ target }) => {
    const u = socket.data.username; const state = room.game;
    if (!state || state.status !== 'night' || state.nightStep !== 'doppelganger') return;
    if (aliveWithRole('doppelganger')[0] !== u) return;
    if (target === u || !state.players[target] || !state.players[target].alive) return;
    state.players[u].doppelHasPicked = true;
    state.players[u].doppelShadowTarget = target;
    advanceNightStep();
  });

  socket.on('action_guard', ({ target }) => {
    const u = socket.data.username; const state = room.game;
    if (!state || state.status !== 'night' || state.nightStep !== 'guard') return;
    if (aliveWithRole('guard')[0] !== u) return;
    if (!state.players[target] || !state.players[target].alive) return;
    if (state.players[u].guardLastTarget === target) {
      socket.emit('error_message', { message: 'Không được bảo vệ cùng một người 2 đêm liên tiếp.' });
      return;
    }
    state.guardChosenTarget = target;
    advanceNightStep();
  });

  socket.on('action_wolf_vote', ({ target }) => {
    const u = socket.data.username; const state = room.game;
    if (!state || state.status !== 'night' || state.nightStep !== 'wolves') return;
    if (!state.players[u] || state.players[u].role !== 'werewolf' || !state.players[u].alive) return;
    if (!state.players[target] || !state.players[target].alive || team(target) === 'wolf') return;
    state.wolfVotes[u] = target;
    const wolves = aliveWithRole('werewolf');
    wolves.forEach((w) => emitTo(w, 'wolf_vote_update', { votes: state.wolfVotes }));
    const allVoted = wolves.every((w) => state.wolfVotes[w]);
    if (allVoted) {
      const values = wolves.map((w) => state.wolfVotes[w]);
      const unanimous = values.every((v) => v === values[0]);
      if (unanimous) {
        state.wolfTarget = values[0];
        advanceNightStep();
      }
    }
  });

  socket.on('action_seer', ({ target }) => {
    const u = socket.data.username; const state = room.game;
    if (!state || state.status !== 'night' || state.nightStep !== 'seer') return;
    if (aliveWithRole('seer')[0] !== u) return;
    if (target === u || !state.players[target] || !state.players[target].alive) return;
    emitTo(u, 'seer_result', { target, team: team(target) });
    advanceNightStep();
  });

  socket.on('action_witch', ({ type, target }) => {
    const u = socket.data.username; const state = room.game;
    if (!state || state.status !== 'night' || state.nightStep !== 'witch') return;
    if (aliveWithRole('witch')[0] !== u) return;
    const p = state.players[u];
    if (type === 'heal') {
      if (p.witchHealUsed || !state.players[target] || !state.players[target].alive) return;
      p.witchHealUsed = true;
      state.witchAction = { type: 'heal', target };
    } else if (type === 'kill') {
      if (p.witchKillUsed || !state.players[target] || !state.players[target].alive) return;
      p.witchKillUsed = true;
      state.witchAction = { type: 'kill', target };
    } else if (type === 'pass') {
      // không làm gì
    } else return;
    advanceNightStep();
  });

  // ---------- Day actions ----------
  socket.on('action_day_vote', ({ target }) => {
    const u = socket.data.username; const state = room.game;
    if (!state || state.status !== 'day_vote') return;
    if (!state.players[u] || !state.players[u].alive) return;
    if (target !== 'abstain' && (!state.players[target] || !state.players[target].alive)) return;
    state.dayVotes[u] = target;
    io.emit('day_vote_update', { votes: state.dayVotes });
    const alive = alivePlayers();
    if (alive.every((a) => state.dayVotes[a])) tallyDayVotes();
  });

  socket.on('action_execute_vote', ({ choice }) => {
    const u = socket.data.username; const state = room.game;
    if (!state || state.status !== 'day_execute') return;
    if (!state.players[u] || !state.players[u].alive) return;
    if (choice !== 'kill' && choice !== 'spare') return;
    state.executeVotes[u] = choice;
    io.emit('execute_vote_update', { votes: state.executeVotes });
    const alive = alivePlayers();
    if (alive.every((a) => state.executeVotes[a])) tallyExecuteVotes();
  });

  socket.on('host_reset_game', () => {
    const u = socket.data.username;
    if (!u || u !== room.hostUsername) return;
    room.game = null;
    room.config = null;
    broadcastLobby();
  });

  socket.on('voice_signal', ({ to, data }) => {
    const from = socket.data.username;
    if (!from || !to) return;
    emitTo(to, 'voice_signal', { from, data });
  });

  socket.on('voice_mic_state', ({ on }) => {
    const u = socket.data.username;
    if (!u) return;
    room.voiceOn[u] = !!on;
    io.emit('voice_state_update', { voiceOn: room.voiceOn });
  });

  socket.on('disconnect', () => {
    const u = socket.data.username;
    if (u && room.sockets[u] === socket.id) {
      room.online[u] = false;
      room.voiceOn[u] = false;
      io.emit('voice_state_update', { voiceOn: room.voiceOn });

      // Nếu không còn ai online nữa, bỏ trống chủ phòng
      // -> người đăng nhập tiếp theo sẽ tự động thành chủ phòng mới
      const stillHasOnline = Object.values(room.online).some((v) => v);
      if (!stillHasOnline) {
        room.hostUsername = null;
      }

      broadcastLobby();
    }
  });
});

freshRoom();
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Ma Soi server listening on port ${PORT}`));
