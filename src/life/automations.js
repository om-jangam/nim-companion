'use strict';
/*
 * Automations: things Nim does by itself, once you have set them up.
 *
 *   routine    say a phrase and several things happen: "study mode"
 *   schedule   at a time, on some days: "weekdays at 9:00 - open Spotify"
 *   trigger    when something happens: an app opens, you lock or unlock the
 *              PC, you come back, a game starts or ends, the battery runs
 *              low, the charger goes in, a download finishes
 *
 * Every step is one of a fixed menu of acts (ACTS below), turned into an
 * ordinary plan for the agent - so it goes through the validator and the
 * runtime like anything you ask for, and anything risky still asks you first.
 * An automation cannot name a tool or write arguments of its own.
 *
 * Pure: it says what to run and when, and does nothing itself
 * (test/automations.test.js).
 */

const MAX_STEPS = 6;
const MAX_AUTOMATIONS = 40;
const GRACE_MIN = 15;              // a schedule missed by more than this (the PC was off) waits for tomorrow

/* ---- the menu of steps ---------------------------------------------------------
 * value: what the one box beside it holds (null: nothing to fill in). */
const ACTS = {
  'open-app':     { label: 'Open an app', value: 'app', example: 'Spotify', step: (v) => ({ tool: 'app.launch', args: { name: v } }) },
  'close-app':    { label: 'Close an app', value: 'app', example: 'Valorant', step: (v) => ({ tool: 'app.close', args: { name: v } }) },
  'open-site':    { label: 'Open a website', value: 'site', example: 'youtube.com', step: (v) => ({ tool: 'browser.open', args: { url: siteUrl(v) } }) },
  'play-music':   { label: 'Play music', value: 'search', example: 'lofi beats', step: (v) => ({ tool: 'media.play', args: { query: v } }) },
  'pause-music':  { label: 'Pause music', value: null, needs: 'playing', step: () => ({ tool: 'media.pause', args: {} }) },
  'resume-music': { label: 'Resume music (if I paused it)', value: null, needs: 'pausedByNim', step: () => ({ tool: 'media.resume', args: {} }) },
  'volume':       { label: 'Set the volume', value: 'percent', example: '30', step: (v) => ({ tool: 'system.volume', args: { action: 'set', level: num(v, 0, 100, 30) } }) },
  'mute':         { label: 'Mute', value: null, step: () => ({ tool: 'system.volume', args: { action: 'mute' } }) },
  'focus':        { label: 'Start a focus timer', value: 'minutes', example: '25', step: (v) => ({ tool: 'focus.start', args: { minutes: num(v, 5, 180, 25) } }) },
  'quiet':        { label: 'Quiet mode', value: 'minutes', example: '60', step: (v) => ({ tool: 'nim.quiet', args: { minutes: num(v, 5, 600, 60) } }) },
  'saver':        { label: 'Battery saver', value: 'onoff', example: 'on', step: (v) => ({ tool: 'nim.saver', args: { state: /^off$/i.test(String(v).trim()) ? 'off' : 'on' } }) },
  'say':          { label: 'Say something', value: 'text', example: 'Time to study!', step: (v, ev) => ({ tool: 'say', args: { text: fill(v, ev) } }) },
  'weather':      { label: 'Tell me the weather', value: null, step: () => ({ tool: 'weather.now', args: {} }) },
  'briefing':     { label: 'My daily briefing', value: null, step: () => ({ tool: 'briefing.now', args: {} }) },
  'open-folder':  { label: 'Open a folder', value: 'folder', example: 'Downloads', step: (v) => ({ tool: 'folder.open', args: { dir: v } }) },
  'lock':         { label: 'Lock the PC', value: null, step: () => ({ tool: 'system.lock', args: {} }) }
};

/* ---- what can set one off ------------------------------------------------------- */
const EVENTS = {
  app: { label: 'I open an app', value: 'app' },
  lock: { label: 'I lock the PC' },
  unlock: { label: 'I unlock the PC' },
  back: { label: 'I come back to the PC' },
  'game-start': { label: 'A game goes full screen' },
  'game-end': { label: 'The game is closed' },
  'battery-low': { label: 'The battery is low' },
  charging: { label: 'I plug in the charger' },
  download: { label: 'A download finishes' }
};
const DAYS = { every: 'Every day', weekdays: 'Weekdays', weekends: 'Weekends' };

