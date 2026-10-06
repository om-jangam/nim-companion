'use strict';
/*
 * The creature's senses, its voice, its floating surface and its island.
 *
 * Nim is the interface. Most of the time it is just the creature, and its face
 * is the status indicator - you can tell what it is doing from across the room
 * without reading a word. When it has something to say in words, the light
 * above its head grows into the floating surface; touch it and you can type;
 * open it fully and you get the island with every step and control.
 *
 * Everything shown comes from the one shared state the main process sends.
 * Nothing here invents progress or keeps a state machine of its own: the face,
 * the surface and the Dots are three drawings of the same state.
 */

const island = document.getElementById('island');
const goalInput = document.getElementById('goalInput');

const ui = {
  pip: document.getElementById('pip'),
  status: document.getElementById('statusLabel'),
  goal: document.getElementById('goal'),
  bar: document.getElementById('bar'),
  fill: document.getElementById('barFill'),
  count: document.getElementById('count'),
  steps: document.getElementById('steps'),
  controls: document.getElementById('controls'),
  approval: document.getElementById('approval'),
  approvalWhat: document.getElementById('approvalWhat'),
  result: document.getElementById('result')
};

let nim = null;
let cfg = { rate: 0.96, pitch: 1, voice: null };
let voice = null;
let dragging = false;
let dragMoved = false;
let settle = 0;
let expanded = false;
let snap = null;                 // the runtime's own snapshot, for the island
let shared = null;               // the one shared state, from the main process
let surface = null;
const local = { asking: false, hearing: false, enroll: null };
let lastActivity = performance.now();

const log = (m) => window.nimHost.log(m);
// what was heard and decided, word for word: printed only with diagnostics on
const diag = (m) => { if (cfg.diagnostics) window.nimHost.log('diag ' + m); };

/* ---- the voice ----------------------------------------------------------- */

/* Not all Windows voices are equal. The "Desktop" ones are the oldest and
 * thinnest, so they rank last. Lower score wins. Only used if Piper is missing. */
function rank(v) {
  const n = v.name;
  if (/natural|neural/i.test(n)) return 0;
  if (/desktop/i.test(n)) return 60;
  if (/(Ravi|Heera)/i.test(n)) return 5;
  if (/Mark/i.test(n)) return 8;
  if (/^en/i.test(v.lang)) return 20;
  return 90;
}

function chooseVoice() {
  const all = window.speechSynthesis.getVoices();
  if (!all.length) return;
  const chosen = cfg.voice && all.find((v) => v.name === cfg.voice);
  voice = chosen || all.slice().sort((a, b) => rank(a) - rank(b))[0];
  window.nimHost.voices(all.map((v) => ({ name: v.name, lang: v.lang })), voice ? voice.name : null);
}
window.speechSynthesis.onvoiceschanged = chooseVoice;

let audioCtx = null;
let analyser = null;
let playing = null;
const wave = new Uint8Array(256);

