'use strict';
/*
 * Dancing only to songs. Made-up songs and real recorded speech are put through
 * a copy of the browser's audio analyser (music-sim.js), and the tracker has
 * to tell them apart - at 60 frames a second and at 144, as screens differ.
 */
const h = require('./helpers');
const { createBeatTracker, kindOf, isSong, bandsFrom } = require('../src/desktop/music.js');
const sim = require('./music-sim');

/* Plays frames through a fresh tracker; how much of the time (after the first
 * five seconds) it called it a song, given what the title says. */
function play(frames, kind) {
  const t = createBeatTracker();
  let judged = 0, song = 0, last = null;
  for (const f of frames) {
    last = t.push(f.bands, f.t);
    if (f.t > 5000) { judged++; if (isSong(last, kind || '')) song++; }
  }
  return { share: judged ? song / judged : 0, last };
}
const pct = (r) => Math.round(r.share * 100) + '% (continuity ' + r.last.continuity.toFixed(2) + ', ' + r.last.beat + ' hits)';

h.section('the 24 bands');
{
  const flat = new Float32Array(512).fill(-60);
  const b = bandsFrom(flat, 48000, 1024);
  h.check('a flat spectrum gives flat bands', b.length === 24 && b.every((v) => Math.abs(v + 60) < 0.01), b.map((v) => v.toFixed(1)).join(' '));
}

h.section('songs are songs');
for (const bpm of [75, 100, 128, 170]) {
  const r = play(sim.framesOf(sim.synthSong(bpm, 14, { seed: bpm }), 60));
  h.check(bpm + ' BPM: a song nearly all the time', r.share > 0.9, pct(r));
}
{
  const r = play(sim.framesOf(sim.synthSong(90, 14, { drums: false }), 60));
  h.check('a mellow song with no drums is still a song', r.share > 0.9, pct(r));
  const quiet = play(sim.framesOf(sim.synthSong(110, 14, { volume: 0.02 }), 60));
  h.check('turned down low, still a song', quiet.share > 0.9, pct(quiet));
  const fast = play(sim.framesOf(sim.synthSong(120, 14), 144));
  h.check('at 144 frames a second too', fast.share > 0.9, pct(fast));
  const hits = fast.last.beat / 14;
  h.check('the drums are felt: one to four hits a second at 120 BPM', hits >= 1 && hits <= 4, hits.toFixed(2) + '/s');
}

h.section('the beat grid lands on the beat');
for (const [bpm, fps] of [[75, 60], [100, 60], [120, 144], [128, 60], [140, 144]]) {
  const t = createBeatTracker();
  let r = null;
  for (const f of sim.framesOf(sim.synthSong(bpm, 12, { seed: bpm + fps }), fps)) r = t.push(f.bands, f.t);
  const beat = 60000 / bpm;
  let off = ((r.beatAt % beat) + beat) % beat;
  if (off > beat / 2) off -= beat;
  h.check(bpm + ' BPM at ' + fps + ' fps: tempo within 1%, beats within 20 ms',
    Math.abs(r.beatPeriod / beat - 1) < 0.01 && Math.abs(off) <= 20,
    'x' + (r.beatPeriod / beat).toFixed(3) + ', ' + off.toFixed(0) + ' ms');
}

{
  // kick and snare equally loud: the grid must pick one and stay with it
  const t = createBeatTracker();
  let lastAt = 0, moves = 0, grids = 0, r = null;
  for (const fr of sim.framesOf(sim.synthSong(96, 24, { snare: true, seed: 3 }), 60)) {
    r = t.push(fr.bands, fr.t);
    if (r.beatAt && r.beatAt !== lastAt) {
      if (lastAt && fr.t > 6000) {
        let ph = ((r.beatAt - lastAt) / r.beatPeriod) % 1;
        if (ph < 0) ph += 1;
        if (ph > 0.5) ph -= 1;
        grids++;
        if (Math.abs(ph * r.beatPeriod) > 60) moves++;
      }
      lastAt = r.beatAt;
    }
  }
  h.check('kick and snare as loud as each other: the beat does not flip between them', grids > 20 && moves <= 1, moves + ' moves in ' + grids + ' updates');
}

