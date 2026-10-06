'use strict';
/*
 * Matching what someone said against names Nim knows - apps, sites, folders -
 * when what they said is not spelled the way the name is.
 *
 * People mistype, and Whisper mishears: "spotifi", "vs code", "brayve",
 * "googel chrome". Instead of a list of every wrong spelling, a name is
 * compared the way a person would compare it: exact, then the start of the
 * name, then every word present, then letters out of place (edit distance
 * with transpositions, scaled to the length of the word). Short words must
 * match closely; long ones may be a little further off.
 *
 * A small table of everyday short names ("vs code", "chrome", "calc") covers
 * what is genuinely a different word rather than a different spelling.
 */

const ALIASES = {
  'vs code': 'visual studio code', 'vscode': 'visual studio code', 'code': 'visual studio code',
  'chrome': 'google chrome', 'edge': 'microsoft edge', 'explorer': 'file explorer', 'files': 'file explorer',
  'my files': 'file explorer', 'calc': 'calculator', 'cmd': 'command prompt', 'command line': 'command prompt',
  'store': 'microsoft store', 'teams': 'microsoft teams', 'outlook': 'outlook', 'ms word': 'word',
  'microsoft word': 'word', 'ms excel': 'excel', 'microsoft excel': 'excel', 'powerpoint': 'powerpoint',
  'whatsapp': 'whatsapp', 'whats app': 'whatsapp', 'brave browser': 'brave', 'vlc': 'vlc media player',
  'control panel': 'control panel', 'task manager': 'task manager', 'settings': 'settings'
};

function normalize(s) {
  return String(s || '').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Damerau-Levenshtein (optimal string alignment): insertions, deletions,
 * substitutions and swapped neighbours each cost one. */
function distance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/* How many mistakes a word of this length can carry and still be that word. */
function allowed(len) { return len <= 3 ? 0 : len <= 5 ? 1 : len <= 9 ? 2 : 3; }

/** 0..1: how well `query` names `name`. */
function score(query, name) {
  const q = normalize(ALIASES[normalize(query)] || query);
  const n = normalize(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  const compactQ = q.replace(/ /g, ''), compactN = n.replace(/ /g, '');
  if (compactQ === compactN) return 0.98;                     // "what s app" / "whatsapp"
  if (n.startsWith(q + ' ') || (q.length >= 4 && n.startsWith(q))) return 0.93;
  const qw = q.split(' '), nw = n.split(' ');
  if (qw.every((w) => nw.includes(w))) return 0.9;
  // spelling: the whole name, or the word of the name it most resembles
  const whole = distance(compactQ, compactN);
  if (whole <= allowed(compactN.length)) return 0.88 - whole * 0.04;
  if (qw.length === 1) {
    for (const w of nw) {
      if (w.length < 4) continue;
      const dw = distance(compactQ, w);
      if (dw <= allowed(w.length) && dw < w.length / 2) return 0.8 - dw * 0.05;
    }
  }
  return 0;
}

/**
 * best(query, items, nameOf) -> { item, score } or null
 * The best-scoring item at or above `min` (default 0.7).
 */
function best(query, items, nameOf, min) {
  let top = null;
  for (const item of items || []) {
    const s = score(query, nameOf ? nameOf(item) : item);
    if (s > 0 && (!top || s > top.score)) top = { item, score: s };
  }
  return top && top.score >= (min || 0.7) ? top : null;
}

module.exports = { normalize, distance, score, best, ALIASES };
