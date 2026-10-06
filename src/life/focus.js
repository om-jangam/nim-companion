'use strict';
/*
 * The focus timer (Pomodoro): work for a while, then a short break, and every
 * fourth time a longer one. Nim stays quiet and calm while you focus, shows
 * the time left, and cheers when it is up.
 *
 * Pure: the clock is passed in, and what happens is told through onChange, so
 * it is tested directly (test/life.test.js).
 */

const SHORT_BREAK = 5, LONG_BREAK = 15, LONG_EVERY = 4;

function createFocus(opts) {
  const now = (opts && opts.now) || Date.now;
  const onChange = (opts && opts.onChange) || function () {};
  let state = null;          // { phase: 'focus' | 'break', minutes, label, startedAt, until }
  let done = 0;              // focus sessions finished in a row

  function start(minutes, label) {
    const m = Math.max(1, Math.min(180, Math.round(Number(minutes) || 25)));
    state = { phase: 'focus', minutes: m, label: String(label || '').slice(0, 60), startedAt: now(), until: now() + m * 60000 };
    onChange(view(), 'started');
    return view();
  }

  function stop() {
    if (!state) return null;
    const was = view();
    state = null;
    onChange(null, 'stopped');
    return was;
  }

  function view() {
    if (!state) return null;
    return Object.assign({}, state, { left: Math.max(0, state.until - now()) });
  }

  /* Called every few seconds: a focus that is up becomes a break; a break
   * that is up ends it all. */
  function tick() {
    if (!state || now() < state.until) return null;
    if (state.phase === 'focus') {
      done++;
      const rest = done % LONG_EVERY === 0 ? LONG_BREAK : SHORT_BREAK;
      state = { phase: 'break', minutes: rest, label: '', startedAt: now(), until: now() + rest * 60000, after: done };
      onChange(view(), 'focus_done');
      return 'focus_done';
    }
    state = null;
    onChange(null, 'break_done');
    return 'break_done';
  }

  return { start, stop, view, tick, get active() { return !!state; } };
}

/* "25 minutes", "an hour", "half an hour", "1.5 hours" -> minutes. */
function minutesIn(text) {
  const s = String(text || '').toLowerCase();
  if (/half an? hour/.test(s)) return 30;
  if (/\ban? hour\b/.test(s)) return 60;
  let m = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/.exec(s);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /(\d+)\s*(?:m|min|mins|minutes?)\b/.exec(s);
  if (m) return Number(m[1]);
  m = /\b(\d{1,3})\b/.exec(s);
  return m ? Number(m[1]) : null;
}

module.exports = { createFocus, minutesIn, SHORT_BREAK, LONG_BREAK };
