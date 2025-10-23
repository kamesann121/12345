// シンプルな WebSocket サーバ
// 動作: chat / presence / taps をブロードキャスト。in-memory の接続リストと簡易永続化（data.json）
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const DATA_FILE = path.join(__dirname, 'data.json');

let db = { taps: {}, users: {}, chat: [] };
// load existing
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    db = JSON.parse(raw);
    console.log('Loaded data.json');
  }
} catch (e) {
  console.error('Failed to load data.json', e);
}

// 保存ヘルパー（簡易、頻度抑制のため throttle する）
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), err => {
      if (err) console.error('Save error', err);
      saveTimer = null;
    });
  }, 2000);
}

// WebSocket server
const wss = new WebSocket.Server({ port: PORT }, () => {
  console.log(`WebSocket server started on ${PORT}`);
});

// 全接続に JSON を送る
function broadcast(obj, exceptWs = null) {
  const raw = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client !== exceptWs) {
      try { client.send(raw); } catch (e) {}
    }
  }
}

// クライアントごとのメタ
wss.on('connection', (ws, req) => {
  ws.id = Math.random().toString(36).slice(2,10);
  ws.nick = `User${Math.floor(Math.random()*900+100)}`;

  // 初期情報を送る（全サーバ保存データ）
  ws.send(JSON.stringify({ type: 'init', payload: { db, serverTime: Date.now() } }));

  // 当該接続を全体に通知（presence join）
  // 他クライアントへの通知はクライアントからの presence メッセージ受信で行う（以下）。
  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) { return; }

    // メッセージタイプによる処理
    if (data.type === 'chat') {
      const entry = { nick: data.nick || ws.nick, text: data.text || '', ts: Date.now() };
      db.chat.push(entry);
      if (db.chat.length > 500) db.chat.shift();
      scheduleSave();
      broadcast({ type: 'chat', payload: entry });
    } else if (data.type === 'presence') {
      // presence: {tabId, nick, score, extra}
      const p = data.payload || {};
      ws.nick = p.nick || ws.nick;
      // サーバ側 users は接続中のクライアントを map に保持（lastSeen を保存）
      db.users[ws.id] = { id: ws.id, nick: ws.nick, score: p.score || 0, ts: Date.now() };
      scheduleSave();
      broadcast({ type: 'presence', payload: db.users });
    } else if (data.type === 'tap') {
      // tap: {userId, name, delta, total}
      const t = data.payload;
      if (!t || !t.name) return;
      const key = t.name;
      db.taps[key] = db.taps[key] || { name: key, total: 0, lastTs: 0 };
      db.taps[key].total = typeof t.total === 'number' ? t.total : (db.taps[key].total + (t.delta || 1));
      db.taps[key].lastTs = Date.now();
      scheduleSave();
      broadcast({ type: 'taps_update', payload: { name: key, total: db.taps[key].total, lastTs: db.taps[key].lastTs } });
    } else if (data.type === 'get_taps') {
      ws.send(JSON.stringify({ type: 'taps_snapshot', payload: db.taps }));
    } else if (data.type === 'disconnect_me') {
      // クライアント明示的切断通知
      delete db.users[ws.id];
      scheduleSave();
      broadcast({ type: 'presence', payload: db.users });
    }
  });

  ws.on('close', () => {
    delete db.users[ws.id];
    scheduleSave();
    broadcast({ type: 'presence', payload: db.users });
  });
});
