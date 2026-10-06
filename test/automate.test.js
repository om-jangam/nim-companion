'use strict';
/*
 * The automation engine with a stand-in runtime: routines, triggers,
 * schedules and downloads start the plans they should - validated - and
 * nothing else. Its files (Downloads, habits) are pointed at a scratch folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
h.stubElectron();

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-automate-'));
const downloads = path.join(scratch, 'Downloads');
fs.mkdirSync(downloads);
process.env.NIM_DOWNLOADS_DIR = downloads;
process.env.NIM_HABITS_FILE = path.join(scratch, 'habits.json');

const { createAutomate } = require('../src/desktop/automate');
const validator = require('../src/agent/validator');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const started = [];
let busy = false;
let media = { status: 'Playing' };
const config = { name: 'Sam' };
const auto = createAutomate({
  config, saveConfig: () => {}, validator, brainCtx: () => ({ disabledTools: [] }),
  agent: { isBusy: () => busy, snapshot: () => ({ status: 'idle' }), approve: () => {} },
  bridge: { call: async (op) => (op === 'media.now' ? media : op === 'foreground' ? { process: '' } : {}) },
  say: () => {}, send: () => {}, log: () => {},
  startPlan: async (goal, plan) => { started.push({ goal, plan }); },
  idleSeconds: () => 0, isQuiet: () => false, isGaming: () => false
});
const tools = (i) => started[i].plan.steps.map((s) => s.tool).join(',');

(async () => {
  h.section('first start');
  h.check('the starter set is installed', config.automations.length === 10);

  h.section('a routine');
  const r = auto.match('start study mode');
  h.check('its phrase finds it', r && r.id === 'study-mode');
  await auto.run(r, 'phrase');
  h.check('and runs its steps as one validated plan', started.length === 1 && tools(0) === 'focus.start,media.play,say', started[0] && tools(0));
  h.check('said out loud at the end, since you asked for it', auto.quietEnd({ status: 'completed' }) === false);

  h.section('triggers');
  auto.fire('lock');
  await wait(30);
  h.check('locking the PC pauses the music that plays', started.length === 2 && tools(1) === 'media.pause', started[1] && tools(1));
  h.check('a trigger does not announce "Done"', auto.quietEnd({ status: 'completed' }) === true);
  media = { status: 'Paused' };
  auto.fire('unlock');
  await wait(30);
  h.check('unlocking plays again what Nim paused', started.length === 3 && tools(2) === 'media.resume', started[2] && tools(2));
  auto.quietEnd({ status: 'completed' });
  auto.fire('battery-low');
  await wait(30);
  h.check('a low battery: battery saver, and a word', started.length === 4 && tools(3) === 'nim.saver,say');
  auto.quietEnd({ status: 'completed' });
  auto.fire('email-arrived');
  await wait(30);
  h.check('something no automation follows starts nothing', started.length === 4);

  h.section('while Nim is busy');
  busy = true;
  const q = await auto.run(auto.list().find((a) => a.id === 'download-done'), 'event', { file: 'x.pdf' });
  h.check('a trigger waits its turn', q.queued === true && started.length === 4);
  const p = await auto.run(auto.match('good night'), 'phrase');
  h.check('a routine you said is told why not', p.ok === false && /busy/.test(p.say));
  busy = false;

  h.section('schedules');
  auto.toggle('bedtime reminder', true);
  await auto.checkSchedules(new Date(2026, 9, 5, 23, 35));
  h.check('switched on, it runs at its time', started.length === 5 && started[4].goal === 'Bedtime reminder');
  auto.quietEnd({ status: 'completed' });
  await auto.checkSchedules(new Date(2026, 9, 5, 23, 40));
  h.check('and only once that day', started.length === 5);

  h.section('your own');
  h.check('one that makes no sense is refused', auto.save({ name: 'x', when: { type: 'time', at: '99:99' }, do: [{ act: 'briefing' }] }).ok === false);
  const made = auto.save({ name: 'Movie night', when: { type: 'phrase', phrase: 'movie time' }, do: [{ act: 'volume', value: '70' }, { act: 'quiet', value: '150' }] });
  h.check('a new one is kept, with an id of its own', made.ok && made.value.id === 'movie-night' && !!auto.match('movie time'));
  h.check('by voice, switched off by name', auto.ctx.toggle('movie night', false).on === false && !auto.match('movie time'));
  h.check('and deleted', auto.remove('movie-night') && !auto.list().some((a) => a.id === 'movie-night'));

  h.section('downloads');
  const before = started.length;
  fs.writeFileSync(path.join(downloads, 'notes.pdf.crdownload'), 'half');
  await wait(300);
  fs.renameSync(path.join(downloads, 'notes.pdf.crdownload'), path.join(downloads, 'notes.pdf'));
  await wait(6500);
  const texts = started.slice(before).flatMap((s) => s.plan.steps.filter((x) => x.tool === 'say').map((x) => x.args.text));
  h.check('a finished download is told, by name', texts.includes('Download finished: notes.pdf'), JSON.stringify(texts));
  h.check('the half-downloaded file was not', !started.some((s) => /crdownload/.test(JSON.stringify(s.plan))));
  h.check('and the one that waited its turn ran once Nim was free', started.some((s) => JSON.stringify(s.plan).includes('Download finished: x.pdf')));

  auto.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
  h.finish();
})().catch((e) => { console.error(e); auto.stop(); process.exit(1); });
