'use strict';
/*
 * Nim looking after you, in the background:
 *
 *   focus       a Pomodoro timer: quiet while you work, a cheer when it is up
 *   breaks      after an hour at it without a rest: rest your eyes, have some water
 *   PC health   battery low, processor flat out, memory full, drive nearly full
 *   briefing    the first time you are at the PC in the morning: the day ahead
 *   welcome     back after a while away: a wave
 *   gaming      a game or a film full-screen: Nim gets out of the way, and stops
 *               listening, until it is over
 *   clipboard   copy a paragraph: summarize, translate or fix its grammar
 *   quizzes     shown in the window, one question at a time
 *
 * Everything that acts on the computer still goes the one road: a fixed plan,
 * checked by the validator, run by the runtime. Nothing here is a shortcut.
 */
const { clipboard } = require('electron');
const { createFocus } = require('../life/focus');
const { createBreaks } = require('../life/breaks');
const health = require('../life/health');
const briefing = require('../life/briefing');
const clip = require('../life/clip');

function createLife(deps) {
  const { send, config, saveConfig, bridge, reminders, validator, startPlan, brainCtx, log, idleSeconds, isLocked, isBusy, model } = deps;
  const timers = [];
  const every = (ms, fn) => timers.push(setInterval(() => { try { fn(); } catch (err) { log('life: ' + err.message); } }, ms));
  // what happened, for automations (automate.js): a game, coming back, the battery
  const happened = (event, data) => { try { if (deps.onEvent) deps.onEvent(event, data || {}); } catch (err) { log('life: ' + err.message); } };

  /* ---- quiet mode ---------------------------------------------------------------
   * Do not disturb: Nim keeps its own reminders, tips and offers to itself until
   * then. It still answers when spoken to, and a low battery is still said. */
  let quietUntil = 0;
  const quiet = () => quietUntil > Date.now();
  const say = (text, mood, urgent) => { if (!quiet() || urgent) deps.say(text, mood); };
  function setQuiet(minutes) {
    quietUntil = minutes > 0 ? Date.now() + minutes * 60000 : 0;
    send('nim:quiet', { until: quietUntil });
    log(quietUntil ? 'quiet mode until ' + new Date(quietUntil).toLocaleTimeString() : 'quiet mode off');
    return quietUntil;
  }
  every(30000, () => { if (quietUntil && !quiet()) { quietUntil = 0; send('nim:quiet', { until: 0 }); } });

  /* ---- battery saver: a lighter Nim, told to the window ------------------------------ */
  let saving = false;
  function setSaver(on) {
    saving = !!on;
    send('nim:saver', saving);
    log('battery saver ' + (saving ? 'on' : 'off'));
  }

  /* ---- focus ---------------------------------------------------------------- */
  const focus = createFocus({
    onChange: (state, what) => {
      send('nim:focus', state);
      if (what === 'focus_done') say(state && state.minutes >= 15 ? 'Great work! Take a ' + state.minutes + '-minute break - a proper one.' : 'Time is up - great focus! Take a short break.', 'happy', true);
      if (what === 'break_done') say('Break is over. Ready for another round? Say "focus" when you are.', 'happy', true);
    }
  });
  every(2000, () => focus.tick());

  /* ---- gaming mode ------------------------------------------------------------ */
  let gaming = null;                    // the process that is full-screen, while it is
  let fullSeen = 0;                     // checks in a row that something was full screen
  // full-screen for a moment, but not a game: a screenshot tool's capture
  // overlay (ShareX, the Snipping Tool), Windows' own panels, Nim itself
  const NOT_A_GAME = /^(electron|nim|sharex|snippingtool|screenclippinghost|screensketch|greenshot|lightshot|flameshot|snagit\d*|snagiteditor|powertoys.*|gamebar|gamebarftserver|textinputhost|shellexperiencehost|searchhost|startmenuexperiencehost|lockapp)$/i;
  every(3000, async () => {
    if (config.hideWhenFullscreen === false) { if (gaming) endGaming(); return; }
    let r;
    try { r = await bridge.call('fullscreen', {}, 2500); } catch { return; }
    const full = !!(r && r.full && !NOT_A_GAME.test(r.process || ''));
    fullSeen = full ? fullSeen + 1 : 0;
    // two checks in a row, three seconds apart: a capture overlay or a flash of full screen is not a game
    if (full && !gaming && fullSeen >= 2) {
      gaming = r.process || 'a full-screen app';
      log('gaming mode: out of the way while ' + gaming + ' is full screen');
      deps.setHidden(true);
      happened('game-start', { app: gaming });
    } else if (!full && gaming) endGaming();
  });
  function endGaming() {
    log('gaming mode: back');
    const was = gaming;
    gaming = null;
    deps.setHidden(false);
    happened('game-end', { app: was });
  }

  /* ---- health breaks ----------------------------------------------------------- */
  const breaks = createBreaks({ minutes: config.breakMinutes || 60 });
  every(60000, () => {
    breaks.note(idleSeconds(), isLocked());
    if (config.healthBreaks === false) return;
    const m = breaks.due(focus.active || !!gaming || quiet() || isBusy() || idleSeconds() > 120);
    if (!m) return;
    send('nim:stretch', { kind: m.kind });
    say(m.text, 'happy');
  });

  /* ---- PC health -------------------------------------------------------------- */
  const sampleCpu = health.cpuSampler();
  let battery = null;
  const memo = {};
  every(30000, () => {
    const r = health.read(sampleCpu, battery);
    if (config.pcHealth === false) return;
    for (const a of health.evaluate(r, memo)) {
      log('pc health: ' + a.kind);
      send('nim:worried', { kind: a.kind });
      // a battery warning matters even when focusing or quiet; the rest can wait
      if (!gaming && (!focus.active || a.kind === 'battery')) say(a.say, a.mood, a.kind === 'battery');
    }
  });

  /* ---- welcome back, and the morning briefing ---------------------------------- */
  let awaySince = 0, lastWelcome = 0;
  const today = () => new Date().toISOString().slice(0, 10);
  async function morning(reason) {
    const h = new Date().getHours();
    if (config.dailyBriefing === false || quiet() || h < 5 || h >= 12 || config.lastBriefing === today()) return false;
    config.lastBriefing = today();
    saveConfig();
    log('briefing: ' + reason);
    say(await briefingWords(), 'happy');
    return true;
  }
  every(15000, async () => {
    const idle = idleSeconds();
    if (idle >= 600 && !awaySince) awaySince = Date.now() - idle * 1000;
    if (idle < 5 && awaySince) {
      const away = Date.now() - awaySince;
      awaySince = 0;
      if (away >= 600000) { happened('back', { minutes: Math.round(away / 60000) }); await back(); }
    }
  });
  async function back() {
    if (gaming || focus.active || quiet()) return;
    if (await morning('back at the PC')) return;
    if (Date.now() - lastWelcome < 30 * 60000) return;
    lastWelcome = Date.now();
    send('nim:welcome', {});
    say('Welcome back' + (config.name ? ', ' + config.name : '') + '!', 'happy');
  }
  setTimeout(() => morning('started').catch(() => {}), 20000);

  async function briefingWords() {
    let w = null;
    if (config.city) { try { w = await briefing.weather(config.city); } catch (err) { log('weather: ' + err.message); } }
    return briefing.compose({ name: config.name, date: new Date(), reminders: reminders.list(), weather: w });
  }

  /* ---- the clipboard ------------------------------------------------------------ */
  let lastSeen = '', offer = null, skipNext = false;
  const sig = (t) => t.length + ':' + t.slice(0, 40) + ':' + t.slice(-40);
  let reading = false;
  every(1500, async () => {
    if (config.clipboardHelper === false || reading) return;
    let text = '';
    reading = true;
    try { text = String((await clipboard.readText()) || ''); } catch { return; } finally { reading = false; }
    const s = sig(text);
    if (s === lastSeen) return;
    lastSeen = s;
    if (skipNext) { skipNext = false; return; }           // what Nim itself just copied
    if (offer && Date.now() > offer.until) offer = null;
    if (gaming || focus.active || quiet() || isBusy() || !clip.worthOffering(text)) return;
    offer = { text, until: Date.now() + 15000 };
    // the window is told only how much was copied - never what
    send('nim:clip-offer', { words: text.split(/\s+/).filter(Boolean).length });
  });

  async function clipAction(action) {
    if (!offer || Date.now() > offer.until) return { error: 'that offer has gone' };
    const plan = clip.planFor(action, offer.text);
    offer = null;
    if (!plan) return { error: 'not something I offer' };
    const checked = validator.validate(plan, brainCtx());
    if (!checked.ok) { log('clipboard plan refused: ' + checked.errors[0]); return { error: 'I could not do that' }; }
    if (action !== 'summarize') skipNext = true;          // its result goes on the clipboard: not an offer
    try { await startPlan(plan.goal, checked.plan); } catch (err) { return { error: err.message }; }
    return { ok: true };
  }

  /* ---- what the tools may ask for --------------------------------------------------- */
  const ctx = {
    focusStart: (minutes, label) => focus.start(minutes, label),
    focusStop: () => focus.stop(),
    focusStatus: () => focus.view(),
    health: async () => {
      const r = health.read(sampleCpu, battery);
      return { readings: r, words: health.report(r) };
    },
    weather: async (city) => {
      const w = await briefing.weather(city || config.city || '');
      return Object.assign({ words: briefing.weatherWords(w) }, w);
    },
    setCity: (city) => { config.city = String(city).slice(0, 60); saveConfig(); },
    city: () => config.city || '',
    briefing: () => briefingWords(),
    showQuiz: (quiz) => send('nim:quiz', quiz),
    clipboardText: async () => { try { return String((await clipboard.readText()) || ''); } catch { return ''; } },
    model: () => model(),
    quiet: (minutes) => setQuiet(minutes),
    quietUntil: () => (quiet() ? quietUntil : 0),
    saver: (on) => setSaver(on),
    saverOn: () => saving
  };

  /* The battery as the window reports it: low (once, until it is charged
   * again) and the charger going in are things an automation can follow. */
  let lowSaid = false;
  function onBattery(b) {
    const was = battery;
    battery = b && Number.isFinite(Number(b.level)) ? { level: Math.round(Number(b.level)), charging: !!b.charging } : null;
    if (!battery) return;
    if (!battery.charging && battery.level <= 20 && !lowSaid) { lowSaid = true; happened('battery-low', { level: battery.level }); }
    if (battery.charging || battery.level > 25) lowSaid = false;
    if (was && !was.charging && battery.charging) happened('charging', { level: battery.level });
  }

  return {
    ctx,
    clipAction,
    onBattery,
    isQuiet: () => quiet(),
    onUnlock: (lockedFor) => { if (lockedFor >= 180000) back().catch(() => {}); },
    focusStop: () => focus.stop(),
    focusStart: (m) => focus.start(m, ''),
    setBreakMinutes: (m) => breaks.setMinutes(m),
    get focusing() { return focus.active; },
    get gaming() { return !!gaming; },
    stop: () => timers.forEach(clearInterval)
  };
}

module.exports = { createLife };
