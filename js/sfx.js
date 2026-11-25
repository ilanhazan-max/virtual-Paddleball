// צלילים קצרים עם WebAudio ורטט
export const Sfx = {
  ctx: null,
  init() {
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* */ }
  },
  tone(freq, dur, type = 'sine', vol = 0.3, slide = 0) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  },
  hit() { this.tone(950, 0.07, 'triangle', 0.6, -300); vibrate(40); },
  incoming() { this.tone(500, 0.05, 'sine', 0.15); },
  fault() { this.tone(220, 0.45, 'sawtooth', 0.25, -150); vibrate([120, 60, 120]); },
  serve() { this.tone(660, 0.08, 'sine', 0.25); },
  win() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.18, 'triangle', 0.3), i * 140)); },
};

export function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch { /* */ } }