function pump() {
  if (!playing || !analyser) return;
  analyser.getByteTimeDomainData(wave);
  let sum = 0;
  for (let i = 0; i < wave.length; i++) {
    const v = (wave[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / wave.length);
  if (nim && rms > 0.012) nim.speak(Math.min(1.2, rms * 7));
  requestAnimationFrame(pump);
}

function playWav(bytes) {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(audioCtx.destination);
  }
  if (playing) { try { playing.stop(); } catch { /* already finished */ } }

  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return audioCtx.decodeAudioData(copy).then((buf) => new Promise((done) => {
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(analyser);
    src.onended = () => { if (playing === src) playing = null; done(); };
    playing = src;
    src.start();
    pump();
  }));
}

/* Speech ends one way or another; either way the face goes back to whatever
 * the shared state says it should be - and if you were talking to Nim, it
 * keeps listening for a moment, so the conversation can go on without saying
 * its name every time. */
function afterSpeak(mood) {
  window.nimHost.emit('response_completed', {});
  if (nim) {
    if (mood === 'sleep') nim.setState('sleep');
    else if (mood === 'happy') setTimeout(applyFace, 900);
    else applyFace();
  }
  keepListening(mood);
}

/* The follow-up window. Opened once per spoken turn, after Nim's reply - not
 * after a reminder, not while a task is still running, never for a high-risk
 * question (those take "Hey Nim, confirm" or a click). A question Nim
 * asked you gets longer, and any answer; otherwise only what is plainly said
 * to Nim continues the conversation. */
let voiceTurn = false;
const FOLLOW_MS = 8000;
function keepListening(mood) {
  if (!voiceTurn || cfg.followUp === false || !wake || !wake.armed || mood === 'sleep') return;
  // an everyday question ("Close Notepad? Yes or no?") is answered without the
  // name; a high-risk one still needs "Hey Nim, confirm" or a click
  const asking = snap && snap.status === 'waiting-approval' && snap.pendingApproval;
  if (asking && !/^(low|medium)$/.test(snap.pendingApproval.risk || '')) return;
  if (!asking && snap && !['idle', 'completed', 'error', 'cancelled'].includes(snap.status)) return;
  if (!asking && shared && shared.phase === 'confirming') return;
  voiceTurn = false;
  const kind = mood === 'waiting' ? 'answer' : 'conversation';
  if (!wake.expectFollowUp(kind === 'answer' ? 12000 : FOLLOW_MS, kind)) return;
  window.nimHost.emit('listening_started', {
    via: 'follow-up', label: kind === 'answer' ? 'Listening for your answer...' : 'Still listening...'
  });
  if (nim && !playing) nim.setState('listening');
}

function systemSay(text, mood) {
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = cfg.rate;
  u.pitch = cfg.pitch;
  u.onboundary = () => { if (nim) nim.speak(0.55); };
  u.onend = () => afterSpeak(mood);
  u.onerror = () => afterSpeak(mood);
  window.speechSynthesis.speak(u);
}

/* A reply a sentence at a time: the first is heard while the next is being
 * made, so a human-sounding voice that takes a moment per sentence still
 * starts talking at once. A very short sentence ("Hi Sam!") goes with the next. */
function sentences(text) {
  // a sentence ends at . ! or ? followed by a space - not inside "2.5" or "9.30"
  const parts = String(text).split(/(?<=[.!?]["')\]]*)\s+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].length < 12) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out.length ? out : [String(text)];
}

let speechSeq = 0;                     // a newer line, or hush(), ends an older one
async function say(text, mood, speak) {
  if (!text) return;
  speak = speak || text;               // what is heard can be shorter than what is shown
  const my = ++speechSeq;
  lastActivity = performance.now();
  // what Nim is saying is part of the shared state, so the surface can show it
  window.nimHost.emit('response_started', { text: String(text) });
  if (nim) nim.setState(mood || 'speaking');
  const parts = sentences(speak);
  let spoke = false;
  try {
    let next = window.nimHost.synth(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      const wav = await next;
      if (my !== speechSeq) return;
      if (!wav || !wav.byteLength) break;
      // the next sentence is made while this one plays
      next = i + 1 < parts.length ? window.nimHost.synth(parts[i + 1]) : null;
      spoke = true;
      await playWav(wav);
      if (my !== speechSeq) return;
    }
  } catch { /* a broken voice must never cost you the answer */ }
  if (my !== speechSeq) return;
  if (spoke) { afterSpeak(mood); return; }
  systemSay(speak, mood);
}

/* A soft two-note chime the moment Nim knows it was spoken to - the "I heard
 * you" every voice assistant gives, without words that would talk over the
 * request you are about to make. The wake listener is deaf for its length, so
 * Nim never hears its own chime as the start of your sentence. */
let chimeCtx = null;
let chimingUntil = 0;
function chime() {
  try {
    if (!chimeCtx) chimeCtx = new AudioContext();
    const t = chimeCtx.currentTime + 0.01;
    [[784, 0], [1175, 0.11]].forEach(([freq, at]) => {
      const osc = chimeCtx.createOscillator();
      const gain = chimeCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + at);
      gain.gain.linearRampToValueAtTime(0.07, t + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + at + 0.22);
      osc.connect(gain).connect(chimeCtx.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.25);
    });
    chimingUntil = performance.now() + 450;
  } catch { /* no sound is better than no Nim */ }
}

/* Nim must never record itself talking. */
function hush() {
  speechSeq++;                         // and the rest of the sentences are not said either
  if (playing) { try { playing.stop(); } catch { /* already finished */ } }
  window.speechSynthesis.cancel();
}

/* ---- the face (Lume) ---------------------------------------------------------
 *
 * The creature's face follows the one shared state. Speech and push-to-talk
 * still move it directly while they are happening, since those are moments the
 * window itself is living through.
 */
const FACE = {
  idle: 'idle', listening: 'listening', transcribing: 'thinking', thinking: 'thinking',
  confirming: 'waiting', speaking: 'speaking', done: 'happy', error: 'error'
};

function faceFor(state, event) {
  if (!state) return 'idle';
  // nothing else going on and a song playing: lost in the music
  if (state.phase === 'idle' && dancing) return 'dancing';
  if (state.phase === 'idle' && performance.now() < worriedUntil) return 'worried';
  if (state.phase === 'idle' && focusState && focusState.phase === 'focus') return 'focus';
  if (state.phase === 'idle' && lateAtNight()) return 'sleepy';
  if (state.phase !== 'working') return FACE[state.phase] || 'idle';
  const type = event && event.type;
  const current = state.task && state.task.current;
  // reaching out to the computer; weaving when it is putting results together
  if (type === 'tool_started') return current && (current.category === 'ai' || current.uses) ? 'weaving' : 'reaching';
  if (type === 'tool_completed') return 'receiving';
  if (type === 'verification_started') return 'thinking';
  return null;                               // in between: keep whatever it is doing
}

function applyFace(event) {
  if (!nim || (mic && mic.busy) || playing) return;
  const face = faceFor(shared, event) || (nim.state === 'idle' ? 'working' : null);
  if (face && nim.state !== face) nim.setState(face);
}

/* ---- dancing to music ---------------------------------------------------------
 *
 * While Windows says a song is playing (the shared state's `media`), Nim
 * listens to the computer's own sound for the beat (music.js) and dances -
 * but only when it is free: a request, a question or its own voice comes
 * first, and the dance picks up again afterwards. Someone talking (a video, a
 * podcast, a stream) is not a song, and it stays still. The sound is
 * analysed, never kept.
 */
let musicEar = null;
let dancing = false;
let beatLostAt = 0;
let songSince = 0, silentSince = 0, confirmedKey = '';
const CONFIRM_MS = 6000;        // danced to this long: it is a song, dialogue and all
const SONG_SILENCE_MS = 3000;   // a pause inside a song is shorter than this
const KEEP_DANCING_MS = 2500;   // through a quiet bar

let playingKey = '';
let wasPlaying = false;
let earIdleTimer = 0;
const EAR_KEEP_MS = 60000;      // paused: keep listening a minute, so pressing play again dances at once

/* The song's own clock (from Windows, once a second) and its timed lyrics
 * (looked up by the main process). Between reports the clock runs on. */
let lyricsFor = { key: '', lines: null };
let moodFor = { key: '', mood: '' };          // what the song feels like (Qwen, on this PC)
let checkFor = { key: '', music: null };      // a browser video: is it music at all? (Qwen, from the title)

/* What to dance by (music.js danceKind): a browser video only once it has
 * shown it is a song - its lyrics found, or the model on this PC calling it
 * music - and the sound agrees. */
function danceKind() {
  return window.NimMusic.danceKind(shared && shared.media, {
    lyrics: lyricsFor.key === playingKey && !!lyricsFor.lines,
    check: checkFor.key === playingKey ? checkFor.music : null
  });
}

/* Lyrics a little early or late against the video (a slow start, buffering):
 * nudged by half seconds from the bar on its belly, and remembered per song. */
const lyricShift = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('nim.lyricShift') || '{}') || {}; } catch { saved = {}; }
  return {
    get: (key) => Number(saved[key]) || 0,
    nudge: (key, by) => {
      saved[key] = Math.max(-15, Math.min(15, Math.round(((Number(saved[key]) || 0) + by) * 10) / 10));
      const keys = Object.keys(saved);
      if (keys.length > 200) delete saved[keys[0]];
      try { localStorage.setItem('nim.lyricShift', JSON.stringify(saved)); } catch { /* fine: for this session only */ }
      return saved[key];
    }
  };
})();
let actedLine = '';                            // the last lyric line acted out
let songClock = { key: '', playing: false, position: 0, updated: 0 };

/* Automatic lyric timing: what was heard in the singing range, against the
 * song's own clock, for the song now playing; and the shift found from it. */
let heardFor = { key: '', samples: [], shift: 0, checkedAt: 0, logged: '' };

function listenForLyrics(f) {
  if (heardFor.key !== playingKey) heardFor = { key: playingKey, samples: [], shift: 0, checkedAt: 0, logged: '' };
  const pos = songPosition();
  if (pos === null || !songClock.playing || !lyricsFor.lines || lyricsFor.key !== playingKey) return;
  heardFor.samples.push({ t: pos, v: f.vocal || 0 });
  if (heardFor.samples.length > 60 * 90) heardFor.samples.shift();       // the last minute and a half
  const now = performance.now();
  if (now - heardFor.checkedAt < 8000 || heardFor.samples.length < 60 * 25) return;
  heardFor.checkedAt = now;
  const r = window.NimMusic.alignLyrics(heardFor.samples, lyricsFor.lines);
  if (!r) return;
  // only a clear answer moves the words: a shift that stands well clear of the
  // others, and clearly better than the timing as found
  // and the same answer twice running, so one lucky guess cannot move them
  const clearNow = r.sure > 2.4 && (r.asFound === null || r.sure - r.asFound > 0.8);
  const clear = clearNow && heardFor.last !== undefined && Math.abs(heardFor.last - r.shift) <= 0.3;
  heardFor.last = clearNow ? r.shift : undefined;
  const line = 'lyrics timing: the singing fits best ' + (r.shift > 0 ? r.shift + ' s later' : r.shift < 0 ? -r.shift + ' s earlier' : 'as found') +
    ' (clarity ' + r.sure.toFixed(1) + (r.asFound === null ? '' : ', as found ' + r.asFound.toFixed(1)) + ')' + (clear ? ' - following it' : ' - not sure, left as is');
  if (line !== heardFor.logged) { log(line); heardFor.logged = line; }
  if (clear) heardFor.shift = -r.shift;     // sung later than the file says: show each line later
}

function songPosition() {
  if (!songClock.updated) return null;
  return songClock.position + (songClock.playing ? (Date.now() - songClock.updated) / 1000 : 0);
}

