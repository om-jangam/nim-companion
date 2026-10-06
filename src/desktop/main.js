'use strict';
/*
 * Nim on the desktop.
 *
 * No frame, no panel, no dashboard - a transparent window holding the creature,
 * the Dots around it, and, when Nim has something to say, the floating surface
 * that grows out of the light above its head. It floats above every other app
 * and is click-through everywhere except what is drawn, so your clicks land on
 * whatever is underneath unless you are actually pointing at Nim.
 *
 * The window is deliberately non-focusable. That is what lets Nim press keys
 * into the app you are really working in: it never takes the keyboard from you.
 * The one exception is while you are typing to it.
 *
 * Everything Nim thinks with runs on this computer: its rules, Qwen through
 * Ollama, Whisper, Piper. Nothing here calls a paid service.
 */
const { app, BrowserWindow, ipcMain, screen, Menu, globalShortcut, session, Notification, powerMonitor, desktopCapturer } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const skills = require('../brain/skills');
const piper = require('../voice/piper');
const kokoro = require('../voice/kokoro');
const whisper = require('../voice/whisper');
const hearing = require('../voice/hearing');
const variants = require('../voice/variants');
const agent = require('../agent/runtime');
const brain = require('../brain');
const ollama = require('../brain/providers/ollama');
const bus = require('../core/bus');
const context = require('../agent/context');
const reminders = require('../agent/reminders');
const validator = require('../agent/validator');
const { createLife } = require('./life');
const settingsModel = require('./settings-model');
const { createAutomate } = require('./automate');
const automations = require('../life/automations');
const memory = require('../memory/store');
const bridge = require('../system/bridge');
const lyrics = require('../media/lyrics');
const mood = require('../media/mood');
const songcheck = require('../media/songcheck');
const music = require('./music');

/* Diagnostics: what each stage of hearing and doing decided, with timings.
 * Off by default because it includes what you said; NIM_DIAG=1 or
 * "diagnostics": true in config.json turns it on. */
let DIAG = process.env.NIM_DIAG === '1';
function diag(line) { if (DIAG) console.log('[diag]', line); }

/* What Nim reports about itself also goes to logs/nim.log, so a problem can be
 * looked at after the fact - which mind answered, which tool ran, whether the
 * microphone heard anything addressed to Nim. Never what you said: the lines
 * that carry words are diagnostics, and only exist while diagnostics are on.
 * Kept to a couple of megabytes; the previous one is kept as nim.log.1. */
const LOG_FILE = path.join(__dirname, '..', '..', 'logs', 'nim.log');
(function logToFile() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch { /* a log that cannot be kept is not worth failing over */ }
  const write = (args) => {
    try {
      const line = args.map((a) => (typeof a === 'string' ? a : (a && a.message) || JSON.stringify(a))).join(' ');
      const d = new Date();
      const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
                    ' ' + d.toTimeString().slice(0, 8);
      fs.appendFileSync(LOG_FILE, stamp + ' ' + line + '\n');
    } catch { /* see above */ }
  };
  const log = console.log.bind(console), error = console.error.bind(console);
  console.log = (...args) => { log(...args); write(args); };
  console.error = (...args) => { error(...args); write(['[error]'].concat(args)); };
}());

/* Every window that draws Nim gets every event and the same state. */
const surfaces = new Set();
function broadcast(event, state) {
  for (const w of surfaces) {
    if (w && !w.isDestroyed()) w.webContents.send('nim:state', { event, state });
  }
}
bus.on('event', broadcast);

// the runtime's own account of each step goes straight onto the bus
agent.on('event', (type, data) => {
  try { bus.publish(type, data); } catch { /* unknown: ignored */ }
  // a question is asked out loud too, short. For an everyday step (closing an
  // app) Nim then listens a few seconds for a plain "yes" or "no"; for a
  // high-risk one (shutting down, deleting) the answer still needs the name or
  // a click, so a "yes" from a video cannot give it. The runtime sets the risk.
  if (type === 'confirmation_required') {
    const q = data.question || 'Should I go ahead?';
    say(!/^(low|medium)$/.test(data.risk || '') ? q + ' Say "Hey Nim, confirm" or "Hey Nim, cancel".' : q + ' Yes or no?', 'waiting');
  }
});

/* After a finished or failed task, settle back to idle on its own - the
 * surface folds away unless something still needs you. Only from "done" or
 * "error": a new request that started in the meantime is left alone. */
let settleTimer = 0;
bus.on('event', (event) => {
  if (['task_completed', 'task_cancelled', 'error', 'response_completed'].includes(event.type)) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const s = bus.snapshot();
      if (['done', 'error'].includes(s.phase) && !agent.isBusy() && !s.confirm) bus.publish('idle');
    }, event.type === 'error' ? 6000 : 3500);
  }
});

/* Nim keeps a box of its own, always this size and always pinned to the
 * window's bottom-right corner. The window grows past it for the island, which
 * is why the creature never changes size or moves when the island opens. */
const NIM_BOX = { width: 320, height: 430 };
const COLLAPSED = { width: 320, height: 430 };
const EXPANDED = { width: 470, height: 600 };

/* How big Nim is drawn in its box, and where it stands in it. Main and the
 * renderer must agree on both, or the hit area drifts off the body. A small
 * Nim stands further into the corner. */
const SIZES = {
  normal: { scale: 1.1, anchor: { x: 0.5, y: 0.70 } },
  small: { scale: 0.72, anchor: { x: 0.66, y: 0.80 } }
};
let SCALE = SIZES.normal.scale;
let ANCHOR = SIZES.normal.anchor;
function applySize() {
  const z = SIZES[config.size] || SIZES.normal;
  SCALE = z.scale;
  ANCHOR = z.anchor;
}
const MARGIN = 24;                      // drifts off the body
const REST_MS = 450;                    // the cursor still on the body this long: Nim can be touched

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');
const DEFAULTS = {
  name: '', greetOnStart: true, voice: null, rate: 1, pitch: 1,
  outfit: { skin: 'aurora', hat: 'none', face: 'none', outfit: 'none', shoes: 'none' },
  voiceEngine: 'piper',
  piperVoice: null,
  wakeWord: true,         // "Hey Nim, open youtube" - see the Voice section of the README
  projects: {},           // name -> folder Nim may inspect, e.g. { "myapp": "D:/code/myapp" }
  // Nim thinks on this machine only: its rules, then Qwen through Ollama.
  brain: { ollamaModel: 'qwen2.5:3b' },
  danceToMusic: true,     // move to the beat while a song is playing
  lyrics: true,           // sing along: timed lyrics from lrclib.net (only the song's name, artist and length are sent)
  dailyBriefing: true,    // the first time at the PC in the morning: the day ahead
  healthBreaks: true,     // after an hour at it: rest your eyes, have some water
  pcHealth: true,         // battery low, processor flat out, memory or drive full
  clipboardHelper: true,  // copy a paragraph: summarize / translate / fix grammar
  hideWhenFullscreen: true, // games and films full-screen: out of the way
  city: '',               // for the weather (Open-Meteo; only the city name is sent)
  diagnostics: false
};

let win = null;
let ticker = null;
let drag = null;
let ignoring = true;
let expanded = false;
let config = DEFAULTS;
let voices = { list: [], current: null };
let settingsWin = null;

function loadConfig() {
  try {
    config = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    config = DEFAULTS;       // a missing or broken config should never stop it starting
  }
  // Nim no longer has a paid cloud mind; settings left over from when it did
  // are dropped rather than half-honoured
  const b = Object.assign({}, config.brain || {});
  delete b.order; delete b.claudeEffort; delete b.mode;
  config.brain = Object.assign({}, DEFAULTS.brain, b);
  if (!config.kokoroChosen && kokoro.available()) {
    config.kokoroChosen = true;
    config.voiceEngine = 'kokoro';
    config.kokoroVoice = config.kokoroVoice || kokoro.DEFAULT_VOICE;
    setTimeout(saveConfig, 0);
  }
  // the dressing room is gone: Nim keeps its colour and nothing else
  let skin = config.outfit && settingsModel.SKINS.includes(config.outfit.skin) ? config.outfit.skin : DEFAULTS.outfit.skin;
  // the new colours: once, everyone starts from Aurora (any other is a click away in Settings)
  if (!config.lookV2) { config.lookV2 = true; skin = 'aurora'; setTimeout(saveConfig, 0); }
  config.outfit = { skin, hat: 'none', face: 'none', outfit: 'none', shoes: 'none' };
  if (config.diagnostics === true) DIAG = true;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch { /* a read-only config is not worth crashing over */ }
}

