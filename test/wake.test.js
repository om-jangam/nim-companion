'use strict';
/*
 * What wakes Nim, and - just as important - what does not.
 *
 * The first half is the text check: given what Whisper wrote, was it
 * addressed to Nim? The second half runs the real two-pass decision (the same
 * function the app uses) against scripted transcripts, so each rule about
 * when to trust which pass is pinned down. test/wake-audio.test.js does the
 * same against real audio and real Whisper.
 */
global.performance = global.performance || { now: () => Date.now() };
const h = require('./helpers');
const { createWake } = require('../src/desktop/wake.js');
const wc = (t, v) => createWake.wakeCommand(t, v);

h.section('wakes, and separates the request from the name');
[
  ['Hey Nim, open YouTube.',           'open YouTube.'],
  ['Hey, Nim, open YouTube.',          'open YouTube.'],
  ['Hey Nim.',                         ''],
  ['Hey Nim, what time is it?',        'what time is it?'],
  ['Hi Nim, what time is it?',         'what time is it?'],
  ['Hey, him, turn down the volume.',  'turn down the volume.'],
  ['Hey name, open YouTube.',          'open YouTube.'],
  ['Hey Neem, play some music.',       'play some music.'],
  ['He Nim, volume down.',             'volume down.'],
  ['Hay Nim, open Spotify.',           'open Spotify.'],
  ['Heynim, open Brave',               'open Brave'],
  ['Nim, open YouTube.',               'open YouTube.'],
  ['Nim. Open YouTube.',               'Open YouTube.'],
  ['Nim open YouTube',                 'open YouTube'],
  ['Nim what time is it',              'what time is it'],
  ['Nim take a screenshot',            'take a screenshot'],
  ['Nim',                              ''],
  ['Nim.',                             ''],
  ['Name.',                            ''],
  ['OK Nim, mute.',                    'mute.']
].forEach(([said, want]) => h.check('"' + said + '"', wc(said) === want, 'got ' + JSON.stringify(wc(said))));

h.section('does not wake on ordinary speech');
[
  'Thank you.',
  'I was telling my friend about the weather today.',
  'I was telling my friend about something.',
  'Could you open the window please?',
  'The nimble fox jumped over it.',
  'I gave him the documentation.',
  'Name the file notes.',
  'Okay, name the file notes.',
  'Ok, named the file notes',
  'Her name is Priya.',
  'We should trim the list down a bit.',
  'him, open youtube',
  'Nimble fingers make light work.',
  'Ask Nim to open YouTube later.',
  'Hey Neil, open the door.',
  'Honey, can you get the door?',
  'He needs more time.',
  'Hey guys, welcome to my video.',
  'Hope to see you in the next video.',
  'Hey man, how are you?',
  'Hi Nina, how was the trip?',
  'Henny is coming over tonight.',
  'Neem leaves are good for the skin.',
  'Hymns were sung at the church.'
].forEach((said) => h.check('ignores "' + said + '"', wc(said) === null, 'got ' + JSON.stringify(wc(said))));

h.section('spellings learned from one person\'s voice');
h.check('"Hini" is not the name for everyone', wc('Hini, open Brave') === null);
h.check('but is for someone whose "Hey Nim" sounds like it', wc('Hini, open Brave', ['hini']) === 'open Brave');
h.check('still only at the start', wc('I said hini open brave', ['hini']) === null);

h.section('the name opening a later sentence counts; the middle of one never does');
h.check('"...next video. Hey Nim, open Brave."', createWake.wakeInSentences('Hope to see you in the next video. Hey Nim, open Brave.') === 'open Brave.');
h.check('"...tell Nim to open Brave."', createWake.wakeInSentences('So I said tell Nim to open Brave.') === null);

