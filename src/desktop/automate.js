'use strict';
/*
 * Running automations - src/life/automations.js says what and when; this does
 * the watching and starts the runs.
 *
 *   routines    from submit(): a phrase you said runs one at once
 *   schedules   checked every twenty seconds
 *   triggers    fire(event) from main and life.js (lock, unlock, back, a game,
 *               the battery); watched here: an app coming to the front, a
 *               download finishing
 *   habits      the app in front is noted - its name and the time, nothing
 *               else - and now and then Nim offers to automate a habit
 *
 * Every run is a plan from planFor(), checked by the validator and started on
 * the runtime: the one road everything takes. A risky step still asks; a
 * question a trigger raised that nobody answers is declined after two
 * minutes, so an empty room never leaves the runtime waiting. Runs that set
 * themselves off do not announce "Done" - their own "say" steps do the
 * talking - but a failure still shows.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const A = require('../life/automations');
const habits = require('../life/habits');

// (the tests point these somewhere of their own)
const HABITS_FILE = process.env.NIM_HABITS_FILE || path.join(__dirname, '..', '..', 'memory', 'habits.json');
const DOWNLOADS = process.env.NIM_DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads');
const PARTIAL = /\.(crdownload|part|partial|download|tmp|opdownload)$|^~\$|^\.|^desktop\.ini$/i;
const APP_AGAIN_MS = 20 * 60000;      // an app back in front within this is not "opening" it
const ANSWER_MS = 120000;             // a trigger's question unanswered this long is declined
const QUEUE_MS = 180000;              // a run waiting for the runtime gives up after this

function createAutomate(deps) {
  const { config, saveConfig, validator, brainCtx, startPlan, agent, bridge, send } = deps;
  const log = (line) => deps.log('automation: ' + line);
  const timers = [];
  const every = (ms, fn) => timers.push(setInterval(() => { Promise.resolve().then(fn).catch((err) => log(err.message)); }, ms));

  /* ---- the list, kept in the config ------------------------------------------------- */
  function load() {
    if (!Array.isArray(config.automations)) {
      config.automations = A.starters();
      saveConfig();
      log('the starter set is in: ' + config.automations.length + ' automations');
      return;
    }
    // anything edited by hand that no longer makes sense is dropped, not half-run
    const ok = config.automations.map((a) => A.clean(a)).filter((r) => r.ok).map((r) => r.value);
    ok.forEach((a) => { if (!a.id) a.id = newId(a.name); });
    if (ok.length !== config.automations.length) log('dropped ' + (config.automations.length - ok.length) + ' that did not make sense');
    config.automations = ok;
  }
  const list = () => config.automations || [];
  function newId(name) {
    const base = String(name || 'auto').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'auto';
    let id = base, n = 1;
    while (list().some((a) => a.id === id)) id = base + '-' + (++n);
    return id;
  }

  function save(def) {
    const r = A.clean(def);
    if (!r.ok) return r;
    const a = r.value;
    const at = a.id ? list().findIndex((x) => x.id === a.id) : -1;
    if (at < 0) {
      if (list().length >= A.MAX_AUTOMATIONS) return { ok: false, error: 'that is the most Nim keeps (' + A.MAX_AUTOMATIONS + ')' };
      a.id = newId(a.name);
      config.automations = list().concat([a]);
    } else {
      config.automations = list().map((x, i) => (i === at ? a : x));
    }
    saveConfig();
    refresh();
    log((at < 0 ? 'added ' : 'changed ') + a.name);
    return { ok: true, value: a };
  }

  function remove(id) {
    const before = list().length;
    config.automations = list().filter((a) => a.id !== id);
    if (config.automationRuns) delete config.automationRuns[id];
    saveConfig();
    refresh();
    return list().length < before;
  }

  /* By id, or by name as it would be said ("good night" for "Good night"). */
  function find(nameOrId) {
    const n = String(nameOrId || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return list().find((a) => a.id === nameOrId) ||
           list().find((a) => a.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === n) ||
           (n.length >= 4 ? list().find((a) => a.name.toLowerCase().includes(n)) : null) || null;
  }

  function toggle(nameOrId, on) {
    const a = find(nameOrId);
    if (!a) return null;
    a.on = !!on;
    saveConfig();
    refresh();
    log(a.name + ' switched ' + (a.on ? 'on' : 'off'));
    return a;
  }

  /* ---- running one ---------------------------------------------------------------------- */
  let pausedByNim = false;     // the music Nim paused, so "resume" only ever restarts that
  let current = null;          // the run in progress: { id, name, quiet, started }
  const queue = [];
  const lastFired = new Map(); // id -> when a trigger last ran it

  async function run(def, reason, event) {
    if (agent.isBusy()) {
      if (reason === 'phrase') return { ok: false, say: 'I am still busy with the last thing. Say stop to cancel it.' };
      if (!queue.some((q) => q.def.id === def.id)) queue.push({ def, reason, event, at: Date.now() });
      return { ok: false, queued: true };
    }
    let playing = false;
    if ((def.do || []).some((s) => s.act === 'pause-music' || s.act === 'resume-music')) {
      try { const m = await bridge.call('media.now', {}, 5000); playing = !!(m && m.status === 'Playing'); } catch { playing = false; }
    }
    const plan = A.planFor(def, { playing, pausedByNim, event, name: config.name || '' });
    if (!plan) { log(def.name + ': nothing to do right now'); return { ok: true, nothing: true }; }
    const checked = validator.validate(plan, brainCtx());
    if (!checked.ok) {
      log(def.name + ' refused: ' + checked.errors[0]);
      return { ok: false, say: 'I could not run ' + def.name + ': ' + checked.errors[0].replace(/^step \d+: /, '') + '.' };
    }
    current = { id: def.id, name: def.name, quiet: reason !== 'phrase', started: Date.now() };
    log('running "' + def.name + '" (' + reason + (event && (event.app || event.file) ? ': ' + (event.app || event.file) : '') + ')');
    try {
      await startPlan(def.name, checked.plan);
    } catch (err) {
      current = null;
      return { ok: false, say: err.message };
    }
    if (checked.plan.steps.some((s) => s.tool === 'media.pause')) pausedByNim = true;
    if (checked.plan.steps.some((s) => s.tool === 'media.resume')) pausedByNim = false;
    if (current.quiet) {
      // nobody may be there to answer a question this run raised
      const mine = current;
      setTimeout(() => {
        const s = agent.snapshot();
        if (current === mine && s.status === 'waiting-approval' && s.pendingApproval) {
          log(def.name + ': nobody answered "' + s.pendingApproval.question + '" - declined');
          agent.approve(s.pendingApproval.stepId, false);
        }
      }, ANSWER_MS);
    }
    return { ok: true };
  }

  /* Called when a run ends: true if Nim should not announce it (it set itself
   * off). Its failure still shows on the surface - only the "Done" is skipped. */
  function quietEnd(snapshot) {
    if (!current) return false;
    const q = current.quiet;
    if (snapshot.status === 'error') log(current.name + ' failed: ' + (snapshot.error || 'unknown'));
    current = null;
    return q;
  }

  every(5000, async () => {
    if (!queue.length || agent.isBusy()) return;
    const q = queue.shift();
    if (Date.now() - q.at > QUEUE_MS) { log(q.def.name + ': waited too long, skipped'); return; }
    await run(q.def, q.reason, q.event);
  });

  /* ---- schedules -------------------------------------------------------------------------- */
  every(20000, () => checkSchedules(new Date()));
  async function checkSchedules(now) {
    config.automationRuns = config.automationRuns || {};
    for (const a of A.dueNow(list(), now, config.automationRuns)) {
      config.automationRuns[a.id] = A.localDay(now);
      saveConfig();
      await run(a, 'time');
    }
  }

  /* ---- triggers ---------------------------------------------------------------------------- */
  function fire(event, data) {
    for (const a of A.forEvent(list(), event, data)) {
      const last = lastFired.get(a.id) || 0;
      if (Date.now() - last < 60000) continue;           // once a minute at most
      lastFired.set(a.id, Date.now());
      run(a, 'event', data).catch((err) => log(err.message));
    }
  }

  /* ---- the app in front: app triggers, and habits ------------------------------------------- */
  let store = { events: [] };
  let storeDirty = false;
  if (config.learnHabits !== false) { try { store = JSON.parse(fs.readFileSync(HABITS_FILE, 'utf8')) || { events: [] }; } catch { store = { events: [] }; } }
  const seenAt = new Map();
  let front = '';
  const wantsFront = () => config.learnHabits !== false || list().some((a) => a.on && a.when.type === 'event' && a.when.event === 'app');

  every(5000, async () => {
    if (!wantsFront()) return;
    let r;
    try { r = await bridge.call('foreground', {}, 3000); } catch { return; }
    const p = r && r.process ? String(r.process) : '';
    if (!p || p === front || /^(electron|nim)$/i.test(p)) return;
    front = p;
    const now = Date.now();
    const last = seenAt.get(p.toLowerCase()) || 0;
    seenAt.set(p.toLowerCase(), now);
    if (now - last < APP_AGAIN_MS) return;
    fire('app', { app: p });
    if (config.learnHabits !== false && !habits.IGNORE.test(p)) { habits.record(store, p, now); storeDirty = true; }
  });

  function saveHabits() {
    if (!storeDirty || config.learnHabits === false) return;
    storeDirty = false;
    try {
      fs.mkdirSync(path.dirname(HABITS_FILE), { recursive: true });
      fs.writeFileSync(HABITS_FILE, JSON.stringify(store), 'utf8');
    } catch (err) { log('could not save habits: ' + err.message); }
  }
  every(60000, saveHabits);

  function setLearning(on) {
    config.learnHabits = !!on;
    saveConfig();
    if (!on) {
      // switching it off forgets what was learned
      store = { events: [] };
      storeDirty = false;
      try { fs.unlinkSync(HABITS_FILE); } catch { /* there was nothing */ }
      log('habit learning off - what was learned is deleted');
    }
  }

  /* ---- offering a habit ------------------------------------------------------------------------ */
  let offer = null;
  function maybeOffer() {
    if (config.learnHabits === false || offer || agent.isBusy()) return;
    if ((deps.isQuiet && deps.isQuiet()) || (deps.isGaming && deps.isGaming())) return;
    if (deps.idleSeconds && deps.idleSeconds() > 60) return;          // not to an empty room
    const today = A.localDay(new Date());
    if (config.habitOfferDay === today) return;                        // one a day at most
    const automated = list().flatMap((a) => (a.do || []).filter((s) => s.act === 'open-app').map((s) => s.value));
    const s = habits.suggest(store, Date.now(), (config.habitSkip || []).concat(automated));
    if (!s) return;
    config.habitOfferDay = today;
    saveConfig();
    offer = Object.assign({ id: Math.random().toString(36).slice(2, 10), at: Date.now() }, s);
    const when = s.days === 'weekdays' ? 'on weekdays' : 'most days';
    const text = 'I noticed you open ' + s.app + ' around ' + s.at + ' ' + when + '. Want me to open it for you then?';
    log('habit offer: ' + s.app + ' at ' + s.at + ' (' + s.count + ' days)');
    send('nim:habit-offer', { id: offer.id, text });
    deps.say(text, 'happy');
  }
  every(30 * 60000, maybeOffer);
  timers.push(setTimeout(maybeOffer, 3 * 60000));

  const offerOpen = () => !!offer && Date.now() - offer.at < 120000;

  function answerHabit(id, choice) {
    if (!offer || offer.id !== id) return { ok: false };
    const s = offer;
    offer = null;
    send('nim:habit-offer', { id: null });          // the card goes, however it was answered
    if (choice === 'yes') {
      const r = save({ name: 'Open ' + s.app + ' at ' + s.at, on: true, when: { type: 'time', at: s.at, days: s.days }, do: [{ act: 'open-app', value: s.app }] });
      if (r.ok) deps.say('Done. I will open ' + s.app + ' at ' + s.at + (s.days === 'weekdays' ? ' on weekdays.' : ' every day.'), 'happy');
      return { ok: r.ok };
    }
    if (choice === 'no') {
      config.habitSkip = (config.habitSkip || []).concat([s.process]).slice(-50);
      saveConfig();
      deps.say('Okay, I will not ask about that again.', 'speaking');
    }
    return { ok: true };
  }

  /* ---- downloads finishing ------------------------------------------------------------------------ */
  let watcher = null;
  const pending = new Map();
  const announced = new Set();
  function watchDownloads(on) {
    if (on && !watcher) {
      try {
        watcher = fs.watch(DOWNLOADS, (type, name) => {
          if (!name || PARTIAL.test(name)) return;
          clearTimeout(pending.get(name));
          // a file counts as finished once it has stopped growing
          pending.set(name, setTimeout(() => settled(name, -1), 2500));
        });
        watcher.on('error', () => { watcher = null; });
      } catch (err) { log('cannot watch Downloads: ' + err.message); watcher = null; }
    } else if (!on && watcher) {
      watcher.close();
      watcher = null;
    }
  }
  function settled(name, size) {
    pending.delete(name);
    let st;
    try { st = fs.statSync(path.join(DOWNLOADS, name)); } catch { return; }
    if (!st.isFile() || st.size === 0 || Date.now() - st.mtimeMs > 120000 || announced.has(name)) return;
    if (st.size !== size) { pending.set(name, setTimeout(() => settled(name, st.size), 2000)); return; }
    announced.add(name);
    if (announced.size > 200) announced.delete(announced.values().next().value);
    fire('download', { file: name });
  }

  function refresh() {
    watchDownloads(list().some((a) => a.on && a.when.type === 'event' && a.when.event === 'download'));
  }

  load();
  refresh();

  return {
    list,
    save,
    remove,
    toggle,
    match: (said) => A.matchPhrase(said, list()),
    run,
    fire,
    quietEnd,
    answerHabit,
    checkSchedules,
    offerOpen,
    answerOpen: (choice) => (offerOpen() ? answerHabit(offer.id, choice) : { ok: false }),
    setLearning,
    // for the tools (automation.list / automation.toggle)
    ctx: {
      list: () => list().map((a) => ({ id: a.id, name: a.name, on: a.on, when: A.describeWhen(a) })),
      toggle: (name, on) => { const a = toggle(name, on); return a ? { id: a.id, name: a.name, on: a.on } : null; }
    },
    stop: () => { timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); watchDownloads(false); saveHabits(); }
  };
}

module.exports = { createAutomate };
