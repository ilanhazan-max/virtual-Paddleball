// חיבור ישיר בין שני הטלפונים (WebRTC דרך PeerJS). קוד ה‑QR מכיל את מזהה המשחק.
const PREFIX = 'vmatkot-';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

// אפשרות לשרת PeerJS עצמאי: ‎?peer=host:port  (ברירת מחדל: השרת הציבורי של PeerJS)
const PEER_PARAM = new URLSearchParams(location.search).get('peer');
export const peerParam = PEER_PARAM;
function peerOptions() {
  if (!PEER_PARAM) return { debug: 1 };
  const [host, port] = PEER_PARAM.split(':');
  const secure = location.protocol === 'https:';
  return { host, port: Number(port) || (secure ? 443 : 80), path: '/', secure, debug: 1 };
}

export function makeCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export function parseCode(text) {
  if (!text) return null;
  try {
    const u = new URL(text);
    const j = u.searchParams.get('join');
    if (j) return j.toLowerCase();
  } catch { /* לא כתובת */ }
  const m = text.trim().toLowerCase().match(/^[a-z0-9]{6}$/);
  return m ? m[0] : null;
}

export class Net {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.onMessage = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
  }

  host(attempt = 0) {
    return new Promise((resolve, reject) => {
      const code = makeCode();
      const peer = new Peer(PREFIX + code, peerOptions());
      this.peer = peer;
      peer.on('open', () => resolve(code));
      peer.on('connection', (conn) => {
        if (this.conn) { conn.close(); return; } // רק שותף אחד
        this._bind(conn);
      });
      peer.on('error', (e) => {
        if (e.type === 'unavailable-id' && attempt < 3) {
          peer.destroy();
          this.host(attempt + 1).then(resolve, reject);
        } else if (!this.conn) reject(e);
        else console.warn(e);
      });
      peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* */ } });
    });
  }

  join(code) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerOptions());
      this.peer = peer;
      const timer = setTimeout(() => reject(new Error('timeout')), 20000);
      peer.on('error', (e) => { clearTimeout(timer); reject(e); });
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true });
        this._bind(conn, () => { clearTimeout(timer); resolve(); });
      });
    });
  }

  _bind(conn, cb) {
    this.conn = conn;
    conn.on('open', () => { this.onOpen(); if (cb) cb(); });
    conn.on('data', (d) => this.onMessage(d));
    conn.on('close', () => this.onClose());
    conn.on('error', (e) => console.warn('conn', e));
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  close() {
    try { if (this.conn) this.conn.close(); } catch { /* */ }
    try { if (this.peer) this.peer.destroy(); } catch { /* */ }
    this.conn = null; this.peer = null;
  }
}
