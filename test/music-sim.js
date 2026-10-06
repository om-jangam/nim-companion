'use strict';
/*
 * Sound for the music tests, turned into what Nim's window sees: Chrome's
 * AnalyserNode (fftSize 1024, Blackman window, no smoothing) is reproduced
 * here frame by frame, then reduced to the same 24 bands as music.js.
 *
 *   synthSong   a made-up song at 48 kHz: kick, bass line, chords, hi-hats and
 *               a sung line that pauses between phrases, at a given tempo
 *   talkStream  real recorded speech (test/fixtures/wake) joined into one long
 *               continuous stretch of talking, with the room's own noise in
 *               the short pauses - as a video or a podcast sounds
 *   framesOf    sound -> [{ t, bands }] at a given frame rate
 */
const fs = require('fs');
const path = require('path');
const { bandsFrom } = require('../src/desktop/music.js');

const RATE = 48000;
const N = 1024;

function rng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const ar = re[i + k + h] * cr - im[i + k + h] * ci, ai = re[i + k + h] * ci + im[i + k + h] * cr;
        re[i + k + h] = re[i + k] - ar; im[i + k + h] = im[i + k] - ai;
        re[i + k] += ar; im[i + k] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function framesOf(samples, fps) {
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / N) + 0.08 * Math.cos(4 * Math.PI * i / N);
  const re = new Float64Array(N), im = new Float64Array(N), db = new Float32Array(N / 2);
  const frames = [];
  for (let t = 1000 / fps; ; t += 1000 / fps) {
    const end = Math.floor(t / 1000 * RATE);
    if (end > samples.length) break;
    for (let i = 0; i < N; i++) { const s = end - N + i; re[i] = (s >= 0 ? samples[s] : 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) db[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) / N + 1e-20);
    frames.push({ t, bands: bandsFrom(db, RATE, N) });
  }
  return frames;
}

/* A song. `drums: false` makes a mellow one: chords and voice only;
 * `snare: true` adds a snare between the kicks as loud as they are. */
function synthSong(bpm, seconds, opts) {
  const o = Object.assign({ drums: true, volume: 0.5, seed: 1 }, opts);
  const rnd = rng(o.seed);
  const x = new Float32Array(Math.floor(seconds * RATE));
  const beat = 60 / bpm;
  const roots = [110, 87.31, 130.81, 98];                       // A, F, C, G
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE;
    const b = t / beat, inBeat = (b % 1) * beat, bar = Math.floor(b / 4) % 4;
    const root = roots[bar];
    let v = 0;
    // chords, held through the bar
    for (const m of [2, 2.52, 3]) v += 0.05 * Math.sin(2 * Math.PI * root * m * t);
    // a sung line: phrases of two bars, a breath between them
    const phrase = (b % 8) / 8;
    if (phrase < 0.85) {
      const f0 = root * 4 * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * t)) * (Math.floor(b) % 3 === 0 ? 1.12 : 1);
      for (let h = 1; h <= 4; h++) v += 0.06 / h * Math.sin(2 * Math.PI * f0 * h * t);
    }
    if (o.drums) {
      // kick on every beat
      v += 0.6 * Math.exp(-inBeat / 0.09) * Math.sin(2 * Math.PI * (50 + 70 * Math.exp(-inBeat / 0.03)) * inBeat);
      // bass on the root, plucked each beat
      v += 0.15 * Math.exp(-inBeat / 0.35) * Math.sin(2 * Math.PI * root / 2 * t);
      // hi-hat on the off-beats
      const off = ((b + 0.5) % 1) * beat;
      v += 0.08 * Math.exp(-off / 0.02) * (rnd() * 2 - 1);
      // a snare as loud as the kick, between them: the beat could be either
      if (o.snare) v += 0.55 * Math.exp(-off / 0.06) * (rnd() * 2 - 1);
    }
    x[i] = v * o.volume;
  }
  return x;
}

function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, rate = 16000, ch = 1, data = null;
  while (p < b.length - 8) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(p + 10); rate = b.readUInt32LE(p + 12); }
    if (id === 'data') { data = b.subarray(p + 8, p + 8 + size); break; }
    p += 8 + size + (size & 1);
  }
  const n = Math.floor(data.length / 2 / ch), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2 * ch) / 32768;
  return { rate, samples: out };
}

/* The speech part of a recording, and how loud the room is without it. */
function trim(x, rate) {
  const step = Math.floor(rate / 50), rms = [];
  for (let i = 0; i + step <= x.length; i += step) {
    let e = 0;
    for (let k = i; k < i + step; k++) e += x[k] * x[k];
    rms.push(Math.sqrt(e / step));
  }
  const loud = Math.max(...rms), noise = rms.slice().sort((a, b) => a - b)[Math.floor(rms.length * 0.1)];
  let first = rms.findIndex((v) => v > loud / 30), last = rms.length - 1;
  while (last > 0 && rms[last] <= loud / 30) last--;
  return { speech: x.subarray(Math.max(0, first - 3) * step, Math.min(rms.length, last + 4) * step), noise };
}

const WAKE_DIR = path.join(__dirname, 'fixtures', 'wake');

function speechFiles() {
  if (!fs.existsSync(WAKE_DIR)) return [];
  return fs.readdirSync(WAKE_DIR).filter((f) => f.endsWith('.wav')).map((f) => path.join(WAKE_DIR, f));
}

function talkStream(seconds, seed, maxGap) {
  const files = speechFiles(), rnd = rng(seed), parts = [];
  let total = 0;
  while (total < seconds * RATE) {
    const w = readWav(files[Math.floor(rnd() * files.length)]);
    const { speech, noise } = trim(w.samples, w.rate);
    const k = RATE / w.rate, up = new Float32Array(Math.floor(speech.length * k));
    for (let i = 0; i < up.length; i++) {
      const at = i / k, f = Math.floor(at), fr = at - f;
      up[i] = 3 * ((speech[f] || 0) * (1 - fr) + (speech[f + 1] || 0) * fr);
    }
    const gap = new Float32Array(Math.floor((0.05 + rnd() * (maxGap || 0.3)) * RATE));
    for (let i = 0; i < gap.length; i++) gap[i] = 3 * (rnd() * 2 - 1) * noise * 1.7;
    parts.push(up, gap);
    total += up.length + gap.length;
  }
  const all = new Float32Array(total);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}

module.exports = { RATE, framesOf, synthSong, talkStream, speechFiles, rng };
