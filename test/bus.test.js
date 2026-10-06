'use strict';
/* One event stream, one state, every surface in step. */
const h = require('./helpers');
const bus = require('../src/core/bus');
const { reduce, initial } = require('../src/core/state');

h.section('a whole request, event by event');
const seen = [];
bus.on('event', (e, s) => seen.push({ type: e.type, phase: s.phase, label: s.label }));

bus.fromRenderer('wake_detected', {});
h.check('wake -> listening', bus.snapshot().phase === 'listening');
bus.fromRenderer('transcription_received', { text: 'open brave and search for electron' });
h.check('what was heard is part of the state', bus.snapshot().heard === 'open brave and search for electron');
bus.publish('planning_started', {});
h.check('planning -> thinking', bus.snapshot().phase === 'thinking' && bus.snapshot().label === 'Thinking...');
bus.publish('plan_created', { provider: 'ollama', steps: 2, title: 'Search' });
h.check('the plan sets up the task', bus.snapshot().task.total === 2 && bus.snapshot().thinkingWith === 'ollama');
bus.publish('tool_started', { tool: 'browser.open', title: 'Open a page' });
let s = bus.snapshot();
h.check('a browser step lights the browser dot', s.activity.browser === 'active' && s.phase === 'working');
h.check('and says what it is doing', /Browsing/.test(s.label), s.label);
bus.publish('tool_started', { tool: 'app.launch', label: 'Opening Brave...' });
h.check('a tool\'s own words win', bus.snapshot().label === 'Opening Brave...');
bus.publish('tool_progress', { tool: 'app.launch', fraction: 0.5, label: 'Half way...' });
h.check('progress inside a step is real numbers from the tool', bus.snapshot().task.current.progress === 0.5 && bus.snapshot().label === 'Half way...');
bus.publish('tool_completed', { tool: 'app.launch', verified: true, label: 'Brave is open' });
h.check('progress is counted from completions', bus.snapshot().task.done === 1);
h.check('and the finished step says what it did', bus.snapshot().label === 'Brave is open');
bus.publish('confirmation_required', { stepId: 's2', title: 'Write a file - notes.txt', question: 'Replace the existing notes.txt?', risk: 'high', tool: 'files.write' });
s = bus.snapshot();
h.check('a confirmation takes over', s.phase === 'confirming' && s.confirm.question === 'Replace the existing notes.txt?');
h.check('and marks the files dot as waiting', s.activity.files === 'waiting');
bus.publish('response_started', { text: 'Replace the existing notes.txt?' });
h.check('saying the question out loud does not end the question', bus.snapshot().phase === 'confirming');
bus.fromRenderer('listening_started', { via: 'follow-up' });
h.check('nor does the microphone', bus.snapshot().phase === 'confirming');
bus.publish('response_completed', {});
h.check('still confirming after the speech', bus.snapshot().phase === 'confirming' && !!bus.snapshot().confirm);
bus.publish('confirmation_resolved', { granted: true });
bus.publish('tool_started', { tool: 'files.write' });
bus.publish('response_started', { text: 'Writing it now.' });
h.check('speaking mid-task does not end the task', bus.snapshot().phase === 'working');
bus.publish('response_completed', {});
h.check('nor does finishing speaking', bus.snapshot().phase === 'working');
bus.publish('tool_completed', { tool: 'files.write' });
bus.publish('task_completed', { label: 'Saved notes.txt' });
h.check('completion, with what was done', bus.snapshot().phase === 'done' && bus.snapshot().task.done === 2 && bus.snapshot().label === 'Saved notes.txt');
bus.publish('idle');
s = bus.snapshot();
h.check('idle clears the task and the finished dots', s.phase === 'idle' && !s.task && !s.activity.browser);

h.section('an answer: thinking, speaking, back to idle');
bus.publish('planning_started', { text: 'how far is the moon' });
bus.publish('plan_created', { provider: 'ollama', steps: 0 });
h.check('no steps: straight to speaking', bus.snapshot().phase === 'speaking');
bus.publish('response_started', { text: 'About 384,000 kilometres.' });
h.check('what is being said is in the state', bus.snapshot().speech.text === 'About 384,000 kilometres.');
bus.publish('response_completed', {});
h.check('finished speaking: idle', bus.snapshot().phase === 'idle' && !bus.snapshot().speech);

h.section('a renderer cannot forge the runtime\'s events');
const before = bus.snapshot();
h.check('tool_completed from a renderer is refused', bus.fromRenderer('tool_completed', { tool: 'files.write' }) === null);
h.check('task_completed from a renderer is refused', bus.fromRenderer('task_completed', {}) === null);
h.check('confirmation_resolved from a renderer is refused', bus.fromRenderer('confirmation_resolved', { granted: true }) === null);
h.check('provider_status from a renderer is refused', bus.fromRenderer('provider_status', { qwen: 'ready' }) === null);
h.check('and the state did not move', bus.snapshot() === before);

h.section('renderer event data is sanitised');
bus.fromRenderer('listening_started', { via: 'wake', nested: { evil: true }, fn: 'x'.repeat(500) });
const last = seen[seen.length - 1];
h.check('the event still landed', last.type === 'listening_started');
bus.fromRenderer('response_started', { text: 'y'.repeat(2000) });
h.check('a long spoken line is capped', bus.snapshot().speech.text.length === 500);
bus.publish('idle');

h.section('unknown events change nothing');
h.check('reduce ignores what it does not know', reduce(initial(), { type: 'made_up' }).phase === 'idle');
let threw = false;
try { bus.publish('made_up'); } catch { threw = true; }
h.check('publishing an unknown event is an error', threw);

h.section('errors, cancellation, reminders');
bus.publish('error', { message: 'the page did not load' });
h.check('error phase with the reason', bus.snapshot().phase === 'error' && bus.snapshot().lastError === 'the page did not load');
bus.publish('task_cancelled', {});
h.check('cancel returns to idle', bus.snapshot().phase === 'idle' && !bus.snapshot().confirm);
bus.publish('reminders_changed', { count: 2 });
h.check('reminders waiting are counted for the Dots', bus.snapshot().reminders === 2);
h.check('there is no cloud mind in the state', !('claude' in bus.snapshot().providers));

h.section('every subscriber gets the same state object');
const a = [], b = [];
bus.on('event', (e, st) => a.push(st));
bus.on('event', (e, st) => b.push(st));
bus.publish('planning_started', {});
bus.publish('plan_created', { steps: 1 });
h.check('identical, not copies that could drift', a.length === 2 && a.every((st, i) => st === b[i]));

h.finish();
