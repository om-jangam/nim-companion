'use strict';
/*
 * Nim's ears.
 *
 * Whisper, running on this machine. The renderer records you, resamples to the
 * 16 kHz mono WAV that Whisper wants, and hands the bytes here; this turns them
 * into text. No account, no internet, nothing leaves the computer.
 *
 * Whisper runs as a small server that Nim starts and owns. Loading the model is
 * most of the cost of a short transcription - starting whisper-cli for every
 * sentence spent most of each call reading the same 148 MB file - so the model
 * is loaded once and every request after that is only the actual listening.
 * The server listens on 127.0.0.1 only, on a port chosen at start-up, and it
 * stops when Nim does. If it cannot start, every request falls back to
 * whisper-cli, exactly as before.
 *
 * Requests go through one queue. Two transcriptions at once would fight over
 * the same cores and neither would arrive sooner, but a request must never be
 * refused because another is running: push-to-talk simply waits its turn, and
 * jumps ahead of wake-word checks that are still waiting.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'vendor', 'whisper', 'Release');
const CLI = path.join(BIN, 'whisper-cli.exe');
const SERVER = path.join(BIN, 'whisper-server.exe');
const MODEL_DIR = path.join(ROOT, 'models');

const THREADS = Math.min(8, Math.max(2, os.cpus().length - 1));
const STALE_MS = 12000;           // a wake check this old is about something long gone

function models() {
  try {
    return fs.readdirSync(MODEL_DIR).filter((f) => f.endsWith('.bin'));
  } catch {
    return [];
  }
}

/* Two models when both are there. The quick one (base) answers the many
 * "was that the name?" checks - background work that must stay light. The
 * accurate one (small) hears what you actually ask, where a wrong word costs
 * the whole request. With only one model, it does both. */
function modelPath(accurate) {
  const found = models();
  const want = accurate ? ['ggml-small.en.bin', 'ggml-base.en.bin'] : ['ggml-base.en.bin', 'ggml-small.en.bin'];
  const pick = want.find((m) => found.includes(m)) || found[0];
  return pick ? path.join(MODEL_DIR, pick) : null;
}

function available() {
  return fs.existsSync(CLI) && models().length > 0;
}

/* Whisper marks non-speech as bracketed tags; they are not words you said. */
function clean(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* The encoder normally looks at 30 seconds. A short clip padded to 30 seconds
 * is mostly silence, so for anything under ten seconds it is told to look at
 * ten - same words, under half the time. Longer recordings get the full view. */
function audioCtxFor(wav) {
  const seconds = Math.max(0, wav.length - 44) / 32000;
  return seconds <= 9.5 ? 512 : 0;
}

/* ---- the server ------------------------------------------------------------ */

const servers = new Map();  // model path -> { proc, port, base }
const starting = new Map(); // model path -> the promise of it starting
const failures = new Map(); // model path -> how often it would not start or died

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function reachable(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

/** Start the servers: the quick one first, then (in the background) the
 * accurate one. Resolves true once the quick one is answering. */
function start() {
  const quick = startFor(modelPath(false));
  quick.then(() => startFor(modelPath(true))).catch(() => {});
  return quick;
}

/** Start the server for one model. Resolves true once it is answering. */
function startFor(model) {
  if (!model) return Promise.resolve(false);
  if (servers.has(model)) return Promise.resolve(true);
  if (starting.has(model)) return starting.get(model);
  if (!fs.existsSync(SERVER) || (failures.get(model) || 0) >= 3) return Promise.resolve(false);
  const failed = () => failures.set(model, (failures.get(model) || 0) + 1);

  const p = (async () => {
    let port;
    try { port = await freePort(); } catch { return false; }

    // an empty folder to serve, so the server has no files of ours to hand out
    const pub = path.join(os.tmpdir(), 'nim-whisper-public');
    try { fs.mkdirSync(pub, { recursive: true }); } catch { /* it is only a mount point */ }

    const proc = spawn(SERVER, [
      '-m', model,
      '-t', String(THREADS),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--public', pub,
      '-nt'
    ], { cwd: BIN, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

    let tail = '';
    proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });

    const exited = new Promise((resolve) => proc.once('exit', () => resolve(true)));
    proc.once('error', () => { /* reported through exit below */ });

    // the model loads before the port opens, so an open port means ready
    for (let i = 0; i < 60; i++) {
      if (await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 250))])) break;
      if (await reachable(port)) {
        const entry = { proc, port, base: 'http://127.0.0.1:' + port, stopping: false };
        servers.set(model, entry);
        proc.once('exit', () => {
          if (servers.get(model) === entry) servers.delete(model);
          if (!entry.stopping) failed();          // put away on purpose is not a failure
        });
        if (model === modelPath(true) && model !== modelPath(false)) restAccurateLater();
        return true;
      }
    }
    failed();
    try { proc.kill(); } catch { /* already gone */ }
    console.log('[nim] whisper server (' + path.basename(model) + ') did not start; using whisper-cli.', tail.split('\n').slice(-3).join(' | '));
    return false;
  })().finally(() => { starting.delete(model); });
  starting.set(model, p);
  return p;
}

function stopOne(model) {
  const s = servers.get(model);
  servers.delete(model);
  if (s) s.stopping = true;
  if (s && s.proc) { try { s.proc.kill(); } catch { /* already gone */ } }
}

function stop() {
  clearTimeout(restTimer);
  for (const model of [...servers.keys()]) stopOne(model);
}

/* The accurate model holds about 600 MB. On a laptop short of memory it is
 * put away after a quarter of an hour unused, and brought back as soon as
 * anyone speaks again - the quick model answers while it loads. */
