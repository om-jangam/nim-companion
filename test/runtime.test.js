'use strict';
/*
 * The runtime: task graph, risk and the approval gate, verification, retries,
 * pause and cancel, step results flowing on, and the audit log. Files are real
 * files in a pretend home folder; nothing outside it is touched.
 */
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
h.stubElectron();
const home = h.isolateHome('runtime');

// the system bridge (PowerShell) is not started in tests: "no browser open"
const bridge = require('../src/system/bridge');
bridge.call = async () => { throw new Error('no bridge in tests'); };

const agent = require('../src/agent/runtime');
const tools = require('../src/agent/tools');
const planner = require('../src/agent/planner');
const { validate } = require('../src/agent/validator');

const said = [];
const remembered = [];
const ctx = { say: async (t) => { said.push(t); }, remember: (p) => remembered.push(p) };
const events = [];
agent.on('event', (type, data) => events.push({ type, data }));

function waitFor(pred, label, ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const s = agent.snapshot();
      if (pred(s)) return resolve(s);
      if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timed out waiting for ' + label + ' (at ' + s.status + ')'));
      setTimeout(tick, 30);
    })();
  });
}
const ended = (s) => ['completed', 'error', 'cancelled'].includes(s.status);
const asking = (s) => s.status === 'waiting-approval' || ended(s);

/* The window-title checks need a real desktop; here they are told nothing
 * opened, which is the honest answer under plain node. */
const observe = require('../src/agent/observe');
observe.windows = async () => [];
observe.waitForWindow = async () => ({ found: false, seen: [] });

async function run(plan, label) {
  const v = validate(plan, Object.assign({}, ctx));
  if (!v.ok) throw new Error(label + ': ' + v.errors.join('; '));
  agent.clear();
  events.length = 0;
  await agent.startPlan(label, v.plan, ctx);
}

