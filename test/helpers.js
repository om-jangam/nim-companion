'use strict';
/*
 * Shared by every test file. No test framework: each file is a plain script
 * that prints PASS/FAIL lines and exits non-zero if anything failed, which is
 * all run.js needs and keeps the suite runnable with nothing but node.
 */
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* Electron is not running under plain node, so what tools reach for is
 * replaced with recorders. Tests can inspect what would have been opened. */
const opened = [];
const trashed = [];
let clip = '';
function stubElectron() {
  const original = Module._load;
  Module._load = function (request) {
    if (request === 'electron') {
      return {
        shell: {
          openExternal: async (u) => { opened.push(u); },
          openPath: async (p) => { opened.push(p); return ''; },
          trashItem: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); }
        },
        clipboard: { readText: () => clip, writeText: (t) => { clip = String(t); } }
      };
    }
    return original.apply(this, arguments);
  };
}

/* Memory and the audit log go to a throwaway place, never the real ones. */
function isolate(name) {
  const dir = path.join(os.tmpdir(), 'nim-test-' + name + '-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  process.env.NIM_MEMORY_FILE = path.join(dir, 'memory.json');
  process.env.NIM_REMINDERS_FILE = path.join(dir, 'reminders.json');
  process.env.NIM_AUDIT_FILE = path.join(dir, 'audit.log');
  return dir;
}

/* A whole pretend home folder, with the usual folders in it. Every file tool
 * resolves paths against it, so tests can write, move and delete for real
 * without going near your own files. */
function isolateHome(name) {
  const dir = isolate(name);
  const home = path.join(dir, 'home');
  for (const f of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) fs.mkdirSync(path.join(home, f), { recursive: true });
  process.env.NIM_HOME = home;
  return home;
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '   (' + detail + ')' : '')); }
}
function section(title) { console.log('\n' + title); }
function skip(label, why) { console.log('  SKIP  ' + label + '   (' + why + ')'); }
function finish() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { stubElectron, isolate, isolateHome, opened, trashed, check, section, skip, finish, wait };