/* The line being sung now, and how far through it. A touch early, as
 * karaoke is: reading takes a moment. */
function currentLyric() {
  const lines = lyricsFor.lines;
  if (!lines || lyricsFor.key !== playingKey || songClock.key !== playingKey || !songClock.playing) return null;
  const pos = songPosition();
  if (pos === null) return null;
  // a touch early, as karaoke is; plus whatever nudge this song was given
  const at = pos + 0.15 + lyricShift.get(playingKey) + (heardFor.key === playingKey ? heardFor.shift : 0);
  let i = -1;
  for (let k = 0; k < lines.length && lines[k].t <= at; k++) i = k;
  if (i < 0) return null;
  const line = lines[i], next = lines[i + 1];
  // a long gap after a line (an instrumental break) does not keep it up
  const end = next ? Math.min(next.t, line.t + 8) : line.t + 6;
  if (at > end) return null;
  // how long it takes to sing: about a twelfth of a second a letter, never
  // longer than the time until the next line (a break after it is not singing)
  const singing = Math.max(0.8, Math.min((end - line.t) * 0.92, 0.6 + line.text.length * 0.085));
  return {
    text: line.text,
    progress: Math.min(1, (at - line.t) / singing),
    started: line.t,
    main: !!(lyricsFor.hooks && lyricsFor.hooks[i])           // a line of the hook
  };
}

function updateMusic() {
  const want = cfg.danceToMusic !== false && !cfg.saver && !!(shared && shared.media && shared.media.playing);
  // a new track, or an ad cutting in: stop, and judge what is playing now afresh
  const m = (shared && shared.media) || {};
  const key = [m.title, m.artist, m.length].join('|');
  if (key !== playingKey || (want && !wasPlaying)) {
    playingKey = key;
    if (musicEar) { musicEar.reset(); stopDancing(); }
  }
  wasPlaying = want;
  if (want) {
    clearTimeout(earIdleTimer);
    earIdleTimer = 0;
    if (!musicEar) {
      const ear = musicEar = window.createMusic({
        onFrame: onMusicFrame, onLog: log, onDiag: diag,
        kind: danceKind
      });
      ear.start().then((ok) => { if (!ok && musicEar === ear) { musicEar = null; stopDancing(); } });
    }
  } else if (musicEar) {
    // paused or stopped: the dance ends now; the listening a little later
    stopDancing();
    if (!earIdleTimer) {
      earIdleTimer = setTimeout(() => {
        earIdleTimer = 0;
        if (musicEar && !wasPlaying) { musicEar.stop(); musicEar = null; }
      }, EAR_KEEP_MS);
    }
  }
}

function onMusicFrame(f) {
  const free = shared && shared.phase === 'idle' && !playing && !(mic && mic.busy) && !local.enroll && !expanded &&
    !(focusState && focusState.phase === 'focus') && !quizOn;
  if (!f || !free || !wasPlaying) { if (dancing) stopDancing(); if (nim) nim.lyric(null); return; }
  listenForLyrics(f);
  const lyric = currentLyric();
  nim.lyric(lyric);
  // the hook is on: the song's own signature routine
  const knowLyrics = lyricsFor.key === playingKey && !!lyricsFor.lines;
  nim.hook(knowLyrics ? !!(lyric && lyric.main) : null);
  // a new line being sung: act out what it says, while dancing
  const lineText = lyric ? lyric.text : '';
  if (lineText !== actedLine) {
    actedLine = lineText;
    if (dancing && lineText) window.NimMusic.actsFor(lineText).slice(0, 2).forEach((a) => nim.act(a));
  }
  // A track it has already danced to for a while is a song, full stop: a
  // spoken dialogue in the middle of it, a quiet bridge, does not end the
  // dance - only a pause, the next track, or real silence for a few seconds.
  // Its lyrics being found settles it from the start.
  const now = performance.now();
  if (dancing && songSince && now - songSince > CONFIRM_MS) confirmedKey = playingKey;
  const certain = confirmedKey === playingKey || (lyricsFor.key === playingKey && !!lyricsFor.lines);
  if (f.silent) {
    if (!silentSince) silentSince = now;
    // a song's own silences are short; the end of one is not
    if (!certain || now - silentSince > SONG_SILENCE_MS) { if (dancing) stopDancing(); return; }
  } else silentSince = 0;
  if (!f.song && certain && f.heard >= 70 && f.loud > -75) f.song = true;
  if (!f.song) {
    // the beat has to stay gone a moment before the dance stops
    if (!dancing) return;
    if (!beatLostAt) beatLostAt = performance.now();
    if (performance.now() - beatLostAt > KEEP_DANCING_MS) { stopDancing(); return; }
  } else beatLostAt = 0;
  if (!dancing) {
    dancing = true;
    songSince = now;
    log('dancing: ' + Math.round(f.continuity * 100) + '% continuous' + (f.kind ? ', title says ' + f.kind : ''));
  }
  f.track = playingKey;          // so each song gets its own choreography
  f.mood = moodFor.key === playingKey ? moodFor.mood : '';
  nim.groove(f);
  if (nim.state !== 'dancing' && nim.state !== 'alert') nim.setState('dancing');
}

function stopDancing() {
  beatLostAt = 0;
  if (!dancing) { if (nim) nim.groove(null); return; }
  dancing = false;
  log('stopped dancing');
  if (nim) nim.groove(null);
  applyFace();
}

/* ---- music controls on its belly ------------------------------------------------
 *
 * While something is playing (or paused), pointing at Nim brings up a small bar
 * on its belly: previous, play/pause, next, volume down and up. It stays a
 * moment after the cursor leaves, follows the body as it dances, and goes away
 * when nothing is playing. */
let mediaBar = null, mediaShowUntil = 0, mediaHover = false, mediaVolTimer = 0, mediaRaf = 0;

function setupMediaBar() {
  mediaBar = document.getElementById('media-bar');
  mediaBar.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      mediaShowUntil = performance.now() + 4000;
      const act = b.dataset.act;
      if (act === 'playpause') mediaBar.classList.toggle('paused');
      const r = await window.nimHost.mediaControl(act);
      if (r && Number.isFinite(r.level)) showBarNote(r.level + '%');
      if (nim) nim.blinkNow();
    });
  });
}

function showBarNote(text) {
  const vol = document.getElementById('media-vol');
  vol.textContent = text;
  vol.classList.add('on');
  clearTimeout(mediaVolTimer);
  mediaVolTimer = setTimeout(() => { vol.textContent = ''; vol.classList.remove('on'); }, 1600);
}

function mediaKnown() { return !!(shared && shared.media && (shared.media.playing || shared.media.title)); }

function refreshMediaBar() {
  if (!mediaBar || !nim) return;
  const show = mediaKnown() && !expanded && (mediaHover || performance.now() < mediaShowUntil);
  if (show !== mediaBar.classList.contains('show')) {
    mediaBar.classList.toggle('show', show);
    if (!show) { boxes.media = null; sendBoxes(); }
  }
  mediaBar.classList.toggle('paused', !(shared && shared.media && shared.media.playing));
  if (show && !mediaRaf) mediaRaf = requestAnimationFrame(placeMediaBar);
}

