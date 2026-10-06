'use strict';
/*
 * The attacks Nim is built to refuse, each tried for real - against a pretend
 * home folder, a stand-in network, and a stand-in for the window in front. A
 * web page, a song title or a downloaded file must never get Nim to run a
 * command, reach this computer or your network, or plant a program.
 */
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
h.stubElectron();
const home = h.isolateHome('security');

const tools = require('../src/agent/tools');
const net = require('../src/agent/tools/net');
const bridge = require('../src/system/bridge');
const skills = require('../src/brain/skills');
const { runsCode } = require('../src/agent/tools/common');

const tool = (name) => tools.byName(name);
async function fails(fn) { try { await fn(); return null; } catch (e) { return e.message; } }

(async () => {
  h.section('the web tools stay on the public internet');
  for (const u of ['http://localhost:11434/api/tags', 'http://127.0.0.1/', 'http://192.168.1.1/admin', 'http://10.0.0.5/',
    'http://172.20.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[fe80::1]/', 'http://router/',
    'http://nas.local/', 'http://0.0.0.0/', 'http://user:pass@example.com/', 'file:///C:/Windows/win.ini']) {
    h.check(u + ' is refused', !!net.blockedNow(u));
  }
  h.check('a public address is fine', net.blockedNow('https://en.wikipedia.org/wiki/Electron') === null);
  const why = await fails(() => tool('http.fetch').run({ url: 'http://192.168.1.1/' }, {}));
  h.check('reading a page on your network fails', why && /local network/.test(why), why);

  // a public page that redirects to a service on this computer
  const realFetch = global.fetch;
  global.fetch = async (url) => (String(url).startsWith('http://93.184.216.34')
    ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:11434/api/tags' } })
    : new Response('secret', { status: 200 }));
  const redirected = await fails(() => net.fetchPublic('http://93.184.216.34/start'));
  h.check('a redirect to this computer is refused', redirected && /local network/.test(redirected), redirected);

  // asked for as a document, sent back as a program
  global.fetch = async () => new Response('MZ fake program', {
    status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="setup.exe"' }
  });
  const swapped = await fails(() => tool('web.download').run({ url: 'http://93.184.216.34/report.pdf' }, {}));
  h.check('a "report.pdf" that arrives as setup.exe is not saved', swapped && /program/.test(swapped) &&
    !fs.existsSync(path.join(home, 'Downloads', 'setup.exe')), swapped);
  global.fetch = realFetch;

  h.check('your own browser asks before opening your network', tools.riskOf(tool('browser.open'), { url: 'http://localhost:3000' }) === 'medium' &&
    tools.riskOf(tool('browser.open'), { url: 'https://youtube.com' }) === 'low');

  h.section('no program is planted');
  fs.writeFileSync(path.join(home, 'Documents', 'notes.txt'), 'echo hello');
  for (const [name, args] of [['files.copy', { from: 'Documents/notes.txt', to: 'Desktop/run.bat' }],
    ['files.move', { from: 'Documents/notes.txt', to: 'Desktop/run.ps1' }],
    ['files.rename', { file: 'Documents/notes.txt', name: 'notes.cmd' }],
    ['files.write', { file: 'Desktop/hello.vbs', content: 'x' }]]) {
    const e = await fails(() => tool(name).run(args, {}));
    h.check(name + ' into a script is refused', !!e && /program|script/.test(e), e);
  }
  h.check('nothing was made on the desktop', fs.readdirSync(path.join(home, 'Desktop')).length === 0);
  const startup = await fails(() => tool('files.write').run({ file: 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.txt', content: 'x' }, {}));
  h.check('nothing goes in the Startup folder', !!startup, startup);
  h.check('the less obvious programs are known too', ['x.settingcontent-ms', 'x.msc', 'x.iso', 'x.vhdx', 'x.rdp', 'x.appref-ms', 'x.xll'].every(runsCode));

  h.section('a command line is never typed into');
  h.check('opening one is asked about first', ['Command Prompt', 'comand promt', 'PowerShell', 'Windows Terminal', 'Ubuntu', 'Registry Editor']
    .every((n) => tools.riskOf(tool('app.launch'), { name: n }) === 'medium') && tools.riskOf(tool('app.launch'), { name: 'Spotify' }) === 'low');
  const realCall = bridge.call;
  for (const proc of ['cmd', 'WindowsTerminal', 'powershell', 'pwsh', 'wsl']) {
    bridge.call = async (op) => (op === 'foreground' ? { process: proc } : {});
    const pasted = await skills.handle('paste', {});
    const typed = await skills.handle('type del /q *', {});
    h.check('no paste or typing into ' + proc, /command line/.test(pasted.say) && /command line/.test(typed.say));
  }
  bridge.call = async () => { throw new Error('bridge down'); };
  const blind = await skills.handle('paste', {});
  h.check('and none when Nim cannot tell what is in front', /command line/.test(blind.say));
  bridge.call = realCall;

  h.section('the app itself');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop', 'main.js'), 'utf8');
  const handlers = [...main.matchAll(/ipcMain\.(?:handle|on)\('([^']+)',\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*([\s\S]{0,220})/g)];
  const unchecked = handlers.filter((m) => !/fromNim\(e\)|fromSettings\(e\)|e\.sender !== win\.webContents|e\.sender === win/.test(m[3]) &&
    !['nim:wake-variants'].includes(m[1])).map((m) => m[1]);
  h.check('every message from a window is checked for who sent it', handlers.length > 20 && unchecked.length === 0, unchecked.join(', '));
  h.check('the microphone is only for Nim\'s own window', /wc === win\.webContents/.test(main));
  for (const page of ['index.html', 'settings.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop', page), 'utf8');
    h.check(page + ' runs only its own scripts', /Content-Security-Policy[^>]*script-src 'self'/.test(html) && !/<script>[^<]/.test(html));
  }
  const nimWindows = [...main.matchAll(/webPreferences:\s*\{([\s\S]*?)\}/g)].map((m) => m[1]);
  h.check('every window: isolated, sandboxed, no Node', nimWindows.length >= 2 &&
    nimWindows.every((w) => /contextIsolation:\s*true/.test(w) && /nodeIntegration:\s*false/.test(w) && /sandbox:\s*true/.test(w)));

  h.finish();
})().catch((e) => { console.error(e); process.exit(1); });
