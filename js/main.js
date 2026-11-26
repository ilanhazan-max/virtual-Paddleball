import { Sensors } from './sensors.js';
import { Camera, Vision } from './vision.js';
import { Net, parseCode, peerParam } from './net.js';
import { Game } from './game.js';
import { Sfx } from './sfx.js';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const overlay = $('overlay');
const octx = overlay.getContext('2d');

const app = {
  mode: null,          // 'solo' | 'host' | 'guest'
  net: null,
  me: 'A',
  settings: null,
  myDist: null,
  partnerDist: null,
  ready: false,
  partnerReady: false,
  game: null,
  calibLoop: null,
  scanning: false,
  manualDist: false,
  wakeLock: null,
};

// ---------- כלים ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  const camScreen = $(id).classList.contains('cam');
  document.body.classList.toggle('cam-on', camScreen && Camera.stream != null);
}

let toastTimer;
function toast(text, ms = 2600) {
  const t = $('toast');
  t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function readSettings() {
  return {
    balls: clamp(parseInt($('set-balls').value, 10) || 10, 1, 30),
    level: $('set-level').value,
    bounds: parseInt($('set-bounds').value, 10),
    sens: parseInt($('set-sens').value, 10),
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function clearOverlay() {
  const dpr = window.devicePixelRatio || 1;
  overlay.width = innerWidth * dpr; overlay.height = innerHeight * dpr;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, innerWidth, innerHeight);
}

// הרשאות: חייבות להתבקש בלחיצה של המשתמש (במיוחד ב‑iPhone)
async function prepareDevice() {
  Sfx.init();
  const ok = await Sensors.requestPermission();
  Sensors.start();
  if (!ok) toast('אין גישה לחיישני התנועה – ניתן לשחק עם רווח/קליק');
  const cam = await Camera.start(video);
  if (!cam) toast('לא ניתן להפעיל את המצלמה. ודא שהאתר נפתח ב‑https ושניתנה הרשאה.');
  try { if ('wakeLock' in navigator) app.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* */ }
  try { await screen.orientation.lock('portrait'); } catch { /* */ }
}

function resetSession() {
  stopCalibration();
  app.scanning = false;
  if (app.game) { app.game.destroy(); app.game = null; }
  if (app.net) { app.net.onClose = () => {}; app.net.close(); app.net = null; }
  Object.assign(app, { mode: null, ready: false, partnerReady: false, myDist: null, partnerDist: null, manualDist: false });
  clearOverlay();
}

function goHome() {
  resetSession();
  show('scr-home');
}

// ---------- רשת ----------
function setupNet(net) {
  app.net = net;
  net.onMessage = (m) => route(m);
  net.onClose = () => {
    toast('החיבור לשחקן השני נותק');
    goHome();
  };
}

function route(m) {
  if (!m || !m.t) return;
  if (app.game && app.game.handles(m.t)) { app.game.onNet(m); return; }
  switch (m.t) {
    case 'ready':
      app.partnerReady = true;
      app.partnerDist = m.dist;
      $('calib-partner').textContent = 'השותף מוכן ✔';
      maybeStart();
      break;
    case 'start':
      startGame(m.S, m.dist, m.settings);
      break;
    case 'rematch':
      startGame(m.S, m.dist, m.settings);
      break;
  }
}

// ---------- מסך פתיחה ----------
$('btn-duo').onclick = () => { $('duo-opts').hidden = !$('duo-opts').hidden; };

$('btn-solo').onclick = async () => {
  await prepareDevice();
  app.mode = 'solo'; app.me = 'A'; app.settings = readSettings();
  goCalibrate();
};

$('btn-host').onclick = async () => {
  await prepareDevice();
  app.mode = 'host'; app.me = 'A'; app.settings = readSettings();
  show('scr-host');
  $('host-status').textContent = 'מתחבר לשרת…';
  $('qr').innerHTML = '';
  const net = new Net();
  setupNet(net);
  net.onOpen = () => { toast('השחקן השני הצטרף!'); goCalibrate(); };
  try {
    const code = await net.host();
    const url = `${location.origin}${location.pathname}?join=${code}` + (peerParam ? `&peer=${encodeURIComponent(peerParam)}` : '');
    const qr = window.qrcode(0, 'M');
    qr.addData(url); qr.make();
    $('qr').innerHTML = `<img alt="QR" src="${qr.createDataURL(8, 0)}">`;
    $('host-code').textContent = code;
    $('host-status').textContent = 'ממתין לשחקן השני…';
  } catch (e) {
    console.error(e);
    $('host-status').textContent = 'שגיאה ביצירת המשחק. בדוק חיבור לאינטרנט ונסה שוב.';
  }
};

$('btn-join').onclick = async () => {
  await prepareDevice();
  app.mode = 'guest'; app.me = 'B';
  show('scr-join');
  $('join-status').textContent = Camera.stream ? 'מחפש קוד…' : 'אין מצלמה – הקלד את הקוד';
  startScan();
};

$('btn-join-manual').onclick = () => {
  const code = parseCode($('join-code').value);
  if (!code) { $('join-status').textContent = 'קוד לא תקין (6 תווים)'; return; }
  doJoin(code);
};

document.querySelectorAll('.back').forEach((b) => (b.onclick = goHome));
$('btn-quit').onclick = goHome;
$('btn-home').onclick = goHome;

['bounds', 'sens'].forEach((k) => {
  const el = $('set-' + k);
  el.oninput = () => ($('set-' + k + '-val').textContent = el.value);
});

// הזמנה דרך קישור (סריקה במצלמה הרגילה של הטלפון)
const inviteCode = parseCode(new URLSearchParams(location.search).get('join') || '');
if (inviteCode) {
  history.replaceState(null, '', location.pathname + (peerParam ? `?peer=${encodeURIComponent(peerParam)}` : ''));
  $('invite-code').textContent = inviteCode;
  show('scr-invite');
  $('btn-invite-join').onclick = async () => {
    await prepareDevice();
    app.mode = 'guest'; app.me = 'B';
    show('scr-join');
    doJoin(inviteCode);
  };
}

// ---------- סריקת QR ----------
let barcodeDetector = null;
const scanCanvas = document.createElement('canvas');
const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

function startScan() {
  app.scanning = true;
  if ('BarcodeDetector' in window) {
    try { barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { barcodeDetector = null; }
  }
  scanTick();
}

async function scanTick() {
  if (!app.scanning) return;
  let text = null;
  if (Camera.ready()) {
    if (barcodeDetector) {
      try {
        const codes = await barcodeDetector.detect(video);
        if (codes.length) text = codes[0].rawValue;
      } catch { barcodeDetector = null; }
    }
    if (!text && window.jsQR) {
      const s = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      scanCanvas.width = Math.round(video.videoWidth * s);
      scanCanvas.height = Math.round(video.videoHeight * s);
      scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
      const img = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
      const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (r) text = r.data;
    }
  }
  const code = parseCode(text);
  if (code) { app.scanning = false; doJoin(code); return; }
  setTimeout(scanTick, 200);
}

async function doJoin(code) {
  app.scanning = false;
  $('join-status').textContent = 'מתחבר למשחק ' + code + '…';
  if (app.net) app.net.close();
  const net = new Net();
  setupNet(net);
  try {
    await net.join(code);
    toast('מחובר!');
    goCalibrate();
  } catch (e) {
    console.error(e);
    app.net = null;
    $('join-status').textContent = 'לא הצלחתי להתחבר. ודא שהקוד נכון ושהשחקן הראשי ממתין.';
    show('scr-join');
    startScan();
  }
}

// ---------- כיול: זיהוי השותף והערכת מרחק ----------
function goCalibrate() {
  show('scr-calib');
  clearOverlay();
  app.ready = false;
  app.manualDist = false;
  const solo = app.mode === 'solo';
  $('btn-ready').disabled = false;
  $('calib-partner').textContent = solo ? '' : (app.partnerReady ? 'השותף מוכן ✔' : 'ממתין שהשותף יהיה מוכן…');
  $('calib-title').innerHTML = solo
    ? '<b>עמוד במקום פתוח וכוון את הטלפון קדימה – לשם יוחזר הכדור</b>'
    : '<b>עמדו במרחק של 2–3 מטרים וכוונו את המצלמה אחד לשני</b>';
  $('calib-hint').textContent = solo ? 'בחר את המרחק מהיריב הווירטואלי' : 'מרכזו את השותף בכוונת';
  $('btn-ready').textContent = solo ? 'התחל משחק' : 'אני מוכן – כיילתי';
  $('calib-dist').textContent = solo ? $('calib-slider').value + " מ'" : '—';
  if (!solo && Camera.stream) runDetection();
}

$('calib-slider').oninput = () => {
  const v = parseFloat($('calib-slider').value);
  $('calib-slider-val').textContent = v.toFixed(1) + " מ'";
  app.manualDist = true;
  app.myDist = v;
  $('calib-dist').textContent = v.toFixed(1) + " מ' (ידני)";
};

function stopCalibration() {
  if (app.calibLoop) { clearTimeout(app.calibLoop); app.calibLoop = null; }
}

async function runDetection() {
  stopCalibration();
  const samples = [];
  $('calib-hint').textContent = 'טוען מודל זיהוי…';
  try { await Vision.load(); } catch (e) {
    console.error(e);
    $('calib-hint').textContent = 'זיהוי אוטומטי לא זמין – קבע מרחק ידנית';
    return;
  }
  const step = async () => {
    if (!$('scr-calib').classList.contains('active') || app.ready) return;
    if (Camera.ready()) {
      let person = null;
      try { person = await Vision.detectPerson(video); } catch (e) { console.warn(e); }
      drawDetection(person);
      if (person) {
        const d = Vision.estimateDistance(person.bbox, video);
        samples.push(d); if (samples.length > 9) samples.shift();
        const med = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
        if (!app.manualDist) {
          app.myDist = med;
          $('calib-dist').textContent = med.toFixed(1) + " מ'";
          $('calib-slider').value = med.toFixed(1);
          $('calib-slider-val').textContent = med.toFixed(1) + " מ'";
        }
        const cx = person.bbox[0] + person.bbox[2] / 2;
        const off = Math.abs(cx / video.videoWidth - 0.5);
        $('calib-hint').textContent =
          med < 1.6 ? 'קרובים מדי – התרחקו קצת' :
          med > 3.8 ? 'רחוקים מדי – התקרבו קצת' :
          off > 0.15 ? 'השותף זוהה – מרכזו אותו בכוונת' : 'מעולה! השותף זוהה במרכז ✔';
      } else {
        $('calib-hint').textContent = 'מחפש את השותף…';
      }
    }
    app.calibLoop = setTimeout(step, 250);
  };
  step();
}

function drawDetection(person) {
  octx.clearRect(0, 0, innerWidth, innerHeight);
  if (!person) return;
  const { s, ox, oy } = Camera.coverTransform(innerWidth, innerHeight);
  const [x, y, w, h] = person.bbox;
  octx.strokeStyle = '#3dff7a'; octx.lineWidth = 3;
  octx.strokeRect(x * s + ox, y * s + oy, w * s, h * s);
}

$('btn-ready').onclick = () => {
  Sfx.init();
  Sensors.calibrate();           // הכיוון הנוכחי = הכיוון אל השותף
  stopCalibration();
  octx.clearRect(0, 0, innerWidth, innerHeight);
  if (app.myDist == null) app.myDist = parseFloat($('calib-slider').value);
  app.ready = true;
  if (app.mode === 'solo') {
    startGame(Game.newState(app.settings, Math.random() < 0.5 ? 'A' : 'B'), app.myDist, app.settings);
    return;
  }
  $('btn-ready').disabled = true;
  $('calib-partner').textContent = app.partnerReady ? 'מתחילים…' : 'ממתין שהשותף יהיה מוכן…';
  app.net.send({ t: 'ready', dist: app.myDist });
  maybeStart();
};

function maybeStart() {
  if (app.mode !== 'host' || !app.ready || !app.partnerReady || app.game) return;
  const dists = [app.myDist, app.partnerDist].filter((d) => typeof d === 'number' && d > 0);
  const dist = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : 2.5;
  const S = Game.newState(app.settings, Math.random() < 0.5 ? 'A' : 'B'); // הגרלת השחקן המתחיל
  app.net.send({ t: 'start', S, dist, settings: app.settings });
  startGame(S, dist, app.settings);
}

// ---------- משחק ----------
function startGame(S, dist, settings) {
  if (app.game) { app.game.destroy(); app.game = null; }
  app.settings = settings;
  Sensors.swingThreshold = settings.sens;
  show('scr-game');
  app.game = new Game({
    canvas: overlay,
    hud: {
      me: $('hud-me'), opp: $('hud-opp'), rally: $('hud-rally'), best: $('hud-best'),
      msg: $('msg'), sub: $('msg-sub'), meName: $('hud-me-name'), oppName: $('hud-opp-name'),
    },
    net: app.net,
    me: app.me,
    solo: app.mode === 'solo',
    dist,
    settings,
    onOver: (r) => showOver(r, dist),
  });
  app.game.begin(S);
}

function showOver({ S, winner, me }, dist) {
  const won = winner === me;
  const solo = app.mode === 'solo';
  $('over-icon').textContent = won ? '🏆' : '🏓';
  $('over-title').textContent = won ? 'ניצחת!' : (solo ? 'המחשב ניצח' : 'השותף ניצח');
  $('over-stats').innerHTML =
    `הרצף הארוך ביותר: <b>${S.best}</b> חבטות<br>` +
    `החבטות שלך: <b>${S.hits[me]}</b> · מרחק: <b>${dist.toFixed(1)} מ'</b>`;
  const canRestart = app.mode !== 'guest';
  $('btn-rematch').hidden = !canRestart;
  $('over-wait').hidden = canRestart;
  show('scr-over');
  $('btn-rematch').onclick = () => {
    const S2 = Game.newState(app.settings, Math.random() < 0.5 ? 'A' : 'B');
    if (app.net) app.net.send({ t: 'rematch', S: S2, dist, settings: app.settings });
    startGame(S2, dist, app.settings);
  };
}

window.addEventListener('resize', () => { if (!app.game) clearOverlay(); });
clearOverlay();

// גישה לבדיקות אוטומטיות
window.__vm = app;
