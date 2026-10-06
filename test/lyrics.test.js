'use strict';
/*
 * Lyrics: reading timed lyrics, cleaning YouTube titles into a song and an
 * artist, and picking the right recording - against a pretend lyrics service,
 * so nothing goes over the network.
 */
const h = require('./helpers');
const { find, cleanQuery, parseLrc } = require('../src/media/lyrics');

h.section('timed lyrics are read in order');
{
  const lines = parseLrc('[00:12.50] second\n[00:03.00] first\nno stamp here\n[01:02.25][01:30.00] chorus');
  h.check('four timed lines', lines.length === 4, JSON.stringify(lines));
  h.check('in order of time', lines[0].text === 'first' && lines[0].t === 3 && lines[1].t === 12.5);
  h.check('a repeated chorus appears at both times', lines[2].t === 62.25 && lines[3].t === 90 && lines[3].text === 'chorus');
}

h.section('titles become a song and an artist');
const CASES = [
  [{ title: 'Katy Perry - Harleys In Hawaii (Official)', artist: 'KatyPerryVEVO' }, 'Harleys In Hawaii', 'Katy Perry'],
  [{ title: '[M/V] LIM KIM - Confess To You :: King the Land OST Part.2', artist: 'MOSTCONTENTS' }, 'Confess To You', 'LIM KIM'],
  [{ title: 'Blinding Lights', artist: 'The Weeknd - Topic' }, 'Blinding Lights', 'The Weeknd'],
  [{ title: 'Shape of You ft. Someone (Lyric Video)', artist: 'Ed Sheeran' }, 'Shape of You', 'Ed Sheeran']
];
for (const [media, track, artist] of CASES) {
  const q = cleanQuery(media);
  h.check(JSON.stringify(media.title) + ' -> ' + track + ' by ' + artist, q.track === track && q.artist === artist, JSON.stringify(q));
}
h.check('"Song - Artist" comes back the other way round too',
  JSON.stringify(cleanQuery({ title: 'Kesariya (Lyrics) - Arijit Singh', artist: 'Sony' }).swapped) === JSON.stringify({ track: 'Kesariya', artist: 'Arijit Singh' }));

h.section('the right recording, or none');
(async () => {
  const asked = [];
  const service = (results) => async (url) => {
    asked.push(decodeURIComponent(url));
    return { ok: true, json: async () => results(url) };
  };
  const lrc = '[00:01.00] hello';
  const live = { duration: 260, syncedLyrics: '[00:01.00] live version' };
  const studio = { duration: 201, syncedLyrics: lrc };

  let lines = await find({ title: 'Song A', artist: 'Band', length: 200 }, { fetch: service(() => [live, studio]) });
  h.check('the one within 3 s of the length wins', lines && lines[0].text === 'hello', JSON.stringify(lines));

  lines = await find({ title: 'Song B', artist: 'Band', length: 200 }, { fetch: service(() => [live]) });
  h.check('a recording of a different length is not sung over', lines === null);

  asked.length = 0;
  lines = await find({ title: 'Kesariya - Arijit Singh', artist: 'Label', length: 268 },
    { fetch: service((url) => /track_name=Kesariya/.test(decodeURIComponent(url)) ? [{ duration: 268, syncedLyrics: lrc }] : []) });
  h.check('the other way round is tried too, and found', lines && asked.some((u) => u.includes('track_name=Kesariya') && u.includes('artist_name=Arijit')), asked.join(' | '));

  // the best of everything found, not the first near enough
  lines = await find({ title: 'Ed Sheeran - Perfect (Official Music Video)', artist: 'Ed Sheeran', length: 282 },
    { fetch: service((url) => /q=/.test(url)
      ? [{ id: 2, trackName: 'Ed Sheeran - Perfect (Official Music Video)', duration: 282, syncedLyrics: '[00:20.70] video timing' }]
      : [{ id: 1, trackName: 'Perfect', duration: 280, syncedLyrics: '[00:03.00] other timing' }]) });
  h.check('a music video gets the lyrics timed to the video', lines && lines[0].text === 'video timing', JSON.stringify(lines));
  lines = await find({ title: 'Song D', artist: 'Band', length: 200 }, { fetch: service(() => [{ id: 9, syncedLyrics: '[00:01.00] no length' }]) });
  h.check('lyrics whose length is unknown are not trusted', lines === null);

  lines = await find({ title: 'Song C', artist: 'Band', length: 200 }, { fetch: async () => { throw new Error('offline'); } });
  h.check('offline: simply no lyrics', lines === null);

  h.check('only the song, artist and length are asked about', asked.every((u) => !new RegExp('user|path|home|' + require('os').userInfo().username, 'i').test(u)), asked.join(' | '));
  h.finish();
})();