/* Where you last put it, if most of it is still on a screen; otherwise the
 * bottom-right corner. */
function startPosition() {
  const p = config.position;
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
    const inside = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      const w = Math.min(p.x + COLLAPSED.width, a.x + a.width) - Math.max(p.x, a.x);
      const h = Math.min(p.y + COLLAPSED.height, a.y + a.height) - Math.max(p.y, a.y);
      return w > COLLAPSED.width * 0.6 && h > COLLAPSED.height * 0.6;
    });
    if (inside) return { x: Math.round(p.x), y: Math.round(p.y) };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - COLLAPSED.width - MARGIN, y: area.y + area.height - COLLAPSED.height - MARGIN };
}

function createWindow() {
  const at = startPosition();
  applySize();

  win = new BrowserWindow({
    width: COLLAPSED.width,
    height: COLLAPSED.height,
    x: at.x,
    y: at.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Nim's page is Nim's page: it never navigates anywhere or opens windows,
  // whatever a bug or a stray link might ask for
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 'screen-saver' is the level that stays above full-screen apps too
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'index.html'));
  surfaces.add(win);

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('agent:update', agent.snapshot());
    win.webContents.send('nim:state', { event: { type: 'sync' }, state: bus.snapshot() });
    if (config.greetOnStart) {
      win.webContents.send('nim:say', {
        text: skills.greeting(config.name) + ' I am here when you need me.',
        mood: 'happy'
      });
    }
  });

  const closing = win;
  win.on('closed', () => {
    surfaces.delete(closing);
    win = null;
    if (ticker) clearInterval(ticker);
    ticker = null;
  });
}

/* Only Nim's own window may ask for what follows. */
function fromNim(e) { return !!(win && !win.isDestroyed() && e && e.sender === win.webContents); }

/* The local systems Nim runs on - its mind, its ears - shown as ambient Dots.
 * Everything here is on this machine; there is no cloud mind to report. */
async function publishProviders() {
  const ctx = brainCtx();
  const qwen = await ollama.available(ctx).catch(() => false);
  const ears = whisper.status();
  bus.publish('provider_status', {
    qwen: qwen ? 'ready' : 'off',
    whisper: whisper.available() ? (ears.server ? 'ready' : 'slow') : 'off'
  });
}

/* ---- starting with Windows -------------------------------------------------- */

/* Unpackaged, the executable is Electron itself, and Electron started without
 * this app's folder opens its own demo window instead of Nim. That is exactly
 * what the first version of this setting registered - so the folder is always
 * passed, and the entry is named for what it starts. */
function loginItem() {
  return app.isPackaged ? { name: 'Nim' } : { name: 'Nim', path: process.execPath, args: [app.getAppPath()] };
}

function startsWithWindows() {
  try { return app.getLoginItemSettings(loginItem()).openAtLogin; } catch { return false; }
}

function setStartsWithWindows(on) {
  app.setLoginItemSettings(Object.assign({ openAtLogin: !!on }, loginItem()));
}

/* An entry that starts bare Electron with no app folder is the broken one
 * above. If you had switched it on, it is replaced with one that starts Nim. */
function repairLoginItem() {
  if (app.isPackaged) return;
  try {
    const items = app.getLoginItemSettings({ path: process.execPath, args: [] }).launchItems || [];
    const same = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(b).toLowerCase();
    const broken = items.filter((i) => same(i.path, process.execPath) && !(i.args || []).length);
    if (!broken.length) return;
    for (const i of broken) {
      app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: [], name: i.name });
    }
    setStartsWithWindows(true);
    console.log('[nim] repaired the start-with-Windows entry (it opened Electron instead of Nim)');
  } catch (err) {
    console.log('[nim] could not check the start-with-Windows entry:', err.message);
  }
}

/* The whole interaction model: find the cursor, decide whether it is over the
 * body, and turn click-through on or off to match. The window hears about the
 * cursor only when it has moved - sixty messages a second of nothing new is
 * work for nobody. */
let lastCursor = '';
function sendCursor(x, y, over, body, ghost) {
  const key = x + ',' + y + ',' + over + ',' + body + ',' + ghost;
  if (key === lastCursor) return;
  lastCursor = key;
  win.webContents.send('nim:cursor', { x, y, over, body, ghost });
}

/* Nim is in nobody's way. While you work, the cursor passes over it like it
 * was not there - it fades so you can see what is under it, and a click goes
 * through to that. Rest the cursor on it a moment and it is solid again: it
 * can be clicked, dragged and petted. Its cards, pills and music bar are
 * always solid. ("See-through while I work" in Settings switches this off.) */
let bodySolid = false, lastMoveAt = 0, lastPoint = { x: 0, y: 0 };

function track() {
  // it runs sixty times a second: one bad moment is logged and skipped, never
  // an error box on the screen
  let complained = false;
  ticker = setInterval(() => {
    try { trackTick(); } catch (err) {
      if (!complained) { complained = true; console.log('[nim] cursor tracking:', err.message); }
    }
  }, 16);
}

function trackTick() {
  {
    if (!win || win.isDestroyed()) return;

    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const now = Date.now();
    if (Math.abs(p.x - lastPoint.x) + Math.abs(p.y - lastPoint.y) > 3) { lastMoveAt = now; lastPoint = p; }

    if (drag) {
      // whole pixels only: with display scaling the cursor can come back in
      // fractions, and a fraction here is an uncaught error in the main process
      const x = Math.round(p.x - drag.dx), y = Math.round(p.y - drag.dy);
      if (Number.isFinite(x) && Number.isFinite(y)) win.setPosition(x, y);
      return;
    }

    const lx = p.x - b.x;
    const ly = p.y - b.y;

    // with the island open the whole window has to stay solid
    if (!expanded) {
      // Nim's box sits in the bottom-right corner whatever size the window is
      const boxX = b.width - NIM_BOX.width;
      const boxY = b.height - NIM_BOX.height;
      // one unit, exactly as nim.js computes it: the body's half-width
      const U = Math.min(NIM_BOX.width, NIM_BOX.height) * 0.24 * SCALE;
      const dx = (lx - (boxX + NIM_BOX.width * ANCHOR.x)) / (U * 1.18);
      const dy = (ly - (boxY + NIM_BOX.height * ANCHOR.y)) / (U * 1.15);
      const onBody = dx * dx + dy * dy <= 1;
      const onUi = hitboxes.some((h) => lx >= h.x && lx <= h.x + h.w && ly >= h.y && ly <= h.y + h.h);
      if (!onBody) bodySolid = false;
      else if (!bodySolid && (config.passThrough === false || now - lastMoveAt > REST_MS)) bodySolid = true;
      const over = onUi || (onBody && bodySolid);

      if (over === ignoring) {
        ignoring = !over;
        win.setIgnoreMouseEvents(ignoring, { forward: true });
      }
      sendCursor(lx, ly, over, onBody, onBody && !bodySolid && !onUi);
    } else {
      sendCursor(lx, ly, true, false, false);
    }
  }
}

/* ---- what the renderer can ask for --------------------------------------- */

ipcMain.handle('nim:config', (e) => (!fromNim(e) ? null : {
  scale: SCALE,
  anchor: ANCHOR,
  passThrough: config.passThrough !== false,
  name: config.name,
  voice: config.voice,
  rate: config.rate,
  pitch: config.pitch,
  outfit: config.outfit,
  voiceEngine: config.voiceEngine,
  piperVoice: config.piperVoice,
  wakeWord: config.wakeWord,
  wakeVariants: cleanVariants(config.wakeVariants),
  danceToMusic: config.danceToMusic !== false,
  followUp: config.followUp !== false,
  diagnostics: DIAG
}));

/* Extra spellings of "Hey Nim" for one person's voice - see variants.js. */
const cleanVariants = variants.clean;

/* New spellings learned from your voice, added to the ones already known. */
ipcMain.handle('nim:wake-variants', (e, list) => {
  if (!win || e.sender !== win.webContents) return { all: cleanVariants(config.wakeVariants), added: [] };
  const { all, added } = variants.merge(config.wakeVariants, list);
  config.wakeVariants = all;
  saveConfig();
  console.log('[nim] learned', added.length, 'new way(s) of saying my name');
  return { all: config.wakeVariants, added };
});

