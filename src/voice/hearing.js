'use strict';
/*
 * The kinds of listening Nim does, and how Whisper is set up for each. Shared
 * by the app (main.js) and the audio tests, so what is measured is what runs.
 *
 *   head     the first second and a half of something heard in the room: is it
 *            addressed to Nim? Primed with the name; background work; quick
 *            (no retries).
 *   full     the whole of something addressed to Nim, or push-to-talk. Primed
 *            with the name, because people say it even when holding the button.
 *            Someone is waiting: it goes ahead of wake checks.
 *   scan     a long stretch that might hold the name later on. Background, quick.
 *   command  the whole utterance, unprimed: the rescue when the primed pass
 *            stopped at the name.
 *
 * The words Whisper is primed with are fixed here; a window can only ask for
 * a kind of listening, never put words of its own into Whisper's arguments.
 */
const WAKE_HINT = 'Hey Nim.';

/* For the whole sentence, the name and the words people actually say to Nim.
 * Whisper treats the prompt as what came just before, so it leans towards
 * these spellings: measured on accented voices, "Open brain" became "Open
 * Brave" and "Voluma" became "volume up" (requests heard right: 55/66 -> 60/66),
 * with no false wakes in 300 sentences that were not for Nim. */
const COMMAND_HINT = 'Hey Nim, open Brave. Open Spotify, Chrome, VS Code, WhatsApp. Volume up. Volume down. ' +
  'Mute. Take a screenshot. What time is it? Search for';

/* accurate: the bigger model, when it is installed - for what you ask, not for
 * the background checks for the name */
const HEARING = {
  head: { prompt: WAKE_HINT, fast: true },
  full: { prompt: COMMAND_HINT, urgent: true, accurate: true },
  scan: { prompt: WAKE_HINT, fast: true },
  command: { urgent: true, accurate: true }
};

function settingsFor(kind) { return HEARING[kind] || HEARING.command; }

module.exports = { HEARING, WAKE_HINT, COMMAND_HINT, settingsFor };