const REST_MS = 15 * 60000;
let restTimer = 0;
function restAccurateLater() {
  clearTimeout(restTimer);
  restTimer = setTimeout(() => {
    const model = modelPath(true);
    if (model !== modelPath(false) && servers.has(model)) stopOne(model);
  }, REST_MS);
  if (restTimer.unref) restTimer.unref();
}

async function viaServer(server, wav, opts) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('audio_ctx', String(audioCtxFor(wav)));
  if (opts.prompt) form.append('prompt', String(opts.prompt));
  // when unsure, Whisper decodes the same audio again and again at rising
  // temperature - seconds of retries for a word or two; a quick check takes
  // its first answer instead
  if (opts.fast) form.append('temperature_inc', '0');
  const res = await fetch(server.base + '/inference', {
    method: 'POST', body: form, signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error('whisper server returned ' + res.status);
  const body = await res.json();
  if (body && body.error) throw new Error('whisper server: ' + body.error);
  return clean(body && body.text);
}

/* ---- the command-line fallback --------------------------------------------- */

function viaCli(wav, opts) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CLI)) return reject(new Error('whisper is not installed'));
    const model = modelPath(!!opts.accurate);
    if (!model) return reject(new Error('no model in models/'));

    const file = path.join(os.tmpdir(), 'nim-hear-' + process.pid + '-' + Date.now() + '.wav');
    fs.writeFileSync(file, wav);

    // the recording is scratch: it goes whatever happens next
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      fs.unlink(file, () => { /* best effort */ });
    };

    // -nt drops timestamps, -np drops the progress chatter, so stdout is the words
    const proc = spawn(CLI, [
      '-m', model, '-f', file, '-nt', '-np', '-t', String(THREADS), '-ac', String(audioCtxFor(wav))
    ].concat(opts.prompt ? ['--prompt', String(opts.prompt)] : [], opts.fast ? ['-nf'] : []), { cwd: BIN, windowsHide: true });

    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (spawnErr) => { cleanup(); reject(spawnErr); });
    proc.on('close', (code) => {
      cleanup();
      if (code !== 0) return reject(new Error('whisper exited ' + code + ': ' + err.slice(-180)));
      resolve(clean(out));
    });
  });
}

/* ---- the queue --------------------------------------------------------------- */

const queue = [];
let busy = false;

function pump() {
  if (busy) return;
  // urgent requests first; within a priority, oldest first
  queue.sort((a, b) => (b.urgent - a.urgent) || (a.at - b.at));
  const job = queue.shift();
  if (!job) return;

  if (!job.urgent && Date.now() - job.at > STALE_MS) {
    job.resolve({ text: '', ms: 0, via: 'skipped', stale: true });
    pump();
    return;
  }

  busy = true;
  const t0 = Date.now();
  (async () => {
    const quick = modelPath(false), accurate = modelPath(true);
    const want = job.opts.accurate ? accurate : quick;
    // someone is talking: have the accurate model ready (it may have been put away)
    if (accurate !== quick && !servers.has(accurate) && !starting.has(accurate)) startFor(accurate).catch(() => {});
    if (want === accurate && servers.has(accurate)) restAccurateLater();
    // the accurate model still loading: the quick one now beats a wait
    const use = !servers.has(want) && starting.has(want) && servers.has(quick) ? quick : want;
    if (!servers.has(use) && fs.existsSync(SERVER)) await startFor(use);
    const server = servers.get(use);
    if (server) {
      try {
        return { text: await viaServer(server, job.wav, job.opts), via: 'server ' + path.basename(use, '.bin').replace(/^ggml-/, '') };
      } catch (err) {
        // a server that has stopped answering is replaced on the next request
        console.log('[nim] whisper server failed (' + err.message + '); falling back to whisper-cli');
        stopOne(use);
      }
    }
    return { text: await viaCli(job.wav, job.opts), via: 'cli' };
  })().then(
    (r) => job.resolve(Object.assign(r, { ms: Date.now() - t0, waited: t0 - job.at })),
    (err) => job.reject(err)
  ).finally(() => { busy = false; pump(); });
}

/**
 * wav: a Buffer of 16 kHz mono 16-bit WAV.
 * opts.prompt  words the audio is likely to contain. Whisper has never heard of
 *              "Nim", so without a hint it hears the nearest common word.
 * opts.urgent  someone is waiting on this one (push-to-talk, a command already
 *              addressed to Nim) - it goes ahead of background wake checks.
 * Resolves to { text, ms, waited, via }.
 */
function transcribeDetailed(wav, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    if (!available()) return reject(new Error('whisper is not installed'));
    queue.push({ wav, opts, urgent: opts.urgent ? 1 : 0, at: Date.now(), resolve, reject });
    // a backlog of wake checks is worth less than the newest ones
    const waiting = queue.filter((j) => !j.urgent);
    if (waiting.length > 4) {
      const drop = waiting[0];
      queue.splice(queue.indexOf(drop), 1);
      drop.resolve({ text: '', ms: 0, via: 'skipped', stale: true });
    }
    pump();
  });
}

/** The plain transcript, for callers that only want the words. */
async function transcribe(wav, opts) {
  return (await transcribeDetailed(wav, opts)).text;
}

function status() {
  const quick = servers.get(modelPath(false)), accurate = servers.get(modelPath(true));
  return {
    server: servers.size > 0, port: quick ? quick.port : accurate ? accurate.port : null,
    models: { quick: quick ? path.basename(modelPath(false)) : null, accurate: accurate ? path.basename(modelPath(true)) : null },
    queued: queue.length, busy
  };
}

module.exports = { available, models, transcribe, transcribeDetailed, start, stop, status, clean };
