'use strict';
/*
 * Nim's small built-in abilities: the ones that need no tool of their own.
 *
 * Telling the time, copying and pasting into the app you are using, typing for
 * you, a word of encouragement, saying hello. Everything that changes the
 * computer in a way that can be checked - volume, apps, pages, files - has a
 * proper tool in src/agent/tools with verification; this is what is left.
 *
 * Each skill says how to recognise a request and what to do about it. Nothing
 * here needs the internet or a model.
 */
const { clipboard } = require('electron');
const { spawn } = require('node:child_process');
const bridge = require('../system/bridge');

/* Keys are never pressed into a command line. Text pasted there with a line
 * break in it runs at once - which is exactly how a web page that talked the
 * planner into "paste" could get a command run on your PC. Nim copies, pastes
 * and types into any other app; in a terminal you type yourself. If Nim
 * cannot tell what is in front, it does not type. */
const TERMINAL = /^(cmd|powershell|powershell_ise|pwsh|windowsterminal|wt|conhost|openconsole|wsl|wslhost|bash|sh|zsh|mintty|alacritty|wezterm|wezterm-gui|putty|kitty|hyper|tabby|ubuntu\d*|debian|kali|ssh|cygwin|msys2)$/i;
async function terminalInFront() {
  try {
    const fg = await bridge.call('foreground', {}, 3000);
    return TERMINAL.test(String((fg && fg.process) || ''));
  } catch {
    return true;
  }
}
const NOT_IN_TERMINAL = 'I do not type or paste into a command line - that is how a web page could run commands on your PC. Type it there yourself.';

/* ---- small helpers ------------------------------------------------------- */

/* Keystrokes go to whatever app you are actually working in. Nim's own window is
 * deliberately non-focusable, so your editor or browser keeps the keyboard and
 * these land where you expect. The pause lets the surface close first. The
 * keys themselves are fixed here: only copy and paste are ever pressed. */
const KEYS = { copy: '^c', paste: '^v' };
function pressKeys(which, delayMs) {
  const keys = KEYS[which];
  if (!keys) return;
  const script =
    '$w = New-Object -ComObject WScript.Shell; ' +
    'Start-Sleep -Milliseconds ' + (delayMs || 160) + '; ' +
    '$w.SendKeys(' + JSON.stringify(keys) + ')';
  // not detached: a detached console program shows its window however hidden it is asked to be
  const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: 'ignore'
  });
  p.on('error', () => { /* the keys simply are not pressed */ });
}

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

const MOTIVATION = [
  'You have done harder things than this one. Start with the smallest piece.',
  'You do not need to feel ready. You only need to begin.',
  'Progress today does not have to look like progress. Just do not stop.',
  'The work you avoid is usually the work that moves you. Pick that one.',
  'You are allowed to do it badly the first time. That is how it gets done at all.',
  'Nobody is coming to make this easier. Luckily, you are enough for it.',
  'Small, dull, consistent effort beats brilliance that shows up occasionally.',
  'You are closer than you were yesterday, even if it does not feel like it.'
];

function greeting(name) {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return part + (name ? ', ' + name : '') + '.';
}

/* ---- the skills ---------------------------------------------------------- */
/* Order matters: the first match wins, so specific patterns sit above loose ones. */

/* ---- sums ------------------------------------------------------------------
 * Only numbers and the words for operations - nothing else is a sum, so
 * "what is 3 idiots rated out of 10" is not one. No eval: a tiny parser. */
const NUM = '\\d[\\d,]*(?:\\.\\d+)?';
const OP = '(?:plus|add|minus|less|times|multiplied\\s+by|x|×|\\*|divided\\s+by|over|÷|\\/|\\+|-|\\^|to\\s+the\\s+power\\s+of|(?:percent|%)\\s+of|mod)';
const ROOT = '(?:(?:the\\s+)?square\\s+root\\s+of|sqrt)\\s*';
const TERM = '(?:' + ROOT + ')?' + NUM + '(?:\\s*(?:squared|cubed|percent|%))?';
const MATH = new RegExp('^(?:please\\s+)?(?:(?:what(?:\'s|\\s+is)|calculate|how\\s+much\\s+is|work\\s+out)\\s+)?' +
  '(?=.*(?:' + OP + '|square|sqrt|cubed|percent|%))' + TERM + '(?:\\s*' + OP + '\\s*' + TERM + ')*\\s*[?.!]?$', 'i');

