'use strict';
/*
 * Feeling the music.
 *
 * While Windows says something is playing, this listens to the computer's own
 * sound output - not the microphone - and turns it into a few numbers every
 * frame: how loud, how much bass, and a beat count that ticks on every hit.
 * Nothing is recorded, transcribed or kept; the numbers move the creature and
 * are gone.
 *
 * It also decides whether what is playing is a song at all. Measured on real
 * songs and real recorded speech: a song's sound is continuous - instruments
 * carry on under and between the words - while talking keeps dropping away
 * between words and phrases. Over the last six seconds, a song spends under a
 * fifth of its time far (18 dB) below its own loud level; talking spends a third
 * to a half there. So Nim dances to songs and stays still through a video of
 * someone talking. (A steady-beat test was tried first: real pop songs, mellow
 * ones especially, scored no better than speech.)
 */
(function (global) {
  'use strict';

  var BANDS = 24;                  // loudness bands, 30 Hz to 12 kHz, evenly on a log scale
  var LOW_BANDS = 7;               // the lowest seven: under ~135 Hz, the kick and bass
  var FLOOR_DB = -100;             // quieter than this is nothing
  var GRID_MS = 20;                // everything below is judged 50 times a second, whatever the frame rate
  var REF_MS = 30;                 // a hit: louder than 30 ms before
  var WINDOW = 300;                // six seconds of history...
  var ENOUGH = 150;                // ...of which three are needed before deciding,
  var ENOUGH_IF_SONG = 70;         // or under a second and a half when the title already says "song"
  var SILENT_TICKS = 20;           // 0.4 s of near silence: the song has stopped
  var DROP_DB = 18;                // "far below its own loud level"
  var MAX_DIPS = 0.2;              // a song is down there under a fifth of the time
  var QUIET_DB = -75;              // and it has to be playing loud enough to hear
  var MIN_GAP_MS = 250;            // hits closer than this are one hit
  var ONSET_LAG_MS = 32;           // how late an onset shows up: the analyser window, then the tick it is counted in
  var SONG_DIPS = 0.3;             // a little more room when the title says it is a song

  /* What Windows says is playing, from its title, artist and length - a hint;
   * the sound decides the rest. An ad sounds just like a song (it usually has
   * one under it), so anything shorter than a song, or titled as an ad, is
   * ruled out. Loud game audio under a streamer's voice can sound as
   * continuous as a song too, so "stream", "podcast", "gameplay" and the like
   * rule it out; "Official Video", "Lyrics", "feat.", a VEVO or "- Topic"
   * channel, or a music app make a song likely. */
  var AD_WORDS = /^\s*(ad|ads|advert|advertisement)\s*$|\b(advertisement|sponsored|promoted|skip\s+ad|ad\s+\d+\s+of\s+\d+)\b/i;
  var SHORTEST_SONG = 75;          // seconds: ads, shorts and jingles are shorter
  var SONG_WORDS = /vevo\b|\(official\)|\b(official\s+(music\s+)?(video|audio)|lyrics?|music\s+video|video\s+song|full\s+song|audio\s+song|ft\.|feat\.?|remix|mashup|cover|acoustic|slowed|reverb|lo-?fi|instrumental|karaoke|unplugged|topic|records|music)\b/i;
  var TALK_WORDS = /\b(live\s*stream|stream(ing)?|podcast|episode|ep\.?\s*\d+|interview|gameplay|walkthrough|let'?s\s+play|vlog|reacts?|reaction|review|tutorial|news|lecture|explained|highlights|ranked|talk\s+show|audiobook|chapter\s+\d+|webinar)\b/i;
  // matches, trailers and films: only ever videos - a track in a music app
  // called "We Are the Champions" is still a song
  var VIDEO_WORDS = /\b(vs|versus|tournament|championships?|champions|group\s+stage|qualifiers?|grand\s+finals?|esports|scrims?|full\s+match|trailer|teaser|full\s+movie|unboxing|documentary|commentary)\b/i;
  var MUSIC_APPS = /^(spotify|media player)$/i;
  // a video in a web browser - YouTube and the like, where anything can play
  var BROWSERS = /^(brave|chrome|edge|firefox|opera|vivaldi|arc|youtube)$/i;

  function isBrowser(app) { return BROWSERS.test(String(app || '')); }

  function kindOf(media) {
    if (!media) return '';
    var text = (media.title || '') + ' ' + (media.artist || '');
    if (AD_WORDS.test(media.title || '') || AD_WORDS.test(media.artist || '')) return 'ad';
    if (media.length > 0 && media.length < SHORTEST_SONG) return 'ad';
    if (SONG_WORDS.test(text)) return 'song';
    if (TALK_WORDS.test(text)) return 'talk';
    if (MUSIC_APPS.test(media.app || '')) return 'song';
    if (VIDEO_WORDS.test(text)) return 'talk';
    return '';
  }

  /* What to dance by. In a music app the sound decides, as above. A video in a
   * browser has to show it is a song first: a match with commentary, a film,
   * a vlog with music under it sound as continuous as any song (an esports
   * final danced to all evening). So its title or channel has to say song, or
   * its lyrics have to be found, or the model on this PC has to call it music
   * from its title - and then the sound still has to agree. Not shown to be a
   * song: 'video', and no dance.
   *   ev.lyrics  timed lyrics were found for it
   *   ev.check   the local model's verdict: true, false, or null (not asked or no answer) */
  function danceKind(media, ev) {
    var kind = kindOf(media);
    if (kind) return kind;
    if (ev && ev.lyrics) return 'song';
    if (!isBrowser(media && media.app)) return '';
    if (ev && ev.check === true) return '';
    return 'video';
  }

  /* The decision: the sound has to be continuous and loud enough, whatever the
   * title; a title or a length that says it is not a song rules it out. */
  function isSong(f, kind) {
    if (!f || kind === 'talk' || kind === 'ad' || kind === 'video' || f.silent || !(f.loud > QUIET_DB) || f.dips === undefined) return false;
    if (f.heard < (kind === 'song' ? ENOUGH_IF_SONG : ENOUGH)) return false;
    // a quick early call has to be a clear one; the looser song allowance comes with more listening
    return f.dips < (kind === 'song' && f.heard >= ENOUGH ? SONG_DIPS : MAX_DIPS);
  }

  /* Acting the words out: what a sung line asks Nim to do. English, Hindi
   * (both scripts) and Korean. One line can ask for more than one thing. */
  var ACTS = [
    ['love',  /\b(love|lover|heart|kiss|darling|pyaa?r|ishq|mohabbat|dil)\b|प्यार|इश्क|दिल|사랑/i],
    ['dance', /\b(dance|dancing|move|groove|nacho|naach|nachna)\b|नाच|춤/i],
    ['jump',  /\b(jump|high|higher|up|fly|flying|sky)\b|उड़|आसमान|하늘/i],
    ['fire',  /\b(fire|burn|burning|hot|flame|aag)\b|आग|불/i],
    ['cry',   /\b(cry|crying|tears?|aansu|rona)\b|आँसू|रो|눈물/i],
    ['night', /\b(night|moon|stars?|dream|dreams|raat|chand|chaand|taare)\b|रात|चाँद|तारे|밤|달|별|꿈/i],
    ['shine', /\b(sun|sunshine|shine|light|bright|gold|golden|glow)\b|धूप|रोशनी|빛|햇살/i],
    ['crazy', /\b(crazy|wild|dizzy|insane|pagal|deewana|diwana)\b|पागल|दीवाना|미쳐/i],
    ['money', /\b(money|rich|cash|dollar|paisa|bling)\b|पैसा|돈/i],
    ['hey',   /^\s*(hey|yeah|oh|ooh|whoa|woo|la la|na na|aye)\b/i],
    ['happy', /\b(smile|smiling|happy|laugh|laughing|joy|khush|muskura)\b|मुस्कुरा|खुश|웃어|행복/i],
    ['bye',   /\b(bye|goodbye|farewell|alvida)\b|अलविदा|안녕/i]
  ];

  function actsFor(text) {
    var out = [];
    for (var i = 0; i < ACTS.length; i++) if (ACTS[i][1].test(String(text || ''))) out.push(ACTS[i][0]);
    return out;
  }

  /* The main lines of a song: the ones that come round again - the hook, the
   * chorus. A song that hardly repeats itself gets every other line instead.
   * lines: [{ t, text }] -> [true/false] for each. */
  function hookLines(lines) {
    var norm = function (t) { return String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim(); };
    var count = {};
    (lines || []).forEach(function (l) { var k = norm(l.text); if (k) count[k] = (count[k] || 0) + 1; });
    var marks = (lines || []).map(function (l) { var k = norm(l.text); return !!k && count[k] >= 2; });
    var hooks = marks.filter(Boolean).length;
    if (hooks >= 3) return marks;
    var n = 0;
    return (lines || []).map(function (l) { return !!norm(l.text) && n++ % 2 === 0; });
  }

  // 3 dB an octave up from 1 kHz (music thins out up there); flat below
  var TILT = (function () {
    var e = [], t = [];
    for (var k = 0; k <= 24; k++) e.push(30 * Math.pow(400, k / 24));
    for (var i = 0; i < 24; i++) t.push(Math.max(0, 3 * Math.log2(Math.sqrt(e[i] * e[i + 1]) / 1000)));
    return t;
  }());

  /* Lining the lyrics up with the singing, as karaoke tools do. Given what was
   * heard - the rise in the singing range at each moment of the song's own
   * clock - and when each line is meant to start, it tries every shift from
   * two and a half seconds early to two and a half late and keeps the one
   * where the line starts fall where the voice comes back after a breath. Returns { shift, sure } (seconds; how clearly
   * that shift beats the rest), or null with too little heard to say.
   *   heard: [{ t, v }] (song seconds, onset strength), lines: [{ t, text }] */
  function alignLyrics(heard, lines) {
    if (!heard || heard.length < 600) return null;                 // ten seconds of frames at least
    var t0 = heard[0].t, t1 = heard[heard.length - 1].t;
    // the onset strength on a 50 ms grid of song time
    var STEP = 0.05, n = Math.floor((t1 - t0) / STEP) + 1, grid = new Array(n).fill(null);
    heard.forEach(function (h) { var i = Math.round((h.t - t0) / STEP); if (i >= 0 && i < n) grid[i] = grid[i] === null ? h.v : Math.max(grid[i], h.v); });
    for (var g = 0; g < n; g++) if (grid[g] === null) grid[g] = g ? grid[g - 1] : (heard[0].v || 0);
    var mean = 0, sd = 0;
    for (var i = 0; i < n; i++) mean += grid[i];
    mean /= n;
    for (var j = 0; j < n; j++) sd += (grid[j] - mean) * (grid[j] - mean);
    sd = Math.sqrt(sd / n) || 1;
    // a line starts where the voice comes back after a breath: louder in the
    // half second after than in the half second before
    var avg = function (from, to) {
      var a = Math.max(0, Math.round((from - t0) / STEP)), b = Math.min(n - 1, Math.round((to - t0) / STEP)), sum = 0, c = 0;
      for (var k = a; k <= b; k++) { sum += grid[k]; c++; }
      return c ? sum / c : null;
    };
    var near = function (t) {
      if (t - 0.6 < t0 || t + 0.6 > t1) return null;
      var after = avg(t + 0.05, t + 0.55), before = avg(t - 0.6, t - 0.1);
      return after === null || before === null ? null : (after - before) / sd;
    };
    var starts = (lines || []).filter(function (l, idx, all) {
      // a line that starts after a pause is a clear start; skip empty lines
      return l.text && (idx === 0 || l.t - all[idx - 1].t > 1.2);
    }).map(function (l) { return l.t; });
    var scores = [], best = -Infinity, bestShift = 0;
    // within two and a half seconds: further, one line's start meets the next's
    for (var d = -2.5; d <= 2.501; d += 0.1) {
      var sum = 0, used = 0;
      starts.forEach(function (s) {
        var z = near(s + d);
        if (z !== null) { sum += z; used++; }
      });
      if (used < 5) { scores.push(null); continue; }
      var sc = sum / used - Math.abs(d) * 0.08;      // the smaller shift, when it is a close call
      scores.push(sc);
      if (sc > best) { best = sc; bestShift = Math.round(d * 10) / 10; }
    }
    var ok = scores.filter(function (x) { return x !== null; });
    if (ok.length < 15) return null;
    var m2 = ok.reduce(function (a, b) { return a + b; }, 0) / ok.length;
    var s2 = Math.sqrt(ok.reduce(function (a, b) { return a + (b - m2) * (b - m2); }, 0) / ok.length) || 1;
    // how far the best stands out; and how the shift-zero (as found) does against it
    return { shift: bestShift, sure: (best - m2) / s2, asFound: scores[25] === null ? null : (scores[25] - m2) / s2 };
  }

  function bandEdges() {
    var e = [];
    for (var k = 0; k <= BANDS; k++) e.push(30 * Math.pow(400, k / BANDS));
    return e;
  }

  /* The analyser's spectrum (dB per bin) -> the 24 bands (dB, mean power). */
  function bandsFrom(db, sampleRate, fftSize, out) {
    var edges = bandEdges(), hz = sampleRate / fftSize, n = db.length;
    out = out || new Array(BANDS);
    for (var k = 0; k < BANDS; k++) {
      var a = Math.max(1, Math.floor(edges[k] / hz));
      var b = Math.max(a, Math.min(n - 1, Math.floor(edges[k + 1] / hz)));
      var p = 0;
      for (var i = a; i <= b; i++) p += Math.pow(10, Math.max(-140, db[i]) / 10);
      out[k] = 10 * Math.log10(p / (b - a + 1) + 1e-14);
    }
    return out;
  }

  function powerSum(bands, from, to) {
    var p = 0;
    for (var i = from; i < to; i++) p += Math.pow(10, Math.max(FLOOR_DB, bands[i]) / 10);
    return 10 * Math.log10(p + 1e-14);
  }

  function quantile(list, q) {
    var s = list.slice().sort(function (x, y) { return x - y; });
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  }

  /* Pure: fed the bands of each frame with its time, it answers every frame.
   * No audio APIs, so it is tested directly (test/music.test.js). */
  function createBeatTracker() {
    var frames = [];                      // the last ~100 ms of frames
    var levels = [], lows = [], flux = [];
    var nextTick = -1, ticks = 0;
    var beat = 0, lastBeat = -Infinity, hits = [];
    var energy = 0, bass = 0, slow = 0, drops = 0, dropAt = -Infinity, lastNow = -1;
    // the beat grid: onset strength per tick, and where the beats fall
    var onsets = [], kicks = [];        // kicks: 1 where the bass jumped like a drum hit
    var vocal = 0;                       // the latest rise in the singing range (300 Hz - 3.4 kHz)
    var grid = { period: 0, beatAt: 0, sure: 0, pending: 0, pendingCount: 0 };
    var top = [], bottom = [], level01 = [];          // the ring's reference level (top[0]), and each band on it
    for (var k = 0; k < BANDS; k++) { top.push(FLOOR_DB); bottom.push(0); level01.push(0); }
    var view = { loud: FLOOR_DB, lowFrom: FLOOR_DB, lowTo: FLOOR_DB + 6, dips: 1, musical: false };

    /* The beat length, from the gaps between recent hits: the most common gap,
     * folded into 0.33-0.9 s so the dance is never frantic or sluggish. */
    function period() {
      var gaps = [];
      for (var i = 1; i < hits.length; i++) {
        var g = hits[i] - hits[i - 1];
        if (g >= 280 && g <= 1100) gaps.push(g);
      }
      if (gaps.length < 3) return 0;
      var p = quantile(gaps, 0.5);
      while (p < 330) p *= 2;
      while (p > 900) p /= 2;
      return p;
    }

    function frameAt(t) {
      var f = frames[0];
      for (var i = 0; i < frames.length && frames[i].t <= t; i++) f = frames[i];
      return f;
    }

    function judge() {
      if (levels.length < ENOUGH_IF_SONG) { view.musical = false; view.dips = 1; return; }
      var loud = quantile(levels, 0.9);
      var dips = 0;
      for (var i = 0; i < levels.length; i++) if (levels[i] < loud - DROP_DB) dips++;
      view.loud = loud;
      view.dips = dips / levels.length;
      view.lowFrom = quantile(lows, 0.1);
      view.lowTo = Math.max(view.lowFrom + 6, quantile(lows, 0.95));
      view.musical = levels.length >= ENOUGH && loud > QUIET_DB && view.dips < MAX_DIPS;
    }

    // the music has stopped: the last moments are all far below how loud it was
    function silentNow() {
      if (levels.length < SILENT_TICKS) return false;
      var floor = Math.max(QUIET_DB, view.loud - 28);
      for (var i = levels.length - SILENT_TICKS; i < levels.length; i++) if (levels[i] > floor) return false;
      return true;
    }

    // a hit: the rise peaks well above what the last two seconds usually do
    function lookForHit(t) {
      var n = flux.length;
      if (n < 3) return;
      var peak = flux[n - 2];
      if (!(peak >= flux[n - 3] && peak > flux[n - 1])) return;
      var from = Math.max(0, n - 100), sum = 0, sq = 0, c = 0;
      for (var i = from; i < n; i++) { sum += flux[i]; sq += flux[i] * flux[i]; c++; }
      var mean = sum / c, sd = Math.sqrt(Math.max(0, sq / c - mean * mean));
      if (peak > mean + 1.4 * sd && peak > 1 && t - GRID_MS - lastBeat > MIN_GAP_MS) {
        lastBeat = t - GRID_MS;
        beat++;
        hits.push(lastBeat);
        if (hits.length > 12) hits.shift();
      }
    }

    function tick(t) {
      var cur = frameAt(t), ref = frameAt(t - REF_MS);
      var rise = 0;
      for (var i = 0; i < BANDS; i++) rise += Math.max(0, Math.max(FLOOR_DB, cur.bands[i]) - Math.max(FLOOR_DB, ref.bands[i]));
      levels.push(powerSum(cur.bands, 0, BANDS));
      lows.push(powerSum(cur.bands, 0, LOW_BANDS));
      flux.push(rise / BANDS);
      // the beat grid listens mostly to the kick and the bass: the drums that
      // carry the beat, not the hi-hats and the singing between them
      var lowRise = 0;
      for (var j = 0; j < 9; j++) lowRise += Math.max(0, Math.max(FLOOR_DB, cur.bands[j]) - Math.max(FLOOR_DB, ref.bands[j]));
      onsets.push(lowRise / 9 + rise / BANDS * 0.5);
      var midRise = 0;
      for (var v = 9; v <= 18; v++) midRise += Math.max(0, Math.max(FLOOR_DB, cur.bands[v]) - Math.max(FLOOR_DB, ref.bands[v]));
      vocal = powerSum(cur.bands, 9, 19);         // the singing range, how loud (dB)
      void midRise;
      // a drum hit: the low end jumps 4 dB or more in 30 ms. Songs with drums do
      // this on 15-25 of every hundred steps; a guitar-and-voice ballad on 2-8.
      var lowNow = powerSum(cur.bands, 2, 9), lowThen = powerSum(ref.bands, 2, 9);
      kicks.push(lowNow - lowThen > 4 ? 1 : 0);
      if (kicks.length > WINDOW) kicks.shift();
      if (levels.length > WINDOW) { levels.shift(); lows.shift(); flux.shift(); }
      if (onsets.length > WINDOW) onsets.shift();
      lookForHit(t);
      if (++ticks % 12 === 0 || levels.length === ENOUGH_IF_SONG) judge();     // every quarter second
      if (ticks % 25 === 0 && onsets.length >= 150) findGrid(t);              // every half second
    }

    /* Where the beats fall, as music software finds them. First the tempo:
     * the last six seconds of onsets compared with themselves one beat later,
     * for every beat length from 0.3 s to 1 s, with a preference for ordinary
     * dancing tempos (around 120 BPM) so a half or double tempo does not win
     * by a whisker. Then the phase: a grid of beats at that tempo slid along
     * the same six seconds until it sits on the most onsets, the latest beats
     * counting most. The result is steady - one off-beat hi-hat cannot move it. */
    function findGrid(t) {
      var n = onsets.length, mean = 0, i, k;
      for (i = 0; i < n; i++) mean += onsets[i];
      mean /= n;
      var x = new Array(n), zero = 0;
      for (i = 0; i < n; i++) { x[i] = onsets[i] - mean; zero += x[i] * x[i]; }
      if (zero < 1e-6) return;
      var ac = [], best = -Infinity, bestLag = 0;
      for (var lag = 13; lag <= 52; lag++) {
        var sum = 0;
        for (k = lag; k < n; k++) sum += x[k] * x[k - lag];
        var prior = Math.exp(-0.5 * Math.pow(Math.log2(lag * GRID_MS / 500) / 0.9, 2));
        ac[lag] = sum / (n - lag) * prior;
        if (ac[lag] > best) { best = ac[lag]; bestLag = lag; }
      }
      // between two samples, where the peak really is
      var p = bestLag;
      if (ac[bestLag - 1] !== undefined && ac[bestLag + 1] !== undefined) {
        var y0 = ac[bestLag - 1], y1 = ac[bestLag], y2 = ac[bestLag + 1], den = y0 - 2 * y1 + y2;
        if (den < 0) p = bestLag + 0.5 * (y0 - y2) / den;
      }
      var sure = Math.max(0, best / (zero / n));

      // Steady, as DJ software keeps it. Twice or half the tempo already found
      // is the same beat heard differently (the hi-hats, or every other kick):
      // it is read as the tempo already found, not a new one.
      var period = p * GRID_MS;
      if (grid.period) {
        var options = [period, period * 2, period / 2, period * 1.5, period / 1.5];
        var nearest = options.reduce(function (m, o) { return Math.abs(o / grid.period - 1) < Math.abs(m / grid.period - 1) ? o : m; });
        if (Math.abs(nearest / grid.period - 1) < 0.06) period = nearest;
      }
      // a really new tempo has to be heard twice before it is believed
      if (grid.period && Math.abs(period / grid.period - 1) > 0.06) {
        if (grid.pending && Math.abs(period / grid.pending - 1) < 0.06) grid.pendingCount++;
        else { grid.pending = period; grid.pendingCount = 1; }
        if (grid.pendingCount < 2) period = grid.period;
      } else if (grid.period) period = grid.period * 0.85 + period * 0.15;
      var P = period / GRID_MS;

      // the phase: which offset from now puts a grid of beats on the onsets
      var at = function (pos) { var f = Math.floor(pos); return f < 0 || f + 1 >= n ? 0 : x[f] + (x[f + 1] - x[f]) * (pos - f); };
      var scoreAt = function (phi) {
        var score = 0, w = 1;
        for (var pos = n - 1 - phi; pos >= 0; pos -= P) { score += at(pos) * w; w *= 0.88; }
        return score;
      };
      var bestPhi = 0, bestScore = -Infinity, all = [];
      for (var phi = 0; phi < P; phi += 0.5) {
        var sc = scoreAt(phi);
        all.push(sc);
        if (sc > bestScore) { bestScore = sc; bestPhi = phi; }
      }
      // how clearly there is a beat at all: how far the best placing of the grid
      // stands out from all the others (a song with drums: far; none: hardly)
      var mean2 = 0, sd2 = 0;
      for (var q = 0; q < all.length; q++) mean2 += all[q];
      mean2 /= all.length;
      for (var q2 = 0; q2 < all.length; q2++) sd2 += (all[q2] - mean2) * (all[q2] - mean2);
      sd2 = Math.sqrt(sd2 / all.length);
      grid.clear = sd2 > 0 ? (bestScore - mean2) / sd2 : 0;
      // The phase, kept: where the beats already fall is checked first and only
      // fine-tuned. Moving the beat elsewhere - usually half a beat over, onto
      // the snare - needs the new place to be clearly better, twice running.
      if (grid.period && grid.beatAt) {
        var keepPhi = (((t - ONSET_LAG_MS - grid.beatAt) / GRID_MS) % P + P) % P;
        var tuned = keepPhi, tunedScore = -Infinity;
        for (var d = -2; d <= 2; d += 0.5) {
          var ph = ((keepPhi + d) % P + P) % P, v = scoreAt(ph);
          if (v > tunedScore) { tunedScore = v; tuned = ph; }
        }
        var gap = Math.abs(bestPhi - tuned);
        gap = Math.min(gap, P - gap);
        // half a beat over is the snare instead of the kick: just as much a beat,
        // and switching between them is what looks wrong - so almost never
        var half = Math.abs(gap - P / 2) < P * 0.15;
        var need = half ? 2.2 : 1.5, votes = half ? 4 : 3;
        if (gap > 2.5 && bestScore > tunedScore * need + 1e-9) {
          grid.moveVotes = (grid.moveVotes || 0) + 1;
          if (grid.moveVotes < votes) bestPhi = tuned;
        } else {
          grid.moveVotes = 0;
          bestPhi = tuned;
        }
      }
      // an onset is counted a tick after it starts: put the beat where it began
      grid.beatAt = t - bestPhi * GRID_MS - ONSET_LAG_MS;
      grid.period = period;
      grid.sure = sure;
    }

    function ease(v, to, dt, upMs, downMs) {
      return v + (to - v) * (1 - Math.exp(-dt / (to > v ? upMs : downMs)));
    }

    function push(bands, now) {
      frames.push({ t: now, bands: bands.slice(0, BANDS) });
      while (frames.length > 2 && now - frames[1].t > 100) frames.shift();
      if (nextTick < 0 || now - nextTick > 500) nextTick = now;   // first frame, or the window was asleep
      while (nextTick <= now) { tick(nextTick); nextTick += GRID_MS; }
      var dt = lastNow < 0 ? 16 : Math.min(100, Math.max(1, now - lastNow));
      lastNow = now;

      var level = levels.length ? levels[levels.length - 1] : FLOOR_DB;
      var low = lows.length ? lows[lows.length - 1] : FLOOR_DB;
      var e = Math.max(0, Math.min(1, (level - (view.loud - 24)) / 24));
      var b = Math.max(0, Math.min(1, (low - view.lowFrom) / (view.lowTo - view.lowFrom)));
      energy = ease(energy, e, dt, 25, 120);
      bass = ease(bass, b, dt, 20, 110);

      // a drop: the song comes back in hard after a quieter stretch
      slow = ease(slow, energy, dt, 4000, 4000);
      // (not in the first fifteen seconds, and twenty seconds apart: a drop is rare)
      if (view.musical && ticks * GRID_MS > 15000 && energy - slow > 0.3 && now - dropAt > 20000) { drops++; dropAt = now; }

      /* The spectrum the equaliser ring shows, done the way music visualisers
       * do it: every band on one shared scale (so quiet treble does not jump
       * as high as the bass), tilted up 3 dB an octave to make up for music
       * having less energy higher up, over a 42 dB window under the loudest
       * band of the last few seconds. */
      var peakNow = FLOOR_DB;
      for (var k = 0; k < BANDS; k++) {
        var x = Math.max(FLOOR_DB, bands[k]) + TILT[k];
        level01[k] = x;
        if (x > peakNow) peakNow = x;
      }
      top[0] = Math.max(peakNow, top[0] - dt * 0.004);     // the reference falls 4 dB a second
      for (var j = 0; j < BANDS; j++) level01[j] = Math.max(0, Math.min(1, (level01[j] - (top[0] - 42)) / 42));
      return {
        energy: energy,
        bass: bass,
        beat: beat,
        sinceBeat: now - lastBeat,
        period: grid.period || period(),
        // the beat grid: a beat fell at beatAt (ms, this clock), and every
        // beatPeriod either side of it; sure is how clearly the song beats
        beatAt: grid.beatAt,
        beatPeriod: grid.period,
        beatSure: grid.sure,
        beatClear: grid.clear || 0,
        // how much drums drive it right now, 0..1-ish (see where kicks are counted)
        vocal: vocal,
        drive: kicks.length >= 100 ? kicks.reduce(function (a, b) { return a + b; }, 0) / kicks.length : 0.2,
        at: now,
        drops: drops,
        bands: level01.slice(),
        musical: view.musical,
        continuity: Math.max(0, 1 - view.dips),
        dips: levels.length < ENOUGH_IF_SONG ? undefined : view.dips,
        heard: levels.length,
        silent: silentNow(),
        loud: view.loud
      };
    }

    return { push: push };
  }

  function createMusic(opts) {
    var stream = null, ctx = null, analyser = null, source = null;
    var spectrum = null, bands = null, raf = 0, running = false, tracker = null;
    var reported = 0, startedAt = 0, firstReport = false, stopped = false;

    /* Something new started playing: judge it afresh, so a song's last seconds
     * never carry the dance into whatever comes next (an ad, say). */
    function reset() {
      if (!running) return;
      tracker = createBeatTracker();
      startedAt = performance.now();
      firstReport = false;
    }

    function summary(f) {
      return 'music: loudness ' + Math.round(f.loud) + ' dB, ' + Math.round(f.continuity * 100) + '% continuous, ' +
        f.beat + ' hits' + (f.kind ? ', title says ' + f.kind : '') + (f.song ? ' - a song' : ' - not a song');
    }

    var lastLook = 0;
    function frame() {
      if (!running) return;
      var now = performance.now();
      // sixty looks a second is plenty, whatever the screen's refresh rate
      if (now - lastLook < 15) { raf = global.requestAnimationFrame(frame); return; }
      lastLook = now;
      analyser.getFloatFrequencyData(spectrum);
      var f = tracker.push(bandsFrom(spectrum, ctx.sampleRate, analyser.fftSize, bands), now);
      f.kind = opts.kind ? opts.kind() : '';
      f.song = isSong(f, f.kind);
      // levels only - one line once it has had time to judge, then with diagnostics on
      if (!firstReport && now - startedAt > 15000) {
        firstReport = true;
        reported = now;
        if (opts.onLog) opts.onLog(summary(f));
      } else if (opts.onDiag && now - reported > 10000) {
        reported = now;
        opts.onDiag(summary(f));
      }
      if (opts.onFrame) opts.onFrame(f);
      raf = global.requestAnimationFrame(frame);
    }

    async function start() {
      if (running) return true;
      var got;
      try {
        // the computer's own sound; the screen picture that comes with it is
        // dropped straight away - only the sound is used
        got = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      } catch (err) {
        if (opts.onLog) opts.onLog('music: cannot hear the computer\'s sound - ' + (err.name || err.message));
        return false;
      }
      // the song stopped while Windows was still handing the sound over
      if (stopped) { got.getTracks().forEach(function (t) { t.stop(); }); return false; }
      stream = got;
      stream.getVideoTracks().forEach(function (t) { t.stop(); });
      if (!stream.getAudioTracks().length) {
        if (opts.onLog) opts.onLog('music: no sound came with it');
        stop();
        return false;
      }
      ctx = new AudioContext();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;       // hits are changes; smoothing hides them
      source.connect(analyser);                 // analysed only: never played back
      spectrum = new Float32Array(analyser.frequencyBinCount);
      bands = new Array(BANDS);
      tracker = createBeatTracker();
      startedAt = performance.now();
      running = true;
      raf = global.requestAnimationFrame(frame);
      if (opts.onLog) opts.onLog('music: listening for the beat');
      return true;
    }

    function stop() {
      stopped = true;
      running = false;
      global.cancelAnimationFrame(raf);
      if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* gone */ } }
      if (ctx) { try { ctx.close(); } catch (e) { /* closed */ } }
      stream = ctx = analyser = source = null;
      if (opts.onFrame) opts.onFrame(null);
    }

    return { start: start, stop: stop, reset: reset, get running() { return running; } };
  }

  var api = {
    createMusic: createMusic, createBeatTracker: createBeatTracker, bandsFrom: bandsFrom, bandEdges: bandEdges,
    kindOf: kindOf, isSong: isSong, danceKind: danceKind, isBrowser: isBrowser,
    actsFor: actsFor, hookLines: hookLines, alignLyrics: alignLyrics, BANDS: BANDS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.createMusic = createMusic;
  global.NimMusic = api;
}(typeof window !== 'undefined' ? window : this));
