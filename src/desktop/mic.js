'use strict';
/*
 * Nim's ears, on the browser side.
 *
 * Records you, converts the audio into what Whisper wants, and hands back the
 * words. Nothing leaves the machine and nothing is kept.
 *
 * It is a three-state machine and it is deliberately strict about it:
 *
 *     idle -> listening -> transcribing -> idle
 *                \-------> idle (too short, or nothing heard)
 *       any state -> idle  (on error, always)
 *
 * The strictness is the point. A microphone that gets stuck in "listening"
 * because an event was missed is worse than one that does not work at all, so
 * every path out of listening and transcribing ends in idle, including the ones
 * that throw. There is a hard ceiling on the recording and another on the
 * transcription, so neither can run forever even if something below misbehaves.
 *
 * Browsers record Opus in a WebM container at whatever rate the device fancies.
 * Whisper wants raw 16 kHz mono PCM in a WAV. That conversion happens here,
 * rather than shelling out to a converter.
 */
(function (global) {
  'use strict';

  var MIN_MS = 350;          // shorter than this is a click or a cough
  var MAX_MS = 15000;        // a recording may never outlive this
  var SILENCE_MS = 1100;     // quiet this long after speech ends it, if enabled
  var SPEECH_RMS = 0.018;    // the least that counts as you, in a silent room
  var TRANSCRIBE_MS = 90000; // Whisper has this long before we give up on it

  /* ---- audio conversion --------------------------------------------------- */

  /* Average the samples falling in each output slot rather than picking every
   * nth one: same cost, without the aliasing that makes speech sound gritty. */
  function encodeWav16k(audioBuffer) {
    var srcRate = audioBuffer.sampleRate;
    var src = audioBuffer.getChannelData(0);
    var ratio = srcRate / 16000;
    var outLen = Math.max(1, Math.floor(src.length / ratio));
    var pcm = new Int16Array(outLen);

    for (var i = 0; i < outLen; i++) {
      var start = Math.floor(i * ratio);
      var end = Math.min(src.length, Math.floor((i + 1) * ratio));
      var sum = 0, n = 0;
      for (var j = start; j < end; j++) { sum += src[j]; n++; }
      var v = n ? sum / n : 0;
      v = v < -1 ? -1 : (v > 1 ? 1 : v);
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }

    var bytes = new Uint8Array(44 + pcm.length * 2);
    var dv = new DataView(bytes.buffer);
    function tag(off, s) {
      for (var k = 0; k < s.length; k++) dv.setUint8(off + k, s.charCodeAt(k));
    }
    tag(0, 'RIFF');  dv.setUint32(4, 36 + pcm.length * 2, true);
    tag(8, 'WAVE');
    tag(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);           // PCM
    dv.setUint16(22, 1, true);           // mono
    dv.setUint32(24, 16000, true);       // sample rate
    dv.setUint32(28, 16000 * 2, true);   // byte rate
    dv.setUint16(32, 2, true);           // block align
    dv.setUint16(34, 16, true);          // bits per sample
    tag(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(bytes.buffer, 44).set(pcm);
    return bytes;
  }

  function describe(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'I need permission to use the microphone. Open Windows Settings, ' +
             'go to Privacy and security, then Microphone, and turn on ' +
             'microphone access for desktop apps.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'I cannot find a microphone on this computer.';
    }
    if (name === 'NotReadableError') {
      return 'Something else is using the microphone right now.';
    }
    return 'The microphone did not work: ' + ((err && err.message) || name || 'unknown');
  }

  /**
   * createMic({ transcribe, onState, onLevel, onText, onError, autoStop })
   *   transcribe(wavBytes) -> Promise<string>
   *   onState('idle' | 'listening' | 'transcribing')
   *   onText(text)   - '' means nothing was heard
   *   autoStop       - stop on silence as well as on release (default true)
   */
  function createMic(opts) {
    opts = opts || {};
    var autoStop = opts.autoStop !== false;

    var state = 'idle';
    var stream = null, recorder = null, chunks = [];
    var ctx = null, analyser = null;
    var raf = 0, ceiling = 0;
    var heard = false, lastLoud = 0, startedAt = 0;
    var frame = new Uint8Array(256);

    function setState(next) {
      if (state === next) return;
      state = next;
      if (opts.onState) opts.onState(state);
    }

    function fail(message) {
      release();
      setState('idle');
      if (opts.onError) opts.onError(message);
    }

    /* Everything acquired in start() is given back here, and this is safe to
     * call twice - which matters, because the error paths all call it. */
    function release() {
      global.cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(ceiling);
      ceiling = 0;
      if (stream) {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* gone */ }
      }
      stream = null;
      if (ctx) { try { ctx.close(); } catch (e) { /* already closed */ } }
      ctx = null;
      analyser = null;
      recorder = null;
    }

    function level() {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(frame);
      var sum = 0;
      for (var i = 0; i < frame.length; i++) {
        var v = (frame[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / frame.length);
    }

    /* "Quiet" is relative to the room. With a video or music playing, the room
     * never drops below a fixed level, so a fixed threshold would never hear
     * you stop and every recording would run to its ceiling. The quiet level is
     * the 20th percentile of the last two seconds; you are a step above it. */
    var recent = [];
    function threshold() {
      if (recent.length < 20) return SPEECH_RMS;
      var sorted = recent.slice().sort(function (a, b) { return a - b; });
      var floor = sorted[Math.floor(sorted.length * 0.2)];
      return Math.max(SPEECH_RMS, floor * 1.8 + 0.006);
    }

    function watch() {
      if (state !== 'listening') return;
      var rms = level();
      if (opts.onLevel) opts.onLevel(Math.min(1, rms * 6));
      recent.push(rms);
      if (recent.length > 120) recent.shift();

      var now = performance.now();
      if (rms > threshold()) {
        heard = true;
        lastLoud = now;
      } else if (autoStop && heard && now - lastLoud > SILENCE_MS) {
        stop();
        return;
      }
      raf = global.requestAnimationFrame(watch);
    }

    /* Runs when the recorder has handed over its last chunk. From here on the
     * only job is to end in idle, whatever happens. */
    async function finish() {
      var captured = chunks.slice();
      var type = (recorder && recorder.mimeType) || 'audio/webm';
      var tooShort = performance.now() - startedAt < MIN_MS;
      release();

      if (tooShort || !captured.length) {
        setState('idle');
        if (opts.onText) opts.onText('');
        return;
      }

      setState('transcribing');
      var decodeCtx = null;
      try {
        var blob = new Blob(captured, { type: type });
        var raw = await blob.arrayBuffer();

        decodeCtx = new AudioContext();
        var audio = await decodeCtx.decodeAudioData(raw);

        if (audio.duration < MIN_MS / 1000) {
          setState('idle');
          if (opts.onText) opts.onText('');
          return;
        }

        var wav = encodeWav16k(audio);

        // Whisper is fast, but a wedged child process must not wedge Nim
        var text = await Promise.race([
          opts.transcribe(wav),
          new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error('transcription timed out')); }, TRANSCRIBE_MS);
          })
        ]);

        setState('idle');
        if (opts.onText) opts.onText(String(text == null ? '' : text).trim());
      } catch (err) {
        setState('idle');
        if (opts.onError) opts.onError('I could not make out the recording: ' + (err.message || err));
      } finally {
        if (decodeCtx) { try { decodeCtx.close(); } catch (e) { /* fine */ } }
        chunks = [];
      }
    }

    async function start() {
      // the guard against a second recording, and against recording while the
      // previous one is still being transcribed
      if (state !== 'idle') return false;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      } catch (err) {
        fail(describe(err));
        return false;
      }

      // the user may have let go while the permission prompt was up
      if (state !== 'idle') { release(); return false; }

      try {
        chunks = [];
        heard = false;
        recent = [];
        startedAt = performance.now();
        lastLoud = startedAt;

        ctx = new AudioContext();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);

        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = function (e) {
          if (e.data && e.data.size) chunks.push(e.data);
        };
        recorder.onstop = finish;
        recorder.onerror = function () { fail('The recording stopped unexpectedly.'); };
        recorder.start();
      } catch (err) {
        fail('I could not start recording: ' + (err.message || err));
        return false;
      }

      setState('listening');
      ceiling = setTimeout(stop, MAX_MS);     // never records forever
      watch();
      return true;
    }

    function stop() {
      if (state !== 'listening') return;
      global.cancelAnimationFrame(raf);
      clearTimeout(ceiling);

      // finish() runs from onstop, so the last chunk is in hand before decoding
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); return; } catch (e) { /* fall through */ }
      }
      finish();
    }

    /* Throw the recording away without transcribing it. */
    function cancel() {
      if (state === 'idle') return;
      if (recorder) recorder.onstop = null;
      release();
      chunks = [];
      setState('idle');
    }

    return {
      start: start,
      stop: stop,
      cancel: cancel,
      toggle: function () { return state === 'listening' ? stop() : start(); },
      get state() { return state; },
      get listening() { return state === 'listening'; },
      get busy() { return state !== 'idle'; }
    };
  }

  createMic.encodeWav16k = encodeWav16k;    // exported so it can be tested
  global.createMic = createMic;
}(typeof window !== 'undefined' ? window : this));
