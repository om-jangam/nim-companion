'use strict';
/*
 * Automations and habits: what is accepted, what runs when, and that every
 * plan an automation makes is an ordinary one the validator passes.
 */
const h = require('./helpers');
h.stubElectron();
const A = require('../src/life/automations');
const habits = require('../src/life/habits');
const validator = require('../src/agent/validator');

h.section('what can be saved');
let r = A.clean({ name: 'Study mode', when: { type: 'phrase', phrase: 'Study Mode!' }, do: [{ act: 'focus', value: '25' }] });
h.check('a routine: a phrase and some steps', r.ok && r.value.when.phrase === 'study mode' && r.value.on === true);
r = A.clean({ name: 'Morning', when: { type: 'time', at: '9:05', days: 'weekdays' }, do: [{ act: 'briefing' }] });
h.check('a schedule: a time and the days', r.ok && r.value.when.at === '09:05' && r.value.when.days === 'weekdays');
r = A.clean({ name: 'Coding', when: { type: 'event', event: 'app', app: 'VS Code' }, do: [{ act: 'play-music', value: 'lofi' }] });
h.check('a trigger: when an app opens', r.ok && r.value.when.app === 'VS Code');
h.check('a time that is not one is refused', !A.clean({ name: 'x', when: { type: 'time', at: '25:00' }, do: [{ act: 'briefing' }] }).ok);
h.check('a phrase that already means something is refused', !A.clean({ name: 'x', when: { type: 'phrase', phrase: 'yes' }, do: [{ act: 'briefing' }] }).ok);
h.check('a step that is not on the menu is refused', !A.clean({ name: 'x', when: { type: 'phrase', phrase: 'go go' }, do: [{ act: 'shell', value: 'format c:' }] }).ok);
h.check('something Nim cannot notice is refused', !A.clean({ name: 'x', when: { type: 'event', event: 'email' }, do: [{ act: 'briefing' }] }).ok);
h.check('at most six steps', !A.clean({ name: 'x', when: { type: 'phrase', phrase: 'many things' }, do: new Array(7).fill({ act: 'briefing' }) }).ok);
h.check('a step that needs a value has one', !A.clean({ name: 'x', when: { type: 'phrase', phrase: 'open it' }, do: [{ act: 'open-app', value: '' }] }).ok);
r = A.clean({ name: '<b>Hi</b>', when: { type: 'phrase', phrase: 'say hi' }, do: [{ act: 'say', value: '<script>x</script> hello {file}' }] });
h.check('no markup gets in; the placeholders stay', r.ok && !/[<>]/.test(r.value.name + r.value.do[0].value) && /\{file\}/.test(r.value.do[0].value));

h.section('the starter set');
const list = A.starters();
h.check('ten starters, all valid', list.length === 10 && list.every(Boolean));
h.check('schedules start switched off (only you know your times)', list.filter((a) => a.when.type === 'time').every((a) => !a.on));
const ctx = { disabledTools: [] };
let allPass = true, why = '';
for (const a of list) {
  const plan = A.planFor(a, { playing: true, pausedByNim: false, name: 'Sam', event: { file: 'report.pdf' } }) ||
               A.planFor(a, { playing: false, pausedByNim: true });
  const v = validator.validate(plan, ctx);
  if (!v.ok) { allPass = false; why = a.name + ': ' + v.errors.join('; '); }
}
h.check('every starter makes a plan the validator passes', allPass, why);

h.section('which to run');
h.check('the phrase', A.matchPhrase('study mode', list) && A.matchPhrase('study mode', list).id === 'study-mode');
h.check('said a little differently', ['start study mode please', 'hey nim study mode', 'Study mode!', 'lets do study mode'].every((s) => (A.matchPhrase(s, list) || {}).id === 'study-mode'));
h.check('not a word of it', !A.matchPhrase('study', list) && !A.matchPhrase('study mode is boring', list) && !A.matchPhrase('open notepad', list));
h.check('any automation by its name after "run"', (A.matchPhrase('run morning start', list) || {}).id === 'morning');
h.check('a switched-off routine does not answer to its phrase', !A.matchPhrase('study mode', list.map((a) => Object.assign({}, a, { on: false }))));