(async () => {
  h.section('the planner splits sentences the way people say them');
  const cases = [
    ['open YouTube, search for Electron documentation, and wait five seconds.', 'web.search,wait'],
    ['Open YouTube and search for the latest Electron documentation.', 'web.search'],
    ['open notepad, wait two seconds, then open calculator', 'app.launch,wait,app.launch'],
    ['open Brave and search for Electron documentation', 'web.search'],
    ['open Spotify and play tum hi ho', 'media.play'],
    ['take a screenshot and then open my downloads folder', 'system.screenshot,folder.open'],
    ['volume down', 'system.volume'],
    ['create a folder called Projects', 'files.mkdir']
  ];
  for (const [s, want] of cases) {
    const p = await planner.rulePlanner(s, {});
    h.check('"' + s + '"', p.steps.map((x) => x.tool).join(',') === want, p.steps.map((x) => x.tool).join(','));
  }
  let p = await planner.rulePlanner('Open YouTube and search for the latest Electron documentation.', {});
  h.check('a YouTube search searches YouTube', p.steps[0].args.engine === 'youtube' && /latest Electron/.test(p.steps[0].args.query), JSON.stringify(p.steps[0].args));
  p = await planner.rulePlanner('open Brave and search for Electron documentation', {});
  h.check('"open Brave and search" searches in Brave', p.steps[0].args.browser === 'brave' && p.steps[0].args.query === 'Electron documentation', JSON.stringify(p.steps[0].args));
  p = await planner.rulePlanner('search for electron', { context: { browser: 'brave' } });
  h.check('a search right after "open Brave" stays in the browser in use (decided when it runs)', p.steps[0].tool === 'web.search');

  h.section('a plan runs in dependency order');
  agent.clear();
  await agent.start('say one and then wait 1 seconds and then say two', ctx);
  let s = await waitFor(ended, 'completion');
  h.check('completed', s.status === 'completed', s.status + ' ' + (s.error || ''));
  h.check('in order', said.join('|') === 'one|two', said.join('|'));
  h.check('progress counted from real steps', s.progress.done === 3 && s.progress.total === 3);

  h.section('the approval gate (a medium-risk step)');
  const from = path.join(home, 'Downloads', 'report.txt');
  fs.writeFileSync(from, 'quarterly numbers');
  await run({ intent: 'command', steps: [{ id: 's1', tool: 'files.move', args: { from: 'Downloads/report.txt', to: 'Documents' }, dependsOn: [] }] }, 'move');
  s = await waitFor(asking, 'the gate');
  h.check('moving a file stops to ask', s.status === 'waiting-approval' && s.pendingApproval.tool === 'files.move', s.status);
  h.check('with a plain question', /^Move report\.txt to Documents\?$/.test(s.pendingApproval.question), s.pendingApproval.question);
  h.check('and the question is an event every surface sees', events.some((e) => e.type === 'confirmation_required' && e.data.question === s.pendingApproval.question));
  h.check('nothing moved before the yes', fs.existsSync(from));
  agent.approve(s.pendingApproval.stepId, true);
  s = await waitFor(ended, 'completion');
  h.check('approved, it runs', s.status === 'completed' && fs.existsSync(path.join(home, 'Documents', 'report.txt')) && !fs.existsSync(from), s.status + ' ' + (s.error || ''));
  h.check('and is verified on disk', s.steps[0].verified === true, s.steps[0].verifyNote);
  h.check('the finished step says what it did', s.steps[0].doneLabel === 'Moved report.txt', s.steps[0].doneLabel);

  fs.writeFileSync(from, 'again');
  await run({ intent: 'command', steps: [{ id: 's1', tool: 'files.move', args: { from: 'Downloads/report.txt', to: 'Desktop' }, dependsOn: [] }] }, 'move');
  s = await waitFor(asking, 'the gate');
  agent.approve(s.pendingApproval.stepId, false);
  s = await waitFor(ended, 'completion');
  h.check('declined, the step is skipped and nothing moves', s.steps[0].status === 'skipped' && fs.existsSync(from));

  h.section('risk is decided again right before each step runs');
  const notes = path.join(home, 'Documents', 'twice.md');
  try { fs.unlinkSync(notes); } catch {}
  await run({ intent: 'multi_step_task', steps: [
    { id: 's1', tool: 'files.write', args: { file: 'twice.md', content: 'first' }, dependsOn: [] },
    { id: 's2', tool: 'files.write', args: { file: 'twice.md', content: 'second' }, dependsOn: ['s1'] }
  ] }, 'write twice');
  s = await waitFor(asking, 'the gate');
  h.check('creating a new file did not ask', s.steps[0].status === 'done' && fs.readFileSync(notes, 'utf8') === 'first');
  h.check('writing over it a moment later does', s.status === 'waiting-approval' && s.pendingApproval.stepId === 's2' && s.pendingApproval.risk === 'high', s.pendingApproval && s.pendingApproval.risk);
  agent.approve('s2', false);
  s = await waitFor(ended, 'completion');
  h.check('declined, the file keeps its first content', fs.readFileSync(notes, 'utf8') === 'first');

  h.section('a plan cannot skip the gate, whatever it says about risk');
  const doomed = path.join(home, 'Desktop', 'keep.txt');
  fs.writeFileSync(doomed, 'precious');
  agent.clear();
  await agent.startPlan('delete it', { steps: [{ id: 's1', tool: 'files.delete', title: 'Delete', risk: 'low', args: { file: 'Desktop/keep.txt' }, dependsOn: [] }] }, ctx);
  s = await waitFor(asking, 'the gate');
  h.check('a delete marked "low" by the plan still asks', s.status === 'waiting-approval' && s.pendingApproval.risk === 'high', s.status);
  agent.cancel();
  s = await waitFor(ended, 'cancel');
  h.check('cancelling at the gate deletes nothing', s.status === 'cancelled' && fs.existsSync(doomed));

  agent.clear();
  await agent.startPlan('shut down', { steps: [{ id: 's1', tool: 'system.shutdown', title: 'Shut down', args: {}, dependsOn: [] }] }, ctx);
  s = await waitFor(asking, 'the gate');
  h.check('a shutdown always asks (critical)', s.status === 'waiting-approval' && s.pendingApproval.risk === 'critical' && s.pendingApproval.question === 'Shut down your computer?');
  agent.cancel();
  await waitFor(ended, 'cancel');

  h.section('unverifiable is not reported as proven');
  await run({ intent: 'command', steps: [{ id: 's1', tool: 'browser.open', args: { url: 'https://example.com' }, dependsOn: [] }] }, 'open');
  s = await waitFor(ended, 'completion');
  h.check('a page that never showed up fails verification', s.status === 'error' && s.steps[0].verified === false, s.status + ' ' + s.steps[0].verified);
  h.check('and the failure says why', /did not take effect|no window/.test(s.error || ''), s.error);

  h.section('results flow between steps');
  const echo = { name: 'test.echo', title: 'Echo', description: 'echo', risk: 'low', input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async (a) => ({ summary: a.text, data: a.text.toUpperCase() }), remember: (a, out) => ({ last: { text: out.data, what: 'an echo' } }) };
  tools.TOOLS.unshift(echo);
  agent.clear();
  await agent.startPlan('chain', { steps: [
    { id: 's1', tool: 'test.echo', title: 'one', args: { text: 'hello' }, dependsOn: [] },
    { id: 's2', tool: 'test.echo', title: 'two', args: { text: 'got {{s1}}!' }, dependsOn: ['s1'] }
  ] }, ctx);
  s = await waitFor(ended, 'completion');
  h.check('{{s1}} is replaced by what s1 produced', s.steps[1].summary === 'got HELLO!', s.steps[1].summary);
  h.check('and what it produced is remembered for "that"', remembered.some((r) => r.last && r.last.text === 'GOT HELLO!'));

  agent.clear();
  await agent.startPlan('last', { steps: [{ id: 's1', tool: 'test.echo', title: 'one', args: { text: 'saved: {{last}}' }, dependsOn: [] }] },
    Object.assign({}, ctx, { context: { last: { text: 'the search results', what: 'search results' } } }));
  s = await waitFor(ended, 'completion');
  h.check('{{last}} is what the previous request produced', s.steps[0].summary === 'saved: the search results', s.steps[0].summary);
  tools.TOOLS.shift();

  h.section('retries are bounded, and a refusal is not retried');
  const flaky = { name: 'test.flaky', title: 'Flaky', description: 'x', risk: 'low', calls: 0, input: { type: 'object', properties: {}, required: [] },
    run: async function () { this.calls++; throw new Error('the page was not ready'); } };
  const rule = { name: 'test.rule', title: 'Rule', description: 'x', risk: 'low', calls: 0, input: { type: 'object', properties: {}, required: [] },
    run: async function () { this.calls++; throw new Error('that path is outside your home folder'); } };
  tools.TOOLS.unshift(flaky, rule);
  agent.clear();
  await agent.startPlan('flaky', { steps: [{ id: 's1', tool: 'test.flaky', title: 'Flaky', args: {}, dependsOn: [] }] }, ctx);
  s = await waitFor(ended, 'failure');
  h.check('a flaky step is tried exactly twice, then reported', flaky.calls === 2 && s.status === 'error', 'calls=' + flaky.calls);
  agent.clear();
  await agent.startPlan('rule', { steps: [{ id: 's1', tool: 'test.rule', title: 'Rule', args: {}, dependsOn: [] }] }, ctx);
  s = await waitFor(ended, 'failure');
  h.check('a refusal is reported at once', rule.calls === 1 && /outside your home folder/.test(s.error), 'calls=' + rule.calls + ' ' + s.error);
  tools.TOOLS.splice(0, 2);

  h.section('timeouts');
  const slow = { name: 'test.slow', title: 'Slow', description: 'x', risk: 'low', timeout: 300, input: { type: 'object', properties: {}, required: [] },
    run: () => new Promise(() => {}) };
  tools.TOOLS.unshift(slow);
  agent.clear();
  await agent.startPlan('slow', { steps: [{ id: 's1', tool: 'test.slow', title: 'Slow', args: {}, dependsOn: [] }] }, ctx);
  s = await waitFor(ended, 'timeout', 5000);
  h.check('a hung tool is cut off', s.status === 'error' && /longer than/.test(s.error || ''), s.error);
  tools.TOOLS.shift();

  h.section('what every surface is told while a step runs');
  const n = path.join(home, 'Documents', 'events.md');
  try { fs.unlinkSync(n); } catch {}
  await run({ intent: 'command', steps: [{ id: 's1', tool: 'files.write', args: { file: 'events.md', content: 'x' }, dependsOn: [] }] }, 'events');
  await waitFor(ended, 'completion');
  const types = events.map((e) => e.type);
  h.check('started, checked, completed, in that order', types.join(',') === 'tool_started,verification_started,verification_completed,tool_completed,task_completed', types.join(','));
  h.check('"started" says what it is doing', events[0].data.label === 'Writing events.md...', events[0].data.label);
  h.check('"completed" says what it did', events.find((e) => e.type === 'tool_completed').data.label === 'Saved events.md');

  h.section('pause, resume, cancel');
  agent.clear();
  await agent.start('wait 2 seconds and then say finished', ctx);
  await h.wait(150);
  h.check('pause', agent.pause().status === 'paused');
  await h.wait(300);
  h.check('stays paused', agent.snapshot().status === 'paused');
  h.check('resume', agent.resume().status === 'working');
  agent.cancel();
  s = await waitFor(ended, 'cancel');
  h.check('cancel ends it', s.status === 'cancelled');

  h.section('the audit log');
  const lines = fs.existsSync(agent.AUDIT_PATH) ? fs.readFileSync(agent.AUDIT_PATH, 'utf8').trim().split('\n') : [];
  const recent = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  h.check('it went to the test log, not the real one', agent.AUDIT_PATH === process.env.NIM_AUDIT_FILE);
  h.check('decisions are recorded', recent.some((e) => e.event === 'approved') && recent.some((e) => e.event === 'declined'));
  h.check('no goal text, arguments or contents are stored', !recent.some((e) => /hello|report\.txt|quarterly|twice|precious|example\.com/.test(JSON.stringify(e))));

  h.finish();
})().catch((e) => { console.error(e); process.exit(1); });