// on the lower belly, following the body while it moves
function placeMediaBar() {
  mediaRaf = 0;
  if (!mediaBar || !mediaBar.classList.contains('show')) return;
  const box = document.getElementById('nim').getBoundingClientRect();
  const p = nim.bodyPoint();
  const w = mediaBar.offsetWidth, h = mediaBar.offsetHeight;
  const x = Math.round(box.left + p.x - w / 2), y = Math.round(box.top + p.y + p.r * 0.42 - h / 2);
  mediaBar.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  const r = { x, y, w, h };
  if (!boxes.media || Math.abs(boxes.media.x - r.x) > 2 || Math.abs(boxes.media.y - r.y) > 2) { boxes.media = r; sendBoxes(); }
  if (performance.now() > mediaShowUntil && !mediaHover) refreshMediaBar();
  mediaRaf = requestAnimationFrame(placeMediaBar);
}

/* ---- looking after you ------------------------------------------------------------
 *
 * The window's half of life.js: the focus pill, the clipboard offer, the quiz,
 * the stretch and the worried look, petting and feeding, sleepy at night, and
 * the battery (which only the window can see). */
let focusState = null, focusTimer = 0, worriedUntil = 0, quizOn = false;
let clipTimer = 0;
const lifeBoxes = {};

function lateAtNight() { const h = new Date().getHours(); return h >= 23 || h < 5; }

function placeNear(el, dy) {
  const box = document.getElementById('nim').getBoundingClientRect();
  const p = nim.bodyPoint();
  const w = el.offsetWidth, h = el.offsetHeight;
  const x = Math.max(4, Math.min(window.innerWidth - w - 4, Math.round(box.left + p.x - w / 2)));
  const y = Math.round(box.top + p.y + p.r * dy - h / 2);
  el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  return { x, y, w, h };
}

function setLifeBox(name, rect) {
  lifeBoxes[name] = rect;
  boxes.life = Object.values(lifeBoxes).filter(Boolean);
  sendBoxes();
}

function showFocus(state) {
  focusState = state;
  const pill = document.getElementById('focus-pill');
  clearInterval(focusTimer);
  if (!state) { pill.classList.remove('show'); setLifeBox('focus', null); applyFace(); return; }
  pill.classList.add('show');
  pill.classList.toggle('break', state.phase === 'break');
  pill.querySelector('.ic').innerHTML = state.phase === 'break' ? '&#9749;' : '&#127919;';
  const until = Date.now() + state.left;
  const tick = () => {
    const left = Math.max(0, until - Date.now()), m = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60;
    document.getElementById('focus-time').textContent = m + ':' + String(sec).padStart(2, '0');
    // above the head, out of the way of the face
    setLifeBox('focus', placeNear(pill, -1.95));
  };
  tick();
  focusTimer = setInterval(tick, 1000);
  if (state.phase === 'break') { nim.setState('happy'); nim.wave(); }
  applyFace();
}

function offerClipboard(p) {
  const el = document.getElementById('clip-offer');
  document.getElementById('clip-what').textContent = 'Copied ' + p.words + ' words:';
  el.classList.add('show');
  setLifeBox('clip', placeNear(el, -2.05));       // above the head; it never shows while focusing
  nim.blinkNow();
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => { el.classList.remove('show'); setLifeBox('clip', null); }, 14000);
}

/* Quiet mode: a small pill above the head, until when, and a way out. */
let quietTimer = 0;
function showQuiet(p) {
  const pill = document.getElementById('quiet-pill');
  clearInterval(quietTimer);
  const until = p && Number(p.until);
  if (!until || until <= Date.now()) { pill.classList.remove('show'); setLifeBox('quiet', null); return; }
  document.getElementById('quiet-text').textContent = 'Quiet till ' + new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  pill.classList.add('show');
  // above the focus pill when both are up
  const place = () => {
    if (Date.now() > until) { showQuiet(null); return; }
    setLifeBox('quiet', placeNear(pill, focusState ? -2.55 : -1.95));
  };
  place();
  quietTimer = setInterval(place, 1000);
}

/* A habit Nim noticed: offered once, with the answer one click away. */
let habitTimer = 0, habitId = '';
function offerHabit(p) {
  if (!p || !p.id) { closeHabit(); return; }
  habitId = String(p.id);
  const card = document.getElementById('habit-offer');
  document.getElementById('habit-text').textContent = String(p.text || '');
  card.classList.add('show');
  setLifeBox('habit', placeNear(card, -2.25));
  nim.setState('happy');
  setTimeout(applyFace, 2000);
  clearTimeout(habitTimer);
  habitTimer = setTimeout(() => closeHabit(), 90000);
}
function closeHabit() {
  document.getElementById('habit-offer').classList.remove('show');
  setLifeBox('habit', null);
  clearTimeout(habitTimer);
}

/* The quiz: one question at a time; right or wrong, and why; a score at the end. */
let quiz = null, quizAt = 0, quizScore = 0;
function startQuiz(qs) {
  if (!Array.isArray(qs) || !qs.length) return;
  quiz = qs; quizAt = 0; quizScore = 0; quizOn = true;
  if (local.asking) askOpen(false);              // the quiz has the floor
  document.getElementById('quiz').classList.add('show');
  showQuestion();
}
function showQuestion() {
  const q = quiz[quizAt], card = document.getElementById('quiz');
  document.getElementById('quiz-count').textContent = (quizAt + 1) + ' / ' + quiz.length;
  document.getElementById('quiz-q').textContent = q.question;
  document.getElementById('quiz-why').textContent = '';
  const opts = document.getElementById('quiz-opts');
  opts.innerHTML = '';
  q.options.forEach((o, i) => {
    const b = document.createElement('button');
    b.textContent = String.fromCharCode(65 + i) + '.  ' + o;
    b.addEventListener('click', (e) => { e.stopPropagation(); answer(i); });
    opts.appendChild(b);
  });
  const r = card.getBoundingClientRect();
  setLifeBox('quiz', { x: r.left, y: r.top, w: r.width, h: r.height });
}
function answer(i) {
  const q = quiz[quizAt], buttons = [...document.querySelectorAll('#quiz-opts button')];
  if (buttons.some((b) => b.disabled)) return;
  buttons.forEach((b) => { b.disabled = true; });
  buttons[q.answer].classList.add('right');
  const right = i === q.answer;
  if (right) { quizScore++; nim.setState('happy'); nim.pet(); }
  else { buttons[i].classList.add('wrong'); nim.setState('sad'); }
  document.getElementById('quiz-why').textContent = (right ? 'Right! ' : 'Not quite - it is ' + String.fromCharCode(65 + q.answer) + '. ') + (q.why || '');
  const r = document.getElementById('quiz').getBoundingClientRect();
  setLifeBox('quiz', { x: r.left, y: r.top, w: r.width, h: r.height });
  setTimeout(() => {
    quizAt++;
    if (quizAt < quiz.length) { applyFace(); showQuestion(); return; }
    const all = quiz.length;
    endQuiz();
    say(quizScore === all ? 'Perfect score! ' + all + ' out of ' + all + '!' : 'You got ' + quizScore + ' out of ' + all + '. ' + (quizScore >= all / 2 ? 'Nice work!' : 'Want another go?'),
        quizScore >= all / 2 ? 'happy' : 'speaking');
  }, right ? 1800 : 3200);
}
function endQuiz() {
  quiz = null; quizOn = false;
  document.getElementById('quiz').classList.remove('show');
  setLifeBox('quiz', null);
  applyFace();
}