/* Words that already mean something to Nim on their own. */
const RESERVED = /^(yes|yeah|no|nope|ok|okay|confirm|cancel|stop|nevermind|never mind|hey|hi|hello|nim|hey nim)$/;

/* ---- small helpers ---------------------------------------------------------------- */
function num(v, lo, hi, dflt) {
  const n = Math.round(Number(String(v === undefined || v === null ? '' : v).replace(/[^\d.]/g, '')));
  return Number.isFinite(n) && String(v).trim() !== '' ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/* "youtube" or "youtube.com" or a full address -> an https address. */
function siteUrl(v) {
  let s = String(v || '').trim();
  if (!/^https?:\/\//i.test(s)) {
    s = s.replace(/^www\./i, '');
    if (!/\.[a-z]{2,}(\/|$)/i.test(s)) s = s.replace(/\s+/g, '') + '.com';
    s = 'https://' + s;
  }
  return s;
}

/* {file}, {app} and {name} in a line to say: filled from what happened. */
function fill(text, ev) {
  ev = ev || {};
  const safe = (x) => String(x || '').replace(/[^\p{L}\p{N} ._()&'-]/gu, '').slice(0, 60).trim();
  return String(text || '')
    .replace(/\{file\}/g, safe(ev.file) || 'a file')
    .replace(/\{app\}/g, safe(ev.app) || 'that app')
    .replace(/\s*\{name\}/g, ev.name ? ', ' + safe(ev.name) : '')
    .trim();
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/* One line of plain text: no control characters, no markup. */
function text(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

/* ---- checking what is saved ---------------------------------------------------------
 * Everything that comes in - from the settings window, or a file edited by
 * hand - goes through here. { ok: true, value } or { ok: false, error }. */
function clean(def) {
  if (!def || typeof def !== 'object') return { ok: false, error: 'not an automation' };
  const out = {};
  out.id = /^[a-z0-9-]{1,24}$/.test(String(def.id || '')) ? def.id : null;
  out.name = text(def.name, 40).replace(/[{}]/g, '');
  if (!out.name) return { ok: false, error: 'give it a name' };
  out.on = def.on !== false;

  const w = def.when || {};
  if (w.type === 'phrase') {
    const phrase = norm(w.phrase).slice(0, 40);
    if (phrase.length < 3) return { ok: false, error: 'the phrase is too short' };
    if (RESERVED.test(phrase)) return { ok: false, error: '"' + phrase + '" already means something to Nim' };
    out.when = { type: 'phrase', phrase };
  } else if (w.type === 'time') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(w.at || '').trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, error: 'the time should look like 09:30' };
    out.when = { type: 'time', at: String(m[1]).padStart(2, '0') + ':' + m[2], days: DAYS[w.days] ? w.days : 'every' };
  } else if (w.type === 'event') {
    if (!EVENTS[w.event]) return { ok: false, error: 'not something Nim can notice' };
    out.when = { type: 'event', event: w.event };
    if (w.event === 'app') {
      const app = text(w.app, 40).replace(/[{}]/g, '');
      if (!app) return { ok: false, error: 'which app?' };
      out.when.app = app;
    }
  } else return { ok: false, error: 'say when it should happen' };

  if (!Array.isArray(def.do) || !def.do.length) return { ok: false, error: 'give it something to do' };
  if (def.do.length > MAX_STEPS) return { ok: false, error: 'at most ' + MAX_STEPS + ' steps' };
  out.do = [];
  for (const raw of def.do) {
    const act = raw && ACTS[raw.act];
    if (!act) return { ok: false, error: 'not a step Nim knows' };
    const step = { act: raw.act };
    if (act.value) {
      const v = text(raw.value, act.value === 'text' ? 200 : 100);
      if (!v && ['app', 'site', 'search', 'text', 'folder'].includes(act.value)) return { ok: false, error: act.label.toLowerCase() + ': fill in the box' };
      step.value = v;
    }
    out.do.push(step);
  }
  return { ok: true, value: out };
}

/* ---- in words, for the settings window and for Nim to say ------------------------------ */
function describeWhen(def) {
  const w = def.when || {};
  if (w.type === 'phrase') return 'When you say "' + w.phrase + '"';
  if (w.type === 'time') return (DAYS[w.days] || 'Every day') + ' at ' + w.at;
  if (w.type === 'event') {
    if (w.event === 'app') return 'When you open ' + w.app;
    const what = EVENTS[w.event].label.replace(/^I /, 'you ');
    return 'When ' + what.charAt(0).toLowerCase() + what.slice(1);
  }
  return '';
}

/* The steps in words; a line to say is shown as it will sound ("{name}" is
 * your name, "{file}" the file's). */
function describeSteps(def, name) {
  return (def.do || []).map((s) => {
    const a = ACTS[s.act];
    if (!a) return '';
    if (!a.value) return a.label;
    if (a.value === 'minutes') return a.label + ' (' + num(s.value, 1, 600, Number(a.example)) + ' min)';
    if (a.value === 'percent') return a.label + ' to ' + num(s.value, 0, 100, 30) + '%';
    if (a.value === 'text') return a.label + ': "' + fill(s.value, { name, file: 'the file name', app: 'the app' }) + '"';
    return a.label + ': ' + s.value;
  }).filter(Boolean).join(', ');
}

/* ---- finding the ones to run ---------------------------------------------------------- */

const LEAD = /^(?:(?:hey\s+)?nim\s+|please\s+|ok(?:ay)?\s+)*(?:(?:run|start|begin|do|activate|enable|switch\s+to|turn\s+on|go|time\s+for|let'?s\s+do|lets\s+do|let'?s\s+start)\s+)?(?:the\s+|my\s+)?/;
const TAIL = /\s+(?:please|now|routine|automation)$/;

/* A routine's phrase said (when it is switched on), or any automation asked
 * for by its name: "run morning start" runs it now, whatever its trigger. */
function matchPhrase(said, list) {
  const raw = norm(said);
  if (!raw) return null;
  const s = raw.replace(LEAD, '').replace(TAIL, '').trim();
  const named = /^(?:(?:hey\s+)?nim\s+|please\s+)*(?:run|start|activate|do)\s+/.test(raw);
  for (const a of list || []) {
    if (a && a.on && a.when && a.when.type === 'phrase' && (s === a.when.phrase || raw === a.when.phrase)) return a;
  }
  if (named) for (const a of list || []) if (a && s === norm(a.name)) return a;
  return null;
}

function localDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function dayFits(days, d) {
  const wd = d.getDay();               // 0 Sunday .. 6 Saturday
  if (days === 'weekdays') return wd >= 1 && wd <= 5;
  if (days === 'weekends') return wd === 0 || wd === 6;
  return true;
}

/* Schedules due now: on, today one of their days, the time reached within the
 * last quarter of an hour, and not run yet today. */
function dueNow(list, now, lastRuns) {
  const d = now instanceof Date ? now : new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const today = localDay(d);
  return (list || []).filter((a) => {
    if (!a || !a.on || !a.when || a.when.type !== 'time') return false;
    if (!dayFits(a.when.days, d)) return false;
    const [h, m] = a.when.at.split(':').map(Number);
    const late = mins - (h * 60 + m);
    return late >= 0 && late < GRACE_MIN && (lastRuns || {})[a.id] !== today;
  });
}

/* "Valorant" against the process "VALORANT-Win64-Shipping", "VS Code" against "Code". */
const ALIASES = { code: 'vscode', msedge: 'edge', winword: 'word', powerpnt: 'powerpoint', excel: 'excel', 'vs code': 'vscode', 'visual studio code': 'vscode', 'microsoft edge': 'edge' };
function appKey(s) {
  const n = String(s || '').toLowerCase().trim();
  return (ALIASES[n] || n).replace(/[^a-z0-9]/g, '');
}
function appMatches(want, process) {
  const w = appKey(want), p = appKey(process);
  if (!w || !p) return false;
  return p === w || (w.length >= 3 && p.includes(w)) || (p.length >= 4 && w.includes(p));
}

function forEvent(list, event, data) {
  return (list || []).filter((a) => a && a.on && a.when && a.when.type === 'event' && a.when.event === event &&
    (event !== 'app' || appMatches(a.when.app, data && data.app)));
}

/* ---- the plan --------------------------------------------------------------------------
 * state: { playing, pausedByNim, event: { file, app }, name }. Steps whose
 * moment has passed are left out - no "pause" when nothing plays, no "resume"
 * for music Nim did not pause. Nothing left: null, nothing to run. */
function planFor(def, state) {
  state = state || {};
  const ev = Object.assign({ name: state.name }, state.event || {});
  const steps = [];
  for (const s of def.do || []) {
    const act = ACTS[s.act];
    if (!act) continue;
    if (act.needs === 'playing' && !state.playing) continue;
    if (act.needs === 'pausedByNim' && (!state.pausedByNim || state.playing)) continue;
    const st = act.step(s.value, ev);
    steps.push({ id: 's' + (steps.length + 1), tool: st.tool, args: st.args, dependsOn: [] });
  }
  if (!steps.length) return null;
  return { intent: steps.length > 1 ? 'multi_step_task' : 'command', goal: def.name, reply: '', steps };
}

/* ---- the starter set -------------------------------------------------------------------
 * Routines only run when you say them; the triggers on here are gentle ones.
 * The schedules start switched off - only you know your times. */
const STARTERS = [
  { id: 'study-mode', name: 'Study mode', on: true, when: { type: 'phrase', phrase: 'study mode' },
    do: [{ act: 'focus', value: '25' }, { act: 'play-music', value: 'lofi hip hop study music' }, { act: 'say', value: 'Study mode on{name}. You got this!' }] },
  { id: 'good-night', name: 'Good night', on: true, when: { type: 'phrase', phrase: 'good night' },
    do: [{ act: 'pause-music' }, { act: 'volume', value: '20' }, { act: 'say', value: 'Good night{name}. Sleep well!' }] },
  { id: 'lock-pause', name: 'Pause music when I lock the PC', on: true, when: { type: 'event', event: 'lock' },
    do: [{ act: 'pause-music' }] },
  { id: 'unlock-resume', name: 'Resume it when I unlock', on: true, when: { type: 'event', event: 'unlock' },
    do: [{ act: 'resume-music' }] },
  { id: 'battery-saver', name: 'Save power when the battery is low', on: true, when: { type: 'event', event: 'battery-low' },
    do: [{ act: 'saver', value: 'on' }, { act: 'say', value: 'Battery is low - please plug in the charger. I am saving power.' }] },
  { id: 'charger-in', name: 'Back to normal on the charger', on: true, when: { type: 'event', event: 'charging' },
    do: [{ act: 'saver', value: 'off' }] },
  { id: 'download-done', name: 'Tell me when a download finishes', on: true, when: { type: 'event', event: 'download' },
    do: [{ act: 'say', value: 'Download finished: {file}' }] },
  { id: 'morning', name: 'Morning start', on: false, when: { type: 'time', at: '08:30', days: 'weekdays' },
    do: [{ act: 'briefing' }] },
  { id: 'bedtime', name: 'Bedtime reminder', on: false, when: { type: 'time', at: '23:30', days: 'every' },
    do: [{ act: 'say', value: 'It is late{name}. Time to wind down and get some sleep.' }] },
  { id: 'coding-music', name: 'Music when I start coding', on: false, when: { type: 'event', event: 'app', app: 'VS Code' },
    do: [{ act: 'play-music', value: 'lofi coding music' }] }
];

function starters() { return STARTERS.map((a) => clean(a).value); }

module.exports = {
  ACTS, EVENTS, DAYS, MAX_STEPS, MAX_AUTOMATIONS,
  clean, describeWhen, describeSteps, matchPhrase, dueNow, forEvent, planFor, appMatches, localDay, starters, siteUrl, fill
};
