'use strict';
/*
 * The floating surface shows exactly what the shared state says, and nothing
 * the state does not: no progress bar without a real multi-step task, no
 * "done" before the runtime says done, a question that stays until answered.
 */
const h = require('./helpers');
const { view, holdFor } = require('../src/desktop/surface-model.js');
const { initial, reduce } = require('../src/core/state');

function after(...events) {
  let s = initial();
  for (const [type, data] of events) s = reduce(s, { type, data: data || {}, at: 1 });
  return s;
}

h.section('idle: nothing there');
let v = view(initial(), {});
h.check('hidden while nothing is happening', v.mode === 'hidden');
v = view(initial(), { asking: true });
h.check('opened by hand: a box to type in', v.mode === 'ask' && v.input === true);

h.section('one request, start to finish');
v = view(after(['wake_detected']), {});
h.check('"Hey Nim": Listening', v.mode === 'listening' && v.title === 'Listening...' && v.meter);
v = view(after(['listening_started', { label: 'Still listening...' }]), {});
h.check('a follow-up says it is still listening', v.title === 'Still listening...');
v = view(after(['wake_detected'], ['transcription_started']), {});
h.check('hearing you', v.mode === 'hearing');
v = view(after(['transcription_received', { text: 'open brave' }], ['planning_started', { provider: 'ollama' }]), {});
h.check('thinking, with what it heard', v.mode === 'thinking' && /open brave/.test(v.detail));
v = view(after(['planning_started'], ['plan_created', { steps: 1, provider: 'rules' }], ['tool_started', { tool: 'app.launch', label: 'Opening Brave...' }]), {});
h.check('one quick action: one line, no bar, no buttons', v.mode === 'working' && v.title === 'Opening Brave...' && !v.progress && !v.actions.length);
v = view(after(['planning_started'], ['plan_created', { steps: 1 }], ['tool_started', { tool: 'app.launch' }], ['tool_completed', { tool: 'app.launch', label: 'Brave is open' }], ['task_completed', { label: 'Brave is open' }]), {});
h.check('then done, saying what was done', v.mode === 'done' && v.title === 'Brave is open');
h.check('and it folds away on its own', holdFor(v) > 0 && !v.sticky);

h.section('a longer task shows real progress and can be stopped');
v = view(after(['plan_created', { steps: 4, title: 'Electron notes' }], ['tool_started', { tool: 'web.search' }], ['tool_completed', { tool: 'web.search' }], ['tool_started', { tool: 'http.fetch', label: 'Reading electronjs...' }]), {});
h.check('one of four done, as the runtime counted', v.progress && v.progress.done === 1 && v.progress.total === 4 && v.meta === '1 of 4');
h.check('with a stop button', v.actions.some((a) => a[0] === 'stop'));
h.check('and it stays until the task moves on', v.sticky);

h.section('a question stays until it is answered');
v = view(after(['plan_created', { steps: 1 }], ['confirmation_required', { stepId: 's1', question: 'Shut down your computer?', risk: 'critical', tool: 'system.shutdown' }]), {});
h.check('the question, Cancel and Confirm', v.mode === 'confirm' && v.title === 'Shut down your computer?' &&
  v.actions.map((a) => a[0]).join() === 'deny,approve');
h.check('says how to answer by voice', /Hey Nim, confirm/.test(v.detail));
h.check('never times out', v.sticky && holdFor(v) === 0);
v = view(after(['plan_created', { steps: 1 }], ['confirmation_required', { stepId: 's1', question: 'Shut down your computer?', tool: 'system.shutdown' }], ['response_started', { text: 'Shut down your computer?' }]), {});
h.check('even while Nim says the question out loud', v.mode === 'confirm');

h.section('replies and errors');
v = view(after(['plan_created', { steps: 0 }], ['response_started', { text: 'It is 6:30 PM.' }]), {});
h.check('a spoken answer is shown while it is said', v.mode === 'reply' && v.detail === 'It is 6:30 PM.');
v = view(after(['error', { message: 'Brave did not open' }]), {});
h.check('an error says what went wrong', v.mode === 'error' && v.detail === 'Brave did not open' && holdFor(v) > 0);

h.section('short and clear');
v = view(after(['plan_created', { steps: 1 }], ['confirmation_required', { stepId: 's1', question: 'Close Notepad?', risk: 'medium', tool: 'app.close' }]), {});
h.check('an everyday question is answered with a plain yes or no', v.mode === 'confirm' && /yes or no/i.test(v.detail));
v = view(after(['plan_created', { steps: 1 }], ['tool_started', { tool: 'screen.capture' }],
  ['tool_completed', { tool: 'screen.capture', label: 'Screenshot saved as Nim screenshot 2026-10-04 14.03.22.png' }],
  ['task_completed', { label: 'Screenshot saved as Nim screenshot 2026-10-04 14.03.22.png' }], ['response_started', { text: 'Screenshot saved as Nim screenshot 2026-10-04 14.03.22.png.' }]), {});
h.check('a done card has a short headline', v.mode === 'done' && v.title === 'Screenshot saved', JSON.stringify(v.title));
h.check('with the file name underneath, said once', v.detail === 'Nim screenshot 2026-10-04 14.03.22.png', JSON.stringify(v.detail));

h.finish();
