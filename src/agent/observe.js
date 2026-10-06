'use strict';
/*
 * How Nim checks what actually happened on screen.
 *
 * Two senses, in order of cost:
 *
 *   windows()  - the titles of every visible top-level window. Cheap (one
 *                PowerShell call, well under a second) and surprisingly
 *                decisive: a browser that opened YouTube is a window titled
 *                "... YouTube ...". This is what most verification uses.
 *
 *   look()     - a screenshot shown to a local vision model (moondream, via
 *                Ollama) with a yes/no question. Slower - seconds, on the GPU -
 *                and reserved for when titles cannot settle it.
 *
 * Neither ever leaves the machine. Screenshots live in memory only and are
 * dropped as soon as the model has answered.
 */
const { spawn } = require('node:child_process');

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const VISION_MODEL = process.env.NIM_VISION_MODEL || 'moondream';

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error(cmd + ' timed out')); }, timeoutMs || 8000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || cmd + ' exited ' + code));
      resolve(out);
    });
  });
}

/** Every visible window: [{ title, process, pid }] - every window, not one
 * per app, so a browser's second window counts. Through the system bridge
 * (milliseconds); a one-off PowerShell call if the bridge is not running. */
async function windows() {
  try {
    const list = await require('../system/bridge').call('windows', {}, 10000);
    return (list || []).map((w) => ({ title: String(w.title || ''), process: String(w.process || ''), pid: w.pid }));
  } catch { /* fall back below */ }
  const script =
    "Get-Process | Where-Object { $_.MainWindowTitle } | " +
    "Select-Object @{n='t';e={$_.MainWindowTitle}}, @{n='p';e={$_.ProcessName}} | " +
    'ConvertTo-Json -Compress';
  const raw = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 8000);
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((w) => ({ title: w.t, process: w.p }));
}

/**
 * Wait for a window whose title or process matches, polling until it appears
 * or the deadline passes. Opening a browser tab takes a moment; checking once,
 * immediately, would fail things that are about to succeed.
 */
async function waitForWindow(test, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 9000);
  let last = [];
  while (Date.now() < deadline) {
    try {
      last = await windows();
      const hit = last.find(test);
      if (hit) return { found: true, window: hit };
    } catch { /* a failed poll is not a verdict; try again */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { found: false, seen: last.map((w) => w.title).slice(0, 8) };
}

/** A screenshot of the primary display as a PNG buffer. Main process only. */
async function screenshot() {
  const { desktopCapturer, screen } = require('electron');
  const size = screen.getPrimaryDisplay().size;
  // half resolution: plenty for "is YouTube open", and a quarter of the pixels
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(size.width / 2), height: Math.round(size.height / 2) }
  });
  if (!sources.length) throw new Error('no screen to capture');
  return sources[0].thumbnail.toPNG();
}

/** Ask the local vision model a question about the screen. */
async function look(question, png) {
  const image = png || await screenshot();
  const res = await fetch(OLLAMA + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      prompt: question,
      images: [image.toString('base64')],
      stream: false,
      options: { temperature: 0 }
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) throw new Error('vision model returned ' + res.status);
  const body = await res.json();
  return String(body.response || '').trim();
}

/** A yes/no question about the screen, answered by the vision model. */
async function confirm(question, png) {
  const answer = await look(question + ' Answer yes or no.', png);
  return { yes: /^\s*yes\b/i.test(answer), answer };
}

module.exports = { windows, waitForWindow, screenshot, look, confirm, VISION_MODEL };
