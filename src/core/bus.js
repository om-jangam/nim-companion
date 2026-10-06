'use strict';
/*
 * The central event bus. Everything that happens to Nim - a wake word, a plan,
 * a tool starting, a confirmation needed, an error - becomes one event here.
 * The bus folds it into the single state (state.js) and hands both the event
 * and the new state to every subscriber, which in practice means every window.
 *
 * Renderers may report only the events that genuinely happen in a renderer -
 * the microphone, the wake word, speech playback. A renderer cannot claim a
 * tool finished or an approval was granted; those come from the runtime alone.
 */
const { EventEmitter } = require('node:events');
const { initial, reduce } = require('./state');

const FROM_RENDERER = new Set([
  'wake_detected', 'listening_started', 'transcription_started', 'transcription_received',
  'response_started', 'response_completed', 'idle'
]);

const ALL = new Set([
  ...FROM_RENDERER,
  'planning_started', 'plan_created', 'validation_started', 'validation_failed',
  'confirmation_required', 'confirmation_resolved',
  'tool_started', 'tool_progress', 'tool_completed', 'tool_failed',
  'verification_started', 'verification_completed',
  'response_chunk', 'task_completed', 'task_cancelled', 'error', 'provider_status',
  'reminders_changed', 'media_changed'
]);

class Bus extends EventEmitter {
  constructor() {
    super();
    this.state = initial();
  }

  /** Main-process side: anything in ALL. */
  publish(type, data) {
    if (!ALL.has(type)) throw new Error('unknown event ' + type);
    const event = { type, data: data || {}, at: Date.now() };
    this.state = reduce(this.state, event);
    this.emit('event', event, this.state);
    return this.state;
  }

  /** Renderer side, through IPC: only what a renderer can truthfully know. */
  fromRenderer(type, data) {
    if (!FROM_RENDERER.has(type)) return null;          // silently refused, never trusted
    return this.publish(type, sanitize(data));
  }

  snapshot() { return this.state; }
}

/* Event data from a renderer is small and flat; anything else is dropped. A
 * spoken line can be a few sentences long; nothing else needs to be. */
function sanitize(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const [k, v] of Object.entries(data).slice(0, 8)) {
    if (!['string', 'number', 'boolean'].includes(typeof v)) continue;
    out[k] = typeof v === 'string' ? v.slice(0, k === 'text' ? 500 : 200) : v;
  }
  return out;
}

module.exports = new Bus();
module.exports.FROM_RENDERER = FROM_RENDERER;
module.exports.ALL = ALL;
