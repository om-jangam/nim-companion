'use strict';
/*
 * The tool registry and the tools that can be exercised without a desktop:
 * every file tool against a pretend home folder (for real, on disk), the
 * reminder clock, fuzzy matching of app names, reading pages, the
 * conversation context, and the system bridge's fixed list of operations.
 */
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
h.stubElectron();
const home = h.isolateHome('tools');

const bridge = require('../src/system/bridge');
const realCall = bridge.call;
bridge.call = async () => { throw new Error('no bridge in tests'); };      // no PowerShell started

const tools = require('../src/agent/tools');
const fuzzy = require('../src/agent/fuzzy');
const reminders = require('../src/agent/reminders');
const context = require('../src/agent/context');
const browsers = require('../src/agent/tools/browsers');
const web = require('../src/agent/tools/web');
const files = require('../src/agent/tools/files');
const { parseVolume } = require('../src/agent/tools/system');

const byName = tools.byName;
const ctx = { progress: () => {} };
async function step(name, args) {
  const t = byName(name);
  const risk = tools.riskOf(t, args);                // judged before it runs, as the runtime does
  const before = t.before ? await t.before(args, ctx) : null;
  const out = await t.run(args, ctx, before);
  const check = t.verify ? await t.verify(args, out, ctx, before) : null;
  return { out, check, risk };
}