/* Petting: stroking the body back and forth with the cursor. */
let strokes = [], lastStrokeX = null, lastStrokeDir = 0, lastPetAt = 0;
function noticeStroke(x, over) {
  if (!over) { lastStrokeX = null; return; }
  if (lastStrokeX !== null) {
    const dx = x - lastStrokeX;
    if (Math.abs(dx) > 6) {
      const dir = Math.sign(dx);
      if (lastStrokeDir && dir !== lastStrokeDir) strokes.push(performance.now());
      lastStrokeDir = dir;
    }
  }
  lastStrokeX = x;
  const now = performance.now();
  strokes = strokes.filter((t) => now - t < 1400);
  if (strokes.length >= 4 && now - lastPetAt > 2500 && !dancing) {
    lastPetAt = now; strokes = [];
    petted('pet');
  }
}
function petted(kind) {
  if (!nim) return;
  lastActivity = performance.now();
  if (kind === 'feed') { nim.feed(); say(pick(['Yum! Thank you!', 'Cookie! My favourite.', 'Nom nom. Thank you!']), 'happy'); }
  else { nim.pet(); nim.setState('happy'); setTimeout(applyFace, 1800); }
}
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

function setupLife() {
  document.getElementById('focus-stop').addEventListener('click', (e) => { e.stopPropagation(); window.nimHost.focusStop(); });
  document.getElementById('quiz-close').addEventListener('click', (e) => { e.stopPropagation(); endQuiz(); });
  document.querySelectorAll('#clip-offer button').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const act = b.dataset.clip;
    document.getElementById('clip-offer').classList.remove('show');
    setLifeBox('clip', null);
    if (act !== 'close') await window.nimHost.clipAction(act);
  }));
  document.getElementById('quiet-stop').addEventListener('click', (e) => { e.stopPropagation(); window.nimHost.quietStop(); });
  document.querySelectorAll('#habit-offer button').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = habitId;
    closeHabit();
    await window.nimHost.habitAnswer(id, b.dataset.habit);
  }));
  window.nimHost.onQuiet(showQuiet);
  window.nimHost.onHabitOffer(offerHabit);
  // battery saver: a slower, lighter Nim, and no listening to the music
  window.nimHost.onSaver((on) => { cfg.saver = on; nim.saver(on); updateMusic(); });
  window.nimHost.onFocus(showFocus);
  window.nimHost.onStretch(() => { nim.stretch(); });
  window.nimHost.onWorried(() => { worriedUntil = performance.now() + 7000; applyFace(); setTimeout(applyFace, 7100); });
  window.nimHost.onWelcome(() => { nim.setState('happy'); nim.wave(); setTimeout(applyFace, 2500); });
  window.nimHost.onClipOffer(offerClipboard);
  window.nimHost.onQuiz(startQuiz);
  window.nimHost.onPet((p) => petted(p && p.kind));
  // the battery, which only the window can see
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const tell = () => window.nimHost.battery({ level: Math.round(b.level * 100), charging: b.charging });
      tell();
      b.addEventListener('levelchange', tell);
      b.addEventListener('chargingchange', tell);
    }).catch(() => {});
  }
  // late at night it yawns now and then
  setInterval(() => {
    if (lateAtNight() && shared && shared.phase === 'idle' && !dancing && Math.random() < 0.25) nim.yawn();
    applyFace();
  }, 60000);
}

/* ---- the floating surface ----------------------------------------------------- */

let lingering = null, lingerTimer = 0;

/* A finished reply or result stays up long enough to be read, then folds away.
 * That is the only thing decided here; what to show is the model's job. */
function refreshSurface() {
  if (!surface) return;
  const M = window.NimSurfaceModel;
  const v = M.view(shared, local);
  if (expanded) { surface.update({ mode: 'hidden' }); return; }
  if (v.mode === 'hidden' && lingering) { surface.update(lingering); return; }
  clearTimeout(lingerTimer);
  lingering = null;
  const hold = M.holdFor(v);
  if (hold) {
    lingering = v;
    lingerTimer = setTimeout(() => { lingering = null; refreshSurface(); }, hold);
  }
  surface.update(v);
}

function surfaceAction(act) {
  lastActivity = performance.now();
  if (act === 'approve') window.nimHost.agent('approve', true);
  else if (act === 'deny') window.nimHost.agent('approve', false);
  else if (act === 'stop') { window.nimHost.agent('cancel'); hush(); }
  else if (act === 'stop-listening') {
    if (mic && mic.listening) mic.stop();
    else if (shared && shared.phase === 'listening') window.nimHost.emit('idle', {});
  } else if (act === 'listen') { local.asking = false; micToggle(); }
  else if (act === 'expand') { local.asking = false; expand(true); }
  else if (act === 'dismiss') { local.asking = false; clearTimeout(lingerTimer); lingering = null; }
  else if (act === 'enroll-cancel') { if (wake) wake.cancelEnroll(); local.enroll = null; }
  refreshSurface();
}

/* ---- learning your voice ---------------------------------------------------
 *
 * Whisper writes an unfamiliar name as the nearest thing it knows, and what
 * that is depends on the voice: one person's "Hey Nim" comes back "Hey Nim",
 * another's "Hini" or "Henny". Saying it three times shows Nim which spellings
 * mean you - and only the spellings are kept, as words in config.json. No
 * audio is stored.
 */