/* The surface takes the keyboard only while you are typing into it, and gives
 * it straight back - otherwise steps that press keys could not reach your work. */
ipcMain.on('nim:focus', (e, on) => {
  if (!win || e.sender !== win.webContents || expanded) return;
  if (on) {
    win.setFocusable(true);
    win.focus();
  } else {
    win.blur();
    win.setFocusable(false);
  }
});

/* Returns the spoken line as WAV bytes, or null if Piper is not installed -
 * in which case the renderer falls back to the Windows voices. */
ipcMain.handle('nim:synth', async (e, text) => {
  if (!fromNim(e) || typeof text !== 'string') return null;
  if (config.voiceEngine === 'kokoro' && kokoro.available()) {
    try {
      return await kokoro.speak(text, config.kokoroVoice || kokoro.DEFAULT_VOICE, config.rate);
    } catch (err) {
      console.error('kokoro:', err.message);           // Piper says it instead
    }
  }
  if ((config.voiceEngine === 'piper' || config.voiceEngine === 'kokoro') && piper.available()) {
    try {
      return await piper.speak(text, config.piperVoice, config.rate);
    } catch (err) {
      console.error('piper:', err.message);
    }
  }
  return null;
});

/* Opening the island grows the window up and to the left, keeping its
 * bottom-right corner exactly where it was - which is the corner Nim lives in,
 * so the creature does not move a pixel while the panel unfolds around it.
 *
 * It is also the only time Nim holds the keyboard, and it gives it straight
 * back on close; otherwise steps that press keys could not reach your work. */
ipcMain.on('nim:expand', (e, open) => {
  if (!fromNim(e)) return;
  expanded = !!open;

  const b = win.getBounds();
  const size = expanded ? EXPANDED : COLLAPSED;
  win.setBounds({
    x: b.x + b.width - size.width,
    y: b.y + b.height - size.height,
    width: size.width,
    height: size.height
  });

  if (expanded) {
    ignoring = false;
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.focus();
  } else {
    win.setFocusable(false);
    win.blur();
    ignoring = true;
    win.setIgnoreMouseEvents(true, { forward: true });
  }
});

/* ---- the agent ----------------------------------------------------------- */

/* Everything a tool is allowed to reach back into. Keeping it this narrow is
 * what stops a tool from quietly driving the interface. */
function agentCtx() {
  return Object.assign(brainCtx(), {
    say: async (text, mood) => say(text, mood),
    // what a finished step tells us "it" and "that" now mean
    remember: (partial) => context.update(partial),
    config: { browser: config.browser || null },
    // the focus timer, the PC's health, weather, briefing, quizzes (life.js)
    life: life ? life.ctx : null,
    // your automations, to list and switch on or off (automate.js)
    automations: automate ? automate.ctx : null,
    // a screenshot is of your screen, not of Nim: it steps out for a moment
    withoutNim: async (fn) => {
      const shown = win && !win.isDestroyed() && win.isVisible();
      if (shown) win.hide();
      await new Promise((r) => setTimeout(r, 180));
      try { return await fn(); } finally { if (shown && win && !win.isDestroyed()) win.showInactive(); }
    }
  });
}

/* What the brain and the tools are allowed to know: your name, the projects
 * you listed, the model to use, what "that" currently refers to, and which
 * tools you have switched off. */
function brainCtx() {
  return {
    name: config.name,
    projects: config.projects || {},
    brain: config.brain || {},
    context: context.get(),
    disabledTools: Array.isArray(config.disabledTools) ? config.disabledTools : []
  };
}

/* What is said out loud is the short form of what is shown: a voice reading
 * "Nim screenshot 2026-10-04 14.03.22.png" or a whole folder path is noise.
 * The card keeps the details. */
const EXT = '(?:png|jpe?g|gif|webp|bmp|txt|md|pdf|docx?|xlsx?|pptx?|csv|json|js|ts|py|html?|css|mp3|wav|mp4|mkv|zip|exe|log)';
const SAVED_AS = new RegExp('\\s+as\\s+.{1,80}?\\.' + EXT + '\\b', 'gi');   // "saved as <file name>"
const FILE = new RegExp('[^\\s"]+\\.' + EXT + '\\b', 'gi');
const PATH = /(?:[a-z]:\\|\\\\)[^\s,;"]*/gi;
function spoken(text, brief) {
  let t = String(text)
    .replace(SAVED_AS, '')
    // a folder by its own name ("Downloads"), a file as "the file"
    .replace(PATH, (m) => {
      const last = m.replace(/[\\.]+$/, '').split('\\').filter(Boolean).pop() || '';
      return (/\.\w{2,4}$/.test(last) ? 'the file' : last) + (/\.$/.test(m) ? '.' : '');
    })
    .replace(FILE, 'the file')
    .replace(/\s+(?:I have no way to check that it worked|I could not check every step), though\./g, '')
    .replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
  if (brief) {
    // a result read out: the first two sentences are the answer
    const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
    if (parts.length > 2) t = parts.slice(0, 2).join(' ');
    if (t.length > 180) t = t.slice(0, 180).replace(/\s+\S*$/, '') + '...';
  }
  return t || String(text);
}

function say(text, mood, opts) {
  if (!text || !win || win.isDestroyed()) return;
  win.webContents.send('nim:say', { text: String(text), speak: spoken(text, opts && opts.brief), mood: mood || 'speaking' });
  // what Nim said is part of the conversation the model sees next time, so
  // "yes" after "Did you mean Brave?" means something
  memory.note('nim', String(text));
}

/* Tools whose result is the answer: when the last step is one of these, its
 * result is what Nim says. */
const REPORTS = new Set(['project.inspect', 'git.status', 'project.test', 'memory.recall', 'memory.remember',
  'memory.forget', 'screen.describe', 'files.list', 'files.search', 'clipboard.read', 'reminder.list',
  'reminder.set', 'reminder.cancel', 'system.cancel_shutdown']);

/* When a run ends, say what actually happened - including what could not be
 * checked and what was skipped. "Done" only when it is done. */
function report(s) {
  if (automate && automate.quietEnd(s)) return;
  const last = s.steps[s.steps.length - 1];
  const spokeAlready = s.steps.every((x) => x.tool === 'skill' || x.tool === 'say');
  const skipped = s.steps.filter((x) => x.status === 'skipped');
  const unchecked = s.steps.filter((x) => x.status === 'done' && x.verified === null &&
                                         !['skill', 'say', 'wait'].includes(x.tool));

  if (s.status === 'error') {
    const done = s.steps.filter((x) => x.status === 'done').length;
    say('I could not finish. ' + (s.error || '') +
        (done && s.steps.length > 1 ? ' ' + done + ' of ' + s.steps.length + ' steps did work.' : ''), 'sad');
    return;
  }
  if (s.status !== 'completed' || spokeAlready) return;
  if (s.steps.every((x) => x.status === 'skipped')) { say('Okay, I left it alone.', 'speaking'); return; }

  let line;
  if (last && last.status === 'done' && REPORTS.has(last.tool) && last.summary) line = last.summary;
  else if (last && last.status === 'done' && last.tool === 'text.compose' && last.summary) line = 'Here it is: ' + last.summary;
  else if (last && last.doneLabel) line = last.doneLabel + '.';
  else if (last && last.verifyNote && last.verified) line = 'Done - ' + last.verifyNote + '.';
  else line = 'Done.';

  if (skipped.length) line += ' I skipped ' + skipped.length + ' step' + (skipped.length > 1 ? 's' : '') + ' you did not approve.';
  else if (unchecked.length && !(last && REPORTS.has(last.tool))) {
    line += unchecked.length === s.steps.length ? ' I have no way to check that it worked, though.' : ' I could not check every step, though.';
  }
  say(line, 'happy', { brief: true });
}

/* A desktop notification, but only for things worth interrupting you for: a
 * long task finishing, or one waiting on your answer while you look elsewhere. */
function notify(body) {
  try {
    if (Notification.isSupported()) new Notification({ title: 'Nim', body, silent: false }).show();
  } catch { /* a missing notification is not worth failing anything */ }
}

let lastStatus = 'idle';
agent.on('update', (snapshot) => {
  if (win && !win.isDestroyed()) win.webContents.send('agent:update', snapshot);

  if (snapshot.status !== lastStatus) {
    const took = snapshot.startedAt ? Date.now() - snapshot.startedAt : 0;
    if (snapshot.status === 'completed' || snapshot.status === 'error') {
      report(snapshot);
      if (took > 15000) {
        notify(snapshot.status === 'completed' ? 'Finished: ' + (snapshot.title || 'your task') : 'Could not finish: ' + (snapshot.error || ''));
      }
    }
    if (snapshot.status === 'waiting-approval' && !expanded) {
      notify('Waiting for your approval: ' + (snapshot.pendingApproval ? snapshot.pendingApproval.title : 'a step'));
    }
    lastStatus = snapshot.status;
  }
});

/* Turns recorded audio into words. The renderer sends a 16 kHz mono WAV it has
 * already resampled, so this is only ever handed what Whisper can read. What
 * the renderer chooses is only the kind of listening (see hearing.js); the
 * words Whisper is primed with are fixed there. Nothing is ever refused for
 * being busy - requests queue (see whisper.js). */
const MAX_WAV = 1.5 * 1024 * 1024;          // 45 s of 16 kHz audio; recordings are capped far below

ipcMain.handle('nim:transcribe', async (e, bytes, kind) => {
  if (!win || e.sender !== win.webContents) throw new Error('not allowed');
  if (!whisper.available()) throw new Error('whisper is not installed');
  if (!bytes || !bytes.byteLength || bytes.byteLength > MAX_WAV) throw new Error('that recording is not something I can hear');
  const k = hearing.HEARING[kind] ? kind : 'command';
  const r = await whisper.transcribeDetailed(Buffer.from(bytes), hearing.settingsFor(k));
  diag('whisper ' + k + ': ' + r.via + ' ' + r.ms + 'ms' + (r.waited > 50 ? ' (queued ' + r.waited + 'ms)' : '') +
       (r.stale ? ' - skipped, too old' : ''));
  return r.text;
});

ipcMain.handle('nim:can-hear', (e) => {
  if (!fromNim(e)) return false;
  const ok = whisper.available();
  console.log('[nim] whisper available:', ok, '| models:', whisper.models().join(',') || 'none');
  return ok;
});

/* The companion window has no frame and no console, so anything it needs to
 * tell a developer comes out here instead. Lines marked as diagnostics carry
 * what was heard, and are only printed while diagnostics are on. */
let wakeTestDone = null;          // the self-test waiting for the window to finish one recording
ipcMain.on('nim:log', (e, line) => {
  if (!win || e.sender !== win.webContents) return;
  const s = String(line).slice(0, 600);
  if (s === 'wake-test-done') { if (wakeTestDone) wakeTestDone(); return; }
  if (s.startsWith('diag ')) diag(s.slice(5));
  else console.log('[nim]', s);
});

/* A renderer can report what it alone can know - the microphone, the wake
 * word, speech - and nothing else. The bus refuses any other event type. */
ipcMain.on('nim:emit', (e, type, data) => {
  if (!win || e.sender !== win.webContents) return;
  bus.fromRenderer(String(type), data);
});
ipcMain.handle('nim:state', (e) => (fromNim(e) ? bus.snapshot() : null));

/* Where the Dots are drawn, so those spots can be clicked in a click-through
 * window. Numbers only, and a handful at most. */
let hitboxes = [];
ipcMain.on('nim:hitboxes', (e, boxes) => {
  if (!win || e.sender !== win.webContents || !Array.isArray(boxes)) return;
  hitboxes = boxes.slice(0, 24).filter((b) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite))
    .map((b) => ({ x: b.x, y: b.y, w: Math.min(b.w, 480), h: Math.min(b.h, 620) }));
});