function calculate(text) {
  let s = String(text).toLowerCase()
    .replace(/^(?:please\s+)?(?:(?:what(?:'s|\s+is)|calculate|how\s+much\s+is|work\s+out)\s+)?/, '')
    .replace(/[?.!]+$/, '').replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(?:the\s+)?square\s+root\s+of|sqrt/g, ' r ')
    .replace(/(?:percent|%)\s+of/g, ' * 0.01 * ').replace(/percent|%/g, ' * 0.01 ')
    .replace(/to\s+the\s+power\s+of/g, ' ^ ').replace(/squared/g, ' ^ 2 ').replace(/cubed/g, ' ^ 3 ')
    .replace(/multiplied\s+by|times|×|\bx\b/g, ' * ').replace(/divided\s+by|\bover\b|÷/g, ' / ')
    .replace(/\bplus\b|\badd\b/g, ' + ').replace(/\bminus\b|\bless\b/g, ' - ').replace(/\bmod\b/g, ' % ');
  const tokens = s.match(/\d+(?:\.\d+)?|[-+*/^%r]/g);
  if (!tokens) return null;
  // shunting-yard: numbers out, operators by precedence; r is square root
  const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3, r: 4 };
  const out = [], ops = [];
  for (const t of tokens) {
    if (/\d/.test(t)) { out.push(Number(t)); continue; }
    while (ops.length && t !== 'r' && (PREC[ops[ops.length - 1]] > PREC[t] || (PREC[ops[ops.length - 1]] === PREC[t] && t !== '^'))) out.push(ops.pop());
    ops.push(t);
  }
  while (ops.length) out.push(ops.pop());
  const st = [];
  for (const t of out) {
    if (typeof t === 'number') { st.push(t); continue; }
    if (t === 'r') { if (!st.length) return null; st.push(Math.sqrt(st.pop())); continue; }
    if (st.length < 2) return null;
    const b = st.pop(), a = st.pop();
    st.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : t === '/' ? a / b : t === '%' ? a % b : Math.pow(a, b));
  }
  return st.length === 1 && Number.isFinite(st[0]) ? st[0] : null;
}

function spokenNumber(v) {
  const r = Math.round(v * 1000) / 1000;
  return Math.abs(r) >= 1e15 ? v.toExponential(3) : r.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

const SKILLS = [
  {
    name: 'copy',
    test: /^(?:please\s+)?copy(?:\s+(?:this|that|it|the selection))?\s*[.!]?$/i,
    run: async () => {
      // (in a terminal, Ctrl+C stops what is running rather than copying)
      if (await terminalInFront()) return { say: NOT_IN_TERMINAL, mood: 'speaking' };
      pressKeys('copy');
      return { say: pick(['Got it.', 'Copied that for you.', 'Copied.']), mood: 'happy', after: 500 };
    }
  },

  {
    name: 'paste',
    test: /^(?:please\s+)?paste(?:\s+(?:this|that|it|here|it here))?\s*[.!]?$/i,
    run: async () => {
      if (await terminalInFront()) return { say: NOT_IN_TERMINAL, mood: 'speaking' };
      pressKeys('paste');
      return { say: pick(['There you go.', 'Done.', 'Dropped it in.']), mood: 'happy' };
    }
  },

  {
    // only "type ...": "write a poem" is a request to write something, not to
    // press those three words into whatever app is open
    name: 'type-text',
    test: /^(?:please\s+)?type\s+(?:out\s+)?(.+)$/i,
    run: async (m) => {
      if (await terminalInFront()) return { say: NOT_IN_TERMINAL, mood: 'speaking' };
      // one line of text, never a line break: nothing typed is ever "entered"
      const text = String(m[1]).replace(/[\r\n]+/g, ' ').split(String.fromCharCode(0x2028)).join(' ').split(String.fromCharCode(0x2029)).join(' ');
      // the paste waits for the copy (the clipboard answers with a promise now)
      Promise.resolve(clipboard.writeText(text)).then(() => pressKeys('paste'), () => {});
      return { say: pick(['There.', 'Typed.', 'Done.']), mood: 'happy' };
    }
  },

  {
    name: 'time',
    test: /^(?:please\s+)?(?:what(?:'s| is)?\s+the\s+time|what time is it|tell me the time|time please|what's the time now|the time)\b/i,
    run: () => ({
      say: pick(['It is ', 'Just gone ', 'About ']) +
        new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.',
      mood: 'speaking'
    })
  },

  {
    name: 'date',
    test: /^(?:please\s+)?(?:what(?:'s| is)?\s+(?:the\s+|today'?s\s+)?date|what day is it|which day is it|what(?:'s| is) today)\b/i,
    run: () => ({
      say: 'Today is ' + new Date().toLocaleDateString([], {
        weekday: 'long', day: 'numeric', month: 'long'
      }) + '.',
      mood: 'speaking'
    })
  },

  {
    // sums, said the way people say them: "15 percent of 2400", "what is 12
    // times 8", "square root of 81". Worked out exactly here - a small model
    // gets arithmetic wrong.
    name: 'math',
    test: MATH,
    run: (m) => {
      const v = calculate(m[0]);
      if (v === null) throw new Error('I could not work that sum out');
      return { say: 'That is ' + spokenNumber(v) + '.', mood: 'speaking' };
    }
  },

  {
    name: 'motivate',
    test: /\b(?:motivat\w*|inspire me|encourage me|cheer me up|i (?:feel|am) (?:low|sad|tired|stuck|demotivated)|i can'?t do (?:this|it))\b/i,
    run: () => ({ say: pick(MOTIVATION), mood: 'happy' })
  },

  {
    name: 'thanks',
    test: /^(?:ok(?:ay)?\s+)?(?:thanks|thank you|good job|well done|nice one|great job)\b/i,
    run: () => ({ say: pick(['Any time.', 'That is what I am here for.', 'Glad to help.']), mood: 'happy' })
  },

  {
    name: 'who-are-you',
    test: /\b(?:who are you|what are you|what(?:'s| is) your name)\b/i,
    run: () => ({
      say: pick([
        'I am Nim. I live on your desktop, and I help where I can.',
        'Nim. I sit here and keep you company while you work.'
      ]),
      mood: 'happy'
    })
  },

  {
    name: 'greet',
    test: /^\s*(?:hi|hey|hello|yo|good morning|good evening|good afternoon)[\s!.,]*(?:there|nim)?[\s!.]*$/i,
    run: (m, ctx) => ({
      say: greeting(ctx.name) + ' ' + pick(['What do you need?', 'What are we doing?', 'I am listening.']),
      mood: 'happy'
    })
  },

  {
    name: 'goodbye',
    test: /^(?:ok(?:ay)?\s+)?(?:bye|goodbye|see you|good night|go to sleep)\b/i,
    run: () => ({ say: pick(['Good night. I will be right here.', 'Rest well. I am not going anywhere.']), mood: 'sleep' })
  }
];

/* ---- the way in ---------------------------------------------------------- */

async function handle(text, ctx) {
  const said = (text || '').trim();
  if (!said) return { say: '', mood: 'idle', handled: true };

  for (const skill of SKILLS) {
    const m = said.match(skill.test);
    if (!m) continue;
    try {
      const result = await skill.run(m, ctx || {});
      return Object.assign({ handled: true, skill: skill.name, mood: 'speaking' }, result);
    } catch (err) {
      return { handled: true, skill: skill.name, say: 'That did not work: ' + err.message, mood: 'sad' };
    }
  }

  return {
    handled: false,
    say: pick([
      'I cannot do that one yet.',
      'That is beyond me for now - I am still learning.',
      'I do not know how to do that yet.'
    ]),
    mood: 'sad'
  };
}

/** Which skill would claim this, without running it - or null. */
function match(text) {
  const said = String(text || '').trim();
  for (const skill of SKILLS) if (skill.test.test(said)) return skill.name;
  return null;
}

module.exports = { handle, match, greeting, names: () => SKILLS.map((s) => s.name) };
