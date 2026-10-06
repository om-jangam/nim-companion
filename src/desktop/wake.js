'use strict';
/*
 * "Hey Nim" - the wake word.
 *
 * Two stages, so it can stay on all day:
 *
 *   1. Raw audio flows through a small processor that measures its loudness
 *      and keeps the last half second in a ring buffer. That costs almost
 *      nothing and runs no transcription at all.
 *
 *   2. When it hears speech, it keeps collecting until you stop, then asks
 *      Whisper whether that utterance was addressed to Nim. If it was, the rest
 *      of the sentence is the command - "Hey Nim, open YouTube" is heard and
 *      run from one breath.
 *
 * The ring buffer is the part that matters most. Speech is only recognised as
 * speech a moment after it starts, so anything that begins recording at that
 * point has already lost the first syllable - and a wake phrase with its first
 * syllable missing is "...im", which Whisper confidently transcribes as "Thank
 * you." So the half second before detection is always kept and put back in front.
 *
 * The loudness threshold follows the room's own noise floor, because a quiet
 * laptop microphone and a headset differ by an order of magnitude and one fixed
 * value cannot serve both.
 *
 * Audio never leaves this machine and nothing is written to disk by this file.
 */
(function (global) {
  'use strict';

  var PREROLL_MS = 500;       // kept from before speech is detected
  var END_MS = 650;           // quiet this long means the sentence is over
  var MIN_SPEECH_MS = 220;    // less loud audio than this is a click, not a word
  var MAX_MS = 8000;          // longer than this is a conversation, not a command
  var COOLDOWN_MS = 300;      // breathing room after each transcription
  var FLOOR_MIN = 0.003;      // the threshold never drops below silence
  var THRESHOLD_MIN = 0.008;
  var THRESHOLD_MAX = 0.045;
  var HISTORY = 240;          // ~10 s of loudness readings, for the noise floor
  var START_CHUNKS = 2;       // loud this many chunks in a row to count as speech
  var REPORT_MS = 30000;      // how often the listening level is reported
  var HEAD_S = 1.5;           // the wake check listens to this much: pre-roll + ~1s of speech
  var LONG_S = HEAD_S + 1.0;  // an utterance this long may hold the wake phrase past its start
  var AWAIT_MS = 10000;       // after a bare "Hey Nim", how long you have to start saying the request
  var QUEUE_MAX = 3;          // utterances kept while Whisper is busy

  /* ---- what counts as being addressed ----------------------------------------
   *
   * Whisper writes the name as it hears it, and it does not know it is a name.
   * These are the spellings it actually produces for "Nim" and for "Hey" -
   * measured on US and Indian English voices, clean, soft and noisy (see
   * test/wake-audio.test.js). An Indian English "Hey Nim" comes back as "He
   * Nim" as often as "Hey Nim", so "he" counts as a greeting - but only
   * directly before the name, where no ordinary sentence puts it.
   *
   * "him" and "name" are accepted only straight after a hey-like word, never on
   * their own and never after "okay" ("Okay, name the file..." is an ordinary
   * sentence).
   *
   * Every pattern is anchored to the start of an utterance or of a sentence,
   * so the name said in the middle of a sentence never triggers anything:
   *
   *   "hey nim, open youtube"   greeted, with a command
   *   "heynim open youtube"     greeting and name heard as one word
   *   "nim, open youtube"       addressed: the name, then a comma or full stop
   *   "nim open youtube"        addressed without punctuation, but only when what
   *                             follows is plainly an instruction
   *   "nim"                     the name alone and nothing else
   */
  var NAME = '(?:nim|nimh|nimm|nym|neem|neam|nims|nem|hymn|ni+m)';
  var HEY = '(?:hey|hay|hi|he|hai|hei|heh)';
  var GREETING = '(?:' + HEY + '|hello|ok|okay|yo)';
  var REST = '\\b[\\s,.!?:-]*(.*)$';
  var GREETED = new RegExp('^\\s*(?:' + GREETING + '[\\s,!.]+' + NAME + '|' + HEY + '[\\s,!.]+(?:him|name))' + REST, 'i');
  var FUSED = new RegExp('^\\s*(?:hey|hay|he|hi)-?(?:nim|neem|nem|nym)' + REST, 'i');
  var ADDRESSED = new RegExp('^\\s*' + NAME + '\\s*[,:.!?]\\s*(.+)$', 'i');
  var ORDERED = new RegExp('^\\s*' + NAME + '\\s+((?:open|play|search|what|whats|tell|show|check|run|write|make|' +
    'remember|turn|stop|pause|go|find|read|take|volume|close|mute|unmute|set|create|save|lock)\\b.*)$', 'i');
  var ALONE = new RegExp('^\\s*' + NAME + '[\\s,.!?:-]*$', 'i');
  /* "Nim" said on its own, in an Indian English accent, is very often written
   * "name". Accepted as the name only when it is the whole utterance - which,
   * as an ordinary remark, almost never happens - and even then all it does is
   * open the listening window: nothing runs until a request follows. */
  var ALONE_NAME = /^\s*name[\s.!?]*$/i;

  /* Spellings of "Hey Nim" that one particular person's voice produces, learned
   * when they teach Nim their voice. Treated exactly like the built-in ones:
   * only at the start of an utterance, followed by a pause or a command. */
  function personal(text, variants) {
    var t = String(text || '');
    for (var i = 0; i < (variants || []).length; i++) {
      var v = String(variants[i]).toLowerCase().replace(/[^a-z ]/g, '').trim();
      if (!v) continue;
      var re = new RegExp('^\\s*' + v.split(/\s+/).join('[\\s,.!?-]+') + REST, 'i');
      var m = re.exec(t);
      if (m) return (m[1] || '').trim();
    }
    return null;
  }

  /** The command after the wake phrase; '' for the name alone; null if not addressed. */
  function wakeCommand(text, variants) {
    var m = GREETED.exec(text) || FUSED.exec(text) || ADDRESSED.exec(text) || ORDERED.exec(text);
    if (m) return (m[1] || '').trim();
    if (ALONE.test(text) || ALONE_NAME.test(text)) return '';
    return personal(text, variants);
  }

  /* Whisper punctuates, so in a long stretch of speech - you talking over a
   * video, say - "Hey Nim" can open the second or third sentence. Sentence
   * starts count; the middle of a sentence still never does. */
  function wakeInSentences(text, variants) {
    var parts = String(text || '').split(/(?<=[.!?])\s+/);
    for (var i = 1; i < parts.length; i++) {
      var c = wakeCommand(parts.slice(i).join(' '), variants);
      if (c !== null) return c;
    }
    return null;
  }

  /* Whether a short, rough transcript sounds anything like the name. This only
   * decides whether to spend a second, closer listen; it never wakes anything. */
  var NEAR = /^(?:n[aeiy]+m\w*|h[aeiy]*n+[aeiy]*m?\w*|h[aeiy]+m|hymn\w*|him|them|name\w*|me)$/i;
  function nearWake(text, variants) {
    var words = String(text || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4);
    if (words.some(function (w) { return NEAR.test(w); })) return true;
    return (variants || []).some(function (v) { return words.join(' ').indexOf(String(v).toLowerCase()) === 0; });
  }

  // Whisper marks music with notes; lyrics are never a request
  function isMusic(t) { return /[♪♫♬]/.test(t); }

  /* How sure a transcript is that it was addressed to Nim:
   *   strong  the name itself was heard (any spelling above, or a learned one)
   *   weak    only "hey him" / "hey name": plausible, but ordinary words too
   *   null    not addressed */
  var WEAK = new RegExp('^\\s*' + HEY + '[\\s,!.]+(?:him|name)' + REST, 'i');
  var OPENS_WITH_GREETING = new RegExp('^\\s*' + GREETING + '\\b', 'i');
  function classify(text, variants) {
    var command = wakeCommand(text, variants);
    if (command === null) return { kind: null, command: null };
    return { kind: WEAK.test(String(text || '')) ? 'weak' : 'strong', command: command };
  }

  function words(t) {
    return String(t || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
  }

  /* How requests to an assistant begin: an instruction or a question. "Take a
   * screenshot", "what time is it", "can you open Brave" - not "I was telling
   * my friend", which is someone talking about something else. */
  var REQUEST_START = new RegExp('^(?:open|launch|start|play|pause|resume|stop|search|google|look|find|show|tell|' +
    'what|whats|how|when|where|who|why|which|is|are|can|could|would|will|do|does|please|take|turn|set|make|' +
    'create|write|save|read|close|quit|exit|switch|go|volume|mute|unmute|lock|restart|reboot|shut|remind|note|' +
    'delete|remove|move|copy|rename|download|organi[sz]e|tidy|clean|summari[sz]e|explain|translate|help|check|' +
    'put|give|add|list|next|skip|previous|increase|decrease|raise|lower|louder|quieter|screenshot|capture|run|' +
    'type|paste|calculate|convert|cancel|bring|minimi[sz]e|maximi[sz]e)$', 'i');
  function requestLike(text) {
    var first = String(text || '').trim().split(/\s+/)[0] || '';
    return REQUEST_START.test(first.toLowerCase().replace(/[^a-z']/g, '').replace(/'s$/, 's'));
  }

  /* What continues a conversation without the name: a request or a question,
   * or "and..." / "what about...". Narration - a video, someone talking in the
   * room ("so today we are going to...") - does not. */
  var CONTINUES = /^(?:and|also|what about|how about|please|thanks|thank you|another|again|one more|stop|cancel|never ?mind)\b/i;
  function conversational(text) {
    var t = String(text || '').trim();
    if (!t || isMusic(t)) return false;
    return requestLike(t) || /\?\s*$/.test(t) || CONTINUES.test(t);
  }

  /* The request inside a transcript whose opening is a misheard name: "Hain
   * him. Open Brave." - at most a couple of short words are skipped before
   * something that reads as a request. */
  function requestAfterOpening(full) {
    var tokens = String(full || '').trim().split(/\s+/).filter(Boolean);
    for (var i = 0; i <= Math.min(3, tokens.length - 1); i++) {
      var skipped = tokens.slice(0, i);
      if (skipped.some(function (t) { return t.replace(/[^a-z']/gi, '').length > 7; })) break;
      if (i === 3 && !/[,.!?:;]$/.test(skipped[2])) break;
      var rest = tokens.slice(i).join(' ').replace(/^[\s,.!?:;-]+/, '');
      if (requestLike(rest)) return rest;
    }
    return null;
  }

  /* The short pass heard the name and the full pass did not. Whisper, given
   * the whole sentence, often drops or garbles the greeting - "Take a
   * screenshot." or "Hain him. Open Brave." after a short pass of "Hey Nim."
   * The full transcript then gives the request, but only when:
   *   - it does not open with a greeting followed by something other than the
   *     name ("Hey Neil, open the door", "Ok, named the file") - that is the
   *     short pass mishearing another name as Nim's;
   *   - it agrees with whatever the short pass heard after the name;
   *   - what is left reads as a request, not as someone talking about
   *     something else ("I was telling my friend...").
   * The name heard alone, then a word or two that is no request: the name. */
  function droppedGreeting(headText, fullText, variants) {
    var full = String(fullText || '').trim();
    if (!full || OPENS_WITH_GREETING.test(full)) return null;
    var after = classify(headText, variants).command || '';
    var fragment = words(after).filter(function (w) { return w.length >= 3; });
    if (fragment.length && words(full).slice(0, 4).indexOf(fragment[0]) === -1) return null;
    var request = requestAfterOpening(full);
    if (request) return request;
    if (!after && words(full).length <= 2) return '';
    return null;
  }

  /* The request from an unprimed transcript: whatever comes after the first
   * word or two if they sound like the wake phrase. */
  function stripWake(text, variants) {
    var t = String(text || '').trim();
    var c = wakeCommand(t, variants);
    if (c !== null) return c;
    var w = t.split(/\s+/), n = 0;
    while (n < 2 && n < w.length) {
      var bare = w[n].toLowerCase().replace(/[^a-z]/g, '');
      if (!(NEAR.test(bare) || /^(hey|hi|hay|he|hai|ok|okay)$/.test(bare))) break;
      n++;
    }
    return w.slice(n).join(' ').replace(/^[\s,.!?-]+/, '').trim();
  }

  /*
   * Was this utterance for Nim, and what was asked? The one decision, used by
   * the live listener below and by the audio tests (test/wake-audio.test.js),
   * so what is measured is exactly what runs.
   *
   *   hear(samples, kind) -> Promise<{ text, ms }>, kind one of
   *     head     the first second and a half, primed with the name
   *     full     the whole utterance, primed with the name, urgent
   *     scan     the same, as background work (a long utterance, just in case)
   *     command  the whole utterance, unprimed
   *   opts.variants  learned spellings; opts.spoke  ms of actual speech;
   *   opts.onEarly() called the moment the short pass is sure
   *
   * Whisper treats a short greeting at the start of a sentence as filler and
   * often drops it, so the short pass comes first, primed with the name, where
   * there is no sentence for it to prefer. For most of what is said in a room
   * that is the only pass. But cut mid-syllable, an accented "Hey Nim" can come
   * back as "He Nim" or "Hini" while the whole sentence transcribes perfectly -
   * so when the short pass sounds anything like the name, or the utterance is
   * long enough to hold the name later on, the whole of it is transcribed too
   * and either pass can confirm. Confirming still takes the same anchored
   * patterns: listening closer is not matching looser.
   */
  async function decide(samples, rate, hear, opts) {
    opts = opts || {};
    var variants = opts.variants || [];
    var headLength = Math.min(samples.length, Math.round(rate * HEAD_S));
    var head = await hear(samples.subarray(0, headLength), 'head');
    var out = { wake: false, command: null, reason: '', head: head.text, headMs: head.ms, full: null, fullMs: 0 };
    if (!head.text || isMusic(head.text)) { out.reason = head.text ? 'music' : 'nothing heard'; return out; }

    var h = classify(head.text, variants);
    var long = samples.length > Math.round(rate * LONG_S);
    var near = nearWake(head.text, variants);
    if (h.kind === 'strong' && opts.onEarly) opts.onEarly();
    if (!h.kind && !near && !long) { out.reason = 'not for Nim'; return out; }

    var full = headLength < samples.length ? await hear(samples, h.kind || near ? 'full' : 'scan') : head;
    out.full = full.text;
    out.fullMs = full === head ? 0 : full.ms;
    if (isMusic(full.text)) { out.reason = 'music'; return out; }

    var f = classify(full.text, variants);
    var command = null;
    if (f.kind === 'strong' || (f.kind === 'weak' && h.kind === 'strong')) command = f.command;
    else if (!f.kind && long) command = wakeInSentences(full.text, variants);
    if (command === null && h.kind === 'strong' && !f.kind) command = droppedGreeting(head.text, full.text, variants);
    if (command === null) {
      out.reason = f.kind === 'weak' || h.kind === 'weak' ? 'only "hey him", never the name' : 'not for Nim';
      return out;
    }

    // "Hey Nim." and nothing more - though plainly more was said. Primed with
    // the name, Whisper sometimes stops right there; one more listen, unprimed,
    // for the rest of the sentence. What it finds counts only if it reads as a
    // request: over a video playing in the room, the rest of the utterance is
    // the video, and then the name alone is the honest answer.
    if (!command && f.kind && (opts.spoke || 0) > 1500 && samples.length > headLength &&
        String(full.text).replace(/[^a-z]/gi, '').length <= 12) {
      var again = await hear(samples, 'command');
      out.full += ' | ' + again.text;
      out.fullMs += again.ms;
      var rest = stripWake(again.text, variants);
      command = requestLike(rest) ? rest : '';
    }
    out.wake = true;
    out.command = command;
    out.reason = command ? 'a request' : 'the name alone';
    return out;
  }

  function createWake(opts) {
    opts = opts || {};
    var transcribe = opts.transcribe;
    var encode = opts.encode || (global.createMic && global.createMic.encodeWav16k);
    var variants = function () { return (opts.variants && opts.variants()) || []; };

    var stream = null, ctx = null, node = null, source = null;
    // testArmed: tests drive the listener through inject(), with no microphone
    var armed = opts.testArmed === true, paused = false, working = false;
    var rate = 48000;
    var segN = 0;

    // the rolling half second before anything is detected
    var ring = [], ringSamples = 0;
    // the utterance being collected
    var parts = null, speechMs = 0, quietMs = 0, totalMs = 0, peak = 0;
    var floor = 0.01, cooldownUntil = 0;
    var pending = [];              // utterances waiting while Whisper is busy
    var awaitingUntil = 0;         // set by a bare "Hey Nim", or after Nim has answered
    var awaitingFor = 'name';      // 'name': the request after "Hey Nim" | 'answer': a reply to Nim's question
                                   // | 'conversation': whatever you say next, if it is said to Nim
    var mutedWhy = '', mutedUntil = 0;
    var enrolling = null;          // { left, samples, onSample, onDone, until } while learning your voice

    function log(line) { if (opts.onLog) opts.onLog(line); }
    // what was heard, word for word - printed only while diagnostics are on
    function diag(line) { if (opts.onDiag) opts.onDiag(line); }

    /* The floor is the room when nobody is talking: the 20th percentile of the
     * last ten seconds, not the average. An average climbs with every bit of
     * background chatter and fan noise - and with gain control lifting it - until
     * the bar sits above an ordinary speaking voice, which is exactly how this
     * failed before. Speech is then a step clearly above that floor. */
    var history = [], sinceFloor = 0, loudRun = 0;

    function updateFloor(rms) {
      history.push(rms);
      if (history.length > HISTORY) history.shift();
      if (++sinceFloor < 20 || history.length < 20) return;      // about once a second
      sinceFloor = 0;
      var sorted = history.slice().sort(function (a, b) { return a - b; });
      floor = Math.max(FLOOR_MIN, sorted[Math.floor(sorted.length * 0.2)]);
    }

    function threshold() {
      return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, floor * 2.0, floor + 0.008));
    }

    function pushRing(chunk) {
      ring.push(chunk);
      ringSamples += chunk.length;
      var keep = rate * PREROLL_MS / 1000;
      while (ring.length > 1 && ringSamples - ring[0].length >= keep) {
        ringSamples -= ring.shift().length;
      }
    }

    var segStartedAt = 0;
    function begin() {
      parts = ring.slice();           // the pre-roll goes in front (and holds the loud run)
      ring = []; ringSamples = 0;
      speechMs = 0; quietMs = 0; totalMs = 0; peak = 0;
      segStartedAt = performance.now();
      segN++;
      diag('wake #' + segN + ': speech started (threshold ' + threshold().toFixed(3) + ', floor ' + floor.toFixed(3) + ')');
      if (opts.onHeard) opts.onHeard(true);
    }

    function finish() {
      var collected = parts;
      var spoke = speechMs, loudest = peak, id = segN;
      parts = null;
      if (opts.onHeard) opts.onHeard(false);

      if (spoke < MIN_SPEECH_MS) {                  // a knock, a cough, a click
        diag('wake #' + id + ': too short to be speech (' + Math.round(spoke) + 'ms)');
        return;
      }

      var n = 0;
      collected.forEach(function (c) { n += c.length; });
      var samples = new Float32Array(n);
      var at = 0;
      collected.forEach(function (c) { samples.set(c, at); at += c.length; });

      // begun while Nim was waiting for the request after its name: it is the
      // request, however long it took to say
      var seg = { id: id, samples: samples, spoke: spoke, peak: loudest, at: performance.now(),
                  followUp: awaitingUntil > 0 && segStartedAt <= awaitingUntil };
      diag('wake #' + id + ': heard ' + (n / rate).toFixed(1) + 's (speech ' + (spoke / 1000).toFixed(1) +
           's, peak ' + loudest.toFixed(3) + ', threshold ' + threshold().toFixed(3) + ')');

      // never drop what someone said because Whisper was still busy with the
      // last thing - queue it, and when the queue is full lose the oldest
      if (working) {
        pending.push(seg);
        if (pending.length > QUEUE_MAX) diag('wake #' + pending.shift().id + ': dropped, too many waiting');
        return;
      }
      process(seg);
    }

    function asWav(s) {
      return encode({ sampleRate: rate, length: s.length, getChannelData: function () { return s; } });
    }

    async function hear(s, kind) {
      var t0 = performance.now();
      var text = String((await transcribe(asWav(s), kind)) || '').trim();
      return { text: text, ms: Math.round(performance.now() - t0) };
    }

    async function process(seg) {
      working = true;
      try {
        var samples = seg.samples, id = seg.id;
        var now = performance.now();

        // learning your voice: each utterance is one "Hey Nim", heard exactly
        // as the wake check hears it - and is not acted on
        if (enrolling) {
          var sample = await hear(samples.subarray(0, Math.min(samples.length, Math.round(rate * HEAD_S))), 'head');
          diag('wake #' + id + ': learning, heard ' + JSON.stringify(sample.text));
          if (!enrolling) return;
          enrolling.samples.push(sample.text);
          enrolling.left--;
          if (enrolling.onSample) enrolling.onSample(enrolling.samples.length, sample.text);
          if (enrolling.left <= 0) { var done = enrolling; enrolling = null; done.onDone(done.samples); }
          return;
        }

        // after a bare "Hey Nim", or while a conversation is going, the next
        // thing said is the request itself - no name needed
        if (seg.followUp || awaitingUntil > now) {
          var mode = awaitingFor;
          // primed with the name: people often say it again anyway
          var followUp = await hear(samples, 'full');
          var heardText = followUp.text;
          var said = stripWake(heardText, variants());
          diag('wake #' + id + ': follow-up (' + mode + ') ' + JSON.stringify(heardText) + ' (' + followUp.ms + 'ms)');
          if (!heardText || isMusic(heardText)) {
            if (mode === 'name') { awaitingUntil = 0; if (opts.onAwaitEnd) opts.onAwaitEnd(); }
            return;
          }
          // In a conversation the room keeps talking too - a video, someone
          // else. Only what is plainly said to Nim continues it: a request or
          // a question, or after Nim asked something, a short answer ("the
          // second one", "Spotify"). Anything else is left alone, and the
          // window stays open until it runs out.
          var reply = said || heardText;
          var fits = conversational(reply) || (mode === 'answer' && words(reply).length <= 4);
          if (mode !== 'name' && !fits) {
            log('wake #' + id + ': heard during the conversation, but not said to Nim');
            return;
          }
          awaitingUntil = 0;
          if (!said && wakeCommand(heardText, variants()) === '') {
            // just the name again: wait for the request, as after any bare name
            awaitingUntil = performance.now() + AWAIT_MS;
            awaitingFor = 'name';
            if (opts.onTrigger) opts.onTrigger('', heardText);
            return;
          }
          log('wake #' + id + ': ' + (mode === 'name' ? 'request heard after the name' : mode === 'answer' ? 'your answer' : 'the conversation goes on'));
          if (opts.onTrigger) opts.onTrigger(said || heardText, heardText);
          return;
        }

        var early = false;
        var r = await decide(samples, rate, hear, {
          variants: variants(),
          spoke: seg.spoke,
          // shown as soon as it is known, before the slower full transcript
          onEarly: function () { early = true; if (opts.onWake) opts.onWake({ id: id }); }
        });
        diag('wake #' + id + ': head ' + JSON.stringify(r.head) + ' (' + r.headMs + 'ms)' +
             (r.full !== null ? ', full ' + JSON.stringify(r.full) + ' (' + r.fullMs + 'ms)' : '') +
             ' -> ' + (r.wake ? (r.command ? 'request ' + JSON.stringify(r.command) : 'name alone') : r.reason));
        var took = r.headMs + (r.fullMs ? '+' + r.fullMs : '') + 'ms';
        if (!r.wake) {
          log('wake #' + id + ': ' + (samples.length / rate).toFixed(1) + 's, ' + r.reason + ' (' + took + ')');
          if (early && opts.onWakeRetracted) opts.onWakeRetracted();
          return;
        }
        if (!early && opts.onWake) opts.onWake({ id: id });
        log('wake #' + id + ': addressed to Nim, ' + r.reason + ' (' + took + ')');

        if (!r.command) {
          awaitingUntil = performance.now() + AWAIT_MS;
          awaitingFor = 'name';
          if (opts.onTrigger) opts.onTrigger('', r.full || r.head);
          return;
        }
        if (opts.onTrigger) opts.onTrigger(r.command, r.full || r.head);
      } catch (err) {
        log('wake: ' + (err.message || err));
      } finally {
        working = false;
        cooldownUntil = performance.now() + COOLDOWN_MS;
        var next = pending.shift();
        if (next) process(next);
      }
    }

    // a running report of what the microphone is hearing, so "it does not
    // respond" can be told apart from "it hears nothing at all"
    var rep = { since: 0, sum: 0, n: 0, peak: 0, segs: 0, mutedMs: 0 };

    function onAudio(e) {
      var input = e.inputBuffer.getChannelData(0);
      var chunk = new Float32Array(input);           // the buffer is reused; copy it
      var ms = chunk.length / rate * 1000;

      var sum = 0;
      for (var i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      var rms = Math.sqrt(sum / chunk.length);
      if (opts.onLevel) opts.onLevel(Math.min(1, rms * 6));

      var now = performance.now();
      if (!rep.since) rep.since = now;
      rep.sum += rms; rep.n++; if (rms > rep.peak) rep.peak = rms;
      if (now - rep.since > REPORT_MS) {
        log('wake: level avg ' + (rep.sum / rep.n).toFixed(4) + ' peak ' + rep.peak.toFixed(4) +
            ' | floor ' + floor.toFixed(4) + ' threshold ' + threshold().toFixed(4) +
            ' | ' + (segN - rep.segs) + ' utterances' +
            (rep.mutedMs > 500 ? ' | deaf ' + (rep.mutedMs / 1000).toFixed(1) + 's (Nim talking or push-to-talk)' : '') +
            (paused ? ' (paused)' : ''));
        rep = { since: now, sum: 0, n: 0, peak: 0, segs: segN, mutedMs: 0 };
      }

      // learning that ran out of time: finish with what was heard
      if (enrolling && now > enrolling.until && !parts && !working) {
        var cut = enrolling; enrolling = null;
        cut.onDone(cut.samples);
      }

      // a bare "Hey Nim", or a conversation, that nobody followed up on: stop
      // waiting - even while deaf, or the window could outlive its welcome
      if (awaitingUntil && now > awaitingUntil && !parts && !working) {
        awaitingUntil = 0;
        diag('wake: nothing followed (' + awaitingFor + ')');
        if (opts.onAwaitEnd) opts.onAwaitEnd();
      }

      /* Deaf while Nim itself is talking, or while push-to-talk has the
       * microphone. Asked of the renderer on every chunk rather than tracked
       * with pause and resume calls, because a paired call that never arrives -
       * a greeting that starts before the listener exists - leaves it either
       * deaf for good or listening to itself. A question cannot get out of step. */
      var why = paused ? 'paused' : (opts.isMuted && opts.isMuted()) || '';
      if (why !== mutedWhy) {
        diag(why ? 'wake: deaf (' + why + ')' : 'wake: listening again');
        mutedWhy = why;
      }
      if (why) { mutedUntil = now + 450; rep.mutedMs += ms; }    // and a moment for the echo to die
      if (why || now < mutedUntil || now < cooldownUntil) {
        if (parts) {
          diag('wake #' + segN + ': dropped, Nim ' + (why ? 'became ' + why : 'was just talking'));
          parts = null;
          if (opts.onHeard) opts.onHeard(false);
        }
        loudRun = 0;
        pushRing(chunk);
        return;
      }

      var loud = rms > threshold();

      if (!parts) {
        updateFloor(rms);                       // learn the room while nobody is talking
        loudRun = loud ? loudRun + 1 : 0;
        pushRing(chunk);
        // a single spike - a tap on the desk - is not speech; a run of loud chunks is
        if (loudRun >= START_CHUNKS) { loudRun = 0; begin(); }
        return;
      }

      parts.push(chunk);
      totalMs += ms;
      if (rms > peak) peak = rms;
      if (loud) { speechMs += ms; quietMs = 0; }
      else quietMs += ms;

      if (quietMs >= END_MS || totalMs >= MAX_MS) finish();
    }

    async function start() {
      if (armed) return true;
      if (typeof encode !== 'function') { log('wake: no encoder available'); return false; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // gain control on: a laptop microphone is quiet, and without it normal
          // speech can sit below any sensible threshold. Noise suppression off:
          // it eats the soft start of words, which is exactly the "Hey".
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 }
        });
      } catch (err) {
        log('wake: microphone unavailable - ' + (err.name || err.message));
        if (opts.onError) opts.onError(err);
        return false;
      }
      try {
        ctx = new AudioContext();
        rate = ctx.sampleRate;
        source = ctx.createMediaStreamSource(stream);
        node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = onAudio;
        source.connect(node);
        node.connect(ctx.destination);               // required for it to run; outputs silence
      } catch (err) {
        log('wake: could not start listening - ' + err.message);
        stop();
        return false;
      }
      armed = true;
      paused = false;
      var track = stream.getAudioTracks()[0];
      var set = track && track.getSettings ? track.getSettings() : {};
      log('wake word armed (' + rate + ' Hz, ' + ((track && track.label) || 'default microphone') + ')');
      diag('wake: microphone settings ' + JSON.stringify({
        agc: set.autoGainControl, echo: set.echoCancellation, noise: set.noiseSuppression,
        channels: set.channelCount, rate: set.sampleRate
      }));
      return true;
    }

    function stop() {
      armed = false;
      parts = null;
      pending = [];
      if (node) { try { node.disconnect(); node.onaudioprocess = null; } catch (e) {} }
      if (source) { try { source.disconnect(); } catch (e) {} }
      if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
      if (ctx) { try { ctx.close(); } catch (e) {} }
      node = source = stream = ctx = null;
      log('wake word disarmed');
    }

    /* Test seam: hand the listener an utterance directly, as if the microphone
     * had just finished collecting it. Everything after the microphone - the
     * transcription, the matching, the callbacks - is the real path. */
    function inject(samples, sampleRate) {
      var saved = rate;
      rate = sampleRate || rate;
      segN++;
      var seg = { id: segN, samples: samples, spoke: samples.length / rate * 1000, peak: 0, at: performance.now() };
      diag('wake #' + seg.id + ': injected ' + (samples.length / rate).toFixed(1) + 's');
      var run = working ? (pending.push(seg), Promise.resolve()) : process(seg);
      return Promise.resolve(run).then(function () { rate = saved; });
    }

    return {
      start: start,
      stop: stop,
      inject: inject,
      /* Push-to-talk and the wake word must never fight over the microphone,
       * and Nim must not hear itself talk. */
      pause: function () { paused = true; },
      resume: function () { paused = false; cooldownUntil = performance.now() + COOLDOWN_MS; },
      /* Nim has just answered: for the next few seconds, what you say next is
       * taken without the name - 'answer' after Nim asked you something,
       * 'conversation' otherwise (and then only if it is said to Nim). */
      expectFollowUp: function (ms, kind) {
        if (!armed) return false;
        awaitingUntil = performance.now() + (ms || 8000);
        awaitingFor = kind === 'answer' ? 'answer' : 'conversation';
        return true;
      },
      endFollowUp: function () { awaitingUntil = 0; },
      /* Learn how this voice says "Hey Nim": the next `count` utterances are
       * transcribed as wake checks are, collected, and handed to onDone -
       * nothing is acted on meanwhile. Gives up after `timeoutMs`. */
      enroll: function (o) {
        if (!armed) return false;
        awaitingUntil = 0;
        enrolling = { left: o.count || 3, samples: [], onSample: o.onSample, onDone: o.onDone,
                      until: performance.now() + (o.timeoutMs || 45000) };
        return true;
      },
      cancelEnroll: function () { enrolling = null; },
      get enrolling() { return !!enrolling; },
      get awaiting() { return awaitingUntil > performance.now() ? awaitingFor : null; },
      get armed() { return armed; },
      get paused() { return paused; },
      get threshold() { return threshold(); }
    };
  }

  createWake.wakeCommand = wakeCommand;       // exported so they can be tested
  createWake.wakeInSentences = wakeInSentences;
  createWake.nearWake = nearWake;
  createWake.classify = classify;
  createWake.decide = decide;
  createWake.stripWake = stripWake;
  createWake.requestLike = requestLike;
  createWake.droppedGreeting = droppedGreeting;
  createWake.conversational = conversational;
  createWake.HEAD_S = HEAD_S;
  global.createWake = createWake;
}(typeof window !== 'undefined' ? window : this));