/* Everything typed or spoken arrives here, and there is one road from here to
 * the computer: the brain proposes, the validator checks, the runtime runs.
 * There used to be a shortcut for single commands that called tools directly,
 * and a shortcut around the runtime is a shortcut around the approval gate -
 * so there is not one any more. A one-step command still goes through the
 * runtime; it simply does not open the island to do it. */
let selfTesting = false;           // the self-test owns the conversation: the room is not heard
ipcMain.handle('agent:submit', (e, text) => {
  if (!win || e.sender !== win.webContents) return { quick: true, say: '', mood: 'idle' };
  if (selfTesting) { console.log('[selftest] ignored from the window:', JSON.stringify(String(text).slice(0, 60))); return { quick: true, say: '', mood: 'idle' }; }
  return submit(text);
});

/* Answers to "Shut down your computer?" and the like. Only ever read while a
 * question is actually waiting - and only ever reached through the wake word
 * or a click, so a "yes" from a video in the background cannot answer it. */
const YES = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|confirm(?:ed)?|do it|go ahead|go for it|please do|proceed|approve(?:d)?|absolutely|of course|correct|right)\b/i;
const NO = /^(?:no|nope|nah|cancel|don'?t|do not|stop|never ?mind|abort|deny|skip(?: it)?|not now|leave it|wait)\b/i;
const STOP = /^(?:stop|cancel|halt|abort|never ?mind|forget it|enough)(?:\s+(?:it|that|this|everything|now|please))*\s*[.!]?$/i;

let thinking = null;            // the request the brain is working on, so it can be called off

async function submit(text) {
  const said = String(text || '').trim().replace(/^[\s,.!?-]+/, '');
  if (!said) return { quick: true, say: '', mood: 'idle' };

  // a question is waiting: this is the answer to it
  const snap = agent.snapshot();
  if (snap.status === 'waiting-approval' && snap.pendingApproval) {
    if (YES.test(said)) {
      agent.approve(snap.pendingApproval.stepId, true);
      return { quick: true, say: '', mood: 'idle' };
    }
    if (NO.test(said)) {
      agent.approve(snap.pendingApproval.stepId, false);
      return { quick: true, say: '', mood: 'idle' };
    }
    say('Should I go ahead? Yes or no?', 'waiting');
    return { quick: true, spoken: true, say: 'Should I go ahead? Yes or no?', mood: 'waiting' };
  }

  // Nim offered to take over a habit: "yes" or "no" answers that
  if (automate && automate.offerOpen() && (YES.test(said) || NO.test(said))) {
    automate.answerOpen(YES.test(said) ? 'yes' : 'no');
    return { quick: true, spoken: true, say: '', mood: 'idle' };
  }

  // "stop" means stop whatever is happening
  if (STOP.test(said)) {
    if (agent.isBusy()) agent.cancel();
    else if (thinking) { thinking.cancelled = true; bus.publish('idle'); }
    else { say('There is nothing to stop.', 'speaking'); return { quick: true, spoken: true, say: 'There is nothing to stop.', mood: 'speaking' }; }
    say('Stopped.', 'speaking');
    return { quick: true, spoken: true, say: 'Stopped.', mood: 'speaking' };
  }

  if (agent.isBusy()) {
    return { quick: true, say: 'I am still working on the last thing. Say stop to cancel it.', mood: 'waiting' };
  }

  // a routine you set up: its phrase runs it now (automate.js) - the same
  // validator and runtime as everything else, so risky steps still ask
  const routine = automate && automate.match(said);
  if (routine) {
    console.log('[nim] routine: ' + routine.name);
    const ran = await automate.run(routine, 'phrase');
    if (ran.ok && !ran.nothing) return { quick: false };
    const line = ran.ok ? 'There is nothing to do for ' + routine.name + ' right now.' : ran.say;
    say(line, ran.ok ? 'speaking' : 'sad');
    return { quick: true, spoken: true, say: line, mood: ran.ok ? 'speaking' : 'sad' };
  }

  const job = { cancelled: false };
  thinking = job;
  let thought;
  bus.publish('planning_started', { text: said.slice(0, 200) });
  try {
    thought = await brain.think(said, Object.assign(brainCtx(), {
      // the brain's own milestones go on the one event stream: which mind is
      // thinking, and the validator checking (and sending back) its plans
      onEvent: (type, data) => {
        if (job.cancelled) return;
        if (type === 'provider') bus.publish('planning_started', { provider: data.provider, text: said.slice(0, 200) });
        else if (type === 'validation_started' || type === 'validation_failed') bus.publish(type, data);
      }
    }));
  } catch (err) {
    console.log('[nim] brain failed:', err.message);
    bus.publish('error', { message: 'I could not think that through.' });
    return { quick: true, say: 'Something went wrong while I was thinking about that.', mood: 'sad' };
  } finally {
    if (thinking === job) thinking = null;
  }
  if (job.cancelled) return { quick: true, say: '', mood: 'idle' };

  const plan = thought.plan;
  // what was decided and by which mind - never what was said
  console.log('[nim] brain:', thought.source, thought.ms + 'ms', plan.intent,
              plan.steps.map((s) => s.tool).join(' > ') || '-',
              thought.tried.length ? '| ' + thought.tried.join(' | ') : '');
  bus.publish('plan_created', { provider: thought.source, steps: plan.steps.length, title: plan.goal || '' });

  if (!plan.steps.length) {
    // spoken from here, so the answer is heard wherever the question was asked
    const mood = plan.intent === 'refuse' ? 'sad' : plan.intent === 'clarify' ? 'waiting' : 'speaking';
    say(plan.reply, mood);
    return { quick: true, spoken: true, say: plan.reply, mood };
  }

  try {
    await agent.startPlan(said, plan, agentCtx());
  } catch (err) {
    return { quick: true, say: err.message, mood: 'sad' };
  }
  return { quick: false };
}

/* ---- the self-test ------------------------------------------------------------
 *
 * Run inside the real app, against the real computer, so a pass means the real
 * path works - not a test double of it.
 *
 *   NIM_SELFTEST="sentence||sentence"  each goes through submit(), exactly as if
 *                                      typed: brain, validator, runtime, tools,
 *                                      verification.
 *   NIM_SELFTEST_WAKE="a.wav||b.wav"   each recording is handed to the window's
 *                                      wake listener: Whisper, the wake check,
 *                                      IPC, the shared state, submit().
 *
 * Along the way it watches the shared state and asks the window what the face,
 * the surface and the Dots are showing, and logs every moment they disagree
 * with the state. Anything that stops for approval is logged and declined,
 * never approved: a test hook must not be a way past the gate.
 */
const VIEW_FOR = {
  listening: { face: ['listening'], surface: ['listening'] },
  transcribing: { face: ['thinking', 'listening'], surface: ['hearing'] },
  thinking: { face: ['thinking'], surface: ['thinking'] },
  working: { face: ['reaching', 'receiving', 'weaving', 'thinking', 'working'], surface: ['working'] },
  confirming: { face: ['waiting'], surface: ['confirm'] },
  done: { face: ['happy', 'speaking', 'idle'], surface: ['done', 'reply'] },
  error: { face: ['error', 'sad', 'speaking'], surface: ['error', 'reply'] }
};

async function viewNow() {
  if (!win || win.isDestroyed()) return null;
  try { return await win.webContents.executeJavaScript('window.__nimView && window.__nimView()', true); } catch { return null; }
}

/* NIM_SELFTEST_SHOTS=<folder>: a picture of Nim's window at every change of
 * state, so what the surface, the face and the Dots showed can be looked at. */
let shotN = 0;
async function shoot(label) {
  const dir = process.env.NIM_SELFTEST_SHOTS;
  if (!dir || !win || win.isDestroyed()) return;
  try {
    const img = await win.webContents.capturePage();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, String(++shotN).padStart(3, '0') + '-' + label.replace(/[^\w-]+/g, '_') + '.png'), img.toPNG());
  } catch { /* a missing picture is not a failed test */ }
}

