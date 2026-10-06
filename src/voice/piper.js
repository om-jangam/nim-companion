'use strict';
/*
 * Nim's real voice.
 *
 * Piper is a neural text-to-speech engine that runs entirely on this machine -
 * no account, no internet, no per-word cost. It turns a line of text into a WAV
 * in a fraction of the time it takes to say it.
 *
 * Voices are the .onnx files in voices/. Drop another one in and it shows up in
 * Settings (right-click Nim) on the next start.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..', '..');
const EXE = path.join(ROOT, 'vendor', 'piper', 'piper.exe');
const VOICE_DIR = path.join(ROOT, 'voices');

/** Every voice model sitting in voices/, newest naming tidied for display. */
function list() {
  try {
    return fs.readdirSync(VOICE_DIR)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => ({
        id: f,
        engine: 'piper',
        name: f.replace(/\.onnx$/, '').split('-').slice(1, 2).join('') || f,
        full: f.replace(/\.onnx$/, '')
      }));
  } catch {
    return [];
  }
}

function available() {
  return fs.existsSync(EXE) && list().length > 0;
}

/** Resolves to the WAV bytes. Rejects if Piper is missing or fails. */
function speak(text, voiceId, rate) {
  return new Promise((resolve, reject) => {
    const voices = list();
    if (!fs.existsSync(EXE)) return reject(new Error('piper is not installed'));
    if (!voices.length) return reject(new Error('no voice model in voices/'));

    const chosen = voices.find((v) => v.id === voiceId) || voices[0];
    const out = path.join(os.tmpdir(), 'nim-' + process.pid + '-' + Date.now() + '.wav');

    // cwd matters: piper.exe loads its DLLs from alongside itself
    // faster speech is shorter speech: Piper's length scale is the inverse of the rate
    const r = Number(rate);
    const pace = Number.isFinite(r) && r > 0 ? ['--length_scale', (1 / Math.min(1.35, Math.max(0.75, r))).toFixed(2)] : [];
    const proc = spawn(EXE, ['--model', path.join(VOICE_DIR, chosen.id), '--output_file', out].concat(pace), {
      cwd: path.dirname(EXE),
      windowsHide: true
    });

    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('piper exited ' + code + ': ' + err.slice(-180)));
      }
      fs.readFile(out, (readErr, buf) => {
        fs.unlink(out, () => { /* best effort */ });
        if (readErr) reject(readErr); else resolve(buf);
      });
    });

    proc.stdin.end(text);
  });
}

module.exports = { available, list, speak };
