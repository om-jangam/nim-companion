'use strict';
/*
 * What the floating surface shows, worked out from Nim's one shared state.
 *
 * The surface is Nim's way of saying something in words: it grows out of the
 * light above Nim's head when there is something to show, and folds back into
 * it when there is not. It has no state machine of its own. This function maps
 * the shared state - the same state the creature's face and the Dots are drawn
 * from - plus the two things only the window itself knows (whether you opened
 * it to type, and how loud the microphone is) onto a view:
 *
 *   { mode, glyph, title, meta, detail, progress, actions, sticky, input, meter }
 *
 * Pure, so it is tested without a window (test/surface.test.js), and loaded in
 * the window as a plain script.
 *
 * Nothing here invents progress. A bar is shown only when the runtime reports
 * a task with more than one step, and it shows the steps actually finished.
 */
(function (global) {
  'use strict';

  var MIND = { ollama: 'Qwen', rules: '' };

  function clip(text, n) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '...' : s;
  }

  /**
   * view(state, local)
   *   state  the shared state (src/core/state.js)
   *   local  { asking, typing, hearing } - the surface was opened by hand to
   *          type or talk; the microphone is open in this window
   */
  function view(state, local) {
    var s = state || {};
    var l = local || {};
    var task = s.task || null;
    var phase = s.phase || 'idle';
    var out = {
      mode: 'hidden', glyph: '', title: '', meta: '', detail: '',
      progress: null, actions: [], sticky: false, input: false, meter: false
    };

    // learning your voice: what to say, how far along, what it heard
    if (l.enroll) {
      out.mode = 'enroll';
      out.glyph = '◉';
      out.title = 'Say “Hey Nim”';
      out.meta = Math.min(l.enroll.step, l.enroll.total) + ' of ' + l.enroll.total;
      out.detail = l.enroll.heard ? 'I heard: “' + clip(l.enroll.heard, 40) + '”' : 'The way you normally would.';
      out.meter = true;
      out.actions = [['enroll-cancel', 'Cancel']];
      out.sticky = true;
      return out;
    }

    // a question waiting for you beats everything else: it stays until answered
    if (phase === 'confirming' && s.confirm) {
      out.mode = 'confirm';
      out.glyph = '?';
      out.title = clip(s.confirm.question || s.confirm.title || 'Go ahead?', 80);
      out.detail = !/^(low|medium)$/.test(s.confirm.risk || '') ? 'Say "Hey Nim, confirm" or press Confirm.' : 'Just say yes or no.';
      out.actions = [['deny', 'Cancel'], ['approve', 'Confirm']];
      out.sticky = true;
      return out;
    }

    if (phase === 'listening' || l.hearing) {
      out.mode = 'listening';
      out.glyph = '◉';                         // ◉
      out.title = phase === 'listening' && s.label ? clip(s.label, 40) : 'Listening...';
      out.meter = true;
      out.sticky = true;
      return out;
    }

    if (phase === 'transcribing') {
      out.mode = 'hearing';
      out.glyph = '◌';                         // ◌
      out.title = 'Hearing you...';
      out.sticky = true;
      return out;
    }

    if (phase === 'thinking') {
      out.mode = 'thinking';
      out.glyph = '◌';
      out.title = s.label && s.label !== 'Thinking...' ? clip(s.label, 60) : 'Thinking...';
      out.meta = MIND[s.thinkingWith] || '';
      out.detail = s.heard ? '“' + clip(s.heard, 90) + '”' : '';
      out.sticky = true;
      return out;
    }

    // one quick action is a single line; a longer task shows its real progress
    // and can be stopped
    if (phase === 'working') {
      out.mode = 'working';
      out.glyph = '⚡';                         // ⚡
      out.title = clip(s.label || 'Working...', 60);
      if (task && task.total > 1) {
        out.meta = Math.min(task.done, task.total) + ' of ' + task.total;
        out.progress = { done: Math.min(task.done, task.total), total: task.total };
        out.detail = task.title ? clip(task.title, 70) : '';
        out.actions = [['stop', 'Stop']];
      }
      out.sticky = true;
      return out;
    }

    // a finished task reports as done, with what Nim is saying about it underneath
    if (phase === 'done' || (phase === 'speaking' && task)) {
      out.mode = 'done';
      out.glyph = '✓';                         // ✓
      // a short headline ("Screenshot saved"); what it was saved as goes underneath
      var label = s.label && !/^(Done|Thinking\.\.\.)$/.test(s.label) ? String(s.label) : 'Done';
      var as = /^(.{3,40}?)\s+as\s+(.+)$/i.exec(label);
      out.title = clip(as ? as[1] : label, 44);
      if (as) out.detail = clip(as[2].replace(/\.$/, ''), 80);
      if (task && task.total > 1) out.progress = { done: task.done, total: task.total };
      // what Nim is saying, unless it only repeats the headline
      var flat = function (t) { return String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
      if (!as && s.speech && s.speech.text && flat(s.speech.text).indexOf(flat(label)) !== 0) out.detail = clip(s.speech.text, 200);
      return out;
    }

    if (phase === 'speaking' && s.speech && s.speech.text) {
      out.mode = 'reply';
      out.glyph = '';
      out.title = '';
      out.detail = clip(s.speech.text, 320);
      return out;
    }

    if (phase === 'error') {
      out.mode = 'error';
      out.glyph = '!';
      out.title = 'Something went wrong';
      out.detail = clip(s.lastError || '', 160);
      return out;
    }

    // idle: hidden, unless you opened it yourself to ask something
    if (l.asking) {
      out.mode = 'ask';
      out.glyph = '•';                          // •
      out.title = 'Nim';
      out.input = true;
      out.actions = [['listen', 'Talk'], ['expand', 'Open']];
      out.sticky = true;
    }
    return out;
  }

  /* How long a finished view stays before it folds away on its own. Questions
   * and work in progress never time out; they end when the state moves on. */
  function holdFor(v) {
    if (!v || v.sticky) return 0;
    if (v.mode === 'reply') return Math.min(9000, 2200 + v.detail.length * 45);
    if (v.mode === 'done') return 2600;
    if (v.mode === 'error') return 6000;
    return 0;
  }

  var api = { view: view, holdFor: holdFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.NimSurfaceModel = api;
}(typeof window !== 'undefined' ? window : this));
