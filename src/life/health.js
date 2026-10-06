'use strict';
/*
 * Watching the PC: battery, how hard the processor is working, memory, and
 * how full the main drive is. Nim looks worried and says why when something
 * needs you - once, not over and over.
 *
 * read() takes the measurements (Node's own os and fs; the battery comes from
 * the window, which can see it). evaluate() is pure: given readings and what
 * was already said, it decides what to say now (test/life.test.js).
 */
const os = require('node:os');
const fs = require('node:fs');

/* CPU busy share since the last call, 0..100. */
function cpuSampler() {
  let last = os.cpus();
  return function sample() {
    const now = os.cpus();
    let idle = 0, total = 0;
    now.forEach((c, i) => {
      const a = last[i] ? last[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
      const b = c.times;
      const t = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq);
      idle += b.idle - a.idle;
      total += t;
    });
    last = now;
    return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  };
}

function diskOf(root) {
  try {
    const s = fs.statfsSync(root);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { free, total, freePct: total ? Math.round(free / total * 100) : 100 };
  } catch { return null; }
}

function read(sampleCpu, battery) {
  return {
    cpu: sampleCpu(),
    memory: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    disk: diskOf(process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/'),
    battery: battery || null                     // { level 0..100, charging }
  };
}

/*
 * What to say now, if anything. memo carries what was said and when, and how
 * long things have been high (it is updated in place).
 *   battery 15% or less, on battery: once, and again at 7%
 *   processor at 90% or more for three readings in a row: once per half hour
 *   memory at 92% or more for three readings: once per half hour
 *   main drive under 8% free: once a day
 */
function evaluate(r, memo, now) {
  const out = [];
  const t = now || Date.now();
  const b = r.battery;
  if (b && !b.charging && Number.isFinite(b.level)) {
    if (b.level <= 7 && !memo.batteryCritical) {
      memo.batteryCritical = true; memo.batteryLow = true;
      out.push({ kind: 'battery', mood: 'sad', say: 'Battery at ' + b.level + ' percent. Please plug me in soon.' });
    } else if (b.level <= 15 && !memo.batteryLow) {
      memo.batteryLow = true;
      out.push({ kind: 'battery', mood: 'sad', say: 'Battery is getting low: ' + b.level + ' percent.' });
    }
  } else if (b && b.charging) { memo.batteryLow = false; memo.batteryCritical = false; }

  memo.cpuHigh = r.cpu >= 90 ? (memo.cpuHigh || 0) + 1 : 0;
  if (memo.cpuHigh >= 3 && (memo.cpuSaid === undefined || t - memo.cpuSaid > 30 * 60000)) {
    memo.cpuSaid = t;
    out.push({ kind: 'cpu', mood: 'sad', say: 'Your PC is working very hard right now - the processor is at ' + r.cpu + ' percent.' });
  }
  memo.memHigh = r.memory >= 92 ? (memo.memHigh || 0) + 1 : 0;
  if (memo.memHigh >= 3 && (memo.memSaid === undefined || t - memo.memSaid > 30 * 60000)) {
    memo.memSaid = t;
    out.push({ kind: 'memory', mood: 'sad', say: 'Memory is almost full (' + r.memory + ' percent). Closing a few apps would help.' });
  }
  if (r.disk && r.disk.freePct < 8 && (memo.diskSaid === undefined || t - memo.diskSaid > 24 * 3600000)) {
    memo.diskSaid = t;
    out.push({ kind: 'disk', mood: 'sad', say: 'Your main drive is nearly full: only ' + gb(r.disk.free) + ' left.' });
  }
  return out;
}

function gb(bytes) { return (bytes / 1073741824).toFixed(bytes > 10 * 1073741824 ? 0 : 1) + ' GB'; }

/* A spoken summary, for "how is my PC?" */
function report(r) {
  const parts = ['The processor is at ' + r.cpu + ' percent', 'memory at ' + r.memory + ' percent'];
  if (r.disk) parts.push(gb(r.disk.free) + ' free on the main drive (' + r.disk.freePct + ' percent)');
  if (r.battery && Number.isFinite(r.battery.level)) parts.push('battery ' + r.battery.level + ' percent' + (r.battery.charging ? ', charging' : ''));
  const worry = r.cpu >= 90 || r.memory >= 92 || (r.disk && r.disk.freePct < 8) || (r.battery && !r.battery.charging && r.battery.level <= 15);
  return (worry ? 'Something needs attention. ' : 'All looks fine. ') + parts.join(', ') + '.';
}

module.exports = { cpuSampler, read, evaluate, report, diskOf };