const monday905 = new Date(2026, 9, 5, 9, 5), sat = new Date(2026, 9, 3, 9, 5);
const sched = [Object.assign(A.clean({ id: 'm', name: 'M', on: true, when: { type: 'time', at: '09:00', days: 'weekdays' }, do: [{ act: 'briefing' }] }).value)];
h.check('a schedule runs at its time', A.dueNow(sched, monday905, {}).length === 1);
h.check('not twice the same day', A.dueNow(sched, monday905, { m: A.localDay(monday905) }).length === 0);
h.check('not on the wrong day', A.dueNow(sched, sat, {}).length === 0);
h.check('not hours late (the PC was off)', A.dueNow(sched, new Date(2026, 9, 5, 11, 0), {}).length === 0);

const apps = [A.clean({ id: 'v', name: 'V', on: true, when: { type: 'event', event: 'app', app: 'Valorant' }, do: [{ act: 'quiet', value: '120' }] }).value,
  A.clean({ id: 'c', name: 'C', on: true, when: { type: 'event', event: 'app', app: 'VS Code' }, do: [{ act: 'play-music', value: 'lofi' }] }).value];
h.check('"Valorant" is the process VALORANT-Win64-Shipping', A.forEvent(apps, 'app', { app: 'VALORANT-Win64-Shipping' }).map((a) => a.id).join() === 'v');
h.check('"VS Code" is the process Code', A.forEvent(apps, 'app', { app: 'Code' }).map((a) => a.id).join() === 'c');
h.check('and Notepad is neither', A.forEvent(apps, 'app', { app: 'notepad' }).length === 0);

h.section('the plan fits the moment');
const goodNight = list.find((a) => a.id === 'good-night');
h.check('"pause music" only when something is playing', A.planFor(goodNight, { playing: false }).steps.every((s) => s.tool !== 'media.pause') &&
  A.planFor(goodNight, { playing: true }).steps[0].tool === 'media.pause');
const resume = list.find((a) => a.id === 'unlock-resume');
h.check('"resume" only music Nim paused itself', A.planFor(resume, { pausedByNim: false }) === null &&
  A.planFor(resume, { pausedByNim: true, playing: false }).steps[0].tool === 'media.resume' &&
  A.planFor(resume, { pausedByNim: true, playing: true }) === null);
const dl = A.planFor(list.find((a) => a.id === 'download-done'), { event: { file: 'notes<1>.pdf' } });
h.check('what happened goes into the words, cleaned', dl.steps[0].args.text === 'Download finished: notes1.pdf', dl.steps[0].args.text);
h.check('your name, when Nim knows it', A.planFor(goodNight, { playing: false, name: 'Sam' }).steps.find((s) => s.tool === 'say').args.text === 'Good night, Sam. Sleep well!');
h.check('a site becomes an https address', A.siteUrl('youtube') === 'https://youtube.com' && A.siteUrl('www.wikipedia.org') === 'https://wikipedia.org');

h.section('learning habits');
const store = {};
const day = (d, hh, mm) => new Date(2026, 8, d, hh, mm).getTime();
// Spotify first opened around 9 on five weekdays, Chrome at random times
[[21, 9, 2], [22, 8, 55], [23, 9, 10], [24, 9, 0], [25, 9, 20]].forEach(([d, hh, mm]) => {
  habits.record(store, 'Spotify', day(d, hh, mm));
  habits.record(store, 'Spotify', day(d, hh + 3, mm));          // later the same day: not the habit
});
[[21, 10, 0], [22, 15, 30], [23, 20, 0], [24, 13, 0], [25, 7, 0]].forEach(([d, hh, mm]) => habits.record(store, 'chrome', day(d, hh, mm)));
habits.record(store, 'explorer', day(25, 9, 0));
const now = day(26, 8, 0);
const s = habits.suggest(store, now, []);
h.check('a habit is found: Spotify, around 9, on weekdays', s && s.app === 'Spotify' && s.at === '09:00' && s.days === 'weekdays', JSON.stringify(s));
h.check('random times are not a habit', !habits.suggest({ events: store.events.filter((e) => e.a === 'chrome') }, now, []));
h.check('not offered again once it is automated or turned down', habits.suggest(store, now, ['Spotify']) === null);
h.check('Windows\' own parts are never recorded', !store.events.some((e) => e.a === 'explorer'));
h.check('only the app and the time are kept', store.events.every((e) => Object.keys(e).sort().join() === 'a,t'));
h.check('the names you know: Code is VS Code', habits.displayName('Code') === 'VS Code' && habits.displayName('spotify') === 'Spotify');

h.finish();
