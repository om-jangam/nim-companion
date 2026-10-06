'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/* The window's whole reach into the rest of Nim. Each entry is one narrow
 * request; none of them runs code, opens files or reaches the network. */
contextBridge.exposeInMainWorld('nimHost', {
  config: () => ipcRenderer.invoke('nim:config'),
  synth: (text) => ipcRenderer.invoke('nim:synth', String(text || '')),
  // kind is 'head' | 'full' | 'scan' | 'command'; the main process decides what that means
  transcribe: (wav, kind) => ipcRenderer.invoke('nim:transcribe', wav, String(kind || 'command')),
  canHear: () => ipcRenderer.invoke('nim:can-hear'),
  log: (line) => ipcRenderer.send('nim:log', String(line)),
  onListen: (cb) => ipcRenderer.on('nim:listen', () => cb()),
  onWakeWord: (cb) => ipcRenderer.on('nim:wake-word', (_e, on) => cb(on)),

  onCursor: (cb) => ipcRenderer.on('nim:cursor', (_e, p) => cb(p)),
  onSay: (cb) => ipcRenderer.on('nim:say', (_e, p) => cb(p)),
  onOpenInput: (cb) => ipcRenderer.on('nim:open-input', () => cb()),
  onSetVoice: (cb) => ipcRenderer.on('nim:set-voice', (_e, name) => cb(name)),
  onVoiceChanged: (cb) => ipcRenderer.on('nim:voice-changed', (_e, v) => cb(v)),
  onSettings: (cb) => ipcRenderer.on('nim:settings', (_e, v) => cb(v)),
  onSongCheck: (cb) => ipcRenderer.on('nim:song-check', (_e, v) => cb(v)),
  onQuiet: (cb) => ipcRenderer.on('nim:quiet', (_e, v) => cb(v)),
  onSaver: (cb) => ipcRenderer.on('nim:saver', (_e, on) => cb(!!on)),
  onSize: (cb) => ipcRenderer.on('nim:size', (_e, z) => cb(z)),
  onHabitOffer: (cb) => ipcRenderer.on('nim:habit-offer', (_e, v) => cb(v)),
  quietStop: () => ipcRenderer.send('nim:quiet-stop'),
  habitAnswer: (id, choice) => ipcRenderer.invoke('nim:habit-answer', String(id), String(choice)),
  onOutfit: (cb) => ipcRenderer.on('nim:outfit', (_e, partial) => cb(partial)),

  voices: (list, current) => ipcRenderer.send('nim:voices', { list, current }),

  expand: (open) => ipcRenderer.send('nim:expand', !!open),
  // the keyboard, only while you are typing into the surface
  focus: (on) => ipcRenderer.send('nim:focus', !!on),

  // where the Dots and the surface are drawn, so they can be clicked through a
  // click-through window
  hitboxes: (boxes) => ipcRenderer.send('nim:hitboxes', boxes),

  // the one event bus every part of Nim shares
  emit: (type, data) => ipcRenderer.send('nim:emit', String(type), data || {}),
  state: () => ipcRenderer.invoke('nim:state'),
  onState: (cb) => ipcRenderer.on('nim:state', (_e, p) => cb(p)),

  // the agent
  submit: (text) => ipcRenderer.invoke('agent:submit', String(text || '')),
  agent: (action, arg) => ipcRenderer.send('agent:control', { action: String(action), arg: arg === true }),
  onAgent: (cb) => ipcRenderer.on('agent:update', (_e, s) => cb(s)),
  dragStart: () => ipcRenderer.send('nim:drag-start'),
  dragEnd: () => ipcRenderer.send('nim:drag-end'),
  menu: () => ipcRenderer.send('nim:menu'),

  // dancing to music switched on or off from the menu
  onDance: (cb) => ipcRenderer.on('nim:dance', (_e, on) => cb(!!on)),
  onLyrics: (cb) => ipcRenderer.on('nim:lyrics', (_e, p) => cb(p)),
  mediaControl: (action) => ipcRenderer.invoke('nim:media-control', String(action)),
  // looking after you
  battery: (b) => ipcRenderer.send('nim:battery', { level: Number(b && b.level), charging: !!(b && b.charging) }),
  focusStop: () => ipcRenderer.send('nim:focus-stop'),
  clipAction: (action) => ipcRenderer.invoke('nim:clip-action', String(action)),
  onFocus: (cb) => ipcRenderer.on('nim:focus', (_e, p) => cb(p)),
  onStretch: (cb) => ipcRenderer.on('nim:stretch', (_e, p) => cb(p)),
  onWorried: (cb) => ipcRenderer.on('nim:worried', (_e, p) => cb(p)),
  onWelcome: (cb) => ipcRenderer.on('nim:welcome', (_e, p) => cb(p)),
  onClipOffer: (cb) => ipcRenderer.on('nim:clip-offer', (_e, p) => cb(p)),
  onQuiz: (cb) => ipcRenderer.on('nim:quiz', (_e, p) => cb(p)),
  onPet: (cb) => ipcRenderer.on('nim:pet', (_e, p) => cb(p)),
  onSongMood: (cb) => ipcRenderer.on('nim:song-mood', (_e, p) => cb(p)),
  onMediaClock: (cb) => ipcRenderer.on('nim:media-clock', (_e, p) => cb(p)),

  // learning how you say "Hey Nim": the menu starts it, the spellings are saved
  onEnroll: (cb) => ipcRenderer.on('nim:enroll', () => cb()),
  saveWakeVariants: (list) => ipcRenderer.invoke('nim:wake-variants', Array.isArray(list) ? list.map(String).slice(0, 8) : []),

  // self-test only: a recording the main process feeds through the wake path
  onTestWake: (cb) => ipcRenderer.on('nim:test-wake', (_e, bytes) => cb(bytes))
});
