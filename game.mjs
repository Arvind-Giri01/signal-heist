const ROUNDS = 7;
const TURN_MS = 25000;
const TTL = 4 * 3600 * 1000;
const CHANNELS = ['Relay', 'Vault', 'Beacon'];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function player(name) {
  return { name, id: crypto.randomUUID(), total: 0, boosts: 2, pick: null };
}

function newRound(room, now) {
  room.round++;
  room.phase = 'play';
  room.deadline = now + TURN_MS;
  room.values = CHANNELS.map(() => 2 + Math.floor(Math.random() * 4));
  for (const p of room.players) p.pick = null;
}

function reveal(room) {
  const picks = room.players.map(p => p.pick);
  room.results = room.players.map((p, i) => {
    const pick = picks[i];
    let points = 0;
    let result = 'Timed out';
    if (pick) {
      const best = Math.max(...picks.filter(q => q && q.channel === pick.channel).map(q => Number(q.boost)));
      const tied = picks.filter(q => q && q.channel === pick.channel && Number(q.boost) === best).length;
      if (Number(pick.boost) < best) result = 'Outbid';
      else if (tied > 1) result = 'Jammed';
      else {
        points = room.values[pick.channel];
        result = 'Captured';
      }
    }
    p.total += points;
    return { name: p.name, channel: pick?.channel ?? null, boost: !!pick?.boost, points, result };
  });
  room.phase = room.round === ROUNDS ? 'over' : 'reveal';
}

function view(room, id) {
  const me = room.players.find(p => p.id === id);
  if (!me) throw new GameError('Join the room to see the match.', 403);
  return { code: room.code, host: room.players[0] === me, phase: room.phase, round: room.round,
    values: room.values, deadline: room.deadline, you: room.players.indexOf(me),
    players: room.players.map(p => ({name: p.name, total: p.total, boosts: p === me ? p.boosts : null, locked: !!p.pick})),
    pick: me.pick, results: ['over','reveal'].includes(room.phase) ? room.results : null };
}

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || [...name].length > 18 || /[\u0000-\u001f\u007f]/.test(name)) throw new GameError('Enter a name of 1–18 characters.');
  return name;
}

async function createRoom(db, name, now) {
  const host = player(cleanName(name));
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = [...crypto.getRandomValues(new Uint8Array(6))].map(n => ALPHABET[n % ALPHABET.length]).join('');
    const room = {code, phase:'lobby', round:0, players:[host]};
    const res = await db.prepare('INSERT OR IGNORE INTO rooms (code, state, expires) VALUES (?, ?, ?)').bind(code, JSON.stringify(room), now + TTL).run();
    if (res.meta.changes) return {id:host.id, room:view(room, host.id)};
  }
  throw new GameError('Could not create a room. Try again.', 503);
}