function watchViews(tag) {
  const seen = [];
  const problems = [];
  const onEvent = async (event, state) => {
    seen.push(event.type);
    const want = VIEW_FOR[state.phase];
    if (!want) return;
    await new Promise((r) => setTimeout(r, 450));              // springs and faces take a moment
    const now = bus.snapshot();
    if (now.phase !== state.phase) return;                     // moved on; judged at the next event
    const v = await viewNow();
    if (!v) return;
    shoot(state.phase + '-' + v.surface + '-' + v.face);
    const bad = [];
    if (!want.face.includes(v.face)) bad.push('face ' + v.face);
    if (!want.surface.includes(v.surface)) bad.push('surface ' + v.surface);
    const cat = now.task && now.task.current && now.task.current.category;
    if (state.phase === 'working' && cat && v.dots && !['active', 'done'].includes(v.dots[cat])) bad.push('dot ' + cat + '=' + v.dots[cat]);
    if (bad.length) problems.push(state.phase + ' (' + event.type + '): ' + bad.join(', '));
  };
  bus.on('event', onEvent);
  return { stop: () => { bus.off('event', onEvent); return { seen, problems }; }, tag };
}

async function waitForQuiet(ms) {
  const deadline = Date.now() + (ms || 90000);
  let quietSince = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const s = agent.snapshot();
    if (s.status === 'waiting-approval') return 'approval';
    const phase = bus.snapshot().phase;
    const settled = !agent.isBusy() && !thinking && ['idle', 'done', 'error'].includes(phase);
    if (settled) { if (!quietSince) quietSince = Date.now(); if (Date.now() - quietSince > 1200) return phase; }
    else quietSince = 0;
  }
  return 'timeout';
}

function logRun(label, t0, watch) {
  const s = agent.snapshot();
  console.log('[selftest]', label, '->', s.status, ((Date.now() - t0) / 1000).toFixed(1) + 's');
  s.steps.forEach((x) => console.log('[selftest]     ', x.tool, x.status, 'risk=' + x.risk,
    'verified=' + x.verified, x.verifyNote ? '(' + x.verifyNote + ')' : '', x.error ? 'ERR ' + x.error : ''));
  const w = watch.stop();
  console.log('[selftest]      events:', w.seen.join(' > '));
  console.log('[selftest]      views:', w.problems.length ? 'DISAGREE ' + w.problems.join(' | ') : 'face, surface and Dots agreed with the state');
}

async function selfTest(list) {
  for (const sentence of list) {
    const left = agent.snapshot();
    if (left.status === 'waiting-approval' && left.pendingApproval) { agent.approve(left.pendingApproval.stepId, false); await waitForQuiet(15000); agent.clear(); }
    const t0 = Date.now();
    const watch = watchViews(sentence);
    const out = await submit(sentence);
    if (out.quick) {
      await waitForQuiet(15000);
      console.log('[selftest]', JSON.stringify(sentence), '-> reply:', JSON.stringify(out.say || bus.snapshot().lastEvent));
      const w = watch.stop();
      console.log('[selftest]      events:', w.seen.join(' > '));
      continue;
    }
    const end = await waitForQuiet(120000);
    if (end === 'approval') {
      const s = agent.snapshot();
      await new Promise((r) => setTimeout(r, 900));
      const v = await viewNow();
      console.log('[selftest]', JSON.stringify(sentence), '-> STOPPED FOR APPROVAL:', JSON.stringify(s.pendingApproval.question),
        'risk=' + s.pendingApproval.risk, '| surface=' + (v && v.surface), 'face=' + (v && v.face), '(declining)');
      agent.approve(s.pendingApproval.stepId, false);
      await waitForQuiet(15000);
    }
    logRun(JSON.stringify(sentence), t0, watch);
    agent.clear();
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log('[selftest] done');
}

/* Recordings through the window's own wake listener. Each is a 16 kHz WAV. */
async function selfTestWake(files) {
  for (const file of files) {
    let bytes;
    try { bytes = fs.readFileSync(file); } catch (err) { console.log('[selftest-wake]', file, 'unreadable:', err.message); continue; }
    const t0 = Date.now();
    const watch = watchViews(file);
    let woke = false, heard = null;
    const onEvent = (event) => {
      if (event.type === 'wake_detected') woke = true;
      if (event.type === 'transcription_received') heard = event.data.text || '';
    };
    bus.on('event', onEvent);
    // the window says when it has decided whether the recording was for Nim
    const decided = new Promise((r) => { wakeTestDone = r; setTimeout(r, 30000); });
    win.webContents.send('nim:test-wake', new Uint8Array(bytes));
    await decided;
    wakeTestDone = null;
    await new Promise((r) => setTimeout(r, 400));
    let end = await waitForQuiet(woke ? 120000 : 15000);
    if (end === 'approval') {
      const s = agent.snapshot();
      console.log('[selftest-wake]     stopped for approval:', JSON.stringify(s.pendingApproval.question), '(declining)');
      agent.approve(s.pendingApproval.stepId, false);
      end = await waitForQuiet(15000);
    }
    bus.off('event', onEvent);
    console.log('[selftest-wake]', path.basename(file), '->', woke ? 'WOKE' : 'did not wake',
      heard !== null ? 'request ' + JSON.stringify(heard) : (woke ? '(name only)' : ''), ((Date.now() - t0) / 1000).toFixed(1) + 's');
    if (woke) logRun('    ' + path.basename(file), t0, watch); else watch.stop();
    agent.clear();
    if (bus.snapshot().phase === 'listening') bus.publish('idle');
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log('[selftest-wake] done');
}

ipcMain.on('agent:control', (e, msg) => {
  if (!win || e.sender !== win.webContents) return;
  const action = msg && msg.action;
  if (action === 'pause') agent.pause();
  else if (action === 'resume') agent.resume();
  else if (action === 'cancel') {
    if (agent.isBusy()) agent.cancel();
    else if (thinking) { thinking.cancelled = true; bus.publish('idle'); }
  }
  else if (action === 'retry') agent.retry();
  else if (action === 'clear') agent.clear();
  else if (action === 'approve') {
    const s = agent.snapshot();
    if (s.pendingApproval) agent.approve(s.pendingApproval.stepId, !!(msg && msg.arg));
  }
});

ipcMain.on('nim:voices', (e, payload) => { if (fromNim(e) && payload && Array.isArray(payload.list)) voices = payload; });

/* ---- settings ----------------------------------------------------------------
 *
 * One window with what is worth changing. It may only change the settings
 * listed in settings-model.js, to values those settings can take; each change
 * is saved at once and takes effect without a restart. */
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }

  settingsWin = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 400,
    title: 'Nim settings',
    backgroundColor: '#0b0d16',
    autoHideMenuBar: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  // the status line stays true while the window is open
  const refresh = setInterval(async () => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    settingsWin.webContents.send('settings:status', Object.assign(await settingsStatus(), { voices: allVoices() }));
  }, 3000);
  settingsWin.on('closed', () => { clearInterval(refresh); settingsWin = null; });
}