function teachVoice() {
  if (!wake || !wake.armed) {
    say('Turn on listening for my name first - it is in my menu.', 'waiting');
    return;
  }
  local.enroll = { step: 1, total: 3, heard: '' };
  refreshSurface();
  say('Say Hey Nim three times, the way you normally would, with a little pause in between.', 'happy');
  wake.enroll({
    count: 3,
    timeoutMs: 60000,
    onSample: (n, heard) => {
      if (!local.enroll) return;
      local.enroll.step = n + 1;
      local.enroll.heard = heard || '(nothing)';
      chime();
      refreshSurface();
    },
    onDone: async (samples) => {
      local.enroll = null;
      refreshSurface();
      const known = cfg.wakeVariants || [];
      const fresh = [];
      for (const t of samples) {
        if (!t || window.createWake.wakeCommand(t, known) !== null) continue;      // already understood
        const words = t.toLowerCase().replace(/[^a-z\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
        if (!words.length || words.length > 3) continue;                          // not a name, a sentence
        const v = words.join(' ');
        if (!fresh.includes(v)) fresh.push(v);
      }
      log('learned ' + fresh.length + ' new spelling(s) from ' + samples.length + ' samples');
      if (!samples.filter(Boolean).length) { say('I did not hear anything. Try again from my menu when you are ready.', 'sad'); return; }
      if (!fresh.length) { say('Good news - I already understand how you say my name.', 'happy'); return; }
      const saved = await window.nimHost.saveWakeVariants(fresh);
      cfg.wakeVariants = saved.all || known;
      say(saved.added && saved.added.length
        ? 'Got it. I will answer to the way you say my name now.'
        : 'Those sound too much like everyday words, so I left them out. I will keep listening for Hey Nim.', 'happy');
    }
  });
}

function askOpen(on) {
  local.asking = on;
  lingering = null;
  refreshSurface();
}

/* ---- the island ---------------------------------------------------------- */

const LABEL = {
  idle: 'idle', listening: 'listening', planning: 'planning', working: 'working',
  'waiting-approval': 'needs you', paused: 'paused', completed: 'done',
  cancelled: 'cancelled', error: 'went wrong'
};

const MARK = {
  pending: '·', running: '▸', done: '✓',
  failed: '✗', skipped: '–', 'awaiting-approval': '?'
};

function expand(open) {
  if (expanded === open) return;
  expanded = open;
  island.classList.toggle('open', open);
  window.nimHost.expand(open);
  if (open) setTimeout(() => goalInput.focus(), 120);
  refreshSurface();
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function render(s) {
  snap = s;

  const busy = ['planning', 'working'].includes(s.status);
  ui.pip.className = 'pip ' + (s.status === 'waiting-approval' ? 'waiting' : s.status) +
                    (busy ? ' pulse' : '');
  ui.status.textContent = LABEL[s.status] || s.status;
  ui.goal.textContent = s.goal || 'What should I do?';

  const total = s.progress.total;
  const pct = total ? Math.round((s.progress.done / total) * 100) : 0;
  ui.fill.style.width = pct + '%';
  ui.bar.className = 'bar' + (s.status === 'completed' ? ' done' : '') +
                             (s.status === 'error' ? ' bad' : '');
  ui.count.textContent = total
    ? s.progress.done + ' of ' + total + ' done' + (s.progress.failed ? ', ' + s.progress.failed + ' failed' : '')
    : '';

  ui.steps.innerHTML = '';
  s.steps.forEach((step) => {
    const li = document.createElement('li');
    li.className = step.status;
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = MARK[step.status] || '·';
    const body = document.createElement('span');
    body.textContent = step.title;
    if (step.risk && step.risk !== 'low') {
      const tag = document.createElement('em');
      tag.className = 'risk ' + step.risk;
      tag.textContent = step.risk;
      body.appendChild(tag);
    }
    if (step.status === 'done') {
      // say what is proven and what is merely assumed - they are not the same
      const sum = document.createElement('span');
      sum.className = 'sum';
      const proof = step.verified === true ? ' · verified'
                  : step.verified === false ? ' · check failed'
                  : ' · unverified';
      sum.textContent = (step.summary || 'done') + proof;
      if (step.verified === true) sum.classList.add('proven');
      body.appendChild(sum);
    }
    if (step.error && (step.status === 'failed' || step.status === 'skipped')) {
      const sum = document.createElement('span');
      sum.className = 'sum';
      sum.textContent = step.error;
      body.appendChild(sum);
    }
    li.append(mark, body);
    ui.steps.appendChild(li);
  });

  // the approval gate, shown only when the runtime is genuinely blocked on it
  if (s.pendingApproval) {
    ui.approval.style.display = '';
    ui.approvalWhat.textContent = s.pendingApproval.question || s.pendingApproval.title;
  } else {
    ui.approval.style.display = 'none';
  }

  ui.controls.innerHTML = '';
  if (s.status === 'working' || s.status === 'planning') {
    ui.controls.append(
      button('Pause', '', () => window.nimHost.agent('pause')),
      button('Cancel', 'no', () => window.nimHost.agent('cancel'))
    );
  } else if (s.status === 'paused') {
    ui.controls.append(
      button('Resume', 'go', () => window.nimHost.agent('resume')),
      button('Cancel', 'no', () => window.nimHost.agent('cancel'))
    );
  } else if (s.status === 'error') {
    ui.controls.append(
      button('Retry', 'go', () => window.nimHost.agent('retry')),
      button('Dismiss', '', () => window.nimHost.agent('clear'))
    );
  } else if (s.status === 'completed' || s.status === 'cancelled') {
    if (s.result) {
      ui.controls.append(button('Show result', '', () => {
        ui.result.textContent = s.result;
        ui.result.classList.toggle('show');
      }));
    }
    ui.controls.append(button('Clear', '', () => {
      ui.result.classList.remove('show');
      window.nimHost.agent('clear');
    }));
  }

  if (s.status === 'idle') ui.result.classList.remove('show');
}

/* ---- hearing you ---------------------------------------------------------- */

let mic = null;
let wake = null;
const micBtn = document.getElementById('mic');

/* Nim talks through the same speakers the microphone is listening to, so the
 * wake word must be deaf while it speaks - or while push-to-talk has the mic.
 * The listener asks this on every chunk of audio, so it can never get stuck
 * deaf, or left listening to itself, by a pause that was never undone. */
function nimIsTalking() {
  if (playing || window.speechSynthesis.speaking) return 'speaking';
  if (performance.now() < chimingUntil) return 'chiming';
  if (mic && mic.busy) return 'push-to-talk';
  return '';
}

/* Push-to-talk. The button can see a release, so holding it is the real
 * interaction; both ends go through the same controller. */
function micPress() {
  if (!mic || mic.busy) return;
  hush();
  if (wake) wake.endFollowUp();
  mic.start();
}

function micRelease() {
  if (mic && mic.listening) mic.stop();
}

/* A global shortcut only ever reports the key going down - Windows gives
 * Electron no release for it - so from the keyboard this is press to start and
 * press again to stop, with silence detection as the safety net. */
function micToggle() {
  if (!mic) return;
  if (mic.listening) mic.stop();
  else if (!mic.busy) { hush(); if (wake) wake.endFollowUp(); mic.start(); }
}

/* ---- giving it something to do ----------------------------------------------- */

async function submit(text, byVoice) {
  if (!text) return;
  lastActivity = performance.now();
  goalInput.value = '';
  local.asking = false;
  voiceTurn = !!byVoice;
  if (!byVoice && wake) wake.endFollowUp();
  // with a language model behind it, working out what you meant can take a
  // second or two - and Nim should look like it is thinking, because it is
  if (nim) nim.setState('thinking');
  let out;
  try {
    out = await window.nimHost.submit(text);
  } catch {
    out = { quick: true, say: 'Something went wrong while I was thinking about that.', mood: 'sad' };
  }
  if (out && out.quick) {
    // the main process speaks answers itself; only an unspoken one is said here
    if (out.say && !out.spoken) say(out.say, out.mood);
    else if (!out.say) applyFace();
  }
}

goalInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { expand(false); return; }
  if (e.key !== 'Enter') return;
  const text = goalInput.value.trim();
  if (!text) { expand(false); return; }
  // hand the keyboard back first, so steps that press keys reach your real app
  expand(false);
  await submit(text);
});

document.getElementById('collapse').addEventListener('click', () => expand(false));
document.getElementById('approve').addEventListener('click', () => window.nimHost.agent('approve', true));
document.getElementById('deny').addEventListener('click', () => window.nimHost.agent('approve', false));

/* ---- the shared state --------------------------------------------------------- */

/* Subscribed before anything is awaited: the main process sends its first
 * snapshot the moment the page loads, and a listener registered after an await
 * would miss it. */
window.nimHost.onState(({ event, state }) => {
  shared = state;
  if (event && event.type && event.type !== 'provider_status') lastActivity = performance.now();
  if (window.nimDots) window.nimDots.update(state, event);
  if (nim && (!event || event.type === 'media_changed' || event.type === 'sync')) { updateMusic(); refreshMediaBar(); }
  if (dancing && state.phase !== 'idle') stopDancing();
  applyFace(event);
  refreshSurface();
});

window.nimHost.onAgent((s) => {
  const was = snap && snap.status;
  render(s);
  // a question from the runtime is answered from the surface; the island
  // only opens by itself if you already had it open
  if (s.status === 'waiting-approval' && was !== 'waiting-approval' && expanded) render(s);
});

/* ---- where things can be clicked -----------------------------------------------
 *
 * The window is click-through except where something is drawn, so everything
 * clickable reports its rectangle: the Dots, and the surface while it is open.
 */
const boxes = { dots: [], surface: null, media: null, life: [] };
let boxesSent = 0, boxesTimer = 0;
function sendBoxes() {
  const now = performance.now();
  const send = () => {
    boxesSent = performance.now();
    window.nimHost.hitboxes(boxes.dots.concat(boxes.surface ? [boxes.surface] : [], boxes.media ? [boxes.media] : [], boxes.life || []));
  };
  clearTimeout(boxesTimer);
  if (now - boxesSent > 90) send();
  else boxesTimer = setTimeout(send, 90);
}

/* ---- boot ---------------------------------------------------------------- */

(async function boot() {
  cfg = await window.nimHost.config();
  chooseVoice();

  nim = createNim(document.getElementById('nim'), {
    scale: cfg.scale,
    anchor: cfg.anchor,
    outfit: cfg.outfit
  });
  nim.wake();

  const nimBox = () => document.getElementById('nim').getBoundingClientRect();

  // the surface grows out of the light above Nim's head
  surface = window.createSurface(document.getElementById('surface-layer'), {
    anchor: () => {
      const b = nimBox();
      const p = nim.sparkPoint();
      return { x: b.left + p.x, y: b.top + p.y };
    },
    bounds: () => ({ w: window.innerWidth, h: window.innerHeight }),
    onAction: surfaceAction,
    onSubmit: (text) => submit(text),
    focus: (on) => window.nimHost.focus(on),
    reportBox: (box) => {
      const same = (a, b) => (!a && !b) || (a && b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 &&
                                             Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1);
      if (same(box, boxes.surface)) return;
      boxes.surface = box;
      sendBoxes();
    }
  });

  // the Dots sit in a row just under the creature's shadow
  window.nimDots = window.createDots(document.getElementById('dots'), {
    center: () => {
      const r = nimBox();
      const foot = nim.footPoint();
      return { x: r.left + foot.x, y: r.top + foot.y + 24 };
    },
    reportHitboxes: (list) => { boxes.dots = list; sendBoxes(); },
    onAction: (act) => {
      if (act === 'stop') window.nimHost.agent('cancel');
      else if (act === 'open') expand(true);
      else if (act === 'listen') micToggle();
    }
  });
  window.nimHost.state().then((s) => {
    if (!s) return;
    shared = s;
    window.nimDots.update(s);
    refreshSurface();
    updateMusic();
  });

  setupMediaBar();
  setupLife();
  window.nimHost.onCursor(({ x, y, over, body, ghost }) => {
    // the cursor arrives in window coordinates; Nim's canvas is its own box
    const box = nimBox();
    nim.lookAt(x - box.left, y - box.top);
    // passing over while you work: see-through, and clicks go to what is under it
    document.getElementById('nim').classList.toggle('ghost', !!ghost);
    // stroking it still counts, see-through or not
    noticeStroke(x, !!(over || body));
    // pointing at it while music plays brings up the controls
    if (over !== mediaHover) {
      mediaHover = over;
      if (!over) mediaShowUntil = performance.now() + 2500;
      refreshMediaBar();
    }
    if (dragging || expanded) return;
    if (shared && shared.phase !== 'idle') return;        // the agent owns the face

    if (over) {
      if (nim.state === 'idle' || nim.state === 'sleep') nim.setState('alert');
      lastActivity = performance.now();
      settle = 0;
    } else if (nim.state === 'alert') {
      if (++settle > 40) { nim.setState('idle'); settle = 0; }
    }
  });

  // dozes off after a long quiet spell, wakes the moment anything happens
  setInterval(() => {
    if (!nim || !shared || shared.phase !== 'idle' || playing || (mic && mic.busy)) return;
    if (dancing) return;                         // nobody dozes off mid-song
    if (performance.now() - lastActivity > 10 * 60 * 1000 && nim.state !== 'sleep') nim.setState('sleep');
  }, 30000);

  window.nimHost.onSay(({ text, mood, speak }) => say(text, mood, speak));
  window.nimHost.onOutfit((partial) => nim.setOutfit(partial));
  window.nimHost.onVoiceChanged((v) => {
    cfg.voiceEngine = v.engine;
    cfg.piperVoice = v.id;
    if (v.engine === 'system' && v.system) { cfg.voice = v.system; chooseVoice(); }
    say('This is how I sound now. Better?', 'happy');
  });

  window.nimHost.onSetVoice((name) => {
    const found = window.speechSynthesis.getVoices().find((v) => v.name === name);
    if (!found) return;
    voice = found;
    cfg.voice = name;
    say('This is how I sound now. Better?', 'happy');
  });

  // a smaller or bigger Nim, from Settings
  window.nimHost.onSize((z) => {
    if (!z) return;
    cfg.scale = z.scale;
    cfg.anchor = z.anchor;
    nim.setSize(z.scale, z.anchor);
  });

  // changed in the settings window
  window.nimHost.onSettings((v) => {
    if (Number.isFinite(v.rate)) cfg.rate = v.rate;
    cfg.followUp = v.followUp;
  });

  window.nimHost.onOpenInput(() => askOpen(true));
  window.nimHost.onEnroll(() => teachVoice());
  window.nimHost.onDance((on) => { cfg.danceToMusic = on; updateMusic(); });
  window.nimHost.onLyrics((p) => {
    const lines = (p && Array.isArray(p.lines)) ? p.lines : null;
    lyricsFor = { key: (p && p.key) || '', lines, hooks: lines ? window.NimMusic.hookLines(lines) : null };
  });
  window.nimHost.onSongMood((p) => {
    moodFor = { key: String((p && p.key) || ''), mood: String((p && p.mood) || '') };
    log('song mood: ' + moodFor.mood);
  });
  window.nimHost.onSongCheck((p) => {
    checkFor = { key: String((p && p.key) || ''), music: p && typeof p.music === 'boolean' ? p.music : null };
  });
  window.nimHost.onMediaClock((p) => {
    if (!p) return;
    songClock = { key: String(p.key || ''), playing: !!p.playing, position: Number(p.position) || 0, updated: Number(p.updated) || 0 };
  });

  // ---- the microphone
  log('secureContext=' + window.isSecureContext +
      ' mediaDevices=' + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) +
      ' MediaRecorder=' + (typeof MediaRecorder !== 'undefined') +
      ' origin=' + location.protocol);

  const canHear = await window.nimHost.canHear().catch(() => false);
  log('canHear=' + canHear);
  if (!canHear) {
    log('mic button hidden: whisper reported unavailable');
    micBtn.style.display = 'none';
    return;
  }

  mic = window.createMic({
    // primed with the name: people say "Hey Nim, ..." even while holding the button
    transcribe: (wav) => window.nimHost.transcribe(wav, 'full'),

    /* The mic's own state drives the face and the shared state. One mapping,
     * so nothing can show listening while the microphone is actually shut. */
    onState: (s) => {
      log('mic state -> ' + s);
      micBtn.classList.toggle('on', s === 'listening');
      local.hearing = s === 'listening';
      if (s === 'listening') {
        if (nim) nim.setState('listening');
        window.nimHost.emit('listening_started', { via: 'mic' });
      } else if (s === 'transcribing') {
        if (nim) nim.setState('thinking');
        window.nimHost.emit('transcription_started', { via: 'mic' });
      } else {
        applyFace();
      }
      refreshSurface();
    },

    onLevel: (v) => { if (surface) surface.setLevel(v); },

    onText: async (heard) => {
      diag('push-to-talk heard ' + JSON.stringify(heard));
      if (!heard || /^[♪♫♬\s.]*$/.test(heard)) {
        window.nimHost.emit('idle', {});
        say('I did not hear anything.', 'sad');
        return;
      }
      // "Hey Nim, open Brave" while holding the button: the request is "open Brave"
      const after = window.createWake.wakeCommand(heard, cfg.wakeVariants || []);
      const text = after ? after : heard;
      window.nimHost.emit('transcription_received', { via: 'mic', text });
      // the same pipeline typing uses - there is no separate voice path
      await submit(text, true);
    },

    onError: (msg) => { log('mic error: ' + msg); say(msg, 'sad'); }
  });

  micBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); micPress(); });
  micBtn.addEventListener('pointerup', micRelease);
  micBtn.addEventListener('pointerleave', micRelease);
  micBtn.addEventListener('pointercancel', micRelease);

  window.nimHost.onListen(micToggle);

  // ---- the wake word
  wake = window.createWake({
    transcribe: (wav, kind) => window.nimHost.transcribe(wav, kind),
    encode: window.createMic.encodeWav16k,
    variants: () => cfg.wakeVariants || [],
    onLog: log,
    onDiag: diag,
    isMuted: nimIsTalking,
    onLevel: (v) => { if (surface && shared && shared.phase === 'listening' && !local.hearing) surface.setLevel(v); },

    /* Like Siri: nothing shows until the name is actually heard. Nim used to
     * perk up at every sound in the room, which with a video playing meant
     * looking "on" every second for nothing. */
    onHeard: () => {},

    /* Known to be for Nim: show it straight away, before the slower full
     * transcript arrives - this is the moment "Hey Nim" feels answered. */
    onWake: () => {
      if (mic && mic.busy) return;
      lastActivity = performance.now();
      chime();
      window.nimHost.emit('wake_detected', {});
      window.nimHost.emit('transcription_started', { via: 'wake' });
      if (nim) nim.setState('listening');
    },

    /* The short pass thought it heard the name; the full one heard someone
     * else's ("Hey Neil"). Take back the "I'm listening". */
    onWakeRetracted: () => {
      if (shared && ['listening', 'transcribing'].includes(shared.phase) && !local.hearing) window.nimHost.emit('idle', {});
      applyFace();
    },

    onTrigger: async (command, heard) => {
      if (mic && mic.busy) return;
      diag('wake request ' + JSON.stringify(command) + ' from ' + JSON.stringify(heard));
      if (!command) {
        /* Just its name. Nim does not say "yes?" - that would talk over the
         * request you are about to make. It shows it is listening, and the
         * next thing you say is taken as the request. */
        window.nimHost.emit('listening_started', { via: 'wake' });
        if (nim) nim.setState('listening');
        return;
      }
      window.nimHost.emit('transcription_received', { via: 'wake', text: command });
      await submit(command, true);     // the same pipeline as typing and as holding
    },

    onAwaitEnd: () => {
      if (shared && shared.phase === 'listening' && !local.hearing) window.nimHost.emit('idle', {});
      applyFace();
    },

    onError: () => { /* already reported through onLog */ }
  });

  if (cfg.wakeWord) wake.start();
  /* The microphone is opened only while Nim may be spoken to: on when
   * "Listen for my name" is on and you are at the computer, released - and the
   * Windows microphone icon gone - while it is off, while the PC is locked,
   * and while Nim is hidden. */
  window.nimHost.onWakeWord((on) => {
    if (on) wake.start();
    else wake.stop();
  });

  /* Test seam, wired only when the app runs its self-test: the main process
   * hands over a recording, which goes through the real wake path. */
  window.nimHost.onTestWake(async (bytes) => {
    if (!bytes) { wake.resume(); return; }        // the test is over: the room again
    // the room's own sound is shut out while recordings are tested, so the
    // result is about the recording - everything after the microphone is real
    if (!wake.paused) wake.pause();
    const samples = decodeWav16k(bytes);
    if (samples) await wake.inject(samples, 16000);
    window.nimHost.log('wake-test-done');
  });
}());

