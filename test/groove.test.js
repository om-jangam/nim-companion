'use strict';
/*
 * The dance itself, run frame by frame without a screen: it must keep moving
 * sensibly, and land its beats on the song's beat grid - a little early, by
 * the delay with which the sound reaches Nim.
 */
const h = require('./helpers');
const { createGroove } = require('../src/companion/groove');

/* Plays a steady pretend song at `bpm` for `seconds` at 60 fps; the grid
 * says a beat fell at `offset` ms. Returns when the dance's beats fell. */
function dance(bpm, seconds, offset) {
  const g = createGroove();
  const period = 60000 / bpm, beats = [], poses = [];
  let lastKick = 0;
  for (let t = 0; t < seconds * 1000; t += 1000 / 60) {
    g.feed({
      energy: 0.7, bass: 0.6, beat: 0, period, drops: 0, bands: new Array(24).fill(0.5), track: 'song ' + bpm, mood: '',
      beatPeriod: period, beatAt: offset + Math.floor((t - offset) / period) * period, at: t
    });
    g.update(1 / 60);
    const k = g.kick;
    if (k > lastKick + 0.3) beats.push(t);
    lastKick = k;
    poses.push(Object.assign({}, g.pose()));     // a copy: the pose is one object, updated in place
  }
  return { beats, poses, period };
}

h.section('it keeps dancing');
{
  const r = dance(120, 8, 130);
  const bad = r.poses.find((p) => !['dx', 'up', 'tilt', 'sx', 'sy', 'faceDx', 'faceW', 'faceShow'].every((k) => Number.isFinite(p[k])));
  h.check('every pose is real numbers, frame after frame', !bad, JSON.stringify(bad));
  h.check('and it moves', r.poses.some((p) => Math.abs(p.tilt) > 0.01 || Math.abs(p.up) > 0.01));
}

h.section('no drums: it flows instead');
{
  const g = createGroove();
  let highest = 0, flowing = false;
  for (let t = 0; t < 10000; t += 1000 / 60) {
    g.feed({ energy: 0.6, bass: 0.3, beat: 0, period: 650, drops: 0, bands: new Array(24).fill(0.4), track: 'ballad', mood: 'romantic',
      beatPeriod: 650, beatAt: Math.floor(t / 650) * 650, at: t, drive: 0.04 });
    g.update(1 / 60);
    if (t > 6000) { flowing = g.flowing; highest = Math.max(highest, g.pose().up); }
  }
  h.check('a guitar-and-voice ballad: flowing, not beating', flowing);
  h.check('and no hops on a beat it does not have', highest < 0.04, highest.toFixed(3));
}

h.section('on the beat');
for (const [bpm, offset] of [[96, 70], [120, 130], [140, 10]]) {
  const r = dance(bpm, 10, offset);
  const lead = 100;                       // LATENCY: it runs this far ahead of what it hears
  const late = r.beats.filter((t) => t > 2000).map((t) => {
    let off = ((t - offset + lead) % r.period + r.period) % r.period;
    if (off > r.period / 2) off -= r.period;
    return off;
  });
  const worst = Math.max(...late.map(Math.abs));
  h.check(bpm + ' BPM: a beat every beat', Math.abs(late.length - (8 * bpm / 60)) <= 2, late.length + ' beats in 8 s');
  h.check(bpm + ' BPM: each within a frame of the grid (17 ms)', worst <= 17, Math.round(worst) + ' ms');
}

h.finish();
