'use strict';
/*
 * Kokoro, the human-like voice: the sound it hands the window is a proper
 * WAV, its voices have names a person can pick from, and (when the model is
 * installed and NIM_SKIP_LIVE is not set) it really speaks, quickly enough.
 */
const h = require('./helpers');
const kokoro = require('../src/voice/kokoro');

(async () => {
  h.section('the sound it hands over');
  const w = kokoro.wav(new Float32Array([0, 0.5, -0.5, 1, -1, 2]), 24000);
  h.check('a WAV: RIFF, mono, 16-bit, 24 kHz', w.toString('ascii', 0, 4) === 'RIFF' && w.toString('ascii', 8, 12) === 'WAVE' &&
    w.readUInt16LE(22) === 1 && w.readUInt16LE(34) === 16 && w.readUInt32LE(24) === 24000);
  h.check('every sample, and nothing louder than full scale', w.readUInt32LE(40) === 12 && w.readInt16LE(44 + 2 * 3) === 32767 && w.readInt16LE(44 + 2 * 5) === 32767);

  if (!kokoro.available()) {
    h.skip('the voices', 'the Kokoro model is not installed in voices/kokoro');
    return h.finish();
  }

  h.section('the voices');
  const list = kokoro.list();
  const heart = list.find((v) => v.id === 'af_heart');
  h.check('named for people: "Heart - American, female"', heart && heart.name === 'Heart' && heart.full === 'American, female');
  h.check('men and women, American and British', ['American, male', 'British, female', 'British, male'].every((f) => list.some((v) => v.full === f)));
  h.check('the best one is the default', kokoro.DEFAULT_VOICE === list[0].id);

  if (process.env.NIM_SKIP_LIVE) {
    h.skip('speaking', 'NIM_SKIP_LIVE');
    return h.finish();
  }
  h.section('speaking');
  await kokoro.load();
  const t = Date.now();
  const wav = await kokoro.speak('Screenshot saved.', 'af_heart', 1);
  const ms = Date.now() - t, secs = (wav.length - 44) / 2 / 24000;
  h.check('a short reply is spoken', secs > 0.5 && secs < 4, secs.toFixed(1) + 's');
  h.check('and made in under three seconds', ms < 3000, ms + 'ms');
  h.finish();
})().catch((e) => { console.error(e); process.exit(1); });