h.section('lyrics lined up with the singing');
{
  const { alignLyrics } = require('../src/desktop/music.js');
  for (const bpm of [84, 100]) {
    const beat = 60 / bpm, secs = 60;
    const t = createBeatTracker(), heard = [];
    for (const fr of sim.framesOf(sim.synthSong(bpm, secs, { seed: bpm }), 60)) heard.push({ t: fr.t / 1000, v: t.push(fr.bands, fr.t).vocal });
    const sung = [];
    for (let k = 0; k * 8 * beat < secs; k++) sung.push(k * 8 * beat);       // the sung phrases start every two bars
    for (const off of [-1.5, 0, 1.2]) {
      const r = alignLyrics(heard.slice(300), sung.map((x, i) => ({ t: x + off, text: 'line ' + i })));
      h.check(bpm + ' BPM, lyric file ' + (off > 0 ? off + ' s late' : off < 0 ? -off + ' s early' : 'right') + ': put right',
        r && Math.abs(r.shift + off) <= 0.25 && r.sure > 2.4, JSON.stringify(r));
    }
  }
}

h.section('talking is not');
if (!sim.speechFiles().length) {
  h.skip('real speech', 'test/fixtures/wake is not here');
} else {
  for (let i = 0; i < 4; i++) {
    const fps = i % 2 ? 144 : 60;
    const r = play(sim.framesOf(sim.talkStream(25, 11 + i * 7), fps));
    h.check('talking, run ' + (i + 1) + ' at ' + fps + ' fps: never a song', r.share === 0, pct(r));
  }
  const quick = play(sim.framesOf(sim.talkStream(25, 5, 0.1), 60));
  h.check('a fast talker with hardly a pause: not a song', quick.share === 0, pct(quick));
  // the rule that keeps the dance from starting on a talking video, even when
  // the title says "music" - a hint never overrides the sound
  const hinted = play(sim.framesOf(sim.talkStream(25, 3), 60), 'song');
  h.check('talking with a song-like title: still not a song', hinted.share === 0, pct(hinted));
}

h.section('silence, and too soon to say');
{
  const silence = play(sim.framesOf(new Float32Array(sim.RATE * 10), 60));
  h.check('silence: not a song', silence.share === 0, pct(silence));
  // when it starts: how long from the first note until it counts as a song
  const startsAt = (kind) => {
    const t = createBeatTracker();
    for (const f of sim.framesOf(sim.synthSong(120, 6), 60)) if (isSong(t.push(f.bands, f.t), kind)) return f.t;
    return Infinity;
  };
  const hinted = startsAt('song'), unhinted = startsAt('');
  h.check('titled as a song: dancing within 2 s', hinted <= 2000, Math.round(hinted) + ' ms');
  h.check('no title hint: within 3.5 s, but not in the first second', unhinted <= 3500 && unhinted > 1000, Math.round(unhinted) + ' ms');

  // when it ends: a song, then the sound stops
  const song = sim.synthSong(120, 8);
  const both = new Float32Array(song.length + sim.RATE * 2);
  both.set(song);
  const t = createBeatTracker();
  let stoppedAt = Infinity;
  for (const f of sim.framesOf(both, 60)) {
    const r = t.push(f.bands, f.t);
    if (f.t > 8000 && r.silent && stoppedAt === Infinity) stoppedAt = f.t;
  }
  h.check('the song stops: it knows within half a second', stoppedAt - 8000 <= 500, Math.round(stoppedAt - 8000) + ' ms');
  const vetoed = play(sim.framesOf(sim.synthSong(120, 14), 60), 'talk');
  h.check('a title that says "stream" or "podcast" rules it out', vetoed.share === 0, pct(vetoed));
}