/* A 16 kHz mono 16-bit WAV, as the self-test sends it, back into samples. */
function decodeWav16k(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let pos = 12;
    while (pos < u8.length - 8) {
      const id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
      const size = dv.getUint32(pos + 4, true);
      if (id === 'data') {
        const n = Math.floor(Math.min(size, u8.length - pos - 8) / 2);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = dv.getInt16(pos + 8 + i * 2, true) / 32768;
        return out;
      }
      pos += 8 + size + (size & 1);
    }
  } catch { /* not a WAV */ }
  return null;
}

/* What each part is showing right now - for the real-app self-test, which
 * checks that the face, the surface and the Dots agree with the state. */
window.__nimView = () => ({
  face: nim && nim.state,
  surface: surface && surface.mode,
  phase: shared && shared.phase,
  dots: window.nimDots && window.nimDots.snapshot ? window.nimDots.snapshot() : null
});

/* ---- touching it --------------------------------------------------------- */

let holdTimer = 0;
let holdTalking = false;
let holdFrom = null;
const DRAG_SLOP = 7;      // a hand holding still still moves a pixel or two

function onSurfaceOrIsland(target) {
  return island.contains(target) || !!(target.closest && (target.closest('.surface') || target.closest('.nim-dot') || target.closest('.dot-card') || target.closest('.media-bar') || target.closest('.life-pill') || target.closest('.quiz-card')));
}