const fromSettings = (e) => settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;

function allVoices() {
  return kokoro.list().map((v) => ({ id: v.id, engine: 'kokoro', name: v.name + ' - ' + v.full }))
    .concat(piper.list().map((v) => ({ id: v.id, engine: 'piper', name: v.name })))
    .concat((voices.list || []).map((v) => ({ id: v.name, engine: 'system', name: v.name })));
}

async function settingsStatus() {
  let brain = false;
  try { brain = await ollama.available(brainCtx()); } catch { brain = false; }
  const ears = whisper.status();
  const model = (config.brain && config.brain.ollamaModel) || ollama.DEFAULT_MODEL;
  return {
    brain, brainName: model.replace(/:.*/, '').replace(/^qwen/i, 'Qwen ') + ' on this PC',
    ears: whisper.available(),
    earsName: ears.models && ears.models.accurate ? 'Whisper ' + ears.models.accurate.replace(/^ggml-|\.bin$/g, '') : 'Whisper',
    listening: !!listeningNow
  };
}

ipcMain.handle('settings:get', async (e) => {
  if (!fromSettings(e)) return null;
  return {
    values: settingsModel.view(config, { startWithWindows: startsWithWindows() }),
    voices: {
      list: allVoices(),
      current: config.voiceEngine === 'kokoro' ? (config.kokoroVoice || kokoro.DEFAULT_VOICE)
        : config.voiceEngine === 'piper' ? (config.piperVoice || (piper.list()[0] || {}).id) : config.voice
    },
    status: await settingsStatus()
  };
});

ipcMain.handle('settings:set', async (e, key, value) => {
  if (!fromSettings(e)) return { ok: false };
  const c = settingsModel.clean(key, value);
  if (!c.ok) return { ok: false };
  const v = c.value;
  const tell = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };

  if (key === 'startWithWindows') {
    setStartsWithWindows(v);
    return { ok: true, value: startsWithWindows() };
  }
  if (key === 'skin') {
    config.outfit = Object.assign({}, config.outfit, { skin: v });
    tell('nim:outfit', { skin: v });
  } else {
    config[key] = v;
  }
  saveConfig();

  // what each one changes right away
  if (key === 'wakeWord') updateListening();
  if (key === 'danceToMusic') { watchMedia(v); tell('nim:dance', v); }
  if (key === 'lyrics') { lyricsKey = ''; sendLyrics('', null); if (v) checkMedia(); }
  if (key === 'breakMinutes' && life) life.setBreakMinutes(v);
  if (key === 'learnHabits' && automate) automate.setLearning(v);
  if (key === 'size') { applySize(); tell('nim:size', { scale: SCALE, anchor: ANCHOR }); }
  if (key === 'rate' || key === 'followUp') tell('nim:settings', { rate: config.rate, followUp: config.followUp !== false });
  if (key === 'wakeWord' && settingsWin) setTimeout(async () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:status', await settingsStatus());
  }, 600);
  return { ok: true, value: v };
});

ipcMain.handle('settings:voice', (e, choice) => {
  if (!fromSettings(e) || !choice) return { ok: false };
  const v = allVoices().find((x) => x.engine === choice.engine && x.id === choice.id);
  if (!v) return { ok: false };
  if (v.engine === 'kokoro') {
    config.voiceEngine = 'kokoro';
    config.kokoroVoice = v.id;
    kokoro.load();
  } else if (v.engine === 'piper') {
    config.voiceEngine = 'piper';
    config.piperVoice = v.id;
  } else {
    config.voiceEngine = 'system';
    config.voice = v.id;
    voices.current = config.voice;
  }
  saveConfig();
  if (win && !win.isDestroyed()) {
    win.webContents.send('nim:voice-changed', { engine: config.voiceEngine, id: config.voiceEngine === 'kokoro' ? config.kokoroVoice : config.piperVoice, system: config.voice });
  }
  return { ok: true };
});

ipcMain.handle('settings:action', (e, name) => {
  if (!fromSettings(e) || !win || win.isDestroyed()) return { ok: false };
  if (name === 'test-voice') {
    say('Hi' + (config.name ? ' ' + config.name : '') + '! This is how I sound.', 'happy');
    return { ok: true };
  }
  if (name === 'enroll' && config.wakeWord) {
    win.show();
    win.webContents.send('nim:enroll');
    return { ok: true };
  }
  return { ok: false };
});

/* Automations in the settings window: the list, each one in words, and the
 * menus to build one from. Whatever comes back is checked by
 * automations.clean() before it is kept. */
function automationsView() {
  return {
    list: automate ? automate.list().map((a) => ({
      id: a.id, name: a.name, on: a.on, when: a.when, do: a.do,
      whenText: automations.describeWhen(a), doText: automations.describeSteps(a, config.name)
    })) : [],
    acts: Object.entries(automations.ACTS).map(([id, a]) => ({ id, label: a.label, value: a.value, example: a.example || '' })),
    events: Object.entries(automations.EVENTS).map(([id, ev]) => ({ id, label: ev.label, value: ev.value || null })),
    days: Object.entries(automations.DAYS).map(([id, label]) => ({ id, label }))
  };
}
ipcMain.handle('settings:automations', (e) => (fromSettings(e) ? automationsView() : null));
ipcMain.handle('settings:automation-save', (e, def) => {
  if (!fromSettings(e) || !automate) return { ok: false, error: 'not ready yet' };
  const r = automate.save(def);
  return r.ok ? { ok: true, view: automationsView() } : { ok: false, error: r.error };
});
ipcMain.handle('settings:automation-remove', (e, id) => {
  if (!fromSettings(e) || !automate) return null;
  automate.remove(String(id));
  return automationsView();
});
ipcMain.handle('settings:automation-toggle', (e, id, on) => {
  if (!fromSettings(e) || !automate) return null;
  automate.toggle(String(id), !!on);
  return automationsView();
});
// "Try it": run it now, as if its phrase had been said - and so heard to the end
ipcMain.handle('settings:automation-run', async (e, id) => {
  if (!fromSettings(e) || !automate) return { ok: false };
  const a = automate.list().find((x) => x.id === String(id));
  if (!a) return { ok: false, error: 'it is gone' };
  const ran = await automate.run(a, 'phrase');
  if (!ran.ok && ran.say) say(ran.say, 'sad');
  return { ok: !!ran.ok, error: ran.ok ? null : ran.say, nothing: !!ran.nothing };
});

