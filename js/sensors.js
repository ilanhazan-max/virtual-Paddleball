// חיישני תנועה: כיוון המצלמה האחורית (יאו/פיץ') וזיהוי תנועת חבטה.
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const wrap180 = (a) => ((a % 360) + 540) % 360 - 180;

export const Sensors = {
  heading: 0, elev: 0,          // כיוון המצלמה האחורית בעולם (מעלות)
  refHeading: 0, refElev: 0,    // כיוון הייחוס – לעבר השחקן השני (נקבע בכיול)
  hasOrientation: false,
  hasMotion: false,
  swingThreshold: 14,           // סף עוצמה לזיהוי חבטה
  onSwing: null,
  history: [],                  // [{t, yaw, pitch}] – לשליפת הכיוון רגע לפני החבטה
  mouse: { yaw: 0, pitch: 0 },  // מצב מחשב שולחני (ללא חיישנים)
  refMouse: { yaw: 0, pitch: 0 },
  _swing: null,
  _lastSwing: 0,
  _started: false,

  async requestPermission() {
    const results = [];
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission)
        results.push(await DeviceOrientationEvent.requestPermission());
    } catch (e) { console.warn(e); }
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission)
        results.push(await DeviceMotionEvent.requestPermission());
    } catch (e) { console.warn(e); }
    return !results.includes('denied');
  },

  start() {
    if (this._started) return;
    this._started = true;
    window.addEventListener('deviceorientation', (e) => this._onOrientation(e));
    window.addEventListener('devicemotion', (e) => this._onMotion(e));
    // גיבוי למחשב: העכבר מזיז את "המבט", רווח/קליק = חבטה
    window.addEventListener('pointermove', (e) => {
      if (this.hasOrientation) return;
      const W = innerWidth, H = innerHeight;
      this.mouse.yaw = ((e.clientX - W / 2) / W) * 50;
      this.mouse.pitch = (-(e.clientY - H / 2) / W) * 50;
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); this.fakeSwing(); }
    });
  },

  fakeSwing(power = 22) { this._emitSwing(power, performance.now()); },

  // וקטור הכיוון של המצלמה האחורית (‎-Z של המכשיר) במערכת העולם,
  // לפי סדר הסיבובים של W3C: ‏Rz(alpha)·Rx(beta)·Ry(gamma). עמיד גם כשהטלפון זקוף.
  _onOrientation(e) {
    if (e.alpha == null || e.beta == null) return;
    this.hasOrientation = true;
    const a = e.alpha * D2R, b = e.beta * D2R, g = (e.gamma || 0) * D2R;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    const x = -ca * sg - sa * sb * cg;   // מזרח
    const y = -sa * sg + ca * sb * cg;   // צפון
    const z = -cb * cg;                  // מעלה
    const heading = Math.atan2(x, y) * R2D;
    const elev = Math.asin(Math.max(-1, Math.min(1, z))) * R2D;
    // החלקה עדינה (עם טיפול בגלישה של 360°)
    this.heading = wrap180(this.heading + wrap180(heading - this.heading) * 0.6);
    this.elev = this.elev + (elev - this.elev) * 0.6;
    const now = performance.now();
    const aim = this.aim();
    this.history.push({ t: now, yaw: aim.yaw, pitch: aim.pitch });
    while (this.history.length && now - this.history[0].t > 1000) this.history.shift();
  },

  _onMotion(e) {
    const now = performance.now();
    let acc = 0;
    const a = e.acceleration;
    if (a && a.x != null) acc = Math.hypot(a.x, a.y, a.z);
    else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null) {
      const g = e.accelerationIncludingGravity;
      acc = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
    } else return;
    this.hasMotion = true;
    let rot = 0;
    const r = e.rotationRate;
    if (r && r.alpha != null) rot = Math.hypot(r.alpha, r.beta, r.gamma);
    const score = Math.max(acc, rot / 25);

    if (this._swing) {
      this._swing.peak = Math.max(this._swing.peak, score);
      if (now - this._swing.t0 > 120) {
        const s = this._swing; this._swing = null;
        this._emitSwing(s.peak, s.t0);
      }
    } else if (score > this.swingThreshold && now - this._lastSwing > 650) {
      this._swing = { t0: now, peak: score };
    }
  },

  _emitSwing(power, t0) {
    this._lastSwing = performance.now();
    const aim = this.aimAt(t0 - 100); // הכיוון רגע לפני תחילת התנועה
    if (this.onSwing) this.onSwing({ power, aim, t: t0 });
  },

  calibrate() {
    this.refHeading = this.heading;
    this.refElev = this.elev;
    this.refMouse = { ...this.mouse };
    this.history = [];
  },

  // כיוון נוכחי ביחס לשחקן השני: yaw חיובי = ימינה, pitch חיובי = למעלה
  aim() {
    if (!this.hasOrientation) return { yaw: this.mouse.yaw - this.refMouse.yaw, pitch: this.mouse.pitch - this.refMouse.pitch };
    return { yaw: wrap180(this.heading - this.refHeading), pitch: this.elev - this.refElev };
  },

  aimAt(t) {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].t <= t) return { yaw: this.history[i].yaw, pitch: this.history[i].pitch };
    }
    return this.aim();
  },
};
