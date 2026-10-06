'use strict';
/*
 * Nim's one state, and the only function that changes it.
 *
 * Every surface - the creature (Lume), the floating surface, the Dots, the
 * island - draws itself from this. They never keep state machines of their
 * own, so they cannot drift apart: the main process folds each event into this
 * state and sends the same result to every window.
 *
 * Pure: (state, event) -> state. No side effects, no clock reads beyond the
 * event's own timestamp, so it is trivially testable and replayable.
 */

const PHASES = ['idle', 'listening', 'transcribing', 'thinking', 'working',
                'confirming', 'speaking', 'done', 'error'];

/* Which part of the computer a tool touches - the Dots are drawn per category. */
const CATEGORY = {
  'browser.open': 'browser', 'web.search': 'browser', 'http.fetch': 'browser', 'web.research': 'browser',
  'page.open': 'browser', 'page.read': 'browser', 'page.click': 'browser', 'page.type': 'browser', 'page.tabs': 'browser',
  'web.download': 'browser',
  'files.list': 'files', 'files.read': 'files', 'files.write': 'files', 'files.search': 'files',
  'files.mkdir': 'files', 'files.move': 'files', 'files.copy': 'files', 'files.rename': 'files',
  'files.delete': 'files', 'files.open': 'files', 'folder.open': 'files', 'files.organize': 'files',
  'app.open': 'system', 'app.launch': 'system', 'app.close': 'system', 'app.focus': 'system',
  'system.volume': 'media', 'media.play': 'media', 'media.control': 'media', 'media.pause': 'media', 'media.resume': 'media',
  'system.screenshot': 'system', 'system.power': 'system',
  'skill': 'system', 'say': 'voice', 'wait': 'system',
  'memory.remember': 'memory', 'memory.recall': 'memory', 'memory.forget': 'memory',
  'focus.start': 'reminders', 'focus.stop': 'reminders', 'focus.status': 'reminders',
  'system.health': 'system', 'weather.now': 'browser', 'weather.set_city': 'memory', 'briefing.now': 'reminders',
  'study.quiz': 'ai', 'nim.quiet': 'voice', 'nim.saver': 'system', 'automation.list': 'reminders', 'automation.toggle': 'reminders',
  'notes.add': 'memory', 'reminder.set': 'reminders', 'reminder.list': 'reminders', 'reminder.cancel': 'reminders',
  'clipboard.read': 'system', 'clipboard.write': 'system',
  'text.compose': 'ai', 'screen.describe': 'vision',
  'project.inspect': 'code', 'git.status': 'code', 'project.test': 'code', 'project.open': 'code'
};

const VERB = {
  browser: 'Browsing', files: 'Working with files', system: 'Working', media: 'Adjusting',
  memory: 'Remembering', reminders: 'Setting a reminder', ai: 'Writing', vision: 'Looking',
  code: 'Checking the project', voice: 'Speaking'
};

function initial() {
  return {
    phase: 'idle',
    label: '',
    heard: '',                   // what was just said to Nim, as it was heard
    task: null,                  // { title, done, total, current: { tool, title, category, progress } }
    confirm: null,               // { stepId, title, question, risk, tool }
    activity: {},                // category -> 'active' | 'done' | 'failed' | 'waiting'
    providers: { rules: 'ready', qwen: 'unknown', whisper: 'unknown' },
    thinkingWith: null,          // which mind is working on the current request
    speech: null,                // { text } while Nim is saying something
    reminders: 0,                // how many reminders are waiting to go off
    media: null,                 // { playing, title, artist, app, length } - what Windows says is playing
    lastError: null,
    lastEvent: null,
    at: 0
  };
}

function categoryOf(tool) { return CATEGORY[tool] || 'system'; }

