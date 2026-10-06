'use strict';
/*
 * The settings window. Every change is sent the moment it is made; the app
 * checks it (settings-model.js) and says back what it saved.
 */
const host = window.settingsHost;
const W = window.NIM_WARDROBE;
let values = {};
let avatar = null;

const $ = (id) => document.getElementById(id);

let savedTimer = 0;
function saved() {
  $('saved').classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('saved').classList.remove('on'), 1400);
}

async function set(key, value) {
  const r = await host.set(key, value);
  if (r && r.ok) { values[key] = r.value; saved(); }
  render();
  return r;
}

function rateWord(r) {
  return r < 0.88 ? 'Slow' : r < 0.97 ? 'A little slow' : r <= 1.04 ? 'Normal' : r <= 1.15 ? 'A little fast' : 'Fast';
}

function render() {
  document.querySelectorAll('input[type=checkbox][data-key]').forEach((el) => { el.checked = !!values[el.dataset.key]; });
  if (document.activeElement !== $('name')) $('name').value = values.name || '';
  if (document.activeElement !== $('city')) $('city').value = values.city || '';
  $('rate').value = values.rate;
  $('rateLabel').textContent = rateWord(values.rate);
  $('lyricsRow').classList.toggle('muted', !values.danceToMusic);
  $('breakRow').classList.toggle('muted', !values.healthBreaks);
  $('teachRow').classList.toggle('muted', !values.wakeWord);

  $('breakMinutes').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.m) === values.breakMinutes)));
  $('skins').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === values.skin)));
  $('size').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === values.size)));
}

function showStatus(s) {
  if (!s) return;
  // Windows' own voices arrive a little after Nim starts
  if (s.voices && s.voices.length !== voiceCount) fillVoices(s.voices, currentVoice());
  const host = $('status');
  host.innerHTML = '';
  const pill = (state, text) => {
    const p = document.createElement('span');
    p.className = 'pill ' + state;
    p.append(document.createElement('i'), document.createTextNode(text));
    host.appendChild(p);
  };
  pill(s.brain ? 'ok' : 'off', s.brain ? 'Brain: ' + s.brainName : 'Brain: basic commands only');
  pill(s.ears ? 'ok' : 'off', s.ears ? 'Ears: ' + s.earsName : 'Ears: off');
  pill(s.listening ? 'ok' : 'warn', s.listening ? 'Listening for "Hey Nim"' : 'Microphone off');
}

function currentVoice() {
  const v = $('voice').value;
  return v ? v.split('|').slice(1).join('|') : null;
}

// the voice list: Piper's own voices first - they sound like a person
let voiceCount = 0;
const VOICE_GROUPS = { kokoro: 'Human-like (Kokoro)', piper: 'Fast (Piper)', system: 'Windows voices' };
function fillVoices(list, current) {
  const sel = $('voice');
  sel.innerHTML = '';
  voiceCount = list.length;
  const groups = {};
  list.forEach((v) => {
    if (!groups[v.engine]) {
      groups[v.engine] = document.createElement('optgroup');
      groups[v.engine].label = VOICE_GROUPS[v.engine] || v.engine;
      sel.appendChild(groups[v.engine]);
    }
    const o = document.createElement('option');
    o.value = v.engine + '|' + v.id;
    o.textContent = v.name.replace(/^Microsoft\s+/, '');
    if (v.id === current) o.selected = true;
    groups[v.engine].appendChild(o);
  });
}

