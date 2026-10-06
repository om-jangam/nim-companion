'use strict';
/*
 * The song check: the local model sorts a browser video from its title and
 * channel; only "music" lets Nim dance to it. Run against a stand-in for
 * Ollama, so it needs neither the model nor the network.
 */
const h = require('./helpers');
const { isMusic } = require('../src/media/songcheck');

function fakeOllama(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (answer instanceof Error) throw answer;
    return { ok: true, json: async () => ({ message: { content: JSON.stringify(answer) } }) };
  };
  return { fetch, calls };
}

(async () => {
  h.section('what the model says decides');
  let o = fakeOllama({ kind: 'music' });
  h.check('"music" -> a song', await isMusic({ title: 'Tum Hi Ho', artist: 'T-Series' }, { fetch: o.fetch }) === true);
  o = fakeOllama({ kind: 'gaming' });
  h.check('anything else -> not a song', await isMusic({ title: 'GE vs. LOUD — Group Stage', artist: 'VALORANT Champions Tour' }, { fetch: o.fetch }) === false);
  o = fakeOllama({ kind: 'dance now!' });
  h.check('an answer outside the list counts as no answer', await isMusic({ title: 'Odd one', artist: 'X' }, { fetch: o.fetch }) === null);
  o = fakeOllama(new Error('connection refused'));
  h.check('Ollama not running: no answer (and so no dance)', await isMusic({ title: 'Some video', artist: 'Y' }, { fetch: o.fetch }) === null);

  h.section('what is sent, and how often');
  o = fakeOllama({ kind: 'talk' });
  await isMusic({ title: 'My day in Tokyo', artist: 'A traveller', lines: ['secret'], app: 'Brave' }, { fetch: o.fetch });
  const sent = JSON.stringify(o.calls[0].body.messages);
  h.check('only the title and the channel go to the model', /My day in Tokyo/.test(sent) && /A traveller/.test(sent) && !/secret|Brave/.test(sent));
  h.check('to the model on this computer', /^http:\/\/127\.0\.0\.1:11434\//.test(o.calls[0].url));
  h.check('held to the list of kinds', Array.isArray(o.calls[0].body.format.properties.kind.enum));
  await isMusic({ title: 'My day in Tokyo', artist: 'A traveller' }, { fetch: o.fetch });
  h.check('asked once per video', o.calls.length === 1);
  o = fakeOllama(new Error('busy'));
  await isMusic({ title: 'Asked again later', artist: 'Z' }, { fetch: o.fetch });
  await isMusic({ title: 'Asked again later', artist: 'Z' }, { fetch: o.fetch });
  h.check('no answer is not remembered: asked again next time', o.calls.length === 2);

  h.finish();
})().catch((e) => { console.error(e); process.exit(1); });
