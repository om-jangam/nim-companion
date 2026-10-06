'use strict';
/*
 * Extra spellings of "Hey Nim" for one person's voice.
 *
 * Whisper writes an unfamiliar name as the nearest thing it knows, and what
 * that is depends on the voice - one person's "Hey Nim" is "Hini", another's
 * "Henny". These are kept, as words, in config.json ("wakeVariants"), learned
 * from "Teach me your voice" or typed in by hand.
 *
 * Words only, short, and never something people say to each other all day: a
 * spelling made only of everyday words ("he named", "her name") would wake Nim
 * in ordinary conversation, so it is refused.
 */
const COMMON = new Set(['her name', 'his name', 'the name', 'a name', 'name', 'him', 'them', 'me', 'he', 'hey',
  'hi', 'honey', 'money', 'any', 'hey man', 'hey mom', 'hi mom', 'hey him', 'okay', 'ok', 'yes', 'no']);

const EVERYDAY = new Set(['a', 'an', 'the', 'he', 'she', 'his', 'her', 'him', 'me', 'my', 'i', 'it', 'is', 'in', 'on',
  'and', 'you', 'we', 'they', 'them', 'then', 'than', 'that', 'this', 'who', 'what', 'now', 'new', 'no', 'yes', 'ok',
  'okay', 'hi', 'hey', 'hello', 'name', 'named', 'names', 'need', 'needs', 'knee', 'mean', 'means', 'been', 'keen',
  'any', 'many', 'money', 'honey', 'one', 'nine', 'game', 'same', 'came', 'nice', 'nope', 'yeah', 'man', 'mom',
  'pain', 'pay', 'hang', 'hand', 'hen', 'hint', 'hit', 'hold', 'go', 'do', 'to', 'too', 'two']);

/** Clean a list of spellings: lower case words, short, never everyday phrases; at most eight. */
function clean(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const v = String(raw).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    if (v.length < 3 || v.length > 20 || v.split(' ').length > 3 || COMMON.has(v)) continue;
    if (v.split(' ').every((w) => EVERYDAY.has(w))) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 8);
}

/** Add newly learned spellings to the known ones: { all, added }. */
function merge(known, learned) {
  const before = clean(known);
  const added = clean(learned).filter((v) => !before.includes(v));
  return { all: clean(before.concat(added)), added };
}

module.exports = { clean, merge };
