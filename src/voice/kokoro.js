'use strict';
/*
 * Kokoro: a voice that sounds like a person, made on this computer.
 *
 * Kokoro-82M (Apache-2.0), run by sherpa-onnx - both here, no account, no
 * internet. The model is loaded once, in the background, and kept; each line
 * is made on the engine's own threads, so Nim never waits on it to do anything
 * else. The window asks for a reply a sentence at a time, so the first
 * sentence plays while the next is being made.
 *
 * The model lives in voices/kokoro/<model>/. If it is not there, or the engine
 * will not load, Nim speaks with Piper as before (main.js).
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DIR = path.join(__dirname, '..', '..', 'voices', 'kokoro');

/* The models Nim knows, best first, and the English voices in each - by the
 * speaker number sherpa-onnx gives them. */
const MODELS = [
  {
    folder: 'kokoro-multi-lang-v1_0', file: 'model.onnx',
    voices: {
      af_heart: 3, af_bella: 2, af_nicole: 6, af_aoede: 1, af_kore: 5, af_sarah: 9, af_nova: 7, af_sky: 10,
      af_alloy: 0, af_jessica: 4, af_river: 8,
      am_michael: 16, am_fenrir: 14, am_puck: 18, am_echo: 12, am_eric: 13, am_liam: 15, am_onyx: 17, am_adam: 11,
      bf_emma: 21, bf_isabella: 22, bf_alice: 20, bf_lily: 23,
      bm_george: 26, bm_fable: 25, bm_lewis: 27, bm_daniel: 24
    }
  },
  {
    folder: 'kokoro-int8-multi-lang-v1_1', file: 'model.int8.onnx',
    voices: { af_maple: 0, af_sol: 1, bf_vale: 2 }
  }
];
const DEFAULT_VOICE = 'af_heart';

function model() {
  for (const m of MODELS) {
    const dir = path.join(DIR, m.folder);
    if (fs.existsSync(path.join(dir, m.file)) && fs.existsSync(path.join(dir, 'voices.bin'))) return Object.assign({ dir }, m);
  }
  return null;
}

let sherpa = null;
function engineLib() {
  if (sherpa === null) {
    try { sherpa = require('sherpa-onnx-node'); } catch { sherpa = false; }
  }
  return sherpa || null;
}

function available() { return !!(model() && engineLib()); }

/* "af_heart" -> { name: 'Heart', full: 'American, female' }. */
function describe(id) {
  const [kind, name] = String(id).split('_');
  const accent = kind[0] === 'b' ? 'British' : 'American';
  const who = kind[1] === 'm' ? 'male' : 'female';
  return { name: name.charAt(0).toUpperCase() + name.slice(1), full: accent + ', ' + who };
}

/** The voices there are, the best first. */
function list() {
  const m = model();
  if (!m) return [];
  return Object.keys(m.voices).map((id) => Object.assign({ id, engine: 'kokoro' }, describe(id)));
}

let tts = null, loading = null;
/** Load the model (once). Resolves to the engine, or null if it cannot. */
function load() {
  if (tts) return Promise.resolve(tts);
  if (loading) return loading;
  const m = model(), lib = engineLib();
  if (!m || !lib) return Promise.resolve(null);
  const lexicons = ['lexicon-us-en.txt', 'lexicon-zh.txt'].map((f) => path.join(m.dir, f)).filter((f) => fs.existsSync(f));
  const t0 = Date.now();
  loading = lib.OfflineTts.createAsync({
    model: {
      kokoro: {
        model: path.join(m.dir, m.file),
        voices: path.join(m.dir, 'voices.bin'),
        tokens: path.join(m.dir, 'tokens.txt'),
        dataDir: path.join(m.dir, 'espeak-ng-data'),
        lexicon: lexicons.join(','),
        lang: 'en-us'
      },
      // all but one core: the voice is made in a moment, and the rest of the PC keeps one
      numThreads: Math.max(2, Math.min(8, os.cpus().length - 1)),
      provider: 'cpu',
      debug: false
    },
    maxNumSentences: 1
  }).then((engine) => {
    tts = engine;
    console.log('[nim] kokoro voice: ready (' + m.folder + ', ' + (Date.now() - t0) + 'ms)');
    return tts;
  }).catch((err) => {
    console.log('[nim] kokoro voice could not load: ' + err.message);
    return null;
  }).finally(() => { loading = null; });
  return loading;
}

/* 24 kHz float samples -> a 16-bit mono WAV the window can play. */
function wav(samples, rate) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

/* One line at a time: the engine is not asked for two at once. */
let chain = Promise.resolve();

/** WAV bytes for this text, in this voice, at this speed. Rejects if it cannot. */
function speak(text, voiceId, rate) {
  const job = chain.then(async () => {
    const engine = await load();
    if (!engine) throw new Error('the Kokoro voice is not available');
    const m = model();
    const sid = m.voices[voiceId] !== undefined ? m.voices[voiceId] : (m.voices[DEFAULT_VOICE] !== undefined ? m.voices[DEFAULT_VOICE] : 0);
    const speed = Number.isFinite(Number(rate)) ? Math.min(1.35, Math.max(0.75, Number(rate))) : 1;
    // enableExternalBuffer off: Electron does not let a native module hand back
    // memory it owns itself ("TTS settlement failed"); the samples are copied
    const audio = await engine.generateAsync({ text: String(text).slice(0, 600), sid, speed, enableExternalBuffer: false });
    if (!audio || !audio.samples || !audio.samples.length) throw new Error('no sound came back');
    return wav(audio.samples, audio.sampleRate);
  });
  chain = job.catch(() => {});
  return job;
}

module.exports = { available, list, load, speak, model, DEFAULT_VOICE, wav };