h.section('which pass to trust');
const cases = [
  ['Hey Nim.', 'Hain him. Open brave.', 'Open brave.'],
  ['Hey Nim.', 'Take a screenshot.', 'Take a screenshot.'],
  ['Hey Nim, what', 'What time is it?', 'What time is it?'],
  ['Nim.', 'Open YouTube.', 'Open YouTube.'],
  ['Nim.', 'Nib', ''],
  ['Hey Nim.', "Ain't him volume down.", 'volume down.'],
  ['Hey Nim.', 'I was telling my friend about something.', null],
  ['Hey, Nim.', 'Hey Nail, open the door.', null],
  ['Ok, Nim.', 'Ok, named the file notes', null],
  ['Hey Nim, open', 'So anyway the weather', null]
];
for (const [head, full, want] of cases) {
  const got = createWake.droppedGreeting(head, full, []);
  h.check('short "' + head + '", full "' + full + '" -> ' + JSON.stringify(want), got === want, 'got ' + JSON.stringify(got));
}

h.section('what continues a conversation without the name');
[['search for Electron', true], ['what about tomorrow?', true], ['and open Spotify too', true], ['thanks', true],
 ['So today we are going to look at the map', false], ["We're going to get a new one.", false],
 ['Hope to see you in the next video.', false]].forEach(([t, want]) =>
  h.check((want ? 'continues: ' : 'does not: ') + '"' + t + '"', createWake.conversational(t) === want));

h.section('the two-pass decision, with scripted transcripts');
function scripted(script) {
  const calls = [];
  const hear = async (samples, kind) => { calls.push(kind); const t = script[kind]; return { text: Array.isArray(t) ? t.shift() : (t || ''), ms: 1 }; };
  return { hear, calls };
}
const second = (n) => new Float32Array(Math.round(16000 * n));

