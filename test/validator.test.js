'use strict';
/*
 * The validator is the security boundary between a model and the computer:
 * Qwen proposes, the validator checks, the runtime runs. Every case here is a
 * plan a model could produce - by mistake or because a page it read told it
 * to - and none of them may get through.
 */
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
h.stubElectron();
const home = h.isolateHome('validator');

const { validate } = require('../src/agent/validator');

const ok = (plan, ctx) => validate(plan, ctx);
const one = (tool, args, extra) => ({ intent: 'command', goal: 'g', reply: '', steps: [Object.assign({ id: 's1', tool, args, dependsOn: [] }, extra || {})] });
const errs = (r) => r.errors.join(' | ');

h.section('accepts a good plan');
let r = ok({
  intent: 'multi_step_task', goal: 'g', reply: '',
  steps: [
    { id: 's1', tool: 'browser.open', args: { url: 'https://youtube.com' }, dependsOn: [] },
    { id: 's2', tool: 'wait', args: { seconds: '5' }, dependsOn: ['s1'] }
  ]
});
h.check('valid', r.ok, errs(r));
h.check('coerces "5" to a number', r.plan && r.plan.steps[1].args.seconds === 5);
h.check('risk comes from the registry', r.plan && r.plan.steps[0].risk === 'low');

h.section('rejects what a model might invent');
r = ok(one('system.format_disk', {}));
h.check('an invented tool', !r.ok && /no tool called/.test(errs(r)), errs(r));
r = ok(one('shell.execute', { command: 'del /s /q C:\\' }));
h.check('an arbitrary shell tool does not exist', !r.ok && /no tool called/.test(errs(r)), errs(r));
r = ok(one('files.write', { file: 'a.txt' }));
h.check('a missing required argument', !r.ok && /needs "content"/.test(errs(r)), errs(r));
r = ok(one('system.volume', { action: 'explode' }));
h.check('a value outside an enum', !r.ok && /must be one of/.test(errs(r)), errs(r));
r = ok(one('files.write', { file: { $ne: 1 }, content: 'x' }));
h.check('an object where text belongs', !r.ok && /must be text/.test(errs(r)), errs(r));
r = ok({ intent: 'command', steps: [{ id: 's1', tool: 'wait', args: 'seconds=5', dependsOn: [] }] });
h.check('arguments that are not named values', !r.ok, errs(r));
r = ok({ intent: 'take_over', steps: [] });
h.check('an intent that does not exist', !r.ok && /not an intent/.test(errs(r)), errs(r));
r = ok({ intent: 'command', steps: 'rm -rf' });
h.check('steps that are not a list', !r.ok, errs(r));
r = ok('just do it');
h.check('a plan that is not an object', !r.ok);
r = ok({ intent: 'command', steps: [null, 42] });
h.check('steps that are not steps', !r.ok, errs(r));