async function act(db, data, now) {
  if (data.action === 'create') return createRoom(db, data.name, now);
  if (typeof data.code !== 'string' || !/^[A-Z2-9]{6}$/.test(data.code)) throw new GameError('Enter a valid six-character room code.');
  for (let attempt = 0; attempt < 10; attempt++) {
    const row = await db.prepare('SELECT version, state FROM rooms WHERE code = ? AND expires > ?').bind(data.code, now).first();
    if (!row) throw new GameError('Room not found or expired.', 404);
    const room = JSON.parse(row.state);
    let id = data.id;
    if (room.phase === 'play' && now >= room.deadline) reveal(room);
    if (data.action === 'join') {
      if (room.phase !== 'lobby') throw new GameError('This match has already started.');
      if (room.players.length >= 4) throw new GameError('This room is full.');
      const guest = player(cleanName(data.name));
      room.players.push(guest);
      id = guest.id;
    } else {
      const me = room.players.find(p => p.id === id);
      if (!me) throw new GameError('Join the room first.', 403);
      if (data.action === 'advance') {
        if (room.players[0] !== me) throw new GameError('Only the host can advance.');
        if (data.round === room.round && data.phase === room.phase) {
          if (room.phase === 'lobby' && room.players.length >= 2 || room.phase === 'reveal') newRound(room, now);
          else if (room.phase === 'over') {
            for (const p of room.players) { p.total = 0; p.boosts = 2; p.pick = null; }
            room.round = 0;
            room.phase = 'lobby';
          }
        }
      } else if (data.action === 'lock') {
        if (room.phase === 'play' && data.round === room.round && !me.pick) {
          if (!Number.isInteger(data.channel) || data.channel < 0 || data.channel >= CHANNELS.length) throw new GameError('Select a channel.');
          const boost = data.boost === true;
          if (boost && !me.boosts) throw new GameError('You are out of boosts.');
          me.pick = { channel:data.channel, boost };
          if (boost) me.boosts--;
          if (room.players.every(p => p.pick)) reveal(room);
        }
      } else if (data.action !== 'state') throw new GameError('Unknown action.');
    }
    const state = JSON.stringify(room);
    if (state !== row.state) {
      const res = await db.prepare('UPDATE rooms SET state = ?, version = version + 1, expires = ? WHERE code = ? AND version = ?').bind(state, now + TTL, room.code, row.version).run();
      if (!res.meta.changes) continue;
    }
    return {id, room:view(room,id)};
  }
  throw new GameError('Room is busy. Try again.', 503);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return new Response(PAGE, {headers:{'content-type':'text/html; charset=utf-8'}});
    if (url.pathname !== '/api/room' || request.method !== 'POST') return new Response(null,{status:404});
    const headers = {'cache-control':'no-store'};
    try {
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new GameError('Expected JSON.');
      const raw = await request.text();
      if (raw.length > 2048) throw new GameError('Request too large.',413);
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') throw new GameError('Invalid request.');
      const now = Date.now();
      if (data.action === 'create' && Math.random() < 0.05) await env.DB.prepare('DELETE FROM rooms WHERE expires <= ?').bind(now).run();
      return Response.json(await act(env.DB, data, now), {headers});
    } catch (error) {
      const status = error instanceof GameError ? error.status : error instanceof SyntaxError ? 400 : 500;
      return Response.json({error:status === 500 ? 'Connection interrupted. Try again.' : error.message},{status,headers});
    }
  }
};