function build(voices) {
  const sel = $('voice');
  fillVoices(voices.list || [], voices.current);
  sel.addEventListener('change', async () => {
    const [engine, ...rest] = sel.value.split('|');
    const r = await host.setVoice({ engine, id: rest.join('|') });
    if (r && r.ok) saved();
  });

  [30, 45, 60, 90].forEach((m) => {
    const b = document.createElement('button');
    b.dataset.m = m;
    b.textContent = m < 60 ? m + ' min' : (m / 60) + (m === 60 ? ' hour' : ' hours');
    b.addEventListener('click', () => set('breakMinutes', m));
    $('breakMinutes').appendChild(b);
  });

  W.SKINS.forEach((sk) => {
    const b = document.createElement('button');
    b.dataset.id = sk.id;
    b.title = sk.name;
    b.style.background = 'radial-gradient(circle at 35% 30%, ' + sk.glow + ', ' + sk.base + ' 55%, ' + sk.dark + ')';
    b.addEventListener('click', async () => {
      await set('skin', sk.id);
      if (avatar) avatar.setOutfit({ skin: sk.id });
    });
    $('skins').appendChild(b);
  });

  document.querySelectorAll('input[type=checkbox][data-key]').forEach((el) => {
    el.addEventListener('change', () => set(el.dataset.key, el.checked));
  });
  $('size').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => set('size', b.dataset.size)));

  // typed fields: saved when you stop typing, or leave the box
  ['name', 'city'].forEach((key) => {
    let t = 0;
    const el = $(key);
    const save = () => { clearTimeout(t); if (el.value !== values[key]) set(key, el.value); };
    el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(save, 700); });
    el.addEventListener('change', save);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
  });

  let rt = 0;
  $('rate').addEventListener('input', () => {
    $('rateLabel').textContent = rateWord(Number($('rate').value));
    clearTimeout(rt);
    rt = setTimeout(() => set('rate', Number($('rate').value)), 250);
  });

  document.querySelectorAll('[data-action]').forEach((b) => {
    b.addEventListener('click', () => host.action(b.dataset.action));
  });
}

/* ---- automations ---------------------------------------------------------------
 * The list, a switch for each, "try it", change and delete; and a small form
 * to make one: a name, when (a phrase, a time, something that happens) and up
 * to six steps from the menu. The app checks everything before keeping it. */
let auto = { list: [], acts: [], events: [], days: [] };
let editing = null;            // the id being changed; '' for a new one

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderAutomations() {
  const box = $('autoList');
  box.innerHTML = '';
  if (!auto.list.length) { box.appendChild(el('p', 'intro', 'No automations yet - make one below.')); return; }
  auto.list.forEach((a) => {
    const row = el('div', 'auto' + (a.on ? '' : ' off'));
    const sw = el('label', 'sw');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = a.on;
    cb.addEventListener('change', async () => {
      const v = await host.toggleAutomation(a.id, cb.checked);
      if (v) { auto = v; renderAutomations(); saved(); }
    });
    sw.append(cb, el('span'));
    const txt = el('div', 'txt');
    txt.append(el('b', '', a.name), el('small', 'when', a.whenText), el('small', '', a.doText));
    const tryIt = el('button', 'icon', '▶');
    tryIt.title = 'Try it now';
    tryIt.addEventListener('click', async () => {
      tryIt.disabled = true;
      const r = await host.runAutomation(a.id);
      tryIt.disabled = false;
      if (r && r.nothing) tryIt.title = 'Nothing to do right now';
    });
    const edit = el('button', 'icon', '✎');
    edit.title = 'Change';
    edit.addEventListener('click', () => openForm(a));
    const del = el('button', 'icon', '✕');
    del.title = 'Delete';
    let sure = 0;
    del.addEventListener('click', async () => {
      // a second click within three seconds deletes it
      if (Date.now() - sure > 3000) { sure = Date.now(); del.textContent = 'Delete?'; setTimeout(() => { del.textContent = '✕'; }, 3000); return; }
      const v = await host.removeAutomation(a.id);
      if (v) { auto = v; renderAutomations(); saved(); }
    });
    row.append(sw, txt, tryIt, edit, del);
    box.appendChild(row);
  });
}

