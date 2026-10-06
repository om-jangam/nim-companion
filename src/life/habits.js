'use strict';
/*
 * Learning your habits, so Nim can offer to do them for you.
 *
 * Nim notes which apps you bring to the front, and when: the app's name and
 * the time - not window titles, not anything in them. It is kept on this PC
 * (memory/habits.json) for four weeks, and switching "Learn my habits" off
 * deletes it.
 *
 * When the first time you open an app each day falls at about the same time
 * on at least four of the last fourteen days, Nim offers to do it for you:
 * "You open Spotify around 9:00 most days - shall I open it for you?" Yes
 * makes a schedule; no is remembered and not offered again.
 *
 * Pure (test/habits.test.js).
 */
const { appMatches, localDay } = require('./automations');

const KEEP_DAYS = 28;
const LOOK_DAYS = 14;
const MIN_DAYS = 4;
const WINDOW_MIN = 45;
const MAX_EVENTS = 4000;

// Windows' own parts, Nim itself, terminals - not things anyone opens as a habit
const IGNORE = /^(explorer|electron|nim|searchhost|searchapp|searchui|shellexperiencehost|startmenuexperiencehost|lockapp|applicationframehost|textinputhost|systemsettings|taskmgr|dwm|csrss|winlogon|rundll32|consent|sihost|ctfmon|runtimebroker|idle|system|powershell|pwsh|cmd|conhost|windowsterminal|openconsole|claude|ollama|ollama app)$/i;

const DISPLAY = {
  code: 'VS Code', msedge: 'Edge', winword: 'Word', powerpnt: 'PowerPoint', excel: 'Excel', chrome: 'Chrome',
  brave: 'Brave', firefox: 'Firefox', spotify: 'Spotify', discord: 'Discord', whatsapp: 'WhatsApp', notepad: 'Notepad',
  'ms-teams': 'Teams', teams: 'Teams', obs64: 'OBS', steam: 'Steam', telegram: 'Telegram', vlc: 'VLC', zoom: 'Zoom'
};

/* The name to show and to open it by: "Code" -> "VS Code", "spotify" -> "Spotify". */
function displayName(process) {
  const p = String(process || '').trim();
  return DISPLAY[p.toLowerCase()] || (p.charAt(0).toUpperCase() + p.slice(1));
}

/* An app came to the front at time t. Old entries fall away. */
function record(store, app, t) {
  store = store || {};
  if (!app || IGNORE.test(String(app).trim())) return store;
  const cut = t - KEEP_DAYS * 86400000;
  store.events = (store.events || []).filter((e) => e && e.t >= cut);
  store.events.push({ a: String(app).trim().slice(0, 60), t });
  if (store.events.length > MAX_EVENTS) store.events = store.events.slice(-MAX_EVENTS);
  return store;
}

function hhmm(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }

/* The habit most worth offering, or null.
 *   skip: apps already automated, or offered and turned down */
function suggest(store, now, skip) {
  const since = now - LOOK_DAYS * 86400000;
  const byApp = {};
  for (const e of (store && store.events) || []) {
    if (!e || e.t < since || e.t > now) continue;
    const d = new Date(e.t);
    const day = localDay(d);
    const k = String(e.a).toLowerCase();
    const min = d.getHours() * 60 + d.getMinutes();
    byApp[k] = byApp[k] || { name: e.a, days: {} };
    // only the first time each day: that is the habit ("I open it at 9")
    if (!byApp[k].days[day] || min < byApp[k].days[day].min) byApp[k].days[day] = { min, wd: d.getDay() };
  }
  let best = null;
  for (const k of Object.keys(byApp)) {
    if ((skip || []).some((s) => appMatches(s, k))) continue;
    const days = Object.values(byApp[k].days).sort((a, b) => a.min - b.min);
    if (days.length < MIN_DAYS) continue;
    // the most days whose first opening falls inside one 45-minute window
    let lo = 0;
    for (let hi = 0; hi < days.length; hi++) {
      while (days[hi].min - days[lo].min > WINDOW_MIN) lo++;
      const n = hi - lo + 1;
      if (n < MIN_DAYS || (best && n <= best.count)) continue;
      const group = days.slice(lo, hi + 1);
      const mins = group.map((g) => g.min);
      const at = Math.floor(mins[Math.floor(mins.length / 2)] / 5) * 5;
      best = {
        app: displayName(byApp[k].name), process: byApp[k].name, count: n, at: hhmm(at),
        days: group.every((g) => g.wd >= 1 && g.wd <= 5) ? 'weekdays' : 'every'
      };
    }
  }
  return best;
}

module.exports = { record, suggest, displayName, IGNORE, MIN_DAYS };
