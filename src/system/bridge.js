'use strict';
/*
 * The way into bridge.ps1: Nim's fixed set of native Windows operations.
 *
 *   await bridge.call('volume.set', { level: 30 })   -> { level: 30, muted: false }
 *
 * Requests are an operation name and plain arguments, one JSON line each; the
 * PowerShell side looks the name up in its own fixed list. Nothing here builds
 * a command or a script, so nothing a plan says can become one.
 *
 * The process is started on first use and kept, because the start-up is the
 * slow part. If it dies it is started again on the next call.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const SCRIPT = path.join(__dirname, 'bridge.ps1');
const OPS = new Set(['ping', 'volume.get', 'volume.set', 'volume.mute', 'windows', 'foreground', 'fullscreen', 'focus',
  'close', 'apps', 'apppaths', 'browser', 'fileapp', 'media.now', 'media.pause', 'media.play', 'mediakey', 'lock', 'sleep']);

let proc = null;
let ready = null;
let seq = 0;
const waiting = new Map();

function start() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    // -ExecutionPolicy applies to this one process and this one script, our own
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    proc = p;
    let started = false;
    const timer = setTimeout(() => { if (!started) { stop(); reject(new Error('the system bridge did not start')); } }, 20000);

    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line.replace(/^﻿/, '')); } catch { return; }
      if (msg.ready) { started = true; clearTimeout(timer); resolve(true); return; }
      const job = waiting.get(msg.id);
      if (!job) return;
      waiting.delete(msg.id);
      clearTimeout(job.timer);
      if (msg.ok) job.resolve(msg.result);
      else job.reject(new Error(msg.error || 'the system bridge failed'));
    });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d.toString()).slice(-1000); });
    p.on('exit', () => {
      clearTimeout(timer);
      if (proc === p) { proc = null; ready = null; }
      for (const [id, job] of waiting) { clearTimeout(job.timer); job.reject(new Error('the system bridge stopped' + (err ? ': ' + err.trim().split('\n').pop() : ''))); waiting.delete(id); }
      if (!started) reject(new Error('the system bridge did not start' + (err ? ': ' + err.trim().split('\n').pop() : '')));
    });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  ready.catch(() => { ready = null; });
  return ready;
}

/** call(op, args) -> result. Rejects with the bridge's own message on failure. */
async function call(op, args, timeoutMs) {
  if (!OPS.has(op)) throw new Error('unknown system operation ' + op);
  await start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(op + ' took too long'));
    }, timeoutMs || 15000);
    waiting.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify(Object.assign({}, args || {}, { op, id })) + '\n');
  });
}

function stop() {
  const p = proc;
  proc = null;
  ready = null;
  if (p) { try { p.stdin.end(); p.kill(); } catch { /* gone */ } }
}

module.exports = { call, start, stop, OPS };