function stepRow(step) {
  const row = el('div', 'step');
  const sel = document.createElement('select');
  auto.acts.forEach((a) => { const o = el('option', '', a.label); o.value = a.id; sel.appendChild(o); });
  sel.value = step && step.act ? step.act : 'open-app';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 200;
  input.spellcheck = false;
  input.value = step && step.value ? step.value : '';
  const sync = () => {
    const a = auto.acts.find((x) => x.id === sel.value) || {};
    input.hidden = !a.value;
    input.placeholder = a.example ? 'e.g. ' + a.example : '';
  };
  sel.addEventListener('change', sync);
  sync();
  const del = el('button', 'icon', '✕');
  del.title = 'Remove this step';
  del.addEventListener('click', () => { if ($('afSteps').children.length > 1) row.remove(); syncForm(); });
  row.append(sel, input, del);
  return row;
}

function syncForm() {
  const t = $('afType').value;
  document.querySelectorAll('#autoForm [data-for]').forEach((f) => { f.hidden = f.dataset.for !== t; });
  const ev = auto.events.find((e) => e.id === $('afEvent').value);
  $('afApp').hidden = !(ev && ev.value);
  $('afAddStep').disabled = $('afSteps').children.length >= 6;
}

function openForm(a) {
  editing = a ? a.id : '';
  const w = (a && a.when) || { type: 'phrase' };
  $('afName').value = a ? a.name : '';
  $('afType').value = w.type;
  $('afPhrase').value = w.type === 'phrase' ? w.phrase : '';
  $('afAt').value = w.type === 'time' ? w.at : '09:00';
  $('afDays').value = w.type === 'time' ? w.days : 'every';
  $('afEvent').value = w.type === 'event' ? w.event : 'app';
  $('afApp').value = w.app || '';
  $('afSteps').innerHTML = '';
  ((a && a.do) || [{ act: 'open-app' }]).forEach((s) => $('afSteps').appendChild(stepRow(s)));
  $('afError').textContent = '';
  syncForm();
  $('autoForm').hidden = false;
  $('afName').focus();
}

async function saveForm() {
  const type = $('afType').value;
  // a routine with no phrase of its own answers to its name
  const phrase = $('afPhrase').value.trim() || $('afName').value.trim();
  const when = type === 'phrase' ? { type, phrase }
    : type === 'time' ? { type, at: $('afAt').value, days: $('afDays').value }
      : { type, event: $('afEvent').value, app: $('afApp').value };
  const steps = [...$('afSteps').children].map((row) => {
    const sel = row.querySelector('select'), input = row.querySelector('input');
    return input.hidden ? { act: sel.value } : { act: sel.value, value: input.value };
  });
  const def = { name: $('afName').value, on: true, when, do: steps };
  if (editing) {
    def.id = editing;
    def.on = (auto.list.find((x) => x.id === editing) || {}).on !== false;
  }
  const r = await host.saveAutomation(def);
  if (!r || !r.ok) { $('afError').textContent = (r && r.error) || 'That could not be saved.'; return; }
  auto = r.view;
  renderAutomations();
  $('autoForm').hidden = true;
  saved();
}

async function buildAutomations() {
  auto = (await host.automations()) || auto;
  auto.days.forEach((d) => { const o = el('option', '', d.label); o.value = d.id; $('afDays').appendChild(o); });
  auto.events.forEach((ev) => { const o = el('option', '', ev.label); o.value = ev.id; $('afEvent').appendChild(o); });
  $('autoNew').addEventListener('click', () => openForm(null));
  $('afType').addEventListener('change', syncForm);
  $('afEvent').addEventListener('change', syncForm);
  $('afAddStep').addEventListener('click', () => { $('afSteps').appendChild(stepRow(null)); syncForm(); });
  $('afCancel').addEventListener('click', () => { $('autoForm').hidden = true; });
  $('afSave').addEventListener('click', saveForm);
  renderAutomations();
}

(async function boot() {
  const got = await host.get();
  values = got.values;
  build(got.voices);
  render();
  showStatus(got.status);
  host.onStatus(showStatus);
  buildAutomations();

  avatar = createNim($('avatar'), { scale: 0.9, outfit: { skin: values.skin } });
  avatar.setState('happy');
  setTimeout(() => avatar.setState('idle'), 1800);
}());
