'use strict';
/*
 * Reminders: "remind me in 20 minutes to call Mum", "remind me at 5 pm".
 *
 * Kept in memory/reminders.json, a plain file you can read and edit, so they
 * survive a restart. When one comes due Nim says it out loud and shows a
 * Windows notification; one that came due while Nim was closed is said as soon
 * as it starts, marked as late.
 *
 * Times are worked out here, by plain rules, from what was said - never left
 * to a model to calculate.
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = process.env.NIM_REMINDERS_FILE || path.join(__dirname, '..', '..', 'memory', 'reminders.json');
const MAX_DELAY = 2147483647;         // what setTimeout can hold (~24.8 days)

let items = null;
const timers = new Map();
let onDue = null, onChange = null;

function load() {
  if (items) return items;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    items = Array.isArray(data.reminders) ? data.reminders.filter((r) => r && r.id && r.text && Number.isFinite(r.at)) : [];
  } catch {
    items = [];
  }
  return items;
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({
    _about: 'Reminders you asked Nim for. Times are milliseconds since 1970; edit or delete freely.',
    reminders: items
  }, null, 2));
  if (onChange) onChange(items.length);
}

const UNITS = { second: 1000, sec: 1000, minute: 60000, min: 60000, hour: 3600000, hr: 3600000, day: 86400000, week: 604800000 };
const WORD_NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, half: 0.5, couple: 2, few: 3 };

/**
 * When, from words. `now` is a Date (passed in so this can be tested).
 * Returns a timestamp, or null if it cannot tell.
 */
function parseWhen(text, now) {
  const s = String(text || '').toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  now = now || new Date();

  // "in 10 minutes", "in an hour", "in half an hour", "in 2 and a half hours"
  let m = /\b(?:in|after)\s+(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty five|forty|fifty|sixty|half an?|a couple of|a few)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b/.exec(s);
  if (m) {
    const word = m[1].replace(/^half an?$/, 'half').replace(/^a couple of$/, 'couple').replace(/^a few$/, 'few');
    const n = /^\d/.test(word) ? Number(word) : WORD_NUMBERS[word];
    const unit = UNITS[m[2].replace(/s$/, '').replace(/^mins?$/, 'min').replace(/^secs?$/, 'sec').replace(/^hrs?$/, 'hr')];
    if (n && unit) return now.getTime() + Math.round(n * unit);
  }

  // "at 5", "at 5 pm", "at 17:30", "at 5:15pm", "tomorrow at 9", "at noon"
  const day = new Date(now.getTime());
  let tomorrow = /\btomorrow\b/.test(s);
  if (/\btonight\b/.test(s) && !/\bat\b/.test(s)) { day.setHours(20, 0, 0, 0); return day.getTime() > now.getTime() ? day.getTime() : null; }
  if (/\b(?:at\s+)?noon\b/.test(s)) m = ['', '12', '00', 'pm'];
  else if (/\b(?:at\s+)?midnight\b/.test(s)) { m = ['', '12', '00', 'am']; if (!tomorrow) tomorrow = true; }
  else m = /\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m)?\b/.exec(s) || /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/.exec(s);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    const ampm = (m[3] || '').replace(/\s/g, '');
    if (h > 23 || min > 59) return null;
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    day.setHours(h, min, 0, 0);
    if (tomorrow) day.setDate(day.getDate() + 1);
    else if (day.getTime() <= now.getTime()) {
      // "at 5" said at 3 pm means 5 pm; said at 6 pm, tomorrow morning
      if (!ampm && h < 12 && day.getTime() + 12 * 3600000 > now.getTime()) day.setHours(h + 12);
      else day.setDate(day.getDate() + 1);
    }
    return day.getTime();
  }
  if (tomorrow) { day.setDate(day.getDate() + 1); day.setHours(9, 0, 0, 0); return day.getTime(); }
  return null;
}

function schedule(r) {
  clearTimeout(timers.get(r.id));
  const wait = r.at - Date.now();
  if (wait <= 0) { fire(r, true); return; }
  timers.set(r.id, setTimeout(() => (r.at - Date.now() > 1000 ? schedule(r) : fire(r, false)), Math.min(wait, MAX_DELAY)));
}

function fire(r, late) {
  timers.delete(r.id);
  items = load().filter((x) => x.id !== r.id);
  save();
  if (onDue) onDue(r, late && Date.now() - r.at > 60000);
}

/** Begin: load what was saved and set every timer. */
function start(handlers) {
  onDue = (handlers && handlers.onDue) || onDue;
  onChange = (handlers && handlers.onChange) || onChange;
  for (const r of load().slice()) schedule(r);
  if (onChange) onChange(load().length);
}

function add(text, at) {
  const clean = String(text || '').trim().replace(/^to\s+/i, '').replace(/[.!]+$/, '');
  if (!clean) throw new Error('there is nothing to remind you about');
  if (clean.length > 300) throw new Error('that is too long for a reminder');
  if (!Number.isFinite(at) || at < Date.now() - 1000) throw new Error('that time has already passed');
  if (at - Date.now() > 366 * 86400000) throw new Error('that is more than a year away');
  const r = { id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), text: clean, at, created: Date.now() };
  load().push(r);
  save();
  schedule(r);
  return r;
}

function list() { return load().slice().sort((a, b) => a.at - b.at); }

function cancel(query) {
  const all = /^(?:all|everything|all of them|them all)$/i.test(String(query || '').trim());
  const words = String(query || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const gone = load().filter((r) => all || words.some((w) => r.text.toLowerCase().includes(w)));
  if (!gone.length) return [];
  for (const r of gone) clearTimeout(timers.get(r.id));
  items = load().filter((r) => !gone.includes(r));
  save();
  return gone;
}

function when(at, now) {
  const d = new Date(at), n = now || new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(n).setHours(0, 0, 0, 0)) / 86400000);
  return days === 0 ? 'at ' + time : days === 1 ? 'tomorrow at ' + time : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) + ' at ' + time;
}

module.exports = { parseWhen, start, add, list, cancel, when, FILE, _reset: () => { items = null; for (const t of timers.values()) clearTimeout(t); timers.clear(); } };