/** Fold one event into the state. Unknown events change nothing. */
function reduce(state, event) {
  const s = Object.assign({}, state, { activity: Object.assign({}, state.activity), lastEvent: event.type, at: event.at || state.at });
  const d = event.data || {};

  switch (event.type) {
    case 'wake_detected':
      s.phase = 'listening'; s.label = 'Listening...'; s.lastError = null; s.heard = ''; break;
    case 'listening_started':
      // a question waiting for a yes is not interrupted by the microphone
      if (s.phase === 'confirming') break;
      s.phase = 'listening'; s.label = d.label || 'Listening...'; s.lastError = null; s.heard = ''; break;
    case 'transcription_started':
      s.phase = 'transcribing'; s.label = 'Hearing you...'; break;
    case 'transcription_received':
      s.phase = 'thinking'; s.label = 'Thinking...'; s.heard = d.text || ''; break;

    case 'planning_started':
      s.phase = 'thinking'; s.label = 'Thinking...'; s.thinkingWith = d.provider || null;
      s.confirm = null; s.lastError = null; s.speech = null;
      if (d.text) s.heard = d.text;
      break;
    case 'validation_started':
      s.label = 'Checking the plan...'; break;
    case 'plan_created':
      s.thinkingWith = d.provider || s.thinkingWith;
      s.task = d.steps ? { title: d.title || '', done: 0, total: d.steps, current: null } : null;
      if (!d.steps) { s.phase = 'speaking'; s.label = ''; }
      break;
    case 'validation_failed':
      s.label = 'Rethinking...'; break;

    case 'confirmation_required':
      s.phase = 'confirming';
      s.confirm = { stepId: d.stepId, title: d.title, question: d.question || d.title, risk: d.risk, tool: d.tool };
      s.label = d.question || d.title || 'Needs your approval';
      s.activity[categoryOf(d.tool)] = 'waiting';
      break;
    case 'confirmation_resolved':
      s.confirm = null;
      s.phase = 'working';
      s.label = d.granted ? 'Going ahead...' : 'Skipped';
      break;

    case 'tool_started': {
      const cat = categoryOf(d.tool);
      s.phase = 'working';
      s.label = d.label || ((VERB[cat] || 'Working') + '...');
      s.activity[cat] = 'active';
      if (s.task) s.task = Object.assign({}, s.task, { current: { tool: d.tool, title: d.title, category: cat, uses: !!d.uses } });
      break;
    }
    case 'tool_progress':
      if (d.label) s.label = d.label;
      if (s.task && s.task.current && typeof d.fraction === 'number') {
        s.task = Object.assign({}, s.task, { current: Object.assign({}, s.task.current, { progress: Math.max(0, Math.min(1, d.fraction)) }) });
      }
      break;
    case 'verification_started':
      s.label = 'Checking it worked...'; break;
    case 'verification_completed':
      if (d.label) s.label = d.label;
      break;
    case 'tool_completed': {
      const cat = categoryOf(d.tool);
      s.activity[cat] = 'done';
      if (d.label) s.label = d.label;
      if (s.task) s.task = Object.assign({}, s.task, { done: Math.min(s.task.total, (s.task.done || 0) + 1) });
      break;
    }
    case 'tool_failed':
      s.activity[categoryOf(d.tool)] = 'failed'; break;

    case 'response_started':
      s.speech = { text: d.text || '' };
      // speaking in the middle of a task or a question does not end either
      if (s.phase !== 'working' && s.phase !== 'confirming') s.phase = 'speaking';
      break;
    case 'response_chunk':
      if (s.speech) s.speech = { text: (s.speech.text + (d.text || '')).slice(-600) };
      break;
    case 'response_completed':
      s.speech = null;
      if (s.phase === 'speaking') { s.phase = s.task ? 'done' : 'idle'; s.label = s.task ? (s.label || 'Done') : ''; }
      break;

    case 'task_completed':
      s.phase = 'done'; s.label = d.label || 'Done'; s.confirm = null; s.thinkingWith = null; break;
    case 'task_cancelled':
      s.phase = 'idle'; s.label = 'Cancelled'; s.task = null; s.confirm = null; s.thinkingWith = null;
      s.activity = {};                       // the run is over: nothing is still working
      break;
    case 'error':
      s.phase = 'error'; s.label = 'Something went wrong'; s.lastError = d.message || null;
      s.confirm = null; s.thinkingWith = null;
      for (const k of Object.keys(s.activity)) if (s.activity[k] === 'active' || s.activity[k] === 'waiting') s.activity[k] = 'failed';
      break;

    case 'provider_status':
      s.providers = Object.assign({}, s.providers, d); break;
    case 'media_changed':
      s.media = d.playing === undefined && !d.title ? null : {
        playing: !!d.playing, title: String(d.title || ''), artist: String(d.artist || ''), app: String(d.app || ''),
        length: Math.max(0, Math.round(Number(d.length) || 0))
      };
      break;
    case 'reminders_changed':
      s.reminders = Math.max(0, Number(d.count) || 0); break;

    case 'idle':
      // only ever published when nothing is running, so every dot settles back
      s.phase = 'idle'; s.label = ''; s.task = null; s.confirm = null; s.thinkingWith = null;
      s.speech = null; s.heard = ''; s.activity = {};
      break;

    default:
      return state;
  }
  return s;
}

module.exports = { initial, reduce, PHASES, CATEGORY, categoryOf };