document.addEventListener('pointerdown', (e) => {
  if (!nim) return;
  if (onSurfaceOrIsland(e.target)) return;      // clicks inside those are theirs

  if (e.button === 2) { window.nimHost.menu(); return; }

  dragging = true;
  dragMoved = false;
  holdFrom = { x: e.screenX, y: e.screenY };
  window.nimHost.dragStart();

  // Hold the creature itself to talk to it. A quick tap opens the surface to
  // type, and a drag still moves it; only a press that stays put is the mic.
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    if (!dragMoved && dragging && mic && !mic.busy) {
      holdTalking = true;
      micPress();
    }
  }, 350);
});

document.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  // A hand resting on a mouse is never perfectly still, so a pixel of jitter
  // must not count as a drag - that would cancel every hold-to-talk.
  if (holdFrom &&
      Math.abs(e.screenX - holdFrom.x) < DRAG_SLOP &&
      Math.abs(e.screenY - holdFrom.y) < DRAG_SLOP) return;

  dragMoved = true;
  if (!holdTalking) clearTimeout(holdTimer);   // a real drag is a move, not a word
});

document.addEventListener('pointerup', (e) => {
  clearTimeout(holdTimer);
  if (!dragging) return;
  dragging = false;
  window.nimHost.dragEnd();

  if (holdTalking) {                            // let go of the push-to-talk
    holdTalking = false;
    micRelease();
    return;
  }
  if (onSurfaceOrIsland(e.target)) return;

  // a tap that did not move it opens the surface to type to; another closes it
  if (!dragMoved) askOpen(!local.asking);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (expanded) expand(false);
  else if (local.asking) askOpen(false);
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dragstart', (e) => e.preventDefault());
