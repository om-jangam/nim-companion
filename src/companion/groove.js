/*
 * Nim's dance - everything it does while a song plays, and nothing else.
 *
 * Fed the music every frame (music.js: loudness, bass, a count of hits, the
 * beat length, drops and 24 bands), it keeps its own beat clock locked to the
 * hits and dances on it - to this song, not to songs in general:
 *
 *   style       each song is sized up as it plays - its tempo, how loud and
 *               how bassy it runs - as chill, groove or hype, and gets moves
 *               to match: a slow ballad sways, a party track bounces and
 *               headbangs. The same song always gets the same choreography.
 *   mood        what the song feels like (romantic, sad, party, happy, chill,
 *               angry, epic - read by Qwen on this computer from its title and
 *               lyrics) sets the dance, the eyes and the colours: a love song
 *               sways with hearts, a party track bounces in neon shades
 *   the words   a sung line can be acted out: "love" brings heart eyes and
 *               floating hearts, "jump" a jump, "fire" flames, "moon" a moon,
 *               "dance" a spin, "cry" glossy eyes
 *   hook step   every song gets a signature routine of eight poses - steps,
 *               dips, a pop, a lean, a turn - made up for it once and then
 *               danced every time its hook comes round (the lines it repeats,
 *               or, without lyrics, its loudest stretches), as a real hook
 *               step is
 *   sections    when the song changes - a quiet verse, a build, the chorus
 *               coming in - the move changes with it: a breakdown slows to a
 *               sway, a build shimmies, a drop jumps
 *   moves       bounce, sway, nod, shimmy, headbang and a full spin
 *   drops       when a song comes back in hard: a big jump and a burst
 *   headphones  slide on when the song starts and lift off when it ends
 *   equaliser   a ring of bars around the body, moving with the music -
 *               bass at the bottom, treble at the top
 *   eyes        happy, a wink on the beat, stars on a drop, hearts in a soft
 *               song, closed in a breakdown, squeezed shut headbanging
 *   in time     the beat clock starts on the song's first hit and is pulled
 *               onto every hit after; the body pumps with the kick drum the
 *               moment it lands; it stops the moment the music does
 *   colour      its rim, the ring and the light on its head shift with the song
 *
 * Pure drawing and arithmetic: nim.js asks for the pose and calls the draw
 * functions at the right moment, inside its own frame.
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  /* The moves, by how the song goes. Besides the classics: a two-step, the
   * floss, snapping into a pose on every beat, leaning back and vibing, and a
   * jelly wobble. */
  var MOVES = {
    chill:  ['sway', 'vibe', 'nod', 'jelly', 'sway'],
    groove: ['nod', 'bounce', 'twostep', 'snap', 'shimmy', 'sway', 'jelly'],
    hype:   ['bounce', 'headbang', 'floss', 'snap', 'twostep', 'shimmy']
  };

  /* Its eyes, by how the song goes: glyph faces (nim.js FACES), a new one
   * every bar, and on the big moments. */
  var EYES = {
    chill:  ['^^', '-_-', '..', '33', 'uu', 'music', 'flower', '.u.', '^w^', 'big'],
    groove: ['^^', '++', '+=', '-+', 'oo', 'music', '**', 'owo', '^w^', '..', '==', 'big'],
    hype:   ['xx', '><', '**', '$$', 'stars', '@@', '++', 'OO', '>_<', '+=']
  };

  /* The face for the moment: each mood has a calm one, a middle one and an
   * intense one, picked by how hard that part of the song is going. Its
   * words come first - a line about love gets the hearts. */
  var MOOD_FACES = {
    romantic: ['^^', '.u.', '<3'],
    sad:      ['-_-', '..', 'TT'],
    happy:    ['^^', '^w^', 'big'],
    party:    ['^^', 'stars', '$$'],
    chill:    ['-_-', '^^', '33'],
    angry:    ['-_-', '><', 'xx'],
    epic:     ['OO', 'stars', '**']
  };
  var STYLE_MOOD = { chill: 'chill', groove: 'happy', hype: 'party' };

  /* A look for each song: its colours run along one of these, not round the
   * whole rainbow. Hues, end to end. */
  var THEMES = [
    [300, 265, 190],        // vaporwave: pink, purple, cyan
    [25, 340, 285],         // sunset: orange, pink, violet
    [150, 185, 225],        // aurora: green, teal, blue
    [330, 45, 160],         // candy: pink, lemon, mint
    [0, 120, 240, 360]      // neon: all of it
  ];
  var BARS_PER_MOVE = { chill: 16, groove: 8, hype: 8 };

  // the mood of the song, when it is known, decides more than the sound can
  var MOOD_STYLE = { romantic: 'chill', sad: 'chill', chill: 'chill', happy: 'groove', party: 'hype', angry: 'hype', epic: 'hype' };
  var MOOD_EYES = {
    romantic: ['<3', '^^', 'flower', '.u.', '^w^', '<3', 'big', '33'],
    sad:      ['TT', '-_-', '..', 'uu', '-_-'],
    chill:    ['-_-', '^^', 'flower', 'music', '..', '33', '.u.'],
    happy:    ['^^', '^w^', 'owo', 'music', 'stars', '++', 'big', '+='],
    party:    ['$$', 'stars', '**', 'xx', '><', 'OO', '++', '-+'],
    angry:    ['><', 'xx', '-_-', '>_<', '=='],
    epic:     ['stars', '**', 'OO', '++', 'xx', '@@']
  };
  var MOOD_THEME = {
    romantic: [330, 350, 20],      // pink to rose to peach
    sad:      [200, 225, 255],     // blues
    chill:    [300, 265, 190],     // vaporwave
    happy:    [330, 45, 160],      // candy
    party:    [0, 120, 240, 360],  // neon
    angry:    [355, 15, 330],      // reds
    epic:     [45, 25, 280]        // gold to violet
  };

  // a small seeded random, so a song's choreography is its own and repeatable
  function seeded(text) {
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return function () { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
  }
  var SIDE = 22;             // equaliser bars on each side of the ring
  var BARS = SIDE;           // one level per band shown; both sides mirror it

  /* The beat as heard arrives late: the sound is captured after it is played,
   * a hit is only certain once it has peaked, and the frame takes a moment to
   * reach the screen. The beat clock runs this far ahead to make up for it. */
  var LATENCY = 0.10;        // seconds

  /* Hook-step poses: where the body is and how it leans on that beat. */
  var POSES = {
    center: {},
    stepL:  { dx: -0.13, tilt: -0.09 },
    stepR:  { dx: 0.13, tilt: 0.09 },
    dipL:   { dx: -0.05, tilt: -0.13, dip: 0.08 },
    dipR:   { dx: 0.05, tilt: 0.13, dip: 0.08 },
    leanL:  { dx: -0.04, tilt: -0.17 },
    leanR:  { dx: 0.04, tilt: 0.17 },
    crouch: { dip: 0.12 },
    pop:    { pop: true },
    shake:  { shake: true },
    turn:   { turn: true }
  };
  var MIRROR = { stepL: 'stepR', stepR: 'stepL', dipL: 'dipR', dipR: 'dipL', leanL: 'leanR', leanR: 'leanL' };

  /* A routine of eight, in the shape most hook steps have: a move, its mirror,
   * again, then a flourish and a finish. */
  function makeRoutine(rand) {
    var pick = function (list) { return list[Math.floor(rand() * list.length)]; };
    var a = pick(['stepL', 'dipL', 'leanL']), b = MIRROR[a];
    var flourish = pick(['pop', 'shake', 'crouch', 'leanR']);
    var finish = pick(['turn', 'pop', 'shake']);
    return [a, b, a, b, flourish, MIRROR[flourish] || 'center', 'crouch', finish];
  }

  function createGroove() {
    var on = 0;                    // 0..1: how much it is dancing, eased
    var music = null;              // the latest frame, while a song plays
    var energy = 0, bass = 0;
    var phase = 0, wholeBeat = 0, lastHits = -1, lastDrops = -1;
    var move = 'nod', moveFrom = 0, spinFrom = -99, lastSpin = -99;
    var pose = { dx: 0, up: 0, tilt: 0, sx: 1, sy: 1, faceDx: 0, faceW: 1, faceShow: 1 };
    var target = { dx: 0, tilt: 0, dip: 0, faceDx: 0, faceW: 1, faceShow: 1 };
    var hop = 0, hopV = 0, hopG = 0, hopAir = 1, land = 0, kick = 0, bigLand = false;
    // each bar: its height, how fast it is falling, and a cap that lingers at its peak
    var levels = [], fall = [], peaks = [], hold = [];
    for (var i = 0; i < BARS; i++) { levels.push(0); fall.push(0); peaks.push(0); hold.push(0); }
    var bits = [], twinkles = [];
    var songMood = '';
    var drive = 0.2, flow = false;           // drums driving it; flowing instead of beating when there are none
    var lineFace = null, lineFaceUntil = -1; // a face the words asked for, until this beat
    var routine = ['stepL', 'stepR', 'stepL', 'stepR', 'pop', 'center', 'crouch', 'turn'];
    var hookFrom = 0, hookOn = null;        // null: no lyrics to say where the hook is
    var theme = THEMES[0];
    var eyes = { style: 'happy', side: 1, until: -1 };
    var aligned = false;                   // the beat clock has met the song's first beat grid
    var gridSeen = 0, jumpVotes = 0;       // the last grid followed; how many in a row said "move"
    var hue = 0, clock = 0, wear = 0;
    // what this song is like, learned as it plays
    var track = '', rand = Math.random, style = 'groove';
    var songEnergy = 0.5, songBass = 0.5, songPeriod = 500, heard = 0;
    var fastE = 0.5, slowE = 0.5, section = 'steady', sectionAt = -99;

    function newSong(key) {
      track = key || '';
      rand = track ? seeded(track) : Math.random;
      heard = 0; songEnergy = 0.5; songBass = 0.5; songPeriod = 500;
      style = 'groove'; section = 'steady'; sectionAt = -99;
      hue = Math.floor(rand() * 360);
      theme = THEMES[Math.floor(rand() * THEMES.length)];
      songMood = '';
      routine = makeRoutine(rand);
      hookOn = null;
      drive = 0.2; flow = false; lineFace = null; lineFaceUntil = -1;
      phase = 0; wholeBeat = 0; moveFrom = 0; aligned = false;
      eyes = { style: 'happy', side: 1, until: -1 };
    }

    /* A hue from the song's theme: 0..1 runs from one end of it to the other,
     * and back. */
    function themeHue(t) {
      var x = Math.abs(((t % 2) + 2) % 2 - 1) * (theme.length - 1);
      var i = Math.min(theme.length - 2, Math.floor(x)), f = x - i;
      var a = theme[i], b = theme[i + 1];
      var d = ((b - a + 540) % 360) - 180;
      if (theme.length > 3) d = b - a;            // neon goes the long way round
      return ((a + d * f) % 360 + 360) % 360;
    }

    function twinkle(count) {
      for (var i = 0; i < count; i++) {
        var a = Math.random() * TAU, r = 1.35 + Math.random() * 0.6;
        twinkles.push({ x: Math.cos(a) * r * 1.1, y: Math.sin(a) * r * 0.85 - 0.25, age: 0,
                        life: 0.7 + Math.random() * 0.5, size: 0.06 + Math.random() * 0.06,
                        hue: themeHue(Math.random()), spin: Math.random() * TAU });
      }
      if (twinkles.length > 24) twinkles.splice(0, twinkles.length - 24);
    }

    /* The dance's moments, as glyph faces. */
    var AS_FACE = {
      happy: '^^', open: 'oo', closed: '-_-', squint: '><', stars: 'stars', sparkle: '**', hearts: '<3',
      glossy: 'big', dizzy: '@@', cross: 'xx', flame: '>_<', moon: '-_-', note: 'music', uwu: 'uu',
      dots: '..', shades: 'OO', bolt: '**', diamond: '$$', wink: ';)'
    };

    function setEyes(style, beats, side) {
      style = AS_FACE[style] || style;
      eyes = { style: style, side: side || 1, until: wholeBeat + beats };
    }

    function sizeUp() {
      var calm = songPeriod > 640 || songEnergy < 0.42;
      var hard = songEnergy > 0.62 && songBass > 0.45 && songPeriod < 600;
      style = calm ? 'chill' : hard ? 'hype' : 'groove';
      if (songMood) {
        style = MOOD_STYLE[songMood];
        // a "chill" song that is plainly pounding still gets to move
        if (style === 'chill' && songEnergy > 0.68 && songPeriod < 560) style = 'groove';
      }
    }

    function setMood(m) {
      if (!m || m === songMood || !MOOD_STYLE[m]) return;
      songMood = m;
      theme = MOOD_THEME[m];
      sizeUp();
    }

    // hearts floating up off it
    function hearts(n) {
      for (var i = 0; i < n; i++) {
        var side = Math.random() < 0.5 ? -1 : 1;
        bits.push({ kind: 'heart', x: side * (0.6 + Math.random() * 0.6), y: -0.4 - Math.random() * 0.4,
                    vx: side * (0.05 + Math.random() * 0.1), vy: -(0.35 + Math.random() * 0.25), life: 1.8, age: 0,
                    hue: 330 + Math.random() * 30, r: 0.07 + Math.random() * 0.05, wob: Math.random() * TAU });
      }
    }

    /* The hook: true while one of its lines is sung, false between, null when
     * there are no lyrics (then the song's loudest stretches stand in). */
    function setHook(on) {
      hookOn = on;
      var want = !flow && (on === null ? section === 'chorus' : on);
      if (want && move !== 'hook') { move = 'hook'; hookFrom = wholeBeat + 1; moveFrom = hookFrom; }
      else if (!want && move === 'hook') chooseMove(wholeBeat + 1);
    }

    /* Acting out a sung line (see actsFor in music.js). */
    /* Acting out a line waits for the next beat, so nothing happens between beats. */
    var pendingActs = [], pendingDrop = false;
    function act(name) {
      if (on < 0.3) return;
      if (pendingActs.length < 2) pendingActs.push(name);
    }

    function actNow(name) {
      switch (name) {
        case 'love': lineFace = '<3'; lineFaceUntil = wholeBeat + 8; setEyes('<3', 4); hearts(5); break;
        case 'dance':
          if (move !== 'spin' && wholeBeat - lastSpin >= 8) { move = 'spin'; spinFrom = wholeBeat + 1; lastSpin = spinFrom; moveFrom = spinFrom; }
          break;
        case 'jump': if (!flow) jump(0.2, 0.42, true); break;
        case 'fire': lineFace = '><'; lineFaceUntil = wholeBeat + 8; setEyes('><', 4); if (!flow) burst(14, 1.8); break;
        case 'cry': lineFace = 'TT'; lineFaceUntil = wholeBeat + 8; setEyes('TT', 4); break;
        case 'night': lineFace = '-_-'; lineFaceUntil = wholeBeat + 8; setEyes('-_-', 4); break;
        case 'shine': lineFace = 'stars'; lineFaceUntil = wholeBeat + 8; setEyes('stars', 4); twinkle(8); break;
        case 'crazy': lineFace = '@@'; lineFaceUntil = wholeBeat + 6; setEyes('@@', 4); break;
        case 'money': lineFace = '$$'; lineFaceUntil = wholeBeat + 8; setEyes('$$', 4); break;
        case 'happy': lineFace = '^w^'; lineFaceUntil = wholeBeat + 8; setEyes('^w^', 4); break;
        case 'hey': if (!flow) jump(0.07, 0.22, false); break;
        case 'bye': setEyes('wink', 2, 1); break;
      }
    }

    function jump(height, air, big) {
      if (hop > height * 0.35) return;
      hopV = 4 * height / air;
      hopG = 8 * height / (air * air);
      hopAir = air;
      bigLand = !!big;
    }

    function burst(n, power) {
      for (var i = 0; i < n; i++) {
        // from all round its edge, flying outward and a little up
        var a = Math.random() * TAU;
        var sp = power * (0.7 + Math.random() * 0.6);
        bits.push({ x: Math.cos(a) * 1.15, y: Math.sin(a) * 1.08, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - power * 0.4,
                    life: 0.9 + Math.random() * 0.4, age: 0, hue: themeHue(Math.random()), r: 0.025 + Math.random() * 0.03 });
      }
      if (bits.length > 60) bits.splice(0, bits.length - 60);
    }

    function chooseMove(beat) {
      moveFrom = beat;
      if (flow) { move = 'flow'; return; }
      // the song's own shape first: a breakdown sways, a build shimmies
      if (section === 'breakdown') { move = 'sway'; return; }
      if (section === 'build') { move = 'shimmy'; return; }
      var pool = MOVES[style];
      // a spin now and then when there is some life in it
      if (style !== 'chill' && beat - lastSpin >= 24 && rand() < 0.4) {
        move = 'spin'; spinFrom = beat; lastSpin = beat;
        return;
      }
      var next = move;
      for (var tries = 0; tries < 6 && next === move; tries++) next = pool[Math.floor(rand() * pool.length)];
      move = next;
    }

    // every whole beat
    function onBeat(n) {
      kick = flow ? 0.25 : Math.min(1, 0.55 + bass * 0.5);     // flowing: a breath, not a hit
      // what was waiting for the beat happens now, on it
      if (pendingDrop) { pendingDrop = false; jump(0.24, 0.5, true); burst(26, 2.4); kick = 1; setEyes('open', 6); }
      while (pendingActs.length) actNow(pendingActs.shift());
      hue = (hue + 23) % 360;
      if (move !== 'hook' && (n - moveFrom >= BARS_PER_MOVE[style] || (n === sectionAt && move !== 'spin'))) chooseMove(n);
      if (move === 'hook') {
        var key = routine[((n - hookFrom) % 8 + 8) % 8];
        if (key === 'pop') jump(0.13 + energy * 0.04, 0.3, false);
        if (key === 'turn') jump(0.06, 0.24, false);
      }
      if (move === 'bounce' && !flow) jump(0.05 + energy * 0.06 + bass * 0.04, style === 'hype' ? 0.24 : 0.28, false);
      if (move === 'headbang' && n % 2 === 0) jump(0.04 + bass * 0.03, 0.18, false);
      if (move === 'spin' && n === spinFrom) jump(0.10, 0.34, false);
      if (move === 'spin' && n === spinFrom + 2) setEyes('happy', 2);
      if (move === 'spin' && n >= spinFrom + 2) chooseMove(n);
      if (move === 'twostep' || move === 'floss') jump(0.03 + energy * 0.03, 0.2, false);

      // sparkles pop around it, more when the song is going; a love song breathes hearts
      twinkle(style === 'hype' ? 2 : 1);
      if (songMood === 'romantic' && n % 4 === 0) hearts(1);

      // the face: what the words ask for, else the song's mood at this moment's
      // intensity - checked every bar, changed only when it should be
      if (n >= eyes.until) {
        var face;
        if (lineFace && n < lineFaceUntil) face = lineFace;
        else {
          var faces = MOOD_FACES[songMood] || MOOD_FACES[STYLE_MOOD[style]] || MOOD_FACES.happy;
          var tier = flow || section === 'breakdown' || fastE < songEnergy - 0.08 ? 0
                   : (move === 'hook' || section === 'chorus' || fastE > songEnergy + 0.08) ? 2 : 1;
          face = faces[tier];
          // now and then a wink, in the songs that suit one
          if (tier === 1 && n % 16 === 12 && /romantic|happy|party/.test(songMood || STYLE_MOOD[style])) face = ';)';
        }
        setEyes(face, 4);
      }
    }

    /* The pose of the current move at this point in the beat. `b` is the beat
     * clock: whole numbers fall on the beats. */
    function moveTarget(b) {
      var s = Math.sin(Math.PI * b);              // +1 / -1 on alternate half beats
      var onBeatDip = Math.pow(Math.abs(Math.cos(Math.PI * b)), 3);   // 1 on the beat, 0 between
      var t = { dx: 0, tilt: 0, dip: 0, faceDx: 0, faceW: 1, faceShow: 1 };
      // bigger moves when the song is going hard, small ones when it is quiet
      var amt = ((style === 'chill' ? 0.7 : 0.55) + energy * (style === 'hype' ? 0.8 : 0.55)) * (songMood === 'sad' ? 0.7 : 1);
      switch (move) {
        case 'sway':
          t.dx = s * 0.15 * amt; t.tilt = s * 0.11 * amt; t.dip = onBeatDip * 0.03;
          break;
        case 'nod':
          t.dip = onBeatDip * 0.07 * amt; t.tilt = s * 0.04; t.faceDx = s * 0.04;
          break;
        case 'bounce':
          t.tilt = s * 0.05 * amt; t.dx = s * 0.04;
          break;
        case 'shimmy':
          var w = Math.sin(TAU * 2 * b);
          t.tilt = w * 0.07 * amt; t.dx = w * 0.05 * amt; t.dip = onBeatDip * 0.03;
          break;
        case 'headbang':
          t.dip = Math.pow(Math.abs(Math.cos(TAU * b)), 4) * 0.08 * amt; t.tilt = s * 0.03;
          break;
        case 'twostep':
          // a step to one side on a beat, back on the next, landing light
          var step = Math.floor(b) % 2 ? 1 : -1, into = smooth(0, 0.35, b % 1);
          t.dx = step * (1 - 2 * (1 - into)) * 0.10 * amt; t.tilt = step * 0.06 * into; t.dip = onBeatDip * 0.03;
          break;
        case 'floss':
          // the body one way, the head the other, twice a beat
          var fl = Math.sin(TAU * 2 * b);
          t.dx = fl * 0.09 * amt; t.tilt = -fl * 0.10 * amt; t.faceDx = fl * 0.06;
          break;
        case 'snap':
          // snaps into a pose on every beat and holds it
          var poses = [[-0.13, -0.06], [0.12, 0.05], [0, 0], [0.08, -0.04]];
          var pz = poses[Math.floor(b) % poses.length], snapIn = smooth(0, 0.12, b % 1);
          var pv = poses[(Math.floor(b) + poses.length - 1) % poses.length];
          t.tilt = (pv[0] + (pz[0] - pv[0]) * snapIn) * amt * 1.2;
          t.dx = (pv[1] + (pz[1] - pv[1]) * snapIn) * amt;
          t.dip = (1 - snapIn) * 0.04;
          break;
        case 'vibe':
          // leaned back, eyes shut, a slow nod: lost in it
          t.tilt = 0.07 + s * 0.03; t.dip = onBeatDip * 0.04 * amt; t.faceDx = 0.03;
          break;
        case 'jelly':
          // a wobble that runs through the whole body
          var jw = Math.sin(TAU * 2 * b) * Math.exp(-(b % 1) * 2.5);
          t.dip = -jw * 0.05 * amt; t.tilt = jw * 0.03;
          break;
        case 'flow':
          // no beat to keep: a slow, smooth sway that breathes with the music
          var fl = Math.sin(clock * TAU / 3.4), fl2 = Math.sin(clock * TAU / 1.7 + 0.6);
          t.dx = fl * 0.08 * (0.6 + energy * 0.6); t.tilt = fl * 0.07 * (0.6 + energy * 0.6);
          t.dip = (fl2 * 0.5 + 0.5) * 0.025 * energy;
          break;
        case 'hook':
          var at = b - hookFrom, k = ((Math.floor(at) % 8) + 8) % 8, frac = at - Math.floor(at);
          var cur = POSES[routine[k]] || {}, was = POSES[routine[(k + 7) % 8]] || {};
          var into = smooth(0, 0.18, frac);           // snap into the pose, then hold it
          t.dx = ((was.dx || 0) + ((cur.dx || 0) - (was.dx || 0)) * into) * amt * 1.1;
          t.tilt = ((was.tilt || 0) + ((cur.tilt || 0) - (was.tilt || 0)) * into) * amt * 1.1;
          t.dip = ((was.dip || 0) + ((cur.dip || 0) - (was.dip || 0)) * into) * amt + onBeatDip * 0.02;
          if (cur.shake) { var sh = Math.sin(TAU * 4 * b); t.tilt += sh * 0.07; t.dx += sh * 0.03; }
          if (cur.turn) {
            var tt = easeInOut(frac), th2 = tt * TAU;
            t.faceDx = Math.sin(th2) * 0.62;
            t.faceW = Math.max(0.15, Math.abs(Math.cos(th2)));
            t.faceShow = smooth(-0.05, 0.3, Math.cos(th2));
          }
          break;
        case 'spin':
          // it turns all the way round in two beats: the face slides off one
          // side, it shows its back for a moment, the face comes round the other
          var p = easeInOut(clamp((b - spinFrom) / 2, 0, 1));
          var th = p * TAU;
          t.faceDx = Math.sin(th) * 0.62;
          t.faceW = Math.max(0.15, Math.abs(Math.cos(th)));
          t.faceShow = smooth(-0.05, 0.3, Math.cos(th));
          break;
      }
      return t;
    }

    function update(dt) {
      clock += dt;
      // in quickly when a song starts, out quickly when it stops
      on += ((music ? 1 : 0) - on) * Math.min(1, dt * (music ? 4 : 6));
      wear += ((music ? 1 : 0) - wear) * Math.min(1, dt * (music ? 3 : 4));
      if (on < 0.002 && !music) { on = 0; }

      if (music) {
        if ((music.track || '') !== track) newSong(music.track);
        if (music.mood) setMood(music.mood);
        // no drums (a ballad's guitar-and-voice verse): flow with it, do not beat
        drive += ((music.drive === undefined ? 0.2 : music.drive) - drive) * Math.min(1, dt / 1.5);
        if (!flow && drive < 0.10 && heard > 4) { flow = true; if (move !== 'flow') { move = 'flow'; moveFrom = wholeBeat; } }
        else if (flow && drive > 0.13) { flow = false; chooseMove(wholeBeat + 1); }
        energy += (music.energy - energy) * Math.min(1, dt * 3);
        bass = music.bass;
        var per = music.period > 0 ? music.period : 500;

        // sizing the song up: its usual loudness, bass and tempo
        heard += dt;
        var learn = Math.min(1, dt / Math.min(12, 2 + heard));
        songEnergy += (music.energy - songEnergy) * learn;
        songBass += (music.bass - songBass) * learn;
        if (music.period > 0) songPeriod += (music.period - songPeriod) * learn;
        sizeUp();
        // sections: the last two seconds against the last ten
        fastE += (music.energy - fastE) * Math.min(1, dt / 2);
        slowE += (music.energy - slowE) * Math.min(1, dt / 10);
        var was = section;
        if (heard > 8) {
          if (fastE < slowE - 0.16) section = 'breakdown';
          else if (fastE > slowE + 0.12 && fastE < songEnergy + 0.05) section = 'build';
          else if (fastE > songEnergy + 0.08 && heard > 20) section = 'chorus';
          else if (Math.abs(fastE - slowE) < 0.06) section = 'steady';
        }
        if (section !== was) {
          sectionAt = wholeBeat + 1;
          if (hookOn === null) setHook(null);
        }
        phase += dt * 1000 / per;
        // The beat clock follows the beat grid music.js finds (tempo and where
        // the beats fall, from the last six seconds), running LATENCY ahead of
        // it so a move lands on the beat you hear rather than the one Nim heard.
        // It is eased onto the grid, never jerked; a sudden big change has to be
        // confirmed by the next estimate before it is followed.
        if (music.beatPeriod > 0 && music.beatAt) {
          per = music.beatPeriod;
          var gridPhase = (music.at - music.beatAt) / per + LATENCY * 1000 / per;
          var err = (phase - gridPhase) - Math.round(phase - gridPhase);     // -0.5 .. 0.5 of a beat
          if (music.beatAt !== gridSeen) {
            gridSeen = music.beatAt;
            jumpVotes = Math.abs(err) > 0.22 ? jumpVotes + 1 : 0;
          }
          if (!aligned) {
            // the first grid of a song sets the clock outright: the next beat is on it
            phase = wholeBeat + ((gridPhase % 1) + 1) % 1;
            aligned = true;
          } else if (Math.abs(err) <= 0.22 || jumpVotes >= 2) {
            // taken up gently: no beat is squeezed or stretched by more than a
            // tenth, so a correction is felt as nothing at all
            var step = err * Math.min(1, dt * 6), most = dt * 0.15 * 1000 / per;   // at most a tenth of a beat per beat
            phase -= Math.max(-most, Math.min(most, step));
          }
        }
        if (music.beat !== lastHits) lastHits = music.beat;
        if (music.drops !== lastDrops) {
          if (lastDrops !== -1 && on > 0.5) pendingDrop = true;     // it lands on the next beat
          lastDrops = music.drops;
        }
        var whole = Math.floor(phase);
        if (whole > wholeBeat) { wholeBeat = whole; onBeat(whole); }
        // the ring, as music visualisers move: a bar shoots up to its band at
        // once and falls back under gravity; its cap waits at the peak a moment,
        // then drops. Bands 2..23: the two lowest share one analyser bin.
        var bands = music.bands || [];
        for (var i = 0; i < BARS; i++) {
          var v = clamp(bands[2 + i] || 0, 0, 1);
          v = v * v * (3 - 2 * v);                           // a little contrast
          if (v >= levels[i]) { levels[i] += (v - levels[i]) * Math.min(1, dt * 35); fall[i] = 0; }
          else { fall[i] += dt * 3.2; levels[i] = Math.max(v, levels[i] - fall[i] * dt); }
          if (levels[i] >= peaks[i]) { peaks[i] = levels[i]; hold[i] = 0.35; }
          else if ((hold[i] -= dt) < 0) peaks[i] = Math.max(levels[i], peaks[i] - dt * 0.8);
        }
      } else {
        for (var j = 0; j < BARS; j++) { levels[j] = Math.max(0, levels[j] - dt * 3); peaks[j] = Math.max(0, peaks[j] - dt * 2); }
        energy *= Math.max(0, 1 - dt * 2);
      }

      kick = Math.max(0, kick - dt * 3.2);
      land = Math.max(0, land - dt * 6);
      if (hop > 0 || hopV > 0) {
        hopV -= hopG * dt;
        hop += hopV * dt;
        if (hop <= 0) {
          hop = 0; hopV = 0; land = 1;
          if (bigLand) { burst(16, 1.6); bigLand = false; }
        }
      }

      var t = music ? moveTarget(phase) : { dx: 0, tilt: 0, dip: 0, faceDx: 0, faceW: 1, faceShow: 1 };
      var follow = Math.min(1, dt * (move === 'spin' ? 30 : 10));
      ['dx', 'tilt', 'dip', 'faceDx', 'faceW', 'faceShow'].forEach(function (key) { target[key] += (t[key] - target[key]) * follow; });

      // 1 at take-off, 0 at the top of the jump
      var rise = hopV > 0 && hopG > 0 ? clamp(hopV / (hopG * hopAir / 2), 0, 1) : 0;
      pose.dx = target.dx * on;
      pose.up = (hop - target.dip) * on;
      pose.tilt = target.tilt * on;
      // the body pumps with the kick drum, frame by frame
      // on the beat clock, not the bass as heard (which comes late): a squash
      // that lands exactly on each beat and lets go over the next third of it
      var since = phase - Math.floor(phase);
      var pump = music && aligned && !flow ? Math.pow(1 - smooth(0, 0.35, since), 2) * (0.5 + songBass * 0.5) * (style === 'chill' ? 0.025 : 0.05) : 0;
      pose.sx = 1 + (land * 0.08 + target.dip * 0.6 - rise * 0.04 + pump) * on;
      pose.sy = 1 - (land * 0.07 + target.dip * 0.5 - rise * 0.06 + pump * 0.8) * on;
      pose.faceDx = target.faceDx * on;
      pose.faceW = 1 + (target.faceW - 1) * on;
      pose.faceShow = 1 + (target.faceShow - 1) * on;

      for (var y = twinkles.length - 1; y >= 0; y--) {
        twinkles[y].age += dt;
        if (twinkles[y].age > twinkles[y].life) twinkles.splice(y, 1);
      }
      for (var z = bits.length - 1; z >= 0; z--) {
        var bt = bits[z];
        bt.age += dt;
        if (bt.kind === 'heart') bt.vx += Math.cos(bt.age * 3 + bt.wob) * dt * 0.3;
        else bt.vy += 3.2 * dt;
        bt.x += bt.vx * dt; bt.y += bt.vy * dt;
        if (bt.age > bt.life) bits.splice(z, 1);
      }
    }

    /* ---- drawing: everything in units of R around the body ----------------- */


    /* The equaliser: a true circle round it, bars evenly spaced and mirrored
     * left and right - bass at the bottom, treble at the top, a gap at the top
     * for the light on its head. It stays upright while the body dances, and
     * swells a touch on every beat of the beat clock (which runs ahead to
     * make up for hearing the music late). */
    function drawRing(ctx, rig) {
      if (on < 0.02) return;
      var R = rig.U, b = rig.body;
      var r0 = R * 1.34 * (1 + kick * 0.035 * on);
      var spread = 0.76 * Math.PI;                        // from beside the bottom to beside the top
      var step = spread / SIDE, width = Math.max(2, r0 * step * 0.52);
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.lineCap = 'round';
      for (var i = 0; i < SIDE; i++) {
        var t = (i + 0.5) / SIDE;
        var len = R * (0.03 + 0.38 * levels[i]) * on, cap = R * (0.03 + 0.38 * peaks[i]) * on;
        var h = themeHue(t * 0.8 + clock * 0.05);
        var light = 55 + levels[i] * 15 + kick * 8;
        for (var side = -1; side <= 1; side += 2) {
          var a = Math.PI / 2 - side * (0.16 * Math.PI + t * spread);
          var ux = Math.cos(a), uy = Math.sin(a);
          ctx.strokeStyle = 'hsla(' + h.toFixed(0) + ',95%,' + light.toFixed(0) + '%,' + (0.95 * on).toFixed(3) + ')';
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(ux * r0, uy * r0);
          ctx.lineTo(ux * (r0 + len), uy * (r0 + len));
          ctx.stroke();
          // the cap at the peak
          if (peaks[i] > 0.04) {
            var rc = r0 + cap + width * 1.1;
            ctx.fillStyle = 'hsla(' + h.toFixed(0) + ',100%,82%,' + (0.9 * on).toFixed(3) + ')';
            ctx.beginPath();
            ctx.arc(ux * rc, uy * rc, width * 0.42, 0, TAU);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    /* Headphones: a band over the top of the head and a cup on each side. */
    function drawHeadphones(ctx, rig, pal) {
      if (wear < 0.02) return;
      var R = rig.U, b = rig.body;
      var lift = (1 - wear) * R * 0.6;
      ctx.save();
      ctx.globalAlpha = clamp(wear * 1.4, 0, 1);
      ctx.translate(b.x, b.y - lift);
      ctx.rotate(rig.tilt);
      ctx.scale(rig.sx, rig.sy);
      var shell = 'hsl(' + pal.hue + ',22%,13%)', edge = 'hsla(' + pal.hue + ',40%,70%,0.55)';
      var accent = 'hsl(' + ((hue + 200) % 360).toFixed(0) + ',95%,62%)';

      // the band
      ctx.lineCap = 'round';
      ctx.strokeStyle = shell;
      ctx.lineWidth = R * 0.085;
      ctx.beginPath();
      ctx.moveTo(-R * 0.96, -R * 0.22);
      ctx.quadraticCurveTo(0, -R * 2.05, R * 0.96, -R * 0.22);
      ctx.stroke();
      ctx.strokeStyle = edge;
      ctx.lineWidth = Math.max(1, R * 0.018);
      ctx.beginPath();
      ctx.moveTo(-R * 0.93, -R * 0.26);
      ctx.quadraticCurveTo(0, -R * 2.09, R * 0.93, -R * 0.26);
      ctx.stroke();

      // the cups, pulsing a little with the beat
      [-1, 1].forEach(function (side) {
        var w = R * 0.24, h = R * 0.44 * (1 + kick * 0.04), x = side * R * 1.0 - w / 2, y = -R * 0.26;
        var r = w * 0.45;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.fillStyle = shell;
        ctx.fill();
        ctx.strokeStyle = edge;
        ctx.lineWidth = Math.max(1, R * 0.02);
        ctx.stroke();
        // the light on the cup
        ctx.fillStyle = accent;
        ctx.globalAlpha = clamp(wear * 1.4, 0, 1) * (0.55 + kick * 0.45);
        ctx.beginPath();
        ctx.arc(side * R * 1.0, y + h * 0.5, R * (0.045 + kick * 0.02), 0, TAU);
        ctx.fill();
        ctx.globalAlpha = clamp(wear * 1.4, 0, 1);
      });
      ctx.restore();
    }

    /* The burst from a drop. In front of everything. */
    function drawAir(ctx, rig) {
      var R = rig.U, b = rig.body;
      if (!bits.length && !twinkles.length) return;
      ctx.save();
      // twinkles: four-pointed sparkles that grow, turn and fade
      twinkles.forEach(function (tw) {
        var u = tw.age / tw.life, k = Math.sin(Math.PI * u);
        var r = R * tw.size * k, x = b.x + tw.x * R, y = b.y + tw.y * R;
        if (r < 0.5) return;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(tw.spin + u * 1.2);
        ctx.globalAlpha = on * Math.min(1, k * 1.4);
        ctx.fillStyle = 'hsl(' + tw.hue.toFixed(0) + ',100%,78%)';
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.quadraticCurveTo(r * 0.16, -r * 0.16, r, 0);
        ctx.quadraticCurveTo(r * 0.16, r * 0.16, 0, r);
        ctx.quadraticCurveTo(-r * 0.16, r * 0.16, -r, 0);
        ctx.quadraticCurveTo(-r * 0.16, -r * 0.16, 0, -r);
        ctx.fill();
        ctx.restore();
      });
      bits.forEach(function (bt) {
        var a = 1 - smooth(bt.life * 0.5, bt.life, bt.age);
        ctx.globalAlpha = a * Math.min(1, bt.age * 6);
        ctx.fillStyle = 'hsl(' + (bt.hue % 360).toFixed(0) + ',95%,' + (bt.kind === 'heart' ? 68 : 64) + '%)';
        var x = b.x + bt.x * R, y = b.y + bt.y * R, k = R * bt.r;
        ctx.beginPath();
        if (bt.kind === 'heart') {
          ctx.moveTo(x, y + k * 0.75);
          ctx.bezierCurveTo(x - k * 1.25, y - k * 0.05, x - k * 0.6, y - k * 1.05, x, y - k * 0.38);
          ctx.bezierCurveTo(x + k * 0.6, y - k * 1.05, x + k * 1.25, y - k * 0.05, x, y + k * 0.75);
        } else ctx.arc(x, y, k, 0, TAU);
        ctx.fill();
      });
      ctx.restore();
    }

    return {
      /* The latest from music.js, or null when the song stops. */
      feed: function (m) { music = m || null; if (!m) { lastHits = -1; lastDrops = -1; } },
      get style() { return style; },
      get move() { return move; },
      get section() { return section; },
      get flowing() { return flow; },
      /* What the eyes are doing on this beat: happy, wink (with a side), open,
       * stars, hearts, closed or squint. */
      eyes: function () { return eyes; },
      act: act,
      hook: setHook,
      get mood() { return songMood; },
      /* For trying the looks out: hold one until told otherwise. */
      showEyes: function (style, side) { eyes = style ? { style: style, side: side || 1, until: Infinity } : { style: 'happy', side: 1, until: -1 }; },
      update: update,
      pose: function () { return pose; },
      get amount() { return on; },
      get kick() { return kick; },
      get energy() { return energy; },
      /* The colour of the moment, for the rim and the light on its head. */
      hue: function () { return themeHue(clock * 0.06 + 0.4); },
      /* A colour from this song's theme, 0..1 along it. */
      themeHue: themeHue,
      drawRing: drawRing,
      drawHeadphones: drawHeadphones,
      drawAir: drawAir
    };
  }

  global.createGroove = createGroove;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createGroove: createGroove };
}(typeof window !== 'undefined' ? window : this));
