'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/* The settings window can read its settings, change one of them, ask for two
 * fixed things - hear the voice, learn your voice - and look after the
 * automations. Nothing else. */
contextBridge.exposeInMainWorld('settingsHost', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (key, value) => ipcRenderer.invoke('settings:set', String(key), value),
  setVoice: (choice) => ipcRenderer.invoke('settings:voice', choice && { engine: String(choice.engine), id: String(choice.id) }),
  action: (name) => ipcRenderer.invoke('settings:action', String(name)),
  onStatus: (cb) => ipcRenderer.on('settings:status', (_e, s) => cb(s)),
  // automations: what there is, and changes to them - each one checked by the app
  automations: () => ipcRenderer.invoke('settings:automations'),
  saveAutomation: (def) => ipcRenderer.invoke('settings:automation-save', def),
  removeAutomation: (id) => ipcRenderer.invoke('settings:automation-remove', String(id)),
  toggleAutomation: (id, on) => ipcRenderer.invoke('settings:automation-toggle', String(id), !!on),
  runAutomation: (id) => ipcRenderer.invoke('settings:automation-run', String(id))
});
