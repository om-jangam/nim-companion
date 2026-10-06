'use strict';
/*
 * The brain: the rules when they are sure, the local model when they are not,
 * the validator always - and nothing that leaves the machine.
 *
 * The local-model section talks to the real Ollama and is skipped, not failed,
 * when it is not running (or NIM_SKIP_LIVE=1).
 */
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
h.stubElectron();
h.isolateHome('brain');

const brain = require('../src/brain');
const ollama = require('../src/brain/providers/ollama');
const context = require('../src/agent/context');

/* The rules alone: Qwen switched off for the first half. */
const realAvailable = ollama.available;
ollama.available = async () => false;

(async () => {
  h.section('nothing in Nim can reach a paid AI service');
  const src = path.join(__dirname, '..', 'src');
  const all = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html)$/.test(e.name)) all.push(p); } })(src);
  const offending = all.filter((f) => /api\.anthropic\.com|@anthropic-ai|api\.openai\.com|generativelanguage\.googleapis|ANTHROPIC_API_KEY|OPENAI_API_KEY/i.test(fs.readFileSync(f, 'utf8')));
  h.check('no cloud AI endpoint, SDK or API key anywhere in src/', offending.length === 0, offending.join(', '));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  h.check('no AI service in the dependencies', !Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies)).some((d) => /anthropic|openai|google\/generative|cohere|mistral/i.test(d)),
          JSON.stringify(pkg.dependencies || {}));
  h.check('the brain\'s minds are the rules and Ollama, nothing else', Object.keys(brain.PROVIDERS).join() === 'rules,ollama', Object.keys(brain.PROVIDERS).join());

  h.section('the rules answer what they are sure of, instantly');
  const cases = [
    ['what time is it', 'skill'],
    ['volume down', 'system.volume'],
    ['volume up', 'system.volume'],
    ['mute the computer', 'system.volume'],
    ['open Brave', 'app.launch'],
    ['open Spotify', 'app.launch'],
    ['open YouTube', 'browser.open'],
    ['take a screenshot', 'system.screenshot'],
    ['open my Downloads folder', 'folder.open'],
    ['search Google for Electron documentation', 'web.search'],
    ['open Brave and search for Electron documentation', 'web.search'],
    ['open Spotify and play tum hi ho', 'media.play'],
    ['organize my Downloads folder', 'files.organize'],
    ['create a folder called Projects', 'files.mkdir'],
    ['shut down my computer', 'system.shutdown'],
    ['restart my computer', 'system.restart'],
    ['remind me in 20 minutes to stretch', 'reminder.set'],
    ['check git status', 'git.status'],
    ['remember that I use Brave', 'memory.remember']
  ];
  for (const [said, tool] of cases) {
    const r = await brain.think(said, {});
    h.check('"' + said + '" -> ' + tool, r.source === 'rules' && r.plan.steps[0] && r.plan.steps[0].tool === tool,
            r.source + ' ' + r.plan.steps.map((s) => s.tool).join(','));
  }
  let r = await brain.think('volume down', {});
  h.check('and they are instant', r.ms < 200, r.ms + 'ms');

  h.section('sums are worked out exactly, not guessed by a model');
  const skills = require('../src/brain/skills');
  for (const [said, answer] of [['what is 15 percent of 2400', 'That is 360.'], ['what is 12 times 8', 'That is 96.'],
    ['square root of 81', 'That is 9.'], ['2 + 3 * 4', 'That is 14.'], ['calculate 1,250 divided by 4', 'That is 312.5.']]) {
    r = await brain.think(said, {});
    const out = await skills.handle(said, {});
    h.check('"' + said + '" -> ' + answer, r.source === 'rules' && r.plan.steps[0].tool === 'skill' && out.say === answer, out.say);
  }
  h.check('words that only look like a sum are not one', skills.match('what is 3 idiots rated out of 10') === null);

  h.section('a reply may not pretend to do something');
  h.check('"Closing Spotify..." with no step is sent back', brain.qualityIssues({ reply: 'Closing Spotify...', steps: [] }).length === 1);
  h.check('a plain answer is fine', brain.qualityIssues({ reply: 'The capital of Japan is Tokyo.', steps: [] }).length === 0);
  h.check('"Opening hours are 9 to 5" is an answer, not a claim', brain.qualityIssues({ reply: 'Opening hours are 9 to 5.', steps: [] }).length === 0);

  h.section('thinking models answer straight away');
  const { noThinking } = require('../src/brain/thinking');
  h.check('qwen3 is told not to think out loud', noThinking('qwen3:4b').think === false);
  h.check('qwen2.5 is not sent a switch it does not know', !('think' in noThinking('qwen2.5:3b')));

  h.section('remarks are not commands');
  for (const said of ['the video is on mute', "I didn't take a screenshot", 'it was too loud yesterday']) {
    r = await brain.think(said, {});
    h.check('"' + said + '" runs nothing', r.plan.steps.length === 0, r.plan.steps.map((s) => s.tool).join(','));
  }

  h.section('without the model, unknown requests are answered honestly, not attempted');
  r = await brain.think('how do I center a div in css', {});
  h.check('no steps are run for it', r.plan.steps.length === 0 && r.plan.intent === 'answer', r.plan.intent);
  h.check('it says why', /thinking model is not running/i.test(r.plan.reply), r.plan.reply);

  h.section('a clear request that breaks a rule is refused with the reason');
  r = await brain.think('write ../../../Windows/evil.txt with hi', {});
  h.check('refused', r.plan.intent === 'refuse', r.plan.intent);
  h.check('says why', /outside your home folder/.test(r.plan.reply), r.plan.reply);

  h.section('"that" means what it meant a moment ago');
  context.reset();
  r = await brain.think('save that to a file', { context: context.get() });
  h.check('with nothing to refer to, nothing is written', r.plan.steps.length === 0, r.plan.steps.map((s) => s.tool).join(','));
  context.update({ query: 'Electron documentation', last: { text: 'Search results for Electron', what: 'search results' } });
  r = await brain.think('save that to a file', { context: context.get() });
  h.check('after a search, "that" is the results', r.plan.steps[0] && r.plan.steps[0].tool === 'files.write' &&
          r.plan.steps[0].args.content === '{{last}}' && /electron-documentation\.md$/.test(r.plan.steps[0].args.file),
          JSON.stringify(r.plan.steps[0] && r.plan.steps[0].args));
  context.reset();

  h.section('replies are made to be spoken');
  const spoken = brain.speakable({ reply: '**Use** `flexbox`:\n- display: flex\n- ```css\nx{}\n```' });
  h.check('no markdown or code is read aloud', !/[*`#]|```/.test(spoken.reply), spoken.reply);
  const quality = brain.qualityIssues({ steps: [{ id: 's1', tool: 'files.write', args: { file: 'a.md', content: 'Idea 1\nIdea 2\nIdea 3' } }] });
  h.check('placeholder content is caught', quality.length === 1);

  h.section('the local model (live)');
  ollama.available = realAvailable;
  if (process.env.NIM_SKIP_LIVE === '1' || !(await ollama.available({}))) {
    h.skip('planning with Qwen', 'Ollama or qwen2.5:3b not available');
    return h.finish();
  }
  const live = [
    ['tell me a fun fact about octopuses', (p) => p.intent === 'answer' && p.reply.length > 10],
    ['make it a little quieter please', (p) => p.steps[0] && p.steps[0].tool === 'system.volume' && p.steps[0].args.action === 'down'],
    ['bring brave to the front', (p) => p.steps[0] && /^app\.(focus|launch)$/.test(p.steps[0].tool)],
    ['find my latest pdf and summarize it', (p) => p.steps.some((s) => s.tool === 'files.search') && p.steps.some((s) => s.tool === 'text.compose')],
    ['look up how electron ipc works and save a short summary as ipc.md', (p) => p.steps.some((s) => /web\.(research|search)|http\.fetch/.test(s.tool)) &&
      p.steps.some((s) => s.tool === 'files.write' && /\{\{s\d\}\}/.test(s.args.content))],
    ['delete it', (p) => p.intent === 'clarify' && p.steps.length === 0]
  ];
  for (const [said, ok] of live) {
    const t = await brain.think(said, { context: context.get() });
    console.log('        ' + JSON.stringify(said) + ' -> ' + t.source + ' ' + t.ms + 'ms ' + t.plan.intent + ' ' +
                t.plan.steps.map((s) => s.tool).join(' > ') + (t.plan.reply ? ' "' + t.plan.reply.slice(0, 60) + '"' : ''));
    h.check('"' + said + '"', t.source === 'ollama' && ok(t.plan), t.source + ' ' + t.plan.intent + ' ' + (t.tried || []).join(' | '));
  }
  h.finish();
})().catch((e) => { console.error(e); process.exit(1); });
