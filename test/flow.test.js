'use strict';
/*
 * End to end: a sentence goes in, the brain plans it, the validator checks it,
 * the runtime runs it, and the result is checked on disk - not in the plan,
 * on disk (a pretend home folder, so nothing of yours is touched).
 *
 * Live: needs Ollama with qwen2.5:3b, and the network for the research cases.
 * Skipped, not failed, when either is missing (or NIM_SKIP_LIVE=1).
 */
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
h.stubElectron();
const home = h.isolateHome('flow');

const bridge = require('../src/system/bridge');
bridge.call = async () => { throw new Error('no bridge in tests'); };

const brain = require('../src/brain');
const agent = require('../src/agent/runtime');
const ollama = require('../src/brain/providers/ollama');
const context = require('../src/agent/context');

const CTX = { say: async () => {}, remember: (p) => context.update(p) };

function waitFor(pred, ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const s = agent.snapshot();
      if (pred(s)) return resolve(s);
      if (Date.now() - t0 > ms) return reject(new Error('timed out at status ' + s.status));
      setTimeout(tick, 100);
    })();
  });
}

/* Plan with the brain, run with the runtime. Anything that asks is declined:
 * these flows are meant to need no approval at all. */
async function runGoal(said) {
  const thought = await brain.think(said, Object.assign({ context: context.get() }, CTX));
  if (!thought.plan.steps.length) return { thought, final: null };
  agent.clear();
  await agent.startPlan(said, thought.plan, Object.assign({ context: context.get() }, CTX));
  const s = await waitFor((x) => ['waiting-approval', 'completed', 'error', 'cancelled'].includes(x.status), 240000);
  if (s.status === 'waiting-approval') { agent.approve(s.pendingApproval.stepId, false); return { thought, final: await waitFor((x) => x.status !== 'waiting-approval' && !agent.isBusy(), 60000), asked: true }; }
  return { thought, final: s };
}

(async () => {
  if (process.env.NIM_SKIP_LIVE === '1' || !(await ollama.available({}))) {
    h.skip('end-to-end flows', 'Ollama or qwen2.5:3b not available');
    return h.finish();
  }

  h.section('"make a file with three app ideas" - written, not placeholdered');
  const ideasFile = path.join(home, 'Documents', 'nim-test-ideas.txt');
  let r = await runGoal('make a file called nim-test-ideas.txt with three app ideas in it');
  const tools1 = r.thought.plan.steps.map((s) => s.tool);
  console.log('        plan: ' + tools1.join(' -> ') + '   [' + r.thought.source + ', ' + r.thought.ms + 'ms]');
  h.check('it planned writing before saving', tools1.includes('text.compose') && tools1.includes('files.write'), tools1.join(','));
  h.check('it did not add steps nobody asked for', tools1.length <= 3, tools1.join(','));
  h.check('a new file needed no approval', !r.asked);
  h.check('the run completed', r.final && r.final.status === 'completed', r.final && (r.final.status + ' ' + (r.final.error || '')));
  const written = fs.existsSync(ideasFile) ? fs.readFileSync(ideasFile, 'utf8') : '';
  console.log('        file says: ' + JSON.stringify(written.slice(0, 220)));
  h.check('the file exists, in Documents', written.length > 0);
  h.check('with real content', written.length > 60, written.length + ' chars');
  h.check('not placeholders', !/^\W*idea\s*\d\W*$/im.test(written));
  h.check('and the write was verified by reading it back', r.final && r.final.steps.some((s) => s.tool === 'files.write' && s.verified === true));

  h.section('your example, planned: open Brave, search, summarize, save, open');
  const t = await brain.think('Open Brave, search for Electron documentation, summarize it, save it as electron-notes.md, and open the file', CTX);
  const tools2 = t.plan.steps.map((s) => s.tool);
  console.log('        plan: ' + tools2.join(' -> ') + '   [' + t.source + ', ' + t.ms + 'ms]');
  const write = t.plan.steps.find((s) => s.tool === 'files.write');
  h.check('a real plan, from the local model, through the validator', t.source === 'ollama' && t.plan.steps.length >= 4, t.source + ' ' + tools2.join(','));
  h.check('it gets the content from the web', tools2.some((x) => /web\.(research|search)|http\.fetch/.test(x)));
  h.check('it summarizes before saving', tools2.indexOf('text.compose') > -1 && tools2.indexOf('text.compose') < tools2.indexOf('files.write'));
  h.check('it saves what was written ({{sN}}), to electron-notes.md', write && /\{\{s\d+\}\}/.test(write.args.content) && /electron-notes\.md$/i.test(write.args.file), write && JSON.stringify(write.args));
  h.check('and opens the file at the end', tools2[tools2.length - 1] === 'files.open', tools2.join(','));

  let online = false;
  try { online = (await fetch('https://example.com', { signal: AbortSignal.timeout(6000) })).ok; } catch {}
  if (!online) {
    h.skip('research chains', 'no network');
    return h.finish();
  }

  h.section('research: read a page, summarize it, save the summary');
  const sumFile = path.join(home, 'Documents', 'nim-test-summary.txt');
  r = await runGoal('read https://example.com and save a two sentence summary of it to nim-test-summary.txt');
  const tools3 = r.thought.plan.steps.map((s) => s.tool);
  console.log('        plan: ' + tools3.join(' -> ') + '   [' + r.thought.source + ', ' + r.thought.ms + 'ms]');
  h.check('fetch, then write, then save', tools3.join(',') === 'http.fetch,text.compose,files.write', tools3.join(','));
  h.check('the run completed', r.final && r.final.status === 'completed', r.final && (r.final.status + ' ' + (r.final.error || '')));
  const summary = fs.existsSync(sumFile) ? fs.readFileSync(sumFile, 'utf8') : '';
  console.log('        file says: ' + JSON.stringify(summary.slice(0, 240)));
  h.check('the summary is about the page', /example|domain|illustrative|documents/i.test(summary), summary.slice(0, 80));
  h.check('it is not the raw page', !/<html|<div/i.test(summary));

  h.section('a conversation: search, then "save that"');
  context.reset();
  r = await runGoal('read up on the history of the internet');
  h.check('the reading completed', r.final && r.final.status === 'completed', r.final && (r.final.status + ' ' + (r.final.error || '')));
  r = await runGoal('save that to a file called internet.md');
  const saved = path.join(home, 'Documents', 'internet.md');
  const text = fs.existsSync(saved) ? fs.readFileSync(saved, 'utf8') : '';
  h.check('"that" was the pages it just read', text.length > 300 && /internet/i.test(text), text.length + ' chars');

  h.finish();
})().catch((e) => { console.error(e); process.exit(1); });