const PAGE = String.raw`
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0c1212"><title>Signal Heist</title>
<style>
:root{color-scheme:dark;--bg:#0c1212;--panel:#121d1a;--ink:#eef5ea;--muted:#a9bcb1;--line:#30453b;--lime:#dbff72;--mint:#78eed0;--orange:#ffb883;font-family:system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 54% 0%,#263526,transparent 55%),var(--bg);color:var(--ink);min-height:100vh}button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.48}button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid var(--mint);outline-offset:4px}main,header{width:min(1100px,calc(100% - 36px));margin:auto}header{height:84px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand,.mono,.tag{font-family:ui-monospace,monospace;letter-spacing:.09em}.brand{font-weight:900}.brand b{color:var(--lime);margin-right:8px}.tag{color:var(--mint);font-size:.85rem}main{padding:48px 0}.landing{display:grid;grid-template-columns:1.25fr 1fr;gap:60px;align-items:center}h1,h2,p{margin:0}h1{font-size:clamp(3rem,9vw,7rem);line-height:.86;letter-spacing:-.08em;text-transform:uppercase;margin:22px 0}h1 em{font-style:normal;color:var(--lime)}h2{font-size:clamp(1.7rem,4vw,2.5rem);letter-spacing:-.04em;margin:8px 0 12px}.lede{font-size:1.15rem;max-width:33rem;color:var(--muted);line-height:1.6}.panel{border:1px solid var(--line);border-radius:18px;padding:24px;background:var(--panel)}.radar{height:145px;position:relative;margin-top:24px;border:1px solid var(--line);border-radius:18px;overflow:hidden;background:repeating-radial-gradient(circle at 50% 76%,transparent 0 22px,#55765a66 23px 24px),repeating-linear-gradient(90deg,transparent 0 34px,#89b99a13 35px 36px),#141e18}.radar:before{content:"";position:absolute;inset:0;background:conic-gradient(from 290deg at 50% 76%,transparent 0deg,#a5ff9070 48deg,transparent 51deg)}.radar i{width:9px;height:9px;position:absolute;border-radius:50%;background:var(--lime);box-shadow:0 0 18px 3px var(--lime)}.radar i:nth-child(1){top:34%;left:36%}.radar i:nth-child(2){top:65%;left:57%}.radar i:nth-child(3){top:44%;left:74%}label{display:block;font-weight:750;margin:14px 0 7px}input{width:100%;padding:12px;border:1px solid var(--line);border-radius:9px;background:#0d1613;color:var(--ink)}button{border:1px solid var(--line);border-radius:9px;background:#203129;color:var(--ink);padding:11px 15px;font-weight:800}button.primary{background:var(--lime);color:#142014;border-color:var(--lime)}.wide{width:100%;margin-top:12px}.row{display:flex;gap:10px;align-items:center}.row input{min-width:0}.split{border-top:1px solid var(--line);margin-top:20px;padding-top:7px}.muted,li{color:var(--muted);line-height:1.6}.notice{color:var(--orange);min-height:1.5em;margin:14px 0 0}.rules{margin-top:24px}summary{cursor:pointer;font-weight:800}.rules ol{margin-bottom:0;padding-left:24px}.rules li+li{margin-top:6px}.board{display:grid;grid-template-columns:minmax(0,1fr) 275px;gap:18px}.head{display:flex;justify-content:space-between;gap:14px;align-items:center;margin-bottom:19px}.head h2{margin-bottom:0}.clock{font:900 1.45rem ui-monospace,monospace;color:var(--lime)}.code{font:900 clamp(2rem,6vw,4rem) ui-monospace,monospace;letter-spacing:.12em;color:var(--lime);overflow-wrap:anywhere;margin:12px 0}.channels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:20px 0}.channel{text-align:left;padding:14px 10px;min-height:112px;background:#17271e}.channel b{display:block;font-size:clamp(1.4rem,4vw,2.1rem);color:var(--lime);margin-top:10px}.channel[aria-pressed=true]{border-color:var(--lime);background:#34452a}.boost[aria-pressed=true]{border-color:var(--mint);color:var(--mint)}.players,.results{list-style:none;padding:0;margin:10px 0 0}.players li,.results li{border-top:1px solid var(--line);padding:10px 0;display:flex;align-items:center;justify-content:space-between;gap:8px;overflow-wrap:anywhere}.players strong,.results strong{color:var(--ink)}.players small{display:block}.scores{color:var(--lime);font-weight:900}.headline{color:var(--lime)}.actions{flex-wrap:wrap;margin-top:15px}.board .notice:empty{display:none}.secondary{background:transparent}.subtle{font-size:.9rem;color:var(--muted)}
@media(max-width:760px){header{height:66px}main{padding-top:27px}.landing,.board{grid-template-columns:1fr;gap:18px}.landing{align-items:start}.radar{height:95px}.panel{padding:17px}.head{align-items:flex-start}.channels{gap:6px}.channel{min-height:88px;padding:10px 6px}.brand,.tag{letter-spacing:.045em}}
</style></head><body><header><div class="brand"><b>◈</b>SIGNAL HEIST</div><span class="tag">2–4 PLAYERS</span></header><main id="app"></main>
<script>
const app = document.querySelector('#app');
const channels = ['Relay','Vault','Beacon'];
const invitation = new URL(location.href).searchParams.get('room') || '';
let session = null;
try { session = JSON.parse(sessionStorage.getItem('signal-session')); } catch {}
if (invitation && invitation !== session?.code) session = null;
let room, selected = null, boosted = false, busy = false, notice = '', connected = true;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rules = '<details class="panel rules"><summary>How to play</summary><ol><li>Each round, secretly choose one channel. Its points are shown on the card.</li><li>A solo pick captures the channel. If players collide, a boosted pick beats an ordinary pick. A tie for the strongest signal jams that channel and scores zero.</li><li>You get two boosts for the whole match. Lock in within 25 seconds. Missing the deadline scores zero.</li><li>Highest total after seven rounds wins. Equal totals share the win.</li></ol></details>';
function updateNotice() {
  const el = document.querySelector('.notice');
  if (el) el.textContent = notice || (connected ? '' : 'Reconnecting…');
}
function render() {
  const openRules = document.querySelector('.rules')?.open;
  if (!room) {
    app.innerHTML = '<div class="landing"><section><span class="tag">A GAME OF RISK AND READS</span><h1>Signal<br><em>Heist</em></h1><p class="lede">Pick your channel. Read the room. Grab the signal before someone jams it.</p><div class="radar" aria-hidden="true"><i></i><i></i><i></i></div></section><section class="panel"><h2>Enter the arena</h2><label for="name">Player name</label><input id="name" maxlength="18" autocomplete="off" placeholder="Your callsign"><button class="primary wide" data-act="create">Create room</button><div class="split"><label for="code">Joining a friend?</label><div class="row"><input id="code" maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="Room code" value="' + escape(invitation) + '"><button data-act="join">Join</button></div></div><p class="notice" role="status"></p></section></div>' + rules;
  } else {
    const me = room.players[room.you];
    let content = '';
    if (room.phase === 'lobby') content = '<h2>Room lobby</h2><p class="muted">Send this code or invite link to your friends.</p><div class="code">' + room.code + '</div><button data-act="copy">Copy invite</button><div class="row actions">' + (room.host ? '<button class="primary" data-act="advance" '+ (room.players.length < 2 ? 'disabled' : '') +'>Start match</button>' : '<p class="muted">Waiting for the host to start.</p>') + '</div>';
    if (room.phase === 'play') {
      const selection = room.pick?.channel ?? selected;
      content = '<div class="head"><div><span class="tag">ROUND ' + room.round + ' / 7</span><h2>Choose a channel</h2></div><span class="clock" id="clock"></span></div><p class="muted">' + (me.locked ? 'Locked in. Waiting for the other players.' : 'Your choice stays hidden until the reveal.') + '</p><div class="channels">' + channels.map((name, i) => '<button class="channel" data-act="channel" data-index="' + i + '" aria-pressed="' + (selection === i) + '" ' + (me.locked ? 'disabled' : '') + '>' + name + '<b>' + room.values[i] + ' pts</b></button>').join('') + '</div><div class="row actions"><button class="boost" data-act="boost" aria-pressed="' + (room.pick?.boost ?? boosted) + '" ' + (me.locked || !me.boosts ? 'disabled' : '') + '>Boost · ' + me.boosts + ' left</button><button class="primary" data-act="lock" ' + (me.locked || selected === null ? 'disabled' : '') + '>Lock choice</button></div>';
    }
    if (room.results) {
      const winners = room.players.filter(p => p.total === Math.max(...room.players.map(p => p.total))).map(p => p.name);
      content = '<span class="tag">ROUND ' + room.round + ' / 7</span><h2 class="headline">' + (room.phase === 'over' ? escape(winners.join(' & ')) + (winners.length > 1 ? ' tie for first' : ' wins') : 'Signals revealed') + '</h2><ul class="results">' + room.results.map(r => '<li><div><strong>' + escape(r.name) + '</strong><br><span class="subtle">' + (r.channel === null ? '' : channels[r.channel] + (r.boost ? ' · Boosted' : '') + ' · ') + r.result + '</span></div><b class="scores">+' + r.points + '</b></li>').join('') + '</ul>';
      content += room.host ? '<div class="row actions"><button class="primary" data-act="advance">' + (room.phase === 'over' ? 'Play again' : 'Next round') + '</button></div>' : '<p class="muted">Waiting for the host.</p>';
    }
    app.innerHTML = '<div class="board"><section class="panel">'+content+'<p class="notice" role="status"></p></section><aside class="panel"><span class="tag">ROOM '+room.code+'</span><h2>Players</h2><ul class="players">'+room.players.map((p,i)=>'<li><div><strong>'+escape(p.name)+(i===room.you?' (you)':'')+'</strong><small>'+(room.phase==='play'?(p.locked?'Locked':'Choosing'):(i===0?'Host':'Guest'))+'</small></div><b class="scores">'+p.total+'</b></li>').join('')+'</ul><button class="secondary wide" data-act="leave">Back to home</button></aside></div>'+rules;
  }
  if (openRules) document.querySelector('.rules').open = true;
  updateNotice();
  clock();
}
function clock() {
  const el = document.querySelector('#clock');
  if (el && room) el.textContent = Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000)) + 's';
}
async function request(action, fields = {}) {
  if (busy) {
    if (action !== 'state') { notice = 'Syncing the room. Try again in a moment.'; updateNotice(); }
    return;
  }
  busy = true;
  try {
    const response = await fetch('/api/room',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...session,action,...fields}),signal:AbortSignal.timeout(8000)});
    const data = await response.json();
    if (!response.ok) {
      if (action === 'state' && [403,404].includes(response.status)) { session = room = null; sessionStorage.removeItem('signal-session'); render(); }
      throw Error(data.error);
    }
    const previous = room;
    if (!previous || previous.round !== data.room.round || previous.phase !== data.room.phase) { selected = null; boosted = false; }
    room = data.room;
    session = {id:data.id,code:room.code};
    sessionStorage.setItem('signal-session',JSON.stringify(session));
    connected = true;
    if (action !== 'state') notice = '';
    if (JSON.stringify(previous) !== JSON.stringify(room)) render();
    else updateNotice();
  } catch (error) {
    if (action === 'state' && session) connected = false;
    else notice = error.message || 'Connection interrupted. Try again.';
    updateNotice();
  } finally { busy = false; }
}
app.addEventListener('click', async event => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const action = button.dataset.act;
  if (action === 'create' || action === 'join') {
    const name = document.querySelector('#name').value.trim();
    const code = document.querySelector('#code').value.trim().toUpperCase();
    if (!name) { notice = 'Enter your player name.'; updateNotice(); document.querySelector('#name').focus(); return; }
    return request(action,{name,code});
  }
  if (action === 'channel' || action === 'boost') {
    if (action === 'channel') selected = Number(button.dataset.index);
    else boosted = !boosted;
    for (const card of app.querySelectorAll('[data-act="channel"]')) card.setAttribute('aria-pressed', String(Number(card.dataset.index) === selected));
    app.querySelector('[data-act="boost"]').setAttribute('aria-pressed', String(boosted));
    app.querySelector('[data-act="lock"]').disabled = selected === null;
  }
  if (action === 'lock') return request(action,{round:room.round,channel:selected,boost:boosted});
  if (action === 'advance') return request(action,{round:room.round,phase:room.phase});
  if (action === 'copy') {
    const url = new URL(location.href);
    url.searchParams.set('room', room.code);
    try { await navigator.clipboard.writeText(url.href); notice = 'Invite link copied.'; }
    catch { notice = 'Share room code ' + room.code + ' with your friends.'; }
    updateNotice();
  }
  if (action === 'leave' && !busy) {
    room = session = null;
    notice = '';
    sessionStorage.removeItem('signal-session');
    render();
  }
});
render();
if (session) request('state');
setInterval(() => { clock(); if (session) request('state'); }, 1000);
</script></body></html>`;
