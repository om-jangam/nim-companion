'use strict';
/*
 * A song's mood (Qwen on this PC, or the lyrics' own words) and the actions a
 * sung line asks for. Qwen is pretended here: nothing goes over the network.
 */
const h = require('./helpers');
const { songMood, moodFromWords } = require('../src/media/mood');
const { actsFor } = require('../src/desktop/music.js');

h.section('acting out a line');
const LINES = [
  ['I just wanna dance all night under the moon', ['dance', 'night']],
  ['Tum hi ho, mera dil', ['love']],
  ['मेरा दिल तेरे लिए', ['love']],
  ['눈물이 나', ['cry']],
  ['Hey, set the world on fire', ['fire', 'hey']],
  ['Boy, tell me, can you take my breath away?', []],
  ['Uptown funk you up', ['jump']]
];
for (const [line, want] of LINES) {
  const got = actsFor(line);
  h.check(JSON.stringify(line) + ' -> ' + (want.join(', ') || 'nothing'), JSON.stringify(got) === JSON.stringify(want), got.join(', '));
}

h.section('the mood from the words');
h.check('a love song', moodFromWords('my love, my heart, I love you baby') === 'romantic');
h.check('a sad one', moodFromWords('tears fall, I cry alone tonight, the pain') === 'sad');
h.check('one mention is not enough to say', moodFromWords('a song about a car and a heart') === null);

h.section('the mood from Qwen');
(async () => {
  const qwen = (content, ok = true) => async (url, req) => String(url).includes('/api/ps')
    ? { ok: true, json: async () => ({ models: [{ name: 'qwen2.5:3b' }] }) }
    : {
        ok,
        json: async () => ({ message: { content: typeof content === 'function' ? content(JSON.parse(req.body)) : content } })
      };
  let asked = null;
  let r = await songMood({ key: 'a', title: 'Song', artist: 'Band', lines: [{ t: 1, text: 'hello' }] },
    { fetch: qwen((body) => { asked = body; return '{"mood":"party"}'; }) });
  h.check('it answers with one of the seven', r && r.mood === 'party' && r.by === 'qwen', JSON.stringify(r));
  h.check('held to them by the schema', asked && JSON.stringify(asked.format.properties.mood.enum) === JSON.stringify(['romantic', 'sad', 'party', 'happy', 'chill', 'angry', 'epic']));

  r = await songMood({ key: 'b', title: 'Song', lines: [{ t: 1, text: 'love love my heart' }] }, { fetch: qwen('{"mood":"rm -rf"}') });
  h.check('anything else is thrown away (and the words decide)', r && r.mood === 'romantic' && r.by === 'words', JSON.stringify(r));

  r = await songMood({ key: 'c', title: 'Plain', lines: [] }, { fetch: async () => { throw new Error('not running'); } });
  h.check('no Qwen, no telling words: no mood', r === null);

  let calls = 0;
  const counting = async (url) => {
    if (String(url).includes('/api/ps')) return { ok: true, json: async () => ({ models: [{ name: 'qwen2.5:3b' }] }) };
    calls++; return { ok: true, json: async () => ({ message: { content: '{"mood":"chill"}' } }) };
  };
  await songMood({ key: 'd', title: 'Once' }, { fetch: counting });
  await songMood({ key: 'd', title: 'Once' }, { fetch: counting });
  h.check('asked once per song', calls === 1, calls);
  r = await songMood({ key: 'e', title: 'Cold', lines: [{ t: 1, text: 'love my heart, my love' }] },
    { fetch: async (url) => String(url).includes('/api/ps') ? { ok: true, json: async () => ({ models: [] }) } : (() => { throw new Error('should not be asked'); })() });
  h.check('Qwen not loaded: not woken up for this, the words decide', r && r.by === 'words', JSON.stringify(r));
  h.finish();
})();
