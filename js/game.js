// מנוע המשחק: הגשה, חבטה, מעוף הכדור, זיהוי פסילות ותצוגה במציאות רבודה.
import { Sensors, wrap180 } from './sensors.js';
import { Camera } from './vision.js';
import { Sfx } from './sfx.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

const LIFT = 8;           // הגבהה טבעית של החבטה (מעלות)
const HIT_PLANE = 0.55;   // מרחק נקודת החבטה מהגוף (מטר)
const BALL_R = 0.045;     // רדיוס תצוגה של הכדור (מוגדל מעט לנראות)
const ARC = 0.5;          // גובה קשת המעוף (מטר)
const PITCH_MIN = -15, PITCH_MAX = 45;

export const LEVELS = {
  easy:   { hitRadius: 20, window: [0.55, 1.28], speedMul: 0.8, botMiss: 0.04 },
  normal: { hitRadius: 15, window: [0.65, 1.2],  speedMul: 1.0, botMiss: 0.08 },
  hard:   { hitRadius: 11, window: [0.75, 1.12], speedMul: 1.25, botMiss: 0.14 },
};

const REASONS = {
  miss: 'לא פגעת בכדור במיקומו',
  late: 'הכדור עבר אותך',
  early: 'חבטת מוקדם מדי',
  out: 'החבטה יצאה מחוץ לתחום',
};

export class Game {
  static newState(settings, server) {
    const n = settings.balls;
    return { balls: { A: n, B: n }, server, rally: 0, best: 0, hits: { A: 0, B: 0 } };
  }

  constructor({ canvas, hud, net, me, solo, dist, settings, onOver }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hud = hud;
    this.net = net;
    this.me = me;
    this.other = me === 'A' ? 'B' : 'A';
    this.solo = solo;
    this.dist = clamp(dist || 2.5, 1, 6);
    this.settings = settings;
    this.level = LEVELS[settings.level] || LEVELS.normal;
    this.onOver = onOver;
    this.phase = 'idle';
    this.ball = null;
    this.S = null;
    this.timers = [];
    this.alive = true;

    Sensors.onSwing = (s) => this.onSwing(s);
    this._rs = () => this.resize();
    window.addEventListener('resize', this._rs);
    this._pd = () => { if (!Sensors.hasMotion) Sensors.fakeSwing(); };
    window.addEventListener('pointerdown', this._pd);
    this.resize();
    this._loop = () => this.frame();
    requestAnimationFrame(this._loop);

    hud.meName.textContent = 'אתה';
    hud.oppName.textContent = solo ? 'מחשב' : 'שותף';
  }

