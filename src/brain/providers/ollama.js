'use strict';
/*
 * A language model running on this machine, through Ollama.
 *
 * Free, offline, private. The plan schema is passed as Ollama's `format`, which
 * constrains decoding to that grammar - so the model cannot emit malformed JSON
 * or a tool name that does not exist, however small it is.
 *
 * The model is kept loaded for a while after each request, because loading it
 * into the GPU is most of the cost of the first answer.
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { staticPrompt, dynamicContext } = require('../prompt');
const { planSchema } = require('../schema');
const { noThinking } = require('../thinking');

const name = 'ollama';
const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5:3b';

let started = false;
let known = null, knownAt = 0;       // the last good answer, so a busy moment is not "not running"

/* A busy computer can take a few seconds to answer even a local request -
 * Whisper and a video can have every core - so this waits long enough that
 * "slow" is not mistaken for "not running". */
async function reachable(ms) {
  try {
    const res = await fetch(HOST + '/api/tags', { signal: AbortSignal.timeout(ms || 4000) });
    if (!res.ok) return null;
    known = await res.json();
    knownAt = Date.now();
    return known;
  } catch {
    return null;
  }
}

/* Ollama is often installed but not running. Start it if so - it is the
 * user's own local service. Asked again on every request rather than given up
 * on after one bad moment.
 *
 * Its own tray app is what gets started, as if you had opened it: it has no
 * console window. "ollama serve" is a console program, and Windows shows a
 * console for it however it is started detached - a black window flashing
 * open and shut at every boot, since Nim starts before Ollama does. It is
 * used only when the tray app is not installed, and then not detached, so
 * the window really stays hidden. */
const OLLAMA_APP = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe');
const OLLAMA_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');

/* Is the tray app already running? Starting it a second time does not start
 * a server - it only brings its window to the front, a window popping up every
 * time Nim starts. */
function trayRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ollama app.exe', '/NH', '/FO', 'CSV'],
      { windowsHide: true, encoding: 'utf8', timeout: 4000 });
    return /ollama app\.exe/i.test(out);
  } catch { return false; }
}

function startOllama() {
  try {
    if (process.platform === 'win32' && fs.existsSync(OLLAMA_APP) && !trayRunning()) {
      spawn(OLLAMA_APP, [], { detached: true, stdio: 'ignore' }).unref();
    } else serveDirectly();
  } catch { /* not installed: reported below */ }
}

/* The server itself, hidden - for when the tray app is running but its server
 * is not (it happens: the app stays in the tray after the server stops). Not
 * detached, so Windows keeps its console hidden. */
let served = null;
function serveDirectly() {
  if (served) return;
  clearOrphans();
  const exe = process.platform === 'win32' && fs.existsSync(OLLAMA_EXE) ? OLLAMA_EXE : 'ollama';
  try {
    served = spawn(exe, ['serve'], { stdio: 'ignore', windowsHide: true });
    served.on('error', () => { served = null; });
    served.on('exit', () => { served = null; });
  } catch { served = null; }
}

/* A server that stops leaves its model runner (llama-server) behind, still
 * holding the model in the GPU. A few of those and the GPU is full: the next
 * model cannot load ("out of memory") and everything slows down. Runners whose
 * server is gone are stopped before a new server starts. */
function clearOrphans() {
  if (process.platform !== 'win32') return;
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | " +
    "Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | " +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
  } catch { /* nothing to clear, or not allowed: the server will say if memory is short */ }
}

/* When Nim quits, the server it started goes too - with its runner, so the
 * model does not stay in the GPU with nobody to use it. */
function shutdown() {
  if (!served) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(served.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    else served.kill();
  } catch { /* already gone */ }
  served = null;
}

async function ensureServer() {
  if (await reachable()) return true;
  if (!started) {
    started = true;
    startOllama();
  }
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await reachable(3000)) return true;
    // the tray app is up but its server has not come: start the server itself
    if (i === 5) serveDirectly();
  }
  return false;
}

async function available(ctx) {
  const model = (ctx && ctx.brain && ctx.brain.ollamaModel) || DEFAULT_MODEL;
  // answered moments ago: no need to ask again before every request
  const tags = known && Date.now() - knownAt < 15000 ? known : ((await ensureServer()) ? known : null);
  return !!(tags && (tags.models || []).some((m) => m.name === model || m.model === model));
}

/* How much the model can read at once. The planner prompt is about 3,700
 * tokens, so 8192 leaves room; a bigger model on a small GPU can be given less
 * (config brain.ollamaContext) so that all of it fits on the GPU. */
function contextFor(ctx) {
  const n = Number(ctx && ctx.brain && ctx.brain.ollamaContext);
  return Number.isFinite(n) && n >= 4096 ? Math.min(32768, Math.round(n)) : 8192;
}

async function plan(text, ctx, opts) {
  const model = (ctx && ctx.brain && ctx.brain.ollamaModel) || DEFAULT_MODEL;
  const feedback = opts && opts.feedback ? '\n\n' + opts.feedback : '';
  const ask = () => fetch(HOST + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({
      model,
      stream: false,
      format: planSchema(),
      keep_alive: '20m',
      options: { temperature: 0, num_ctx: contextFor(ctx), num_predict: 600 },
      messages: [
        { role: 'system', content: staticPrompt() },
        { role: 'user', content: dynamicContext(ctx) + '\n\nUser: ' + text + feedback }
      ]
    }, noThinking(model))),
    signal: AbortSignal.timeout(90000)
  });
  let res = await ask();
  // a server error is often the model still loading, or the server it was
  // loading on just restarted: one more try, a moment later
  if (res.status >= 500) { await new Promise((r) => setTimeout(r, 2000)); res = await ask(); }
  if (!res.ok) throw new Error('ollama returned ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 200));
  const body = await res.json();
  const content = body && body.message && body.message.content;
  if (!content) throw new Error('ollama returned nothing');
  return JSON.parse(content);
}

/** Plain text out, for writing rather than planning. */
async function generate(instruction, input, ctx) {
  const model = (ctx && ctx.brain && ctx.brain.ollamaModel) || DEFAULT_MODEL;
  const res = await fetch(HOST + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({
      model,
      stream: false,
      keep_alive: '20m',
      options: { temperature: 0.4, num_ctx: contextFor(ctx), num_predict: 900 },
      messages: [
        { role: 'system', content: 'You write exactly what is asked, with no preamble and no closing remarks.' },
        { role: 'user', content: instruction + (input ? '\n\n---\n' + String(input).slice(0, 18000) : '') }
      ]
    }, noThinking(model))),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error('ollama returned ' + res.status);
  const body = await res.json();
  return String((body.message && body.message.content) || '').trim();
}

module.exports = { name, available, plan, generate, ensureServer, shutdown, DEFAULT_MODEL };