ipcMain.on('nim:drag-start', (e) => {
  if (!fromNim(e)) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  drag = { dx: p.x - b.x, dy: p.y - b.y };
});

ipcMain.on('nim:drag-end', (e) => {
  if (!fromNim(e)) return;
  drag = null;
  // remembered, so Nim comes back where you put it
  if (win && !win.isDestroyed() && !expanded) {
    const b = win.getBounds();
    config.position = { x: b.x, y: b.y };
    saveConfig();
  }
});


/* Right-clicking the body is the only chrome there is: the things you do,
 * the microphone (a privacy switch belongs one click away), and Settings for
 * everything else. */
ipcMain.on('nim:menu', (e) => {
  if (!fromNim(e)) return;
  Menu.buildFromTemplate([
    { label: 'Nim', enabled: false },
    { type: 'separator' },
    { label: 'Speak to me  (Ctrl+Alt+V)', click: () => win.webContents.send('nim:listen') },
    { label: 'Type to me  (Ctrl+Alt+Space)', click: () => win.webContents.send('nim:open-input') },
    life && life.focusing
      ? { label: 'Stop focusing', click: () => life.focusStop() }
      : { label: 'Focus for 25 minutes', click: () => life && life.focusStart(25) },
    { label: 'Feed Nim', click: () => win.webContents.send('nim:pet', { kind: 'feed' }) },
    { label: 'Pet Nim', click: () => win.webContents.send('nim:pet', { kind: 'pet' }) },
    { type: 'separator' },
    {
      label: 'Microphone on  (listen for "Hey Nim")',
      type: 'checkbox',
      checked: !!config.wakeWord,
      click: (item) => {
        config.wakeWord = item.checked;
        saveConfig();
        updateListening();
      }
    },
    { label: 'Settings...', click: openSettings },
    { type: 'separator' },
    { label: 'Hide  (Ctrl+Alt+N brings it back)', click: () => win.hide() },
    { label: 'Quit', click: () => app.quit() }
  ]).popup({ window: win });
});

/* ---- dancing to music -------------------------------------------------------
 *
 * Windows keeps track of what is playing - Spotify, a song in a browser tab -
 * and says so in its media flyout. Nim asks the same thing every couple of
 * seconds through the system bridge and puts the answer in the shared state.
 * The window then listens to the computer's own sound output (not the
 * microphone) for the beat, and dances only if there is one - a talk stream
 * playing has no steady beat, and gets no dance.
 */
const MEDIA_APPS = [[/spotify/i, 'Spotify'], [/brave/i, 'Brave'], [/chrome/i, 'Chrome'], [/edge/i, 'Edge'],
  [/firefox/i, 'Firefox'], [/vlc/i, 'VLC'], [/music|zune/i, 'Media Player'], [/youtube/i, 'YouTube']];
let mediaKey = '';
let mediaTimer = 0;
let mediaBusy = false;
let lyricsKey = '';
function mediaApp(id) {
  for (const [re, name] of MEDIA_APPS) if (re.test(id || '')) return name;
  return String(id || '').split(/[.!_]/)[0] || 'an app';
}
function sendLyrics(key, lines) {
  if (win && !win.isDestroyed()) win.webContents.send('nim:lyrics', { key, lines: lines || null });
}

/* For a new song: its timed lyrics (unless they are switched off), then what
 * it feels like - asked of Qwen on this computer, from the title and those
 * lyrics. Anything shorter than a song (an ad) is not looked into at all. */
async function findLyrics(now, key) {
  lyricsKey = key;
  sendLyrics(key, null);
  if (!now.playing || !now.title || (now.length && now.length < 75)) return;
  // A browser video its title says nothing about: is it a song at all? Asked of
  // the model on this PC from the title and channel, alongside the lyrics
  // search - until one of them says song, Nim does not dance to it.
  const unsure = music.isBrowser(now.app) && !music.kindOf(now);
  // (available() starts Ollama if it is not running yet)
  const checking = unsure ? ollama.available(brainCtx()).catch(() => false).then(() => songcheck.isMusic(
    { title: now.title, artist: now.artist }, { model: (config.brain && config.brain.ollamaModel) || ollama.DEFAULT_MODEL })) : null;
  const lines = config.lyrics === false ? null : await lyrics.find(now);
  if (lyricsKey !== key) return;
  sendLyrics(key, lines);
  if (lines) console.log('[nim] lyrics: found ' + lines.length + ' timed lines');
  if (checking && !lines) {
    const verdict = await checking;
    if (lyricsKey !== key) return;
    if (win && !win.isDestroyed()) win.webContents.send('nim:song-check', { key, music: verdict });
    console.log('[nim] is it a song? ' + (verdict === null ? 'no answer - not dancing to it' : verdict ? 'yes, music' : 'no - not dancing to it'));
  }
  const felt = await mood.songMood({ key, title: now.title, artist: now.artist, lines },
    { model: (config.brain && config.brain.ollamaModel) || ollama.DEFAULT_MODEL });
  if (lyricsKey === key && felt && win && !win.isDestroyed()) {
    win.webContents.send('nim:song-mood', { key, mood: felt.mood });
    console.log('[nim] song mood: ' + felt.mood + ' (' + felt.by + ')');
  }
}

async function checkMedia() {
  if (config.danceToMusic === false || mediaBusy) return;
  mediaBusy = true;
  let m;
  try { m = await bridge.call('media.now', {}, 6000); } catch { m = null; } finally { mediaBusy = false; }
  if (!m) return;
  const playing = m.status === 'Playing';
  // its length in seconds when the app gives one (0 when not): an ad is short
  const length = Number.isFinite(m.length) && m.length > 0 && m.length < 86400 ? Math.round(m.length) : 0;
  const now = { playing, title: m.title || '', artist: m.artist || '', app: mediaApp(m.app), length };
  const song = [now.title, now.artist, now.length].join('|');
  // where the song is, every second, so the lyrics and the dance keep time
  if (win && !win.isDestroyed()) {
    win.webContents.send('nim:media-clock', {
      key: song, playing,
      position: Number.isFinite(m.position) ? m.position : 0,
      updated: Number.isFinite(m.updated) && m.updated > 0 ? m.updated : Date.now()
    });
  }
  if (playing && song !== lyricsKey) findLyrics(now, song);
  const key = JSON.stringify(now);
  if (key === mediaKey) return;
  mediaKey = key;
  bus.publish('media_changed', now);
}
function watchMedia(on) {
  clearInterval(mediaTimer);
  mediaTimer = 0;
  // once a second: a song starting or stopping shows within a second
  if (on) { mediaTimer = setInterval(checkMedia, 1000); checkMedia(); }
  else { mediaKey = ''; lyricsKey = ''; sendLyrics('', null); bus.publish('media_changed', { playing: false }); }
}

/* The buttons on its belly while music plays. A fixed set - the media keys
 * every keyboard has, and the volume in steps - asked for by Nim's own window
 * only; nothing else can come through here. */
const MEDIA_KEYS = { playpause: 'playpause', next: 'next', previous: 'previous' };
ipcMain.handle('nim:media-control', async (e, action) => {
  if (!fromNim(e)) return null;
  try {
    if (action === 'volup' || action === 'voldown') {
      const now = await bridge.call('volume.get', {}, 3000);
      const level = Math.max(0, Math.min(100, Math.round(now.level / 5) * 5 + (action === 'volup' ? 5 : -5)));
      return await bridge.call('volume.set', { level }, 3000);
    }
    if (!MEDIA_KEYS[action]) return null;
    await bridge.call('mediakey', { key: MEDIA_KEYS[action] }, 3000);
    setTimeout(checkMedia, 350);              // the change shows at once, not a second later
    return { pressed: action };
  } catch (err) {
    return { error: err.message };
  }
});

/* The computer's own sound, for the beat - granted to Nim's window only, and
 * only as sound: the screen picture that has to come with it is dropped by
 * the window the moment it arrives. Nothing is recorded. */
function allowSystemSound() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const nim = win && !win.isDestroyed() && request.frame && request.frame === win.webContents.mainFrame;
    if (!nim || config.danceToMusic === false) { callback({}); return; }
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
      .catch(() => callback({}));
  });
}

