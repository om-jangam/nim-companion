'use strict';
/*
 * "Hey Nim" against real audio and the real Whisper.
 *
 * Every recording in fixtures/wake goes through the exact decision the app
 * makes (wake.js decide(), with the priming from hearing.js), clean and with
 * room noise added. The recordings are synthesized voices - US and Indian
 * English - saying the phrases Nim is meant to answer to, and the phrases it
 * must never answer to: "Hey Neil...", "Okay, name the file...", "Honey...",
 * a YouTuber's "Hey guys...", "Ask Nim to...".
 *
 * Measured, not just asserted: the rates are printed, and the test fails if
 * anything wakes that should not, or if the wake rate falls below what it is
 * today (a regression).
 *
 * Needs Whisper (vendor/ and models/); skipped without it or with NIM_SKIP_LIVE=1.
 */
global.performance = global.performance || { now: () => Date.now() };
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const whisper = require('../src/voice/whisper');
const hearing = require('../src/voice/hearing');
const { createWake } = require('../src/desktop/wake.js');

const DIR = path.join(__dirname, 'fixtures', 'wake');
const EXPECT = {
  'hey-nim': '', 'nim-alone': '', 'hey-nim-time': 'what time is it', 'nim-youtube': 'open youtube',
  'hey-nim-volume-down': 'volume down', 'hey-nim-brave': 'open brave', 'hey-nim-screenshot': 'screenshot',
  'hey-nim-spotify': 'open spotify'
};

function read(file) {
  const wav = fs.readFileSync(file);
  const n = (wav.length - 44) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = wav.readInt16LE(44 + i * 2) / 32768;
  return out;
}
function encode(s) {
  const pcm = new Int16Array(s.length);
  for (let i = 0; i < s.length; i++) { const v = Math.max(-1, Math.min(1, s[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + pcm.length * 2, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(pcm.length * 2, 40); Buffer.from(pcm.buffer).copy(out, 44);
  return out;
}
let seed = 3;
function noisy(s) {
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = s[i] + ((seed / 0x7fffffff) * 2 - 1) * 0.02; }
  return out;
}
const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
function rightCommand(cmd, want) {
  if (want === '') return cmd === '';
  const w = words(want), c = words(cmd);
  return w.filter((x) => c.includes(x)).length / w.length >= 0.75;
}

(async () => {
  if (process.env.NIM_SKIP_LIVE === '1' || !whisper.available() || !fs.existsSync(DIR)) {
    h.skip('wake word on real audio', 'Whisper or the recordings are not here');
    return h.finish();
  }
  await whisper.start();
  const hear = async (samples, kind) => {
    const t0 = Date.now();
    const text = await whisper.transcribe(encode(samples), hearing.settingsFor(kind));
    return { text, ms: Date.now() - t0 };
  };

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.wav')).sort();
  const stats = { pos: 0, woke: 0, right: 0, neg: 0, falseWakes: 0, ms: 0, n: 0, byVoice: {} };
  const misses = [];
  for (const f of files) {
    const negative = f.startsWith('neg-');
    const [, voice, ...rest] = f.replace(/\.wav$/, '').split('-');
    const key = rest.join('-');
    const clean = read(path.join(DIR, f));
    for (const [cond, samples] of negative ? [['clean', clean]] : [['clean', clean], ['noise', noisy(clean)]]) {
      const r = await createWake.decide(samples, 16000, hear, { spoke: samples.length / 16 - 1150 });
      stats.ms += r.headMs; stats.n++;
      const v = stats.byVoice[voice] = stats.byVoice[voice] || { pos: 0, woke: 0, neg: 0, fw: 0 };
      if (negative) {
        stats.neg++; v.neg++;
        if (r.wake) { stats.falseWakes++; v.fw++; misses.push('FALSE WAKE ' + f + ': head ' + JSON.stringify(r.head) + ', full ' + JSON.stringify(r.full)); }
      } else {
        stats.pos++; v.pos++;
        if (!r.wake) { misses.push('missed ' + f + ' (' + cond + '): head ' + JSON.stringify(r.head) + (r.full ? ', full ' + JSON.stringify(r.full) : '')); continue; }
        stats.woke++; v.woke++;
        if (rightCommand(r.command, EXPECT[key])) stats.right++;
        else misses.push('misheard ' + f + ' (' + cond + '): ' + JSON.stringify(r.command));
      }
    }
  }
  whisper.stop();

  const pct = (a, b) => Math.round(100 * a / Math.max(1, b)) + '%';
  console.log('\n  wake: ' + stats.woke + '/' + stats.pos + ' (' + pct(stats.woke, stats.pos) + ')' +
              '   request heard right: ' + stats.right + '/' + stats.woke + ' (' + pct(stats.right, stats.woke) + ')' +
              '   false wakes: ' + stats.falseWakes + '/' + stats.neg +
              '   first pass: ' + Math.round(stats.ms / stats.n) + 'ms on average');
  for (const [v, s] of Object.entries(stats.byVoice)) {
    console.log('    ' + v.padEnd(6) + (s.pos ? ' woke ' + s.woke + '/' + s.pos : '') + (s.neg ? '   false wakes ' + s.fw + '/' + s.neg : ''));
  }
  misses.forEach((m) => console.log('    ' + m));

  h.section('results');
  h.check('nothing that should not wake Nim did', stats.falseWakes === 0, stats.falseWakes + ' false wakes');
  h.check('wakes on at least 80% of "Hey Nim" / "Nim" across voices, clean and noisy', stats.woke / stats.pos >= 0.8, pct(stats.woke, stats.pos));
  h.check('hears the request right at least 70% of the time once awake', stats.right / Math.max(1, stats.woke) >= 0.7, pct(stats.right, stats.woke));
  h.check('the first pass answers in under a second on average', stats.ms / stats.n < 1000, Math.round(stats.ms / stats.n) + 'ms');
  h.finish();
})().catch((e) => { console.error(e); whisper.stop(); process.exit(1); });
