// מצלמה אחורית + זיהוי השחקן השני (TensorFlow.js COCO‑SSD) והערכת מרחק.
const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const COCO_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';
const LONG_SIDE_FOV = 66;   // שדה ראייה משוער לאורך הצלע הארוכה של מצלמה ראשית בנייד (מעלות)
const PERSON_HEIGHT = 1.7;  // מטר
const PERSON_WIDTH = 0.45;  // רוחב כתפיים משוער, כשרואים רק חלק מהגוף

export const Camera = {
  video: null,
  stream: null,

  async start(video) {
    this.video = video;
    if (this.stream) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = this.stream;
      await video.play().catch(() => {});
      return true;
    } catch (e) {
      console.warn('camera', e);
      return false;
    }
  },

  ready() { return !!(this.video && this.video.readyState >= 2 && this.video.videoWidth > 0); },

  focalPx() {
    const v = this.video;
    return Math.max(v.videoWidth, v.videoHeight) / (2 * Math.tan((LONG_SIDE_FOV / 2) * Math.PI / 180));
  },

  // מיפוי מקואורדינטות הווידאו למסך (object-fit: cover)
  coverTransform(sw, sh) {
    const v = this.video;
    const s = Math.max(sw / v.videoWidth, sh / v.videoHeight);
    return { s, ox: (sw - v.videoWidth * s) / 2, oy: (sh - v.videoHeight * s) / 2 };
  },

  // כמה פיקסלי מסך מייצגת מעלה אחת – כדי שהכדור הווירטואלי "יישב" על התמונה האמיתית
  pxPerDeg(sw, sh) {
    if (!this.ready()) return sw / 50;
    const { s } = this.coverTransform(sw, sh);
    return this.focalPx() * s * Math.PI / 180;
  },
};

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
    document.head.appendChild(s);
  });
}

export const Vision = {
  model: null,
  _loading: null,

  load() {
    if (this.model) return Promise.resolve(this.model);
    if (!this._loading) {
      this._loading = (async () => {
        if (!window.tf) await loadScript(TF_URL);
        if (!window.cocoSsd) await loadScript(COCO_URL);
        this.model = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
        return this.model;
      })().catch((e) => { this._loading = null; throw e; });
    }
    return this._loading;
  },

  async detectPerson(video) {
    if (!this.model) return null;
    const preds = await this.model.detect(video, 6, 0.45);
    const people = preds.filter((p) => p.class === 'person')
      .sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3]);
    return people[0] || null;
  },

  // מרחק ≈ גובה אמיתי × מוקד / גובה בפיקסלים
  estimateDistance(bbox, video) {
    const f = Camera.focalPx();
    const [, y, w, h] = bbox;
    const vh = video.videoHeight, m = vh * 0.02;
    const fullBody = y > m && y + h < vh - m;
    return fullBody ? (PERSON_HEIGHT * f) / h : (PERSON_WIDTH * f) / w;
  },
};