/* ---- looking after you (life.js) ----------------------------------------------- */
let life = null;
let automate = null;
let hiddenForGame = false;
function startLife() {
  if (life) return;
  life = createLife({
    say, config, saveConfig, bridge, reminders, validator, brainCtx,
    send: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); },
    startPlan: (goal, plan) => agent.startPlan(goal, plan, agentCtx()),
    log: (line) => console.log('[nim] ' + line),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    isLocked: () => locked,
    isBusy: () => agent.isBusy(),
    model: () => (config.brain && config.brain.ollamaModel) || ollama.DEFAULT_MODEL,
    // a game, coming back, the battery: for automations to follow
    onEvent: (event, data) => { if (automate) automate.fire(event, data); },
    // a game or a film full-screen: out of the way (and the microphone with it)
    setHidden: (on) => {
      if (!win || win.isDestroyed()) return;
      if (on && win.isVisible()) { hiddenForGame = true; win.hide(); }
      else if (!on && hiddenForGame) { hiddenForGame = false; win.showInactive(); }
    }
  });
  automate = createAutomate({
    config, saveConfig, validator, brainCtx, agent, bridge, say,
    startPlan: (goal, plan) => agent.startPlan(goal, plan, agentCtx()),
    send: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); },
    log: (line) => console.log('[nim] ' + line),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    isQuiet: () => life.isQuiet(),
    isGaming: () => life.gaming
  });
}

ipcMain.on('nim:battery', (e, b) => { if (fromNim(e) && life) life.onBattery(b); });
ipcMain.on('nim:focus-stop', (e) => { if (fromNim(e) && life) life.focusStop(); });
ipcMain.on('nim:quiet-stop', (e) => { if (fromNim(e) && life) life.ctx.quiet(0); });
ipcMain.handle('nim:habit-answer', (e, id, choice) => {
  if (!fromNim(e) || !automate || !['yes', 'no', 'later'].includes(choice)) return null;
  return automate.answerHabit(String(id), choice);
});
ipcMain.handle('nim:clip-action', async (e, action) => {
  if (!fromNim(e) || !life || !['summarize', 'translate', 'fix'].includes(action)) return null;
  return life.clipAction(action);
});

/* ---- when the microphone is open --------------------------------------------
 *
 * Hearing "Hey Nim" means listening - there is no way around that, on any
 * assistant - and Windows shows its microphone icon whenever anything listens.
 * So Nim listens only while it can be spoken to: "Listen for Hey Nim" is on,
 * the PC is not locked, and Nim is not hidden. Otherwise the microphone is
 * released completely, and the icon goes with it.
 */
let locked = false, lockedAt = 0;
let listeningNow = null;
function updateListening() {
  if (!win || win.isDestroyed()) return;
  const want = !!config.wakeWord && !locked && win.isVisible();
  if (want === listeningNow) return;
  listeningNow = want;
  win.webContents.send('nim:wake-word', want);
  console.log('[nim] microphone', want ? 'listening for "Hey Nim"' : 'released' +
    (!config.wakeWord ? ' (listening is switched off)' : locked ? ' (PC locked)' : ' (Nim hidden)'));
}

/* ---- lifecycle ----------------------------------------------------------- */

/* One Nim at a time. A second copy - started from the login entry while one is
 * already running, say - would mean two microphones listening for the same name
 * and two creatures answering. */
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { win.show(); win.setAlwaysOnTop(true, 'screen-saver'); }
});

app.whenReady().then(() => {
  if (!primary) return;
  loadConfig();
  repairLoginItem();

  // Nim's own windows may use the microphone; nothing else is granted.
  // no page anywhere in Nim may embed a webview of its own
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
  });

  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
    const nim = !!(win && !win.isDestroyed() && wc === win.webContents);
    done(nim && (permission === 'media' || permission === 'clipboard-sanitized-write'));
  });

  createWindow();
  if (config.voiceEngine === 'kokoro') kokoro.load();
  if (process.env.NIM_OPEN_SETTINGS) openSettings();    // for checking the settings window
  track();

  // the microphone follows whether Nim can be spoken to (see updateListening)
  win.on('hide', updateListening);
  win.on('show', updateListening);
  win.webContents.once('did-finish-load', () => { listeningNow = !!config.wakeWord; });
  powerMonitor.on('lock-screen', () => { locked = true; lockedAt = Date.now(); updateListening(); if (automate) automate.fire('lock'); });
  powerMonitor.on('unlock-screen', () => {
    locked = false;
    updateListening();
    if (life && lockedAt) life.onUnlock(Date.now() - lockedAt);
    if (automate) automate.fire('unlock');
  });

  // Load the ears now, so the first "Hey Nim" is not also the moment the
  // speech model is read from disk.
  whisper.start().then((ok) => {
    console.log('[nim] whisper server:', ok ? 'ready on 127.0.0.1:' + whisper.status().port : 'not available, using whisper-cli');
    publishProviders();
  });

  // The system bridge compiles its audio interop once; do it now, not on the
  // first "volume down".
  bridge.start().then(() => {
    console.log('[nim] system bridge: ready');
    watchMedia(config.danceToMusic !== false);
    startLife();
  }).catch((err) => console.log('[nim] system bridge: not available -', err.message));
  allowSystemSound();

  // Reminders that were set before Nim last closed, and any that came due
  // while it was closed.
  reminders.start({
    onDue: (r, late) => {
      say((late ? 'I missed this while I was closed: ' : 'Reminder: ') + r.text + '.', 'alert');
      notify('Reminder: ' + r.text);
    },
    onChange: (count) => { try { bus.publish('reminders_changed', { count }); } catch { /* not ready yet */ } }
  });

  // Start the local model in the background, so the first thing you say is not
  // also the moment a 2 GB model has to be loaded onto the GPU.
  (async () => {
    const ctx = brainCtx();
    const ready = await ollama.available(ctx).catch(() => false);
    console.log('[nim] local model:', ready ? 'ready' : 'not available - basic commands only');
    if (ready) ollama.plan('hello', ctx).catch(() => {});
    publishProviders();

    if (process.env.NIM_SELFTEST || process.env.NIM_SELFTEST_WAKE) {
      await new Promise((r) => setTimeout(r, 6000));    // let the window, the bridge and the ears settle
      if (process.env.NIM_SELFTEST_WAKE) {
        await selfTestWake(process.env.NIM_SELFTEST_WAKE.split('||').map((s) => s.trim()).filter(Boolean));
      }
      if (process.env.NIM_SELFTEST) {
        selfTesting = true;
        await selfTest(process.env.NIM_SELFTEST.split('||').map((s) => s.trim()).filter(Boolean));
      }
      selfTesting = false;
      if (win && !win.isDestroyed()) win.webContents.send('nim:test-wake', null);   // the room again
      if (process.env.NIM_SELFTEST_QUIT) app.quit();
    }
  })();

  const registered = [];
  globalShortcut.register('CommandOrControl+Alt+N', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else { win.show(); win.setAlwaysOnTop(true, 'screen-saver'); }
  });

  globalShortcut.register('CommandOrControl+Alt+Space', () => {
    if (!win) return;
    if (!win.isVisible()) win.show();
    win.webContents.send('nim:open-input');
  });

  // talk to it from anywhere, without taking focus from what you are doing
  globalShortcut.register('CommandOrControl+Alt+V', () => {
    if (!win) return;
    if (!win.isVisible()) win.show();
    win.webContents.send('nim:listen');
  });

  /* Another app can already own a shortcut, in which case registering it does
   * nothing at all and says nothing about it. Fall back rather than leave the
   * user pressing a key that will never work. */
  if (!globalShortcut.isRegistered('CommandOrControl+Alt+Space')) {
    globalShortcut.register('CommandOrControl+Alt+T', () => {
      if (!win) return;
      if (!win.isVisible()) win.show();
      win.webContents.send('nim:open-input');
    });
  }
  for (const accel of ['CommandOrControl+Alt+N', 'CommandOrControl+Alt+Space',
                       'CommandOrControl+Alt+T', 'CommandOrControl+Alt+V']) {
    if (globalShortcut.isRegistered(accel)) registered.push(accel);
  }
  console.log('[nim] shortcuts working:', registered.join(' '));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  whisper.stop();
  bridge.stop();
  ollama.shutdown();
  if (automate) automate.stop();
});
app.on('window-all-closed', () => app.quit());
