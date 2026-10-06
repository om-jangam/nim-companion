'use strict';
/*
 * Lyrics for the song that is playing, timed line by line.
 *
 * From LRCLIB (lrclib.net): a free, open lyrics library - no account, no key,
 * nothing paid, no AI. What is sent is only what Windows says is playing: the
 * song's name, the artist and its length. Nothing else about you or your
 * computer. Off with "Show lyrics" in the tray menu (config: lyrics: false).
 *
 * Results are kept in memory for the session, so a song is looked up once.
 */

const API = 'https://lrclib.net/api';
const TIMEOUT_MS = 7000;
const cache = new Map();                // key -> lines | null

/* YouTube titles carry the artist and a lot of decoration: "Katy Perry -
 * Harleys In Hawaii (Official Video)" from "KatyPerryVEVO", "[M/V] LIM KIM -
 * Confess To You :: King the Land OST". Pull out the song and the artist as a
 * lyrics library would know them. "A - B" can be either way round, so the
 * other reading comes back too, as `swapped`. */
const DECORATION = /[([{【][^)\]}】]*\b(official|lyrics?|video|audio|visuali[sz]er|hd|4k|remaster(ed)?|m\s*\/\s*v|mv|full song|teaser|live|eng sub|sub|ost|prod)\b[^)\]}】]*[)\]}】]/gi;
const LABELS = /\b(sony music|t-series|tseries|zee music|saregama|tips (music|official)|yrf|yash raj|speed records|desi music factory|universal music|times music|eros now|venus|white hill|geet mp3|aditya music|lahari|think music|sun music|hybe labels|smtown|jyp|yg entertainment|mostcontents)\b/i;

function cleanQuery(media) {
  let title = String((media && media.title) || '');
  let artist = String((media && media.artist) || '');
  artist = artist.replace(/vevo$/i, '').replace(/\s*-\s*topic$/i, '').replace(/\b(official|music|records|india|entertainment)\b/gi, '').trim();
  title = title
    .replace(DECORATION, '')
    .replace(/\s*(\||::|\/\/).*$/, '')
    .replace(/\s+(ft\.?|feat\.?)\s.*$/i, '')
    .replace(/\s*\b(m\s*\/\s*v|mv)\s*$/i, '')
    // "Bulleya Full Video - ADHM", "Kesariya Video Song", "... Lyrical"
    .replace(/\s*\b(full video|video song|full song|lyrical video|lyrical|official video|official audio|audio song|lyric video|lyrics)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '')           // a dash left hanging by what was taken off
    .trim();
  // a record label's channel is not the singer
  if (LABELS.test(String((media && media.artist) || ''))) artist = '';
  const words = title;
  let swapped = null;
  // "A - B", and the careless "A -B" / "A- B"
  const dash = title.match(/^(.+?)(?:\s+[-–—]\s*|\s*[-–—]\s+)(.+)$/);
  if (dash) {
    // "Artist - Song", usually; trust the side that matches the channel
    const a = dash[1].trim(), b = dash[2].trim();
    if (artist && b.toLowerCase().includes(artist.toLowerCase().split(' ')[0])) { title = a; artist = b; swapped = { track: b, artist: a }; }
    else { swapped = { track: a, artist: b }; artist = a; title = b; }
  }
  return { track: title.trim(), artist: artist.trim(), swapped, words };
}

/* "[01:02.50] words" -> [{ t: 62.5, text: 'words' }], in order. */
function parseLrc(lrc) {
  const lines = [];
  String(lrc || '').split(/\r?\n/).forEach((line) => {
    const stamps = [...line.matchAll(/\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g)];
    if (!stamps.length) return;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    stamps.forEach((m) => lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text }));
  });
  return lines.sort((a, b) => a.t - b.t);
}

async function getJson(url, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await (fetchImpl || fetch)(url, { signal: ctl.signal, headers: { 'User-Agent': 'Nim (a local desktop companion)' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

/* The best timed lyrics for what is playing, or null. Prefers a match on
 * length (within 4 s) so a live version or a remix is not sung over. */
async function find(media, opts = {}) {
  const q = cleanQuery(media);
  if (!q.track) return null;
  const len = Number(media.length) || 0;
  // "Ranjha – Official Video | Shershaah | B Praak | Jasleen Royal": the names after the bars
  const singers = String(media.title || '').split('|').slice(1).map((p) => p.trim().toLowerCase()).filter((p) => p.length > 2 && p.length < 40);
  const key = (q.words + '|' + q.artist + '|' + Math.round(len / 5)).toLowerCase();
  if (cache.has(key)) return cache.get(key);

  // the likeliest reading first, then the other way round, then a plain search
  const tries = [];
  tries.push(q.artist ? { track_name: q.track, artist_name: q.artist } : { track_name: q.track });
  if (q.swapped) tries.push({ track_name: q.swapped.track, artist_name: q.swapped.artist });
  tries.push({ q: q.words });
  // every candidate from every search, then the best of them all - the first
  // near enough is not good enough: "Perfect" at 280 s is not the music video
  // at 282 s, and the video's own lyrics are timed to its intro
  const found = new Map();
  for (const params of tries) {
    const list = await getJson(API + '/search?' + new URLSearchParams(params), opts.fetch);
    if (!Array.isArray(list)) continue;
    list.forEach((r) => { if (r && r.syncedLyrics && !r.instrumental) found.set(r.id || (r.trackName + '|' + r.duration), r); });
  }
  const video = /\b(video|mv)\b/i.test(String(media.title || ''));
  const rank = (r) => {
    const off = Math.abs((r.duration || 0) - len);
    let score = off;
    if (off <= 1) score -= 1;                                                      // to the second
    if (singers.some((n) => String(r.artistName || '').toLowerCase().includes(n))) score -= 2;
    if (video && /\b(video|mv)\b/i.test(String(r.trackName || ''))) score -= 3;     // the video's own timing
    return score;
  };
  const timed = [...found.values()];
  timed.sort((a, b) => rank(a) - rank(b));
  const pick = timed[0];
  // the same recording: within 3 seconds of its length, so a live take, a remix
  // or a video with a long intro is not sung over. A length must be known.
  let best = null;
  if (pick && (!len || (pick.duration && Math.abs(pick.duration - len) <= 3))) best = parseLrc(pick.syncedLyrics);
  const lines = best && best.length ? best : null;
  cache.set(key, lines);
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return lines;
}

module.exports = { find, cleanQuery, parseLrc };