h.section('what the title says');
const KINDS = [
  [{ title: 'Katy Perry - Harleys In Hawaii (Official)', artist: 'KatyPerryVEVO', app: 'Brave' }, 'song'],
  [{ title: 'Stay Mashup (Sush & Yohan) - The Kid LAROI & Justin Bieber', artist: 'Sush & Yohan Music', app: 'Brave' }, 'song'],
  [{ title: 'Kesariya (Lyrics) - Arijit Singh', artist: 'Sony Music India', app: 'Chrome' }, 'song'],
  [{ title: 'Blinding Lights', artist: 'The Weeknd', app: 'Spotify' }, 'song'],
  [{ title: 'Blinding Lights', artist: 'The Weeknd - Topic', app: 'Brave' }, 'song'],
  [{ title: 'Ranked stream', artist: 'TenZ', app: 'Brave' }, 'talk'],
  [{ title: 'Episode 214: Sleep and memory', artist: 'Huberman Lab', app: 'Spotify' }, 'talk'],
  [{ title: 'Minecraft Gameplay Part 3', artist: 'Someone', app: 'Chrome' }, 'talk'],
  [{ title: 'How transformers work, explained', artist: '3Blue1Brown', app: 'Edge' }, 'talk'],
  [{ title: 'My day in Tokyo', artist: 'A traveller', app: 'Brave' }, ''],
  [null, '']
];
for (const [media, want] of KINDS) {
  const got = kindOf(media);
  h.check((media ? JSON.stringify(media.title) : 'nothing') + ' -> ' + (want || 'no hint'), got === want, got);
}
const MORE_TALK = [
  { title: 'GE vs. LOUD — VALORANT Champions Shanghai — Group Stage', artist: 'VALORANT Champions Tour', app: 'Brave' },
  { title: 'Pushpa 2 - Official Trailer', artist: 'Mythri Movie Makers', app: 'Chrome' },
  { title: 'India vs Australia full match', artist: 'Star Sports', app: 'Brave' }
];
for (const media of MORE_TALK) h.check(JSON.stringify(media.title) + ' -> talk', kindOf(media) === 'talk', kindOf(media));
h.check('"Official Trailer" is not "Official Video"', kindOf({ title: 'Official Trailer', artist: 'X', app: 'Brave' }) === 'talk');
h.check('a Spotify song called "We Are The Champions" is still a song', kindOf({ title: 'We Are The Champions', artist: 'Queen', app: 'Spotify' }) === 'song');

h.section('a browser video has to show it is a song');
const { danceKind } = require('../src/desktop/music.js');
const vlog = { title: 'My day in Tokyo', artist: 'A traveller', app: 'Brave' };
h.check('a browser video nobody has called a song: no dance', danceKind(vlog, {}) === 'video');
h.check('its lyrics found: a song', danceKind(vlog, { lyrics: true }) === 'song');
h.check('the local model calls it music: the sound decides', danceKind(vlog, { check: true }) === '');
h.check('the local model says not music: no dance', danceKind(vlog, { check: false }) === 'video');
h.check('a song title in a browser is still a song', danceKind({ title: 'Kesariya (Lyrics) - Arijit Singh', artist: 'Sony Music India', app: 'Chrome' }, {}) === 'song');
h.check('Spotify: the sound decides, as before', danceKind({ title: 'Blinding Lights', artist: 'The Weeknd', app: 'Spotify' }, {}) === 'song' &&
  danceKind({ title: 'Untitled', artist: 'Someone', app: 'VLC' }, {}) === '');
const songLike = { silent: false, loud: -40, dips: 0.05, heard: 300 };
h.check('sound like a song, but a video not shown to be one: no dance', isSong(songLike, '') && !isSong(songLike, 'video'));

h.finish();