  destroy() {
    this.alive = false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    Sensors.onSwing = null;
    window.removeEventListener('resize', this._rs);
    window.removeEventListener('pointerdown', this._pd);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  later(fn, ms) {
    const id = setTimeout(() => { if (this.alive) fn(); }, ms);
    this.timers.push(id);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = innerWidth; this.H = innerHeight;
    this.canvas.width = this.W * dpr; this.canvas.height = this.H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  handles(t) { return t === 'ball' || t === 'fault'; }

  send(m) { if (!this.solo && this.net) this.net.send(m); }

  // ---------- זרימת המשחק ----------
  begin(S) {
    this.S = S;
    this.updateHUD();
    const starter = S.server === this.me ? 'אתה מתחיל!' : (this.solo ? 'המחשב מתחיל' : 'השותף מתחיל');
    this.say(starter, `לכל שחקן ${S.balls.A} כדורים`);
    this.later(() => this.enterServe(), 1800);
  }

  enterServe() {
    this.ball = null;
    if (this.S.server === this.me) {
      this.phase = 'serve';
      Sfx.serve();
      this.say('תורך להגיש', 'כוון לשותף ובצע תנועת חבטה');
    } else {
      this.phase = 'waitServe';
      this.say(this.solo ? 'המחשב מגיש…' : 'השותף מגיש…', 'התכונן לקבל את הכדור');
      if (this.solo) this.later(() => this.botHit(true), 1500);
    }
  }

  onSwing({ power, aim, t }) {
    if (!this.alive) return;
    if (this.phase === 'serve') {
      this.hitBall({ yaw: aim.yaw, pitch: aim.pitch + LIFT }, power);
      return;
    }
    if (this.phase !== 'incoming' || !this.ball) return;
    const b = this.ball;
    const p = (t - b.t0) / b.T;
    const [w0, w1] = this.level.window;
    if (p < w0 - 0.12) return;                 // חבטה מוקדמת מאוד – כנראה תנועה מקרית
    if (p < w0) { this.fault(this.me, 'early'); return; }
    if (p > w1) return;                         // מאוחר – יטופל כפסילה בהמשך
    const pos = this.inPos(b, Math.min(p, 1.05));
    const dy = wrap180(aim.yaw - pos.yaw), dp = aim.pitch - pos.pitch;
    const err = Math.hypot(dy, dp);
    if (err > this.level.hitRadius) { this.fault(this.me, 'miss'); return; }
    // כיוון ההחזרה תלוי בדיוק הפגיעה ובתזמון
    const timing = (p - 0.95) * 30;
    this.hitBall({ yaw: dy * 1.8 + timing + rand(-2, 2), pitch: dp * 1.4 + LIFT + rand(-2, 2) }, power);
  }

  hitBall(dir, power) {
    Sfx.hit();
    const bounds = this.settings.bounds;
    if (Math.abs(dir.yaw) > bounds || dir.pitch < PITCH_MIN || dir.pitch > PITCH_MAX) {
      this.ball = { kind: 'out', t0: performance.now(), T: 900, yaw: clamp(dir.yaw, -70, 70), pitch: dir.pitch, wild: true };
      this.fault(this.me, 'out');
      return;
    }
    const speed = clamp(5 + (power - this.settings.sens) * 0.45, 5, 18) * this.level.speedMul;
    const T = clamp(0.5 + (this.dist / speed) * 1.6, 0.9, 2.8);
    this.S.rally += 1;
    this.S.hits[this.me] += 1;
    this.ball = { kind: 'out', t0: performance.now(), T: T * 1000, yaw: dir.yaw, pitch: dir.pitch, speed };
    this.phase = 'outgoing';
    this.updateHUD();
    this.say('', '');
    this.send({ t: 'ball', yaw: dir.yaw, pitch: dir.pitch, T, speed, rally: this.S.rally });
    if (this.solo) this.later(() => this.botReceive(speed), T * 1000);
  }

  receiveBall(m) {
    this.S.rally = m.rally;
    this.ball = {
      kind: 'in', t0: performance.now(), T: m.T * 1000,   // T נשלח בשניות; בכדור נשמר במילישניות
      ty: clamp(-m.yaw * 0.9, -40, 40),               // תמונת מראה: ימינה אצלו = שמאלה אצלי
      tp: clamp((m.pitch - LIFT) * 0.8, -25, 30),
    };
    this.phase = 'incoming';
    this.updateHUD();
    this.say('', '');
    Sfx.incoming();
  }

  onNet(m) {
    if (!this.alive || !this.S) return;
    if (m.t === 'ball') this.receiveBall(m);
    else if (m.t === 'fault') this.applyFault(m.S, m.who, m.reason);
  }

  fault(who, reason) {
    if (this.phase === 'fault' || this.phase === 'over') return;
    const S = JSON.parse(JSON.stringify(this.S));
    S.balls[who] = Math.max(0, S.balls[who] - 1);
    S.best = Math.max(S.best, S.rally);
    S.rally = 0;
    S.server = who;                 // מי שנפסל מרים כדור חדש ומגיש
    this.send({ t: 'fault', who, reason, S });
    this.applyFault(S, who, reason);
  }

  applyFault(S, who, reason) {
    this.S = S;
    this.phase = 'fault';
    if (this.ball && !this.ball.wild) this.ball = null;
    Sfx.fault();
    const mine = who === this.me;
    const name = this.solo ? 'המחשב' : 'השותף';
    const why = mine ? REASONS[reason] : (reason === 'out' ? 'החבטה שלו יצאה מהתחום' : 'הוא לא פגע בכדור');
    this.say(mine ? 'פסילה!' : `${name} נפסל!`, why || '', true);
    this.updateHUD();
    if (S.balls[who] <= 0) {
      this.later(() => this.finish(), 2400);
    } else {
      this.later(() => { this.say('כדור חדש!', `נשארו ${S.balls[who]} כדורים ל${mine ? 'ך' : name}`); }, 1600);
      this.later(() => this.enterServe(), 3000);
    }
  }

  finish() {
    this.phase = 'over';
    this.ball = null;
    const winner = this.S.balls.A <= 0 ? 'B' : 'A';
    if (winner === this.me) Sfx.win();
    this.onOver({ S: this.S, winner, me: this.me });
  }

  // ---------- יריב ממוחשב (מצב שחקן יחיד) ----------
  botReceive(speed) {
    if (this.phase !== 'outgoing' && this.phase !== 'waitReturn') return;
    const miss = this.level.botMiss + (speed > 14 ? 0.2 : 0) + this.S.rally * 0.008;
    if (Math.random() < miss) { this.fault('B', 'miss'); return; }
    this.later(() => this.botHit(false), 150);
  }

  botHit(isServe) {
    if (!isServe && this.phase !== 'outgoing' && this.phase !== 'waitReturn') return;
    const spread = this.settings.bounds * 0.75;
    const pace = this.level.speedMul * (1 + Math.min(this.S.rally, 20) * 0.02);
    this.S.rally += 1;
    this.S.hits.B += 1;
    this.receiveBall({
      yaw: rand(-spread, spread),
      pitch: LIFT + rand(-8, 14),
      T: clamp(rand(1.5, 2.3) / pace, 0.9, 2.6),
      rally: this.S.rally,
    });
  }

  // ---------- גיאומטריה ----------
  // מסלול הכדור המתקרב, במערכת הצירים של השחקן המקבל (x ימינה, y קדימה, z למעלה)
  inPos(b, p) {
    const D = this.dist;
    const xe = HIT_PLANE * Math.tan(b.ty * D2R), ze = HIT_PLANE * Math.tan(b.tp * D2R);
    const x = xe * p;
    const y = Math.max(0.08, D + (HIT_PLANE - D) * p);
    const z = ze * p + ARC * 4 * p * Math.max(0, 1 - p);
    return { yaw: Math.atan2(x, y) * R2D, pitch: Math.atan2(z, y) * R2D, d: Math.hypot(x, y, z) };
  }

  // מסלול הכדור המתרחק (קוסמטי – מראה את הכדור עף לעבר השותף)
  outPos(b, p) {
    const D = b.wild ? this.dist * 2 : this.dist - HIT_PLANE;
    const x0 = HIT_PLANE * Math.tan(b.yaw * D2R), z0 = HIT_PLANE * Math.tan((b.pitch - LIFT) * D2R);
    const xe = b.wild ? D * Math.tan(b.yaw * D2R) : HIT_PLANE * Math.tan(b.yaw * 0.9 * D2R);
    const ze = b.wild ? D * Math.tan((b.pitch - LIFT) * D2R) : 0;
    const x = x0 + (xe - x0) * p;
    const y = HIT_PLANE + (D - HIT_PLANE) * p;
    const z = z0 + (ze - z0) * p + ARC * 4 * p * (1 - p);
    return { yaw: Math.atan2(x, y) * R2D, pitch: Math.atan2(z, y) * R2D, d: Math.hypot(x, y, z) };
  }

  // ---------- תצוגה ----------
  frame() {
    if (!this.alive) return;
    requestAnimationFrame(this._loop);
    const now = performance.now();
    const b = this.ball;
    if (b) {
      const p = (now - b.t0) / b.T;
      if (b.kind === 'in' && this.phase === 'incoming' && p > this.level.window[1] + 0.05) this.fault(this.me, 'late');
      else if (b.kind === 'out' && p >= 1) {
        this.ball = null;
        if (this.phase === 'outgoing') this.phase = 'waitReturn';
      }
    }
    this.draw(now);
  }

  draw(now) {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);
    const aim = Sensors.aim();
    const ppd = Camera.pxPerDeg(W, H);
    const proj = (yaw, pitch) => ({ x: W / 2 + wrap180(yaw - aim.yaw) * ppd, y: H / 2 - (pitch - aim.pitch) * ppd });
    const radius = (d) => Math.max(3, Math.atan(BALL_R / d) * R2D * ppd);
    const b = this.ball;

    let hot = false;
    if (b && b.kind === 'in') {
      const p = (now - b.t0) / b.T;
      const pos = this.inPos(b, Math.min(p, 1.05));
      const err = Math.hypot(wrap180(aim.yaw - pos.yaw), aim.pitch - pos.pitch);
      hot = p > this.level.window[0] - 0.1 && err < this.level.hitRadius;
    }
    this.drawRacket(W / 2, H / 2, this.level.hitRadius * ppd, hot);

    if (this.phase === 'serve') {
      const bob = Math.sin(now / 280) * 5;
      this.drawBall(W / 2, H / 2 + bob, radius(HIT_PLANE));
    }

    if (b && b.kind === 'in') {
      const p = (now - b.t0) / b.T;
      if (p > 0.3 && p < 1) {   // סימון נקודת ההגעה הצפויה
        const end = this.inPos(b, 1), e = proj(end.yaw, end.pitch);
        ctx.save();
        ctx.globalAlpha = 0.25 + 0.4 * p;
        ctx.strokeStyle = '#ffd23f'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(e.x, e.y, radius(HIT_PLANE), 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      const pos = this.inPos(b, p), s = proj(pos.yaw, pos.pitch), r = radius(pos.d);
      if (s.x > -r && s.x < W + r && s.y > -r && s.y < H + r) {
        this.drawBall(s.x, s.y, r);
        if (p > 0.4 && p < 1) {   // טבעת תזמון שמתכווצת אל הכדור
          ctx.save();
          ctx.strokeStyle = '#ffffffcc'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(s.x, s.y, r + (1 - p) * 120, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
      } else {
        this.drawArrow(s.x, s.y);
      }
    }

    if (b && b.kind === 'out') {
      const p = Math.min(1, (now - b.t0) / b.T);
      const pos = this.outPos(b, p), s = proj(pos.yaw, pos.pitch);
      this.drawBall(s.x, s.y, radius(pos.d));
    }
  }

  drawRacket(x, y, r, hot) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 4;
    ctx.strokeStyle = hot ? '#3dff7a' : '#ffffff88';
    ctx.fillStyle = hot ? '#3dff7a22' : '#ffffff10';
    ctx.beginPath(); ctx.ellipse(x, y, r * 0.85, r, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + r); ctx.lineTo(x, y + r * 1.6); ctx.lineWidth = 10; ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke();
    ctx.restore();
  }

  drawBall(x, y, r) {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = Math.max(8, r);
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, '#fffbe0'); g.addColorStop(0.45, '#ffd23f'); g.addColorStop(1, '#e07b00');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  drawArrow(tx, ty) {
    const { ctx, W, H } = this;
    const cx = W / 2, cy = H / 2, m = 40;
    const ang = Math.atan2(ty - cy, tx - cx);
    const k = Math.min(Math.abs((W / 2 - m) / Math.cos(ang)), Math.abs((H / 2 - m) / Math.sin(ang)));
    const x = cx + Math.cos(ang) * k, y = cy + Math.sin(ang) * k;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = '#ffd23f'; ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(22, 0); ctx.lineTo(-12, -16); ctx.lineTo(-12, 16); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  say(text, sub = '', flash = false) {
    this.hud.msg.textContent = text;
    this.hud.sub.textContent = sub;
    if (flash) {
      this.hud.msg.classList.remove('flash');
      void this.hud.msg.offsetWidth;
      this.hud.msg.classList.add('flash');
    }
  }

  updateHUD() {
    const S = this.S; if (!S) return;
    this.hud.me.textContent = S.balls[this.me];
    this.hud.opp.textContent = S.balls[this.other];
    this.hud.rally.textContent = S.rally;
    this.hud.best.textContent = 'שיא ' + Math.max(S.best, S.rally);
  }
}
