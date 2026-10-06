'use strict';
/*
 * Health breaks: after an hour at the computer without a rest, Nim stretches
 * and reminds you to rest your eyes, drink water or stand up. A real rest -
 * the PC locked, or five minutes away from the keyboard and mouse - starts
 * the hour again, so it never nags someone who has just come back.
 *
 * Pure: fed the time and how long you have been idle, it says when a break
 * is due and which one (test/life.test.js).
 */

const REST_SECONDS = 300;     // this long untouched counts as having had a break

const MESSAGES = [
  { kind: 'eyes', text: 'Time to rest your eyes: look at something far away for twenty seconds.' },
  { kind: 'water', text: 'You have been at it for an hour. A glass of water?' },
  { kind: 'stretch', text: 'Stretch break! Stand up, roll your shoulders, and come back.' },
  { kind: 'posture', text: 'Quick check: sit back, shoulders down, and blink a few times.' },
  { kind: 'walk', text: 'An hour already. Take a short walk - I will keep your spot.' }
];

function createBreaks(opts) {
  const now = (opts && opts.now) || Date.now;
  let every = ((opts && opts.minutes) || 60) * 60000;
  let since = now();          // when the current stretch at the computer began
  let next = 0;

  /* idleSeconds: how long since the last key or mouse movement; locked: the PC is locked. */
  function note(idleSeconds, locked) {
    if (locked || idleSeconds >= REST_SECONDS) since = now();
  }

  /* A message when a break is due (and the hour starts again), else null. */
  function due(paused) {
    if (paused) return null;                   // focusing, gaming: later
    if (now() - since < every) return null;
    since = now();
    const m = MESSAGES[next % MESSAGES.length];
    next++;
    return m;
  }

  return {
    note, due,
    setMinutes: (m) => { every = Math.max(15, Math.min(240, Number(m) || 60)) * 60000; },
    get minutesAtIt() { return Math.floor((now() - since) / 60000); }
  };
}

module.exports = { createBreaks, MESSAGES, REST_SECONDS };
