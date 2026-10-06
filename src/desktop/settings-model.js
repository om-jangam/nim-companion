'use strict';
/*
 * What the settings window may change, and to what.
 *
 * The window sends (key, value); nothing reaches the config unless the key is
 * listed here and the value is one this key can take. A text box cannot set
 * the model Nim thinks with, add a project folder, or switch off a safety
 * rule - those keys are simply not here.
 */
const SKINS = ['aurora', 'ocean', 'candy', 'sunset', 'mint', 'lilac', 'rose', 'midnight'];

const SETTINGS = {
  // you
  name: { kind: 'text', max: 30 },
  city: { kind: 'text', max: 60 },
  // voice
  wakeWord: { kind: 'bool' },
  followUp: { kind: 'bool' },
  rate: { kind: 'number', min: 0.75, max: 1.35 },
  // music
  danceToMusic: { kind: 'bool' },
  lyrics: { kind: 'bool' },
  // looking after you
  dailyBriefing: { kind: 'bool' },
  healthBreaks: { kind: 'bool' },
  breakMinutes: { kind: 'choice', of: [30, 45, 60, 90] },
  pcHealth: { kind: 'bool' },
  clipboardHelper: { kind: 'bool' },
  hideWhenFullscreen: { kind: 'bool' },
  learnHabits: { kind: 'bool' },
  // look
  skin: { kind: 'choice', of: SKINS },
  size: { kind: 'choice', of: ['normal', 'small'] },
  passThrough: { kind: 'bool' },
  // the computer
  startWithWindows: { kind: 'bool' }
};

/** { ok: true, value } with the value as it will be saved, or { ok: false }. */
function clean(key, value) {
  const s = Object.prototype.hasOwnProperty.call(SETTINGS, key) ? SETTINGS[key] : null;
  if (!s) return { ok: false };
  if (s.kind === 'bool') return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
  if (s.kind === 'number') {
    const n = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(n)) return { ok: false };
    return { ok: true, value: Math.round(Math.min(s.max, Math.max(s.min, n)) * 100) / 100 };
  }
  if (s.kind === 'choice') return s.of.includes(value) ? { ok: true, value } : { ok: false };
  if (s.kind === 'text') {
    if (typeof value !== 'string') return { ok: false };
    // letters, spaces and a little punctuation: a name or a city, nothing else
    const v = value.replace(/[^\p{L}\p{N} .,'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, s.max);
    return { ok: true, value: v };
  }
  return { ok: false };
}

/** The values the window shows, read from the config. */
function view(config, extra) {
  return Object.assign({
    name: config.name || '',
    city: config.city || '',
    wakeWord: !!config.wakeWord,
    followUp: config.followUp !== false,
    rate: Number.isFinite(Number(config.rate)) ? Number(config.rate) : 1,
    danceToMusic: config.danceToMusic !== false,
    lyrics: config.lyrics !== false,
    dailyBriefing: config.dailyBriefing !== false,
    healthBreaks: config.healthBreaks !== false,
    breakMinutes: SETTINGS.breakMinutes.of.includes(config.breakMinutes) ? config.breakMinutes : 60,
    pcHealth: config.pcHealth !== false,
    clipboardHelper: config.clipboardHelper !== false,
    hideWhenFullscreen: config.hideWhenFullscreen !== false,
    learnHabits: config.learnHabits !== false,
    skin: (config.outfit && SKINS.includes(config.outfit.skin)) ? config.outfit.skin : 'aurora',
    size: config.size === 'small' ? 'small' : 'normal',
    passThrough: config.passThrough !== false
  }, extra || {});
}

module.exports = { SETTINGS, SKINS, clean, view };