(async () => {
  let s = scripted({ head: 'I was telling my', scan: 'I was telling my friend about something.' });
  let r = await createWake.decide(second(1.2), 16000, s.hear, {});
  h.check('ordinary speech: one short pass, then forgotten', !r.wake && s.calls.join() === 'head', s.calls.join());

  s = scripted({ head: 'Hey Nim.', full: 'Hey Nim. What time is it?' });
  let early = false;
  r = await createWake.decide(second(3), 16000, s.hear, { onEarly: () => { early = true; } });
  h.check('"Hey Nim, what time is it?" wakes with the request', r.wake && r.command === 'What time is it?', JSON.stringify(r));
  h.check('and the first pass shows it is listening before the second finishes', early);

  s = scripted({ head: 'Hey, Nim.', full: 'Hey Neil, open the door.' });
  early = false;
  r = await createWake.decide(second(2.5), 16000, s.hear, { onEarly: () => { early = true; } });
  h.check('"Hey Neil": the closer listen hears another name, and it does not wake', !r.wake, JSON.stringify(r));

  s = scripted({ head: 'Hini.', full: 'Hey Nim. Open Spotify.' });
  r = await createWake.decide(second(2.6), 16000, s.hear, {});
  h.check('an accented short pass ("Hini") gets a second listen, which confirms it', r.wake && r.command === 'Open Spotify.', JSON.stringify(r));

  s = scripted({ head: 'Hey, him.', full: 'Hey, him back tomorrow.' });
  r = await createWake.decide(second(2.6), 16000, s.hear, {});
  h.check('"hey him" twice, never the name, does not wake', !r.wake, JSON.stringify(r));

  s = scripted({ head: '♪ la la ♪' });
  r = await createWake.decide(second(4), 16000, s.hear, {});
  h.check('music is never a request', !r.wake && r.reason === 'music');

  s = scripted({ head: 'We are going to', scan: 'We are going to look at the map. Hey Nim, open Brave.' });
  r = await createWake.decide(second(6), 16000, s.hear, {});
  h.check('in a long stretch of speech, the name can open a later sentence', r.wake && r.command === 'open Brave.', JSON.stringify(r));

  s = scripted({ head: 'Hey Nim.', full: 'Hey Nim.', command: 'Hey Nim, volume up.' });
  r = await createWake.decide(second(3), 16000, s.hear, { spoke: 2200 });
  h.check('when the primed pass stops at the name, an unprimed listen finds the rest', r.wake && r.command === 'volume up.', JSON.stringify(r));

  s = scripted({ head: 'Hey Nim.', full: 'Hey Nim.', command: 'Heinim Voluma' });
  r = await createWake.decide(second(3), 16000, s.hear, { spoke: 2200 });
  h.check('but takes what it finds only if it reads as a request (else the name alone)', r.wake && r.command === '', JSON.stringify(r));

  h.section('after the name, and during a conversation');
  const said = [];
  const queue = [];
  const w = createWake({
    transcribe: async () => queue.shift() || '',
    encode: () => new Uint8Array(10),
    onTrigger: (c) => said.push(c)
  });
  queue.push('Hey Nim.');
  await w.inject(second(1.2), 16000);
  h.check('the name alone waits for the request', said.length === 1 && said[0] === '');
  queue.push('open Brave');
  await w.inject(second(1.5), 16000);
  h.check('the next thing said is the request, without the name', said[1] === 'open Brave', JSON.stringify(said));
  queue.push('open Spotify');
  await w.inject(second(1.5), 16000);
  h.check('after that, the name is needed again', said.length === 2, JSON.stringify(said));

  h.section('a conversation keeps going without the name');
  const heard2 = [];
  const q2 = [];
  const c = createWake({ testArmed: true, transcribe: async () => q2.shift() || '', encode: () => new Uint8Array(10), onTrigger: (x) => heard2.push(x) });
  c.expectFollowUp(8000, 'conversation');
  q2.push('So today we are going to look at the map');
  await c.inject(second(2), 16000);
  h.check('a video talking in the room does not continue it', heard2.length === 0, JSON.stringify(heard2));
  q2.push('search for electron');
  await c.inject(second(1.5), 16000);
  h.check('a request does, without saying "Hey Nim"', heard2[0] === 'search for electron', JSON.stringify(heard2));
  c.expectFollowUp(12000, 'answer');
  q2.push('the second one');
  await c.inject(second(1), 16000);
  h.check('after Nim asked a question, a short answer counts', heard2[1] === 'the second one', JSON.stringify(heard2));
  c.expectFollowUp(12000, 'answer');
  q2.push("It's on mute volume of it, I was telling him");
  await c.inject(second(2), 16000);
  h.check('but a remark to someone else does not', heard2.length === 2, JSON.stringify(heard2));

  h.section('learning how one voice says "Hey Nim"');
  const learnt = [];
  const q3 = ['Hini.', 'He Nim.', 'Henny'];
  const fired = [];
  const e = createWake({ testArmed: true, transcribe: async () => q3.shift() || '', encode: () => new Uint8Array(10), onTrigger: (x) => fired.push(x) });
  let samples = null;
  h.check('learning starts', e.enroll({ count: 3, onSample: (n, t) => learnt.push(t), onDone: (s) => { samples = s; } }));
  for (let i = 0; i < 3; i++) await e.inject(second(1.2), 16000);
  h.check('three samples, heard as the wake check hears them', JSON.stringify(samples) === JSON.stringify(['Hini.', 'He Nim.', 'Henny']), JSON.stringify(samples));
  h.check('and nothing was acted on while learning', fired.length === 0, JSON.stringify(fired));

  const variants = require('../src/voice/variants');
  const m = variants.merge([], ['hini', 'henny', 'he named', 'her name', 'honey', 'name', 'open the door please now']);
  h.check('distinctive spellings are kept', m.added.join() === 'hini,henny', m.added.join());
  h.check('everyday words never become a wake word', !m.all.some((v) => ['he named', 'her name', 'honey', 'name'].includes(v)));
  h.check('a learned spelling then wakes Nim', wc('Henny, volume down.', m.all) === 'volume down.');

  h.finish();
})().catch((e) => { console.error(e); process.exit(1); });