h.section('paths stay inside your own folders');
const pathCases = [
  ['files.write', { file: '../../Windows/x.txt', content: 'x' }, /outside your home/],
  ['files.write', { file: 'Documents/../../../Windows/System32/x.dll', content: 'x' }, /outside your home|program/],
  ['files.read', { file: 'C:/Windows/win.ini' }, /outside your home/],
  ['files.read', { file: '\\\\server\\share\\secrets.txt' }, /outside your home/],
  ['files.read', { file: 'file:///C:/Users/me/x.txt' }, /file:\/\//],
  ['files.write', { file: 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/run.txt', content: 'x' }, /belongs to Windows/],
  ['files.read', { file: '.ssh/id_rsa' }, /settings folder/],
  ['files.read', { file: 'Documents/backup/id_ed25519' }, /keys or passwords/],
  ['files.read', { file: 'Desktop/.env' }, /keys or passwords/],
  ['files.write', { file: 'Documents/CON', content: 'x' }, /reserved by Windows/],
  ['files.write', { file: 'notes.txt:hidden', content: 'x' }, /not an ordinary file path/],
  ['files.delete', { file: '../../../../Windows' }, /outside your home/],
  ['files.move', { from: 'Downloads/a.txt', to: 'D:/elsewhere' }, /outside your home/],
  ['files.copy', { from: '../../etc/passwd', to: 'Desktop' }, /outside your home/],
  ['folder.open', { dir: 'C:/Program Files' }, /outside your home/],
  ['web.download', { url: 'https://example.com/a.zip', folder: 'C:/Windows/Temp' }, /outside your home/]
];
for (const [tool, args, want] of pathCases) {
  r = ok(one(tool, args));
  h.check(tool + ' ' + JSON.stringify(args).slice(0, 70), !r.ok && want.test(errs(r)), errs(r));
}
fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
r = ok(one('files.write', { file: 'Documents/plan.md', content: 'x' }));
h.check('an ordinary path inside your folders is fine', r.ok, errs(r));

h.section('web addresses are http or https');
for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,<script>', 'ftp://x.org/a', 'C:\\Windows', 'https://']) {
  r = ok(one('browser.open', { url }));
  h.check('refuses ' + url, !r.ok && /http and https/.test(errs(r)), errs(r));
}

h.section('projects are only the ones you listed');
r = ok(one('git.status', { project: 'C:/Windows' }));
h.check('an unlisted project', !r.ok && /not one of your listed projects/.test(errs(r)), errs(r));
r = ok(one('project.test', { project: 'myapp' }));
h.check('a project by name you never listed', !r.ok && /not one of your listed projects/.test(errs(r)), errs(r));
r = ok(one('git.status', { project: 'myapp' }), { projects: { myapp: home } });
h.check('a listed project is fine', r.ok, errs(r));

h.section('the dependency graph');
r = ok({ intent: 'multi_step_task', steps: [
  { id: 'a', tool: 'wait', args: { seconds: 1 }, dependsOn: ['b'] },
  { id: 'b', tool: 'wait', args: { seconds: 1 }, dependsOn: ['a'] }
] });
h.check('a cycle is rejected', !r.ok && /circle/.test(errs(r)), errs(r));
r = ok({ intent: 'multi_step_task', steps: [{ id: 'a', tool: 'wait', args: { seconds: 1 }, dependsOn: ['ghost'] }] });
h.check('a dependency on a missing step is rejected', !r.ok && /does not exist/.test(errs(r)));
r = ok({ intent: 'multi_step_task', steps: [{ id: 'a', tool: 'wait', args: { seconds: 1 }, dependsOn: ['a'] }] });
h.check('a step depending on itself is rejected', !r.ok && /itself/.test(errs(r)));
r = ok({ intent: 'multi_step_task', steps: [
  { id: 's1', tool: 'text.compose', args: { instruction: 'x' }, dependsOn: [] },
  { id: 's2', tool: 'files.write', args: { file: 'a.md', content: '{{s1}}' }, dependsOn: [] }
] });
h.check('using a result without waiting for it is rejected', !r.ok && /does not depend on that step/.test(errs(r)), errs(r));
r = ok({ intent: 'multi_step_task', steps: [
  { id: 's1', tool: 'text.compose', args: { instruction: 'x' }, dependsOn: [] },
  { id: 's1', tool: 'wait', args: { seconds: 1 }, dependsOn: [] }
] });
h.check('duplicate step ids are rejected', !r.ok && /duplicate id/.test(errs(r)), errs(r));
r = ok({ intent: 'command', steps: [{ id: 'x; rm', tool: 'wait', args: { seconds: 1 }, dependsOn: [] }] });
h.check('a step id that is not a plain name is rejected', !r.ok && /usable step id/.test(errs(r)), errs(r));

h.section('"{{last}}" needs something to refer back to');
r = ok(one('files.write', { file: 'a.md', content: '{{last}}' }));
h.check('rejected with no previous result', !r.ok && /no previous result/.test(errs(r)), errs(r));
r = ok(one('files.write', { file: 'a.md', content: '{{last}}' }), { context: { last: { text: 'results', what: 'search results' } } });
h.check('allowed when there is one', r.ok, errs(r));

h.section('risk is the registry\'s, never the plan\'s');
r = ok(one('files.delete', { file: 'Documents/old.txt' }, { risk: 'low' }));
h.check('files.delete stays high whatever the plan claims', r.ok && r.plan.steps[0].risk === 'high', r.plan && r.plan.steps[0].risk);
h.check('and the attempt is noted', r.notes.some((n) => /called files.delete low risk/.test(n)), r.notes.join());
r = ok(one('system.shutdown', {}, { risk: 'low' }));
h.check('a shutdown stays critical', r.ok && r.plan.steps[0].risk === 'critical');
r = ok(one('wait', { seconds: 1 }, { risk: 'harmless' }));
h.check('a made-up risk level is rejected', !r.ok && /not a risk level/.test(errs(r)), errs(r));
fs.writeFileSync(path.join(home, 'Documents', 'exists.md'), 'old');
r = ok(one('files.write', { file: 'Documents/new-file.md', content: 'x' }));
h.check('creating a new file is low risk', r.ok && r.plan.steps[0].risk === 'low', r.plan && r.plan.steps[0].risk);
r = ok(one('files.write', { file: 'Documents/exists.md', content: 'x' }));
h.check('writing over an existing file is high risk', r.ok && r.plan.steps[0].risk === 'high', r.plan && r.plan.steps[0].risk);
r = ok(one('web.download', { url: 'https://example.com/setup.exe' }));
h.check('downloading a program is high risk', r.ok && r.plan.steps[0].risk === 'high', r.plan && r.plan.steps[0].risk);
r = ok(one('web.download', { url: 'https://example.com/report.pdf' }));
h.check('downloading a document asks too (medium)', r.ok && r.plan.steps[0].risk === 'medium', r.plan && r.plan.steps[0].risk);

h.section('capabilities you switched off');
r = ok(one('system.shutdown', {}), { disabledTools: ['system.shutdown'] });
h.check('a disabled tool is rejected', !r.ok && /switched off/.test(errs(r)), errs(r));

h.section('unknown arguments are dropped, not passed through');
r = ok(one('wait', { seconds: 1, shell: 'rm -rf /' }));
h.check('the extra argument is gone', r.ok && !('shell' in r.plan.steps[0].args), JSON.stringify(r.plan && r.plan.steps[0].args));
r = ok(one('app.launch', { name: 'Brave', exe: 'C:/evil.exe', args: '--remote-debugging-port=9222' }));
h.check('an app cannot be given a path or flags', r.ok && Object.keys(r.plan.steps[0].args).join() === 'name', JSON.stringify(r.plan && r.plan.steps[0].args));

h.section('size limits');
const many = Array.from({ length: 20 }, (_, i) => ({ id: 's' + i, tool: 'wait', args: { seconds: 1 }, dependsOn: [] }));
r = ok({ intent: 'multi_step_task', steps: many });
h.check('more than 12 steps is rejected', !r.ok && /too many steps/.test(errs(r)));
r = ok(one('web.search', { query: 'x'.repeat(5000) }));
h.check('an absurdly long argument is rejected', !r.ok && /too long/.test(errs(r)));

h.section('answers and clarifications');
r = ok({ intent: 'answer', reply: 'Paris.', steps: [] });
h.check('an answer with a reply is fine', r.ok && r.plan.reply === 'Paris.');
r = ok({ intent: 'clarify', reply: '', steps: [] });
h.check('a clarification with nothing to ask is rejected', !r.ok);
r = ok({ intent: 'answer', reply: 'Sure.', steps: [{ id: 's1', tool: 'system.shutdown', args: {}, dependsOn: [] }] });
h.check('an answer cannot smuggle steps', r.ok && r.plan.steps.length === 0 && r.notes.length === 1);

h.finish();
