'use strict';
/*
 * What "it", "that" and "there" mean right now.
 *
 * People talk to Nim the way they talk to a person: "Open Brave." then "Search
 * for Electron." then "Save that to a file." The second only makes sense in
 * the browser the first one opened; the third only makes sense if Nim kept
 * what the search found. This is where that is kept - the last browser, page,
 * file and app, and the last thing a step produced - and only for this run of
 * Nim: it is never written to disk, and it fades after a while, so "that"
 * cannot reach back to something from an hour ago.
 *
 * Steps refer to the last result as {{last}}. The validator only allows that
 * reference when there is a last result; when there is not, the planner is
 * told so, and asks you what you mean instead of guessing.
 */

const FRESH_MS = 15 * 60 * 1000;

let ctx = blank();

function blank() {
  return { browser: null, url: null, query: null, file: null, folder: null, app: null, last: null, at: 0 };
}

function stale() { return ctx.at && Date.now() - ctx.at > FRESH_MS; }

/** The current context, or an empty one if it has gone stale. */
function get() {
  if (stale()) ctx = blank();
  return Object.assign({}, ctx);
}

/** Merge what a finished step tells us. `last` is { text, what } - what kind of thing it is. */
function update(partial) {
  if (!partial || typeof partial !== 'object') return get();
  if (stale()) ctx = blank();
  for (const k of ['browser', 'url', 'query', 'file', 'folder', 'app']) {
    if (typeof partial[k] === 'string' && partial[k]) ctx[k] = partial[k].slice(0, 500);
  }
  if (partial.last && typeof partial.last.text === 'string' && partial.last.text.trim()) {
    ctx.last = { text: partial.last.text.slice(0, 40000), what: String(partial.last.what || 'result').slice(0, 80) };
  }
  ctx.at = Date.now();
  return get();
}

function reset() { ctx = blank(); }

/** A few plain lines for the planner: what "that" and "there" would refer to. */
function describe() {
  const c = get();
  const lines = [];
  if (c.browser) lines.push('The browser in use is ' + c.browser + '.');
  if (c.url) lines.push('The last page opened: ' + c.url);
  if (c.query) lines.push('The last search: "' + c.query + '"');
  if (c.app) lines.push('The last app opened: ' + c.app);
  if (c.file) lines.push('The last file: ' + c.file);
  if (c.folder) lines.push('The last folder: ' + c.folder);
  if (c.last) {
    lines.push('The last result (' + c.last.what + ', ' + c.last.text.length + ' characters) can be used in a step as "{{last}}".');
  } else {
    lines.push('There is no previous result: "{{last}}" cannot be used. If the user says "that" or "it" and nothing above fits, ask.');
  }
  return lines.join('\n');
}

module.exports = { get, update, reset, describe, FRESH_MS };