(async () => {
  h.section('every tool declares what the registry requires');
  for (const t of tools.TOOLS) {
    const missing = ['name', 'title', 'description', 'risk', 'input', 'run'].filter((k) => !t[k]);
    if (!Array.isArray(t.input.required)) missing.push('required');
    if (missing.length) h.check(t.name + ' is complete', false, 'missing ' + missing.join(', '));
  }
  h.check('all ' + tools.TOOLS.length + ' tools have name, description, schema, required arguments, risk and an action', true);
  const noCheck = tools.TOOLS.filter((t) => !t.verify && !t.hidden).map((t) => t.name);
  h.check('tools that change something verify it (the rest are recorded as unverified)',
    // read-only, spoken, or with nothing that can be read back (a media key, a sleeping PC)
    noCheck.every((n) => ['say', 'wait', 'skill', 'media.control', 'system.sleep', 'reminder.list', 'memory.recall', 'screen.describe', 'clipboard.read'].includes(n)), noCheck.join(', '));
  const kept = ['say', 'wait', 'app.open', 'browser.open', 'web.search', 'http.fetch', 'files.list', 'files.read', 'files.write',
    'project.inspect', 'git.status', 'project.test', 'memory.remember', 'memory.recall', 'memory.forget', 'screen.describe', 'text.compose', 'skill'];
  h.check('the original tools are all still here', kept.every((n) => byName(n)), kept.filter((n) => !byName(n)).join(', '));
  h.check('there is no tool that runs arbitrary commands', !tools.TOOLS.some((t) => /shell|exec|command|powershell|cmd/i.test(t.name)));
  h.check('the old app.open is kept for old plans but not offered to the model', byName('app.open').hidden && !tools.offered().includes(byName('app.open')));
  const risky = { 'system.shutdown': 'critical', 'system.restart': 'critical', 'files.delete': 'high', 'files.organize': 'high',
    'files.move': 'medium', 'files.rename': 'medium', 'app.close': 'medium', 'system.sleep': 'medium', 'web.download': 'medium', 'project.test': 'high' };
  for (const [n, level] of Object.entries(risky)) h.check(n + ' is ' + level + ' risk', byName(n).risk === level, byName(n).risk);
  for (const n of ['system.volume', 'app.launch', 'browser.open', 'system.screenshot', 'folder.open', 'files.mkdir']) {
    h.check(n + ' runs without asking (low risk)', byName(n).risk === 'low');
  }

  h.section('files, for real, in a pretend home folder');
  let r = await step('files.mkdir', { dir: 'Projects' });
  h.check('a folder is created in Documents and checked', r.check.ok && fs.statSync(path.join(home, 'Documents', 'Projects')).isDirectory(), r.check.note);
  r = await step('files.write', { file: 'plan.md', content: '# Plan\n\nShip it.' });
  h.check('a bare file name is saved in Documents and read back', r.check.ok && fs.readFileSync(path.join(home, 'Documents', 'plan.md'), 'utf8') === '# Plan\n\nShip it.', r.check.note);
  h.check('writing a new file is low risk', r.risk === 'low');
  h.check('writing over it would be high risk', tools.riskOf(byName('files.write'), { file: 'plan.md', content: 'x' }) === 'high');
  let threw = null;
  try { await byName('files.write').run({ file: 'Desktop/run.bat', content: 'del *' }, ctx); } catch (e) { threw = e.message; }
  h.check('it will not write a script', /programs or scripts/.test(threw || ''), threw);
  r = await step('files.read', { file: 'Documents/plan.md' });
  h.check('read back', r.out.data === '# Plan\n\nShip it.' && r.check.ok);
  fs.writeFileSync(path.join(home, 'Downloads', 'Budget 2026.pdf'), '%PDF-1.4 fake');
  fs.writeFileSync(path.join(home, 'Downloads', 'notes.txt'), 'n');
  r = await step('files.search', { query: '*.pdf' });
  h.check('finds files by type, newest first', r.check.ok && r.out.data.files[0].name === 'Budget 2026.pdf', JSON.stringify(r.out.data.files.map((f) => f.name)));
  h.check('and hands the newest on to the next step as {{s1}}', /Budget 2026\.pdf$/.test(r.out.data.text));
  r = await step('files.search', { query: 'budget' });
  h.check('and by part of the name', r.out.data.files.length === 1);
  r = await step('files.copy', { from: 'Downloads/notes.txt', to: 'Desktop' });
  h.check('copy, checked by size', r.check.ok && fs.existsSync(path.join(home, 'Desktop', 'notes.txt')));
  h.check('copying over something that is there would be high risk', tools.riskOf(byName('files.copy'), { from: 'Downloads/notes.txt', to: 'Desktop' }) === 'high');
  r = await step('files.rename', { file: 'Desktop/notes.txt', name: 'ideas.txt' });
  h.check('rename, checked', r.check.ok && fs.existsSync(path.join(home, 'Desktop', 'ideas.txt')) && !fs.existsSync(path.join(home, 'Desktop', 'notes.txt')));
  threw = null;
  try { await byName('files.rename').run({ file: 'Desktop/ideas.txt', name: 'ideas.exe' }, ctx); } catch (e) { threw = e.message; }
  h.check('a document cannot be renamed into a program', /into a program/.test(threw || ''), threw);
  r = await step('files.move', { from: 'Desktop/ideas.txt', to: 'Documents/Projects' });
  h.check('move, checked', r.check.ok && fs.existsSync(path.join(home, 'Documents', 'Projects', 'ideas.txt')));
  r = await step('files.delete', { file: 'Documents/Projects/ideas.txt' });
  h.check('delete goes to the Recycle Bin, and is checked', r.check.ok && h.trashed.some((p) => /ideas\.txt$/.test(p)));
  threw = null;
  try { await byName('files.delete').run({ file: 'Documents' }, ctx); } catch (e) { threw = e.message; }
  h.check('a main folder is never deleted', /main folders/.test(threw || ''), threw);
  threw = null;
  fs.writeFileSync(path.join(home, 'Downloads', 'setup.exe'), 'MZ');
  try { await byName('files.open').run({ file: 'Downloads/setup.exe' }, ctx); } catch (e) { threw = e.message; }
  h.check('a program is never opened', /never open those/.test(threw || ''), threw);

  for (const f of ['photo.jpg', 'song.mp3', 'movie.mp4', 'archive.zip', 'report.docx']) fs.writeFileSync(path.join(home, 'Downloads', f), 'x');
  r = await step('files.organize', { dir: 'Downloads' });
  h.check('tidying sorts by type, and checks every file landed', r.check.ok &&
    fs.existsSync(path.join(home, 'Downloads', 'Images', 'photo.jpg')) && fs.existsSync(path.join(home, 'Downloads', 'Installers', 'setup.exe')) &&
    fs.existsSync(path.join(home, 'Downloads', 'Documents', 'Budget 2026.pdf')), r.out.summary);
  h.check('and it is high risk, so it always asks first', r.risk === 'high');

  const pdf = path.join(home, 'Documents', 'hello.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj << /Length 60 >>\nstream\nBT /F1 12 Tf 72 712 Td (Hello from a PDF, Nim can read this.) Tj ET\nendstream\nendobj\n%%EOF');
  h.check('the text of a simple PDF can be read', /Hello from a PDF, Nim can read this\./.test(await files.pdfText(pdf)));

  h.section('notes and reminders');
  r = await step('notes.add', { text: 'the meeting moved to Friday' });
  h.check('a note lands at the end of Nim Notes.md', r.check.ok && /meeting moved to Friday/.test(fs.readFileSync(path.join(home, 'Documents', 'Nim Notes.md'), 'utf8')));
  const at = new Date(2026, 9, 3, 15, 0, 0);
  const when = (s) => reminders.parseWhen(s, at);
  h.check('"in 20 minutes"', when('in 20 minutes') === at.getTime() + 20 * 60000);
  h.check('"in an hour"', when('in an hour') === at.getTime() + 3600000);
  h.check('"in half an hour"', when('in half an hour') === at.getTime() + 1800000);
  h.check('"at 5 pm"', new Date(when('at 5 pm')).getHours() === 17);
  h.check('"at 5" said at 3 pm means 5 pm', new Date(when('at 5')).getHours() === 17);
  h.check('"at 9 am" said at 3 pm means tomorrow', new Date(when('at 9 am')).getDate() === 4);
  h.check('"tomorrow at 9"', new Date(when('tomorrow at 9')).getDate() === 4 && new Date(when('tomorrow at 9')).getHours() === 9);
  h.check('nonsense is not a time', when('whenever you like') === null);
  reminders._reset();
  let fired = null;
  reminders.start({ onDue: (rem) => { fired = rem; } });
  const rem = reminders.add('stretch', Date.now() + 300);
  h.check('a reminder is saved to its file', reminders.list().some((x) => x.id === rem.id) && fs.existsSync(reminders.FILE));
  await h.wait(800);
  h.check('and goes off on time', fired && fired.text === 'stretch' && !reminders.list().length);
  reminders.add('call mum', Date.now() + 3600000);
  h.check('cancelling by a word', reminders.cancel('mum').length === 1 && reminders.list().length === 0);

  h.section('names said loosely still find the app');
  const apps = ['Brave', 'Spotify', 'Visual Studio Code', 'Google Chrome', 'Microsoft Edge', 'WhatsApp', 'Calculator', 'File Explorer', 'Notepad', 'Discord'];
  for (const [said, want] of [['brayve', 'Brave'], ['spotifi', 'Spotify'], ['vs code', 'Visual Studio Code'], ['googel chrome', 'Google Chrome'],
    ['whats app', 'WhatsApp'], ['calc', 'Calculator'], ['notpad', 'Notepad'], ['discrod', 'Discord'], ['edge', 'Microsoft Edge']]) {
    const b = fuzzy.best(said, apps);
    h.check('"' + said + '" -> ' + want, b && b.item === want, b && b.item);
  }
  h.check('"youtube" is not an app here', fuzzy.best('youtube', apps) === null);
  h.check('browsers by any of their names', browsers.which('Google Chrome') === 'chrome' && browsers.which('brave browser') === 'brave' && browsers.which('spotify') === null);

  h.section('the volume, only when asked for');
  for (const [said, want] of [['volume down', 'down'], ['turn it up a bit', 'up'], ['set the volume to 30', 'set'], ['mute', 'mute'], ['unmute', 'unmute'], ['louder', 'up']]) {
    const v = parseVolume(said);
    h.check('"' + said + '" -> ' + want, v && v.action === want, JSON.stringify(v));
  }
  h.check('"set the volume to 30" sets 30', parseVolume('set the volume to 30').level === 30);
  for (const said of ['the video is on mute', 'it was too loud', 'turn the page']) h.check('"' + said + '" is not a volume command', parseVolume(said) === null);

  h.section('reading pages');
  const page = web.pageText('<html><head><title>Electron</title><script>var x=1</script></head><body><nav>menu</nav><main><h1>Intro</h1><p>Electron builds apps with JavaScript, HTML &amp; CSS.</p>' + '<p>More text.</p>'.repeat(40) + '</main><footer>(c)</footer></body></html>');
  h.check('the title and main text, without scripts, menus or footers', page.title === 'Electron' && /HTML & CSS/.test(page.text) && !/var x|menu|\(c\)/.test(page.text));

  h.section('what "that" refers to');
  context.reset();
  h.check('nothing at first', !context.get().last && /cannot be used/.test(context.describe()));
  context.update({ browser: 'brave', query: 'electron', last: { text: 'results', what: 'search results' } });
  h.check('the browser, the search and its results are kept', context.get().browser === 'brave' && context.get().last.text === 'results' && /\{\{last\}\}/.test(context.describe()));
  context.reset();

  h.section('the system bridge only knows its fixed operations');
  bridge.call = realCall;
  for (const op of ['Invoke-Expression', 'run', 'shell', 'exec', 'Start-Process', 'volume.get; Remove-Item C:\\']) {
    let refused = false;
    try { await bridge.call(op, {}); } catch (e) { refused = /unknown system operation/.test(e.message); }
    h.check('refuses "' + op + '"', refused);
  }
  const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'bridge.ps1'), 'utf8');
  h.check('the PowerShell side never evaluates what it is sent', !/Invoke-Expression|\biex\b|ScriptBlock::Create|\& \$req|Start-Process/i.test(ps1));
  bridge.stop();

  h.finish();
})().catch((e) => { console.error(e); process.exit(1); });
