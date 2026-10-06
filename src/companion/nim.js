/*
 * Nim - a small creature that lives on your desktop.
 *
 * A body of dark glass that floats and breathes, two luminous eyes that follow
 * your cursor and blink on their own, and a little light above its head. No
 * mouth unless it is speaking.
 *
 * Calm by default: the body keeps its shape and stays upright, and only the
 * eyes turn toward you. Everything it feels is springs, so it never cuts from
 * one pose to another. The lively motion - dance moves on the beat,
 * headphones, an equaliser ring and notes (groove.js) - is kept for when a
 * song is playing.
 *
 * The wardrobe recolours its light rather than painting over the glass: pick
 * "rose" and the shell goes a deep maroon-black with rose eyes. The shell stays
 * dark whatever you choose, because that is the whole look.
 *
 * Needs wardrobe.js loaded first.
 *   var nim = createNim(canvas, { scale: 1 });
 *   nim.setState('thinking');
 *   nim.lookAt(x, y);
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

  function Spring(value, stiffness, damping) {
    this.v = value; this.target = value; this.vel = 0;
    this.k = stiffness === undefined ? 0.10 : stiffness;
    this.d = damping === undefined ? 0.76 : damping;
  }
  Spring.prototype.step = function (dt) {
    this.vel += (this.target - this.v) * this.k * dt;
    this.vel *= Math.pow(this.d, dt);
    this.v += this.vel * dt;
  };
  Spring.prototype.set = function (v) { this.v = v; this.target = v; this.vel = 0; };
  Spring.prototype.nudge = function (a) { this.vel += a; };

  /*  eyeOpen  eye height          eyeCurve  +1 arcs up (pleased), -1 down
   *  bob      how much it floats  squash    how much it breathes
   *  glow     brightness          antenna   how lively the head light is
   *  tilt     resting lean        lookGain  how far it turns toward you      */
  var MOODS = {
    sleep:     { eyeOpen: 0.03, eyeW: 1.00, eyeCurve:  0.00, bob: 0.30, squash: 0.03, glow: 0.22, antenna: 0.30, tilt:  0.06, lookGain: 0.00 },
    idle:      { eyeOpen: 1.00, eyeW: 1.00, eyeCurve:  0.00, bob: 1.00, squash: 0.04, glow: 0.70, antenna: 1.00, tilt:  0.00, lookGain: 1.00 },
    // the cursor is on it: a little brighter and more open, nothing sudden
    alert:     { eyeOpen: 1.12, eyeW: 1.03, eyeCurve:  0.00, bob: 1.00, squash: 0.04, glow: 0.85, antenna: 1.20, tilt:  0.00, lookGain: 1.00 },
    listening: { eyeOpen: 1.16, eyeW: 1.04, eyeCurve:  0.00, bob: 0.70, squash: 0.04, glow: 0.90, antenna: 1.30, tilt:  0.00, lookGain: 1.00 },
    thinking:  { eyeOpen: 0.50, eyeW: 0.96, eyeCurve:  0.00, bob: 0.60, squash: 0.03, glow: 0.78, antenna: 1.50, tilt: -0.04, lookGain: 0.20 },
    // eyes down a little and the light quick: it is mid-task
    working:   { eyeOpen: 0.70, eyeW: 0.98, eyeCurve:  0.00, bob: 0.80, squash: 0.04, glow: 0.92, antenna: 1.60, tilt: -0.03, lookGain: 0.40 },
    // eyes up and open, turned toward you: it has stopped and needs an answer
    waiting:   { eyeOpen: 1.18, eyeW: 1.04, eyeCurve:  0.00, bob: 0.60, squash: 0.03, glow: 0.88, antenna: 1.30, tilt:  0.03, lookGain: 1.10 },
    // light flaring: it has just sent something into the world
    reaching:  { eyeOpen: 1.06, eyeW: 1.02, eyeCurve:  0.00, bob: 1.00, squash: 0.05, glow: 1.00, antenna: 1.70, tilt: -0.03, lookGain: 0.40 },
    // eyes open: something has just come back to it
    receiving: { eyeOpen: 1.14, eyeW: 1.04, eyeCurve:  0.06, bob: 0.90, squash: 0.04, glow: 1.00, antenna: 1.50, tilt:  0.03, lookGain: 0.50 },
    // eyes narrowed, light quick: it is putting results together
    weaving:   { eyeOpen: 0.60, eyeW: 0.97, eyeCurve:  0.00, bob: 0.70, squash: 0.04, glow: 1.00, antenna: 1.70, tilt: -0.03, lookGain: 0.15 },
    // dim and low: something failed, and it is not hiding it
    error:     { eyeOpen: 0.58, eyeW: 0.95, eyeCurve: -0.65, bob: 0.35, squash: 0.03, glow: 0.35, antenna: 0.40, tilt:  0.06, lookGain: 0.30 },
    speaking:  { eyeOpen: 1.02, eyeW: 1.00, eyeCurve:  0.12, bob: 1.00, squash: 0.05, glow: 1.00, antenna: 1.20, tilt:  0.00, lookGain: 0.80 },
    happy:     { eyeOpen: 0.56, eyeW: 1.08, eyeCurve:  1.00, bob: 1.20, squash: 0.06, glow: 1.00, antenna: 1.40, tilt:  0.00, lookGain: 0.60 },
    // eyes closed in a smile, light lively: lost in a song
    dancing:   { eyeOpen: 0.60, eyeW: 1.06, eyeCurve:  0.85, bob: 0.60, squash: 0.04, glow: 1.00, antenna: 1.60, tilt:  0.00, lookGain: 0.20 },
    sad:       { eyeOpen: 0.64, eyeW: 0.97, eyeCurve: -0.60, bob: 0.45, squash: 0.03, glow: 0.40, antenna: 0.45, tilt:  0.05, lookGain: 0.40 },
    // calm and steady while you focus: eyes soft, hardly moving
    focus:     { eyeOpen: 0.72, eyeW: 0.98, eyeCurve:  0.00, bob: 0.35, squash: 0.02, glow: 0.60, antenna: 0.60, tilt:  0.00, lookGain: 0.15 },
    // something about the PC needs you: eyes wide, brows down
    worried:   { eyeOpen: 1.18, eyeW: 1.02, eyeCurve: -0.30, bob: 0.50, squash: 0.03, glow: 0.80, antenna: 1.40, tilt:  0.04, lookGain: 1.00 },
    // late at night: heavy-lidded and slow
    sleepy:    { eyeOpen: 0.42, eyeW: 1.00, eyeCurve:  0.00, bob: 0.40, squash: 0.03, glow: 0.45, antenna: 0.40, tilt:  0.04, lookGain: 0.40 }
  };

  var DEFAULT_OUTFIT = {
    skin: 'sky',
    hat: 'none',    hatColour: null,
    face: 'none',   faceColour: null,
    outfit: 'none', outfitColour: null,
    shoes: 'none',  shoesColour: null
  };

  /* The wardrobe stores colours as hex; the glass is built from hue, so the
   * chosen colour has to be read back out as one. */
  function hueOf(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return 192;
    var r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return 192;
    var h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }

  function createNim(canvas, options) {
    options = options || {};
    var WD = global.NIM_WARDROBE;
    if (!WD) throw new Error('wardrobe.js must be loaded before nim.js');

    var scale = options.scale || 1;
    var anchor = options.anchor || { x: 0.5, y: 0.47 };
    var ctx = canvas.getContext('2d');
    var outfit = Object.assign({}, DEFAULT_OUTFIT, options.outfit || {});

    var W = 1, H = 1, cx = 0, cy = 0, R = 1;
    function resize() {
      var dpr = Math.min(global.devicePixelRatio || 1, 2);
      var rect = canvas.getBoundingClientRect();
      var w = Math.round(rect.width || canvas.width);
      var h = Math.round(rect.height || canvas.height);

      // A box can be measured mid-layout, when it has collapsed to almost
      // nothing. Taking that reading would shrink the creature to a few pixels
      // and the canvas would simply stretch the result, so ignore it and keep
      // whatever was measured last.
      if (w < 40 || h < 40) return;

      W = w;
      H = h;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W * anchor.x;
      cy = H * anchor.y;
      R = Math.min(W, H) * 0.24 * scale;
    }

    var s = {
      eyeOpen:  new Spring(MOODS.sleep.eyeOpen, 0.20, 0.62),
      eyeW:     new Spring(MOODS.sleep.eyeW),
      eyeCurve: new Spring(0, 0.11, 0.74),
      bob:      new Spring(MOODS.sleep.bob),
      squash:   new Spring(MOODS.sleep.squash),
      glow:     new Spring(MOODS.sleep.glow),
      antenna:  new Spring(MOODS.sleep.antenna),
      tilt:     new Spring(MOODS.sleep.tilt, 0.08, 0.80),
      lookGain: new Spring(0),
      lookX:    new Spring(0, 0.14, 0.70),
      lookY:    new Spring(0, 0.14, 0.70),
      flash:    new Spring(0, 0.10, 0.82),
      wiggle:   new Spring(0, 0.16, 0.66)
    };

    var state = 'sleep';
    var clock = 0, breath = 0;
    var blink = 0, blinkAt = 3;
    var voice = 0;
    var target = null;
    var running = false, raf = 0, lastT = 0, lastDt = 0.016;
    var rig = null;
    var lastError = null;

    /* Dancing lives in groove.js: moves on the beat, headphones, the equaliser
     * ring, notes. Laid over whatever mood it is in, eased in and out so a song
     * starting or stopping never makes it jump. Without groove.js it just
     * doesn't dance. */
    var G = global.createGroove ? global.createGroove() : null;

    /* Little things it does on its own while idle, every ten seconds or so:
     * glances to one side and back, looks up curious, smiles to itself, gets a
     * bit sleepy. Eyes only - the body stays put. */
    var GESTURES = ['glance', 'curious', 'smile', 'glance', 'sleepy'];
    var gesture = null, gestureT = 0, gestureIn = 6 + Math.random() * 6;
    var gaze = { x: 0, y: 0, smile: 0, wide: 0 };

    /* The line of the song being sung, drawn above its head while it dances. */
    var lyricNow = null, lyricPrev = null, lyricAt = 0;

    /* Being looked after, and looking after you: a stretch, a yawn, a cookie,
     * a pat. Each is a short timed animation; bits are its little particles. */
    var act = null, actT = 0;                  // { kind: 'stretch' | 'yawn' | 'eat' | 'pet' }, seconds into it
    var bits = [];                             // hearts, crumbs, the cookie: { kind, x, y, vx, vy, age, life }
    var ACT_LEN = { stretch: 2.6, yawn: 2.0, eat: 2.4, pet: 1.8 };
    var visorText = 0, visorScroll = 0;      // how far the goggles are on; where the words are in them
    var prevScroll = 0;                      // where the line before was, as it slides away
    var shownLook = { style: 'happy', side: 1 }, prevLook = null, shownKey = '', lookAt = -10;
    var STILL = { dx: 0, up: 0, tilt: 0, sx: 1, sy: 1, faceDx: 0, faceW: 1, faceShow: 1 };
    function dancePose() { return G ? G.pose() : STILL; }
    function danceAmount() { return G ? G.amount : 0; }

    /* ---- palette --------------------------------------------------------- */

    function palette() {
      var skin = WD.byId(WD.SKINS, outfit.skin);
      var h = skin.top ? skin.top[0] : Math.round(hueOf(skin.base));
      return {
        hue: h,
        // the glass: lit from the top left, deep below, a sheen across, a glowing edge
        top: skin.top || [h, 60, 50], mid: skin.mid || [h, 50, 28], deep: skin.deep || [h, 50, 12],
        sheen: skin.sheen || [[h, 100, 70], [h, 100, 70], [h, 100, 70]],
        rims: skin.rim || [[h, 90, 70], [h, 90, 70], [h, 90, 70]],
        rim:   (skin.rim || [[h, 90, 62]])[1],
        eye:   skin.eye || [Math.round((h + 338) % 360), 100, 78],
        spark: [h, 100, 72],
        skin: skin.base, skinDark: skin.dark, skinGlow: skin.glow,
        cloth: WD.CLOTH.blue, clothId: 'blue'
      };
    }

    function hsl(c, a) { return 'hsla(' + c[0] + ',' + c[1] + '%,' + c[2] + '%,' + a + ')'; }

    function hsla(c, l, a) {
      return 'hsla(' + c[0] + ',' + c[1] + '%,' + (l === undefined ? c[2] : l) + '%,' + a + ')';
    }

    /* ---- the body -------------------------------------------------------- */

    /* An egg, narrower above and heavier below, with a slow organic wobble.
     * Squash and stretch are applied here so the whole creature deforms as one. */
    function bodyPath(bx, by, r, sx, sy, rot) {
      var N = 72;
      var jelly = danceAmount() * (0.5 + (G ? G.energy : 0));
      ctx.beginPath();
      for (var i = 0; i <= N; i++) {
        var a = (i / N) * TAU;
        // it holds its shape; only a song makes it go a little jelly
        var wob = 1 + (Math.sin(a * 3 + clock * 2.2) * 0.010
                    + Math.sin(a * 2 - clock * 1.7) * 0.008) * jelly;
        var x = Math.cos(a) * r * (1 + Math.sin(a) * 0.17) * wob * sx;
        var y = Math.sin(a) * r * 1.03 * wob * sy;
        var px = bx + x * Math.cos(rot) - y * Math.sin(rot);
        var py = by + x * Math.sin(rot) + y * Math.cos(rot);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }

    function buildRig() {
      // upright: only a mood's slight lean, a greeting wiggle, or a dance move
      var p = dancePose();
      var tilt = s.tilt.v + s.wiggle.v + p.tilt;
      var pulse = Math.sin(breath) * s.squash.v;
      var bx = cx + s.lookX.v * R * 0.03 + p.dx * R;
      var by = cy + Math.sin(breath) * R * 0.045 * s.bob.v - p.up * R;
      // a stretch: up tall and thin, hold, and settle back
      var stretch = act && act.kind === 'stretch' ? Math.sin(Math.PI * clamp(actT / ACT_LEN.stretch, 0, 1)) : 0;
      // eating: a little bob with each bite
      var chew = act && act.kind === 'eat' && actT > 0.6 ? Math.abs(Math.sin((actT - 0.6) * 9)) * 0.03 : 0;
      by -= stretch * R * 0.12;
      tilt += act && act.kind === 'pet' ? Math.sin(actT * 14) * 0.035 * (1 - actT / ACT_LEN.pet) : 0;

      var eyeR = R * 0.20 * s.eyeW.v;
      return {
        U: R, clock: clock, tilt: tilt, pose: p,
        sx: (1 + pulse * 0.5 + voice * 0.04 - stretch * 0.10 + chew) * p.sx,
        sy: (1 - pulse * 0.5 - voice * 0.04 + stretch * 0.16 - chew) * p.sy,
        body: { x: bx, y: by, r: R },
        head: { x: bx, y: by, r: R },
        torso: { x: bx, y: by + R * 0.46, hw: R * 0.72, hh: R * 0.40 },
        arms: [], legs: [],                      // it has neither; wearables skip them
        face: {
          x: bx + (s.lookX.v + gaze.x) * R * 0.17 * p.faceShow + p.faceDx * R,
          y: by,
          eyeY: by + (s.lookY.v + gaze.y) * R * 0.13 - R * 0.06,
          eyeDx: R * 0.34 * s.eyeW.v * p.faceW,
          eyeR: eyeR,
          show: p.faceShow
        }
      };
    }

    /* ---- parts ----------------------------------------------------------- */

    function drawShadow(pal) {
      var y = cy + R * 1.42, x = rig.body.x;
      // light, and smaller while Nim is in the air
      var lift = (Math.sin(breath) * 0.5 + 0.5) * s.bob.v * 0.5 + clamp(rig.pose.up / 0.15, 0, 1) * 0.6;
      var w = R * (0.90 - lift * 0.14);
      var g = ctx.createRadialGradient(x, y, 0, x, y, w);
      g.addColorStop(0, 'hsla(230,60%,4%,' + (0.30 - lift * 0.10).toFixed(3) + ')');
      g.addColorStop(1, 'hsla(230,60%,4%,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, w, w * 0.26, 0, 0, TAU);
      ctx.fill();
    }

    /* The body: glossy coloured glass. Lit from the top left and deep below,
     * a sheen of colour drifting slowly across it, light bouncing up inside
     * from beneath, a soft shine, and a glowing edge. */
    function drawGlass(pal) {
      var b = rig.body;
      bodyPath(b.x, b.y, R, rig.sx, rig.sy, rig.tilt);
      var g = ctx.createRadialGradient(
        b.x - R * 0.32, b.y - R * 0.5, R * 0.08, b.x + R * 0.1, b.y + R * 0.25, R * 1.35
      );
      g.addColorStop(0, hsl(pal.top, 0.98));
      g.addColorStop(0.55, hsl(pal.mid, 0.98));
      g.addColorStop(1, hsl(pal.deep, 0.99));
      ctx.fillStyle = g;
      ctx.fill();

      ctx.save();
      ctx.clip();
      var big = R * 2.2;
      // the sheen, drifting a little
      var drift = Math.sin(clock * 0.35) * R * 0.25;
      var sh = ctx.createLinearGradient(b.x - R + drift, b.y - R, b.x + R + drift, b.y + R * 0.4);
      sh.addColorStop(0, hsl(pal.sheen[0], 0.30));
      sh.addColorStop(0.5, hsl(pal.sheen[1], 0.16));
      sh.addColorStop(1, hsl(pal.sheen[2], 0));
      ctx.fillStyle = sh;
      ctx.fillRect(b.x - big, b.y - big, big * 2, big * 2);
      // light coming up from underneath, as through glass
      var lo = ctx.createRadialGradient(b.x, b.y + R * 1.05, R * 0.1, b.x, b.y + R * 1.05, R * 0.95);
      lo.addColorStop(0, hsl(pal.sheen[2], 0.30));
      lo.addColorStop(1, hsl(pal.sheen[2], 0));
      ctx.fillStyle = lo;
      ctx.fillRect(b.x - big, b.y - big, big * 2, big * 2);
      // the shine
      var hl = ctx.createRadialGradient(b.x - R * 0.42, b.y - R * 0.6, 0, b.x - R * 0.42, b.y - R * 0.6, R * 0.62);
      hl.addColorStop(0, 'rgba(255,255,255,0.36)');
      hl.addColorStop(0.45, 'rgba(255,255,255,0.10)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl;
      ctx.fillRect(b.x - big, b.y - big, big * 2, big * 2);
      ctx.restore();

      // the edge stops it reading as a hole cut in the screen; dancing, it
      // takes the colour of the moment and flashes on every beat
      var d = danceAmount();
      if (d > 0.05) {
        ctx.strokeStyle = 'hsla(' + G.hue().toFixed(0) + ',90%,' + (62 + G.kick * 22).toFixed(0) + '%,' + (0.35 + 0.45 * d).toFixed(3) + ')';
        ctx.lineWidth = Math.max(1.5, R * (0.018 + 0.016 * d));
      } else {
        var a = (0.35 + s.glow.v * 0.35).toFixed(3);
        var rg = ctx.createLinearGradient(b.x - R, b.y - R, b.x + R, b.y + R);
        rg.addColorStop(0, hsl(pal.rims[0], a));
        rg.addColorStop(0.5, hsl(pal.rims[1], a));
        rg.addColorStop(1, hsl(pal.rims[2], a));
        ctx.strokeStyle = rg;
        ctx.lineWidth = Math.max(1.2, R * 0.022);
      }
      ctx.stroke();
    }

    /* One eye, in one of its looks. Drawn around (x, 0), already translated
     * to the eye line and turned with the head. */
    function eyeOpen(pal, x, w, h, alpha) {
      var ew = w * 1.08, eh = Math.max(h * 0.82, R * 0.025);
      ctx.beginPath();
      ctx.ellipse(x, 0, ew / 2, eh / 2, 0, 0, TAU);
      // bright, nearly white at the top, with a soft dark edge around them:
      // they read clearly on every colour of glass, light or deep
      var grad = ctx.createLinearGradient(x, -eh / 2, x, eh / 2);
      grad.addColorStop(0, hsla(pal.eye, 97, (0.99 * alpha).toFixed(3)));
      grad.addColorStop(1, hsla(pal.eye, 76, (0.95 * alpha).toFixed(3)));
      ctx.save();
      ctx.shadowColor = 'rgba(12,8,40,' + (0.55 * alpha).toFixed(3) + ')';
      ctx.shadowBlur = Math.max(3, R * 0.09);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
      if (eh > R * 0.12) {
        // the light caught in it moves a little with where it looks
        var lx = (s.lookX.v + gaze.x) * ew * 0.10, ly = (s.lookY.v + gaze.y) * eh * 0.08;
        ctx.fillStyle = 'hsla(0,0%,100%,' + (0.88 * alpha).toFixed(3) + ')';
        ctx.beginPath();
        ctx.ellipse(x - ew * 0.16 + lx, -eh * 0.20 + ly, ew * 0.15, ew * 0.18, -0.3, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + ew * 0.14 + lx, eh * 0.14 + ly, ew * 0.06, 0, TAU);
        ctx.fill();
      }
    }

    function eyeArc(pal, x, w, curve, alpha) {
      var up = curve > 0 ? 1 : -1;
      ctx.save();
      ctx.shadowColor = 'rgba(12,8,40,' + (0.5 * alpha).toFixed(3) + ')';
      ctx.shadowBlur = Math.max(3, R * 0.07);
      ctx.strokeStyle = hsla(pal.eye, 92, (0.97 * Math.min(1, Math.abs(curve)) * alpha).toFixed(3));
      ctx.lineWidth = Math.max(2.5, R * 0.065);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(x, up * w * 0.34, w * 0.52,
              up > 0 ? 0.18 * Math.PI : 1.18 * Math.PI,
              up > 0 ? 0.82 * Math.PI : 1.82 * Math.PI);
      ctx.stroke();
      ctx.restore();
    }

    function eyeStar(x, w, alpha, hue) {
      var r1 = w * 0.75 * (1 + (G ? G.kick : 0) * 0.2), r2 = r1 * 0.45, spin = clock * 1.6;
      ctx.beginPath();
      for (var i = 0; i < 10; i++) {
        var rr = i % 2 ? r2 : r1, an = spin + i * Math.PI / 5 - Math.PI / 2;
        if (i === 0) ctx.moveTo(x + Math.cos(an) * rr, Math.sin(an) * rr);
        else ctx.lineTo(x + Math.cos(an) * rr, Math.sin(an) * rr);
      }
      ctx.closePath();
      ctx.fillStyle = 'hsla(' + hue + ',100%,72%,' + alpha.toFixed(3) + ')';
      ctx.fill();
      ctx.fillStyle = 'hsla(0,0%,100%,' + (0.9 * alpha).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(x, 0, r2 * 0.45, 0, TAU); ctx.fill();
    }

    function eyeHeart(x, w, alpha) {
      var k = w * 0.62 * (1 + (G ? G.kick : 0) * 0.18);
      ctx.beginPath();
      ctx.moveTo(x, k * 0.75);
      ctx.bezierCurveTo(x - k * 1.25, -k * 0.05, x - k * 0.6, -k * 1.05, x, -k * 0.38);
      ctx.bezierCurveTo(x + k * 0.6, -k * 1.05, x + k * 1.25, -k * 0.05, x, k * 0.75);
      ctx.closePath();
      ctx.fillStyle = 'hsla(340,95%,66%,' + alpha.toFixed(3) + ')';
      ctx.fill();
      ctx.fillStyle = 'hsla(0,0%,100%,' + (0.75 * alpha).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(x - k * 0.38, -k * 0.38, k * 0.16, 0, TAU); ctx.fill();
    }

    function eyeLine(pal, x, w, alpha, shape, side) {
      ctx.strokeStyle = hsla(pal.eye, 86, (0.95 * alpha).toFixed(3));
      ctx.lineWidth = Math.max(2.5, R * 0.06);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (shape === 'squint') {
        // > <  squeezed shut
        var d = -side * w * 0.42;
        ctx.moveTo(x - d, -w * 0.38); ctx.lineTo(x + d, 0); ctx.lineTo(x - d, w * 0.38);
      } else {
        // closed and content, a soft downward curve
        ctx.arc(x, -w * 0.25, w * 0.5, 0.25 * Math.PI, 0.75 * Math.PI);
      }
      ctx.stroke();
    }

    function themeHue(t) { return G ? G.themeHue(t) : 195; }

    function fillShape(colour, alpha, draw) {
      ctx.beginPath(); draw(); ctx.closePath();
      ctx.fillStyle = colour.replace('A', alpha.toFixed(3));
      ctx.fill();
    }

    function shine(x, y, r, alpha) {
      ctx.fillStyle = 'hsla(0,0%,100%,' + (0.9 * alpha).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }

    // a four-pointed sparkle
    function eyeSparkle(x, w, alpha, hue) {
      var r = w * 0.78 * (1 + (G ? G.kick : 0) * 0.25);
      ctx.save();
      ctx.translate(x, 0);
      ctx.rotate(Math.sin(clock * 2) * 0.25);
      fillShape('hsla(' + hue + ',100%,80%,A)', alpha, function () {
        ctx.moveTo(0, -r);
        ctx.quadraticCurveTo(r * 0.14, -r * 0.14, r, 0);
        ctx.quadraticCurveTo(r * 0.14, r * 0.14, 0, r);
        ctx.quadraticCurveTo(-r * 0.14, r * 0.14, -r, 0);
        ctx.quadraticCurveTo(-r * 0.14, -r * 0.14, 0, -r);
      });
      shine(0, 0, r * 0.14, alpha);
      ctx.restore();
    }

    // a flickering flame
    function eyeFlame(x, w, alpha) {
      var f = 1 + Math.sin(clock * 23 + x) * 0.06 + (G ? G.kick : 0) * 0.15, hw = w * 0.5, ht = w * 1.05 * f;
      var g2 = ctx.createLinearGradient(x, -ht * 0.7, x, ht * 0.4);
      g2.addColorStop(0, 'hsla(50,100%,70%,' + alpha.toFixed(3) + ')');
      g2.addColorStop(0.5, 'hsla(28,100%,58%,' + alpha.toFixed(3) + ')');
      g2.addColorStop(1, 'hsla(355,95%,55%,' + alpha.toFixed(3) + ')');
      ctx.beginPath();
      ctx.moveTo(x, -ht * 0.75);
      ctx.bezierCurveTo(x + hw * 0.4, -ht * 0.35, x + hw * 1.2, -ht * 0.1, x + hw * 0.9, ht * 0.18);
      ctx.bezierCurveTo(x + hw * 0.7, ht * 0.5, x - hw * 0.7, ht * 0.5, x - hw * 0.9, ht * 0.18);
      ctx.bezierCurveTo(x - hw * 1.1, -ht * 0.1, x - hw * 0.2, -ht * 0.3, x, -ht * 0.75);
      ctx.fillStyle = g2;
      ctx.fill();
      fillShape('hsla(55,100%,88%,A)', alpha * 0.9, function () { ctx.ellipse(x, ht * 0.12, hw * 0.35, hw * 0.5, 0, 0, TAU); });
    }

    // a spiral, turning: dizzy after a spin
    function eyeDizzy(pal, x, w, alpha) {
      ctx.strokeStyle = hsla(pal.eye, 86, (0.95 * alpha).toFixed(3));
      ctx.lineWidth = Math.max(2, R * 0.04);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (var i = 0; i <= 40; i++) {
        var a = i / 40 * TAU * 2.2 + clock * 8, rr = w * 0.08 + w * 0.42 * i / 40;
        if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, Math.sin(a) * rr);
        else ctx.lineTo(x + Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.stroke();
    }

    // a little flower
    function eyeFlower(x, w, alpha, hue) {
      var r = w * 0.27, spin = clock * 0.8;
      for (var i = 0; i < 5; i++) {
        var a = spin + i * TAU / 5;
        fillShape('hsla(' + hue + ',95%,78%,A)', alpha, function () { ctx.arc(x + Math.cos(a) * r, Math.sin(a) * r, r * 0.85, 0, TAU); });
      }
      fillShape('hsla(48,100%,66%,A)', alpha, function () { ctx.arc(x, 0, r * 0.7, 0, TAU); });
    }

    // a crescent moon
    function eyeMoon(x, w, alpha) {
      var r = w * 0.55, d = r * 0.5, r2 = Math.sqrt(d * d + r * r), a = Math.PI - Math.atan(r / d);
      ctx.beginPath();
      ctx.arc(x, 0, r, -Math.PI / 2, Math.PI / 2, true);
      ctx.arc(x + d, 0, r2, a, TAU - a, false);
      ctx.closePath();
      ctx.fillStyle = 'hsla(48,100%,80%,' + alpha.toFixed(3) + ')';
      ctx.fill();
    }

    // an eighth note
    function eyeNote(x, w, alpha, hue) {
      var r = w * 0.26;
      ctx.save();
      ctx.translate(x, Math.sin(clock * 5 + x) * w * 0.06);
      fillShape('hsla(' + hue + ',95%,76%,A)', alpha, function () { ctx.ellipse(-r * 0.4, r * 1.1, r, r * 0.75, -0.4, 0, TAU); });
      ctx.strokeStyle = 'hsla(' + hue + ',95%,76%,' + alpha.toFixed(3) + ')';
      ctx.lineWidth = Math.max(2, R * 0.035);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(r * 0.5, r * 1.0); ctx.lineTo(r * 0.5, -r * 1.6);
      ctx.quadraticCurveTo(r * 1.6, -r * 1.0, r * 1.2, -r * 0.1); ctx.stroke();
      ctx.restore();
    }

    // big glossy eyes, close to tears (the good kind)
    function eyeGlossy(pal, x, w, alpha) {
      var ew = w * 1.3, eh = R * 0.40;
      fillShape(hsla(pal.eye, 72, 'A'), alpha, function () { ctx.ellipse(x, 0, ew / 2, eh / 2, 0, 0, TAU); });
      shine(x - ew * 0.15, -eh * 0.18, ew * 0.2, alpha);
      shine(x + ew * 0.18, eh * 0.05, ew * 0.08, alpha);
      shine(x - ew * 0.05, eh * 0.3, ew * 0.06, alpha * (0.6 + Math.sin(clock * 6) * 0.4));
    }

    // U  U, and a blush
    function eyeUwu(pal, x, w, alpha) {
      ctx.strokeStyle = hsla(pal.eye, 88, (0.95 * alpha).toFixed(3));
      ctx.lineWidth = Math.max(2.5, R * 0.06);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(x, -w * 0.15, w * 0.42, 0.08 * Math.PI, 0.92 * Math.PI); ctx.stroke();
    }

    function blush(x, w, alpha) {
      fillShape('hsla(345,90%,70%,A)', alpha * 0.45, function () { ctx.ellipse(x, w * 0.75, w * 0.42, w * 0.2, 0, 0, TAU); });
    }

    function eyeDots(pal, x, w, alpha) {
      fillShape(hsla(pal.eye, 88, 'A'), alpha, function () { ctx.arc(x, 0, w * 0.2, 0, TAU); });
    }

    function eyeCross(pal, x, w, alpha) {
      var k = w * 0.36;
      ctx.strokeStyle = hsla(pal.eye, 88, (0.95 * alpha).toFixed(3));
      ctx.lineWidth = Math.max(2.5, R * 0.055);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x - k, -k); ctx.lineTo(x + k, k); ctx.moveTo(x + k, -k); ctx.lineTo(x - k, k); ctx.stroke();
    }

    // a lightning bolt, flickering on the beat
    function eyeBolt(x, w, alpha) {
      var k = w * 0.62 * (1 + (G ? G.kick : 0) * 0.2);
      ctx.save();
      ctx.translate(x, 0);
      ctx.beginPath();
      ctx.moveTo(k * 0.25, -k * 1.1); ctx.lineTo(-k * 0.55, k * 0.12); ctx.lineTo(-k * 0.02, k * 0.12);
      ctx.lineTo(-k * 0.3, k * 1.1); ctx.lineTo(k * 0.6, -k * 0.22); ctx.lineTo(k * 0.06, -k * 0.22);
      ctx.closePath();
      ctx.fillStyle = 'hsla(50,100%,62%,' + alpha.toFixed(3) + ')';
      ctx.fill();
      ctx.strokeStyle = 'hsla(40,100%,85%,' + (0.9 * alpha).toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, R * 0.012);
      ctx.stroke();
      ctx.restore();
    }

    // a cut diamond, catching the light
    function eyeDiamond(x, w, alpha, hue) {
      var k = w * 0.7;
      ctx.save();
      ctx.translate(x, Math.sin(clock * 3) * k * 0.05);
      var g2 = ctx.createLinearGradient(-k, -k, k, k);
      g2.addColorStop(0, 'hsla(' + hue + ',90%,85%,' + alpha.toFixed(3) + ')');
      g2.addColorStop(1, 'hsla(' + ((hue + 40) % 360) + ',90%,60%,' + alpha.toFixed(3) + ')');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.moveTo(-k * 0.9, -k * 0.3); ctx.lineTo(-k * 0.5, -k * 0.75); ctx.lineTo(k * 0.5, -k * 0.75);
      ctx.lineTo(k * 0.9, -k * 0.3); ctx.lineTo(0, k * 0.95); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'hsla(0,0%,100%,' + (0.7 * alpha).toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, R * 0.01);
      ctx.beginPath();
      ctx.moveTo(-k * 0.9, -k * 0.3); ctx.lineTo(k * 0.9, -k * 0.3);
      ctx.moveTo(-k * 0.5, -k * 0.75); ctx.lineTo(-k * 0.2, -k * 0.3); ctx.lineTo(0, k * 0.95);
      ctx.moveTo(k * 0.5, -k * 0.75); ctx.lineTo(k * 0.2, -k * 0.3); ctx.lineTo(0, k * 0.95);
      ctx.stroke();
      shine(-k * 0.35, -k * 0.5, k * 0.1, alpha);
      ctx.restore();
    }

    /* Glyph faces, kaomoji style: each eye a little drawn mark in its own
     * glowing colour - ^ ^, - _ -, x x, + =, 3 3, T T - and some with a mouth.
     * l and r are the eyes, m an optional mouth. */
    var FACES = {
      '^^':  { l: '^', r: '^' },
      '^w^': { l: '^', r: '^', m: 'w' },
      '-_-': { l: '-', r: '-', m: '_' },
      'xx':  { l: 'x', r: 'x' },
      '+=':  { l: '+', r: '=' },
      '-+':  { l: '-', r: '+' },
      '++':  { l: '+', r: '+' },
      '==':  { l: '=', r: '=' },
      '..':  { l: '.', r: '.' },
      '33':  { l: '3', r: '3' },
      'oo':  { l: 'o', r: 'o' },
      'OO':  { l: 'O', r: 'O' },
      '><':  { l: '>', r: '<' },
      '>_<': { l: '>', r: '<', m: '_' },
      'uu':  { l: 'u', r: 'u' },
      'owo': { l: 'o', r: 'o', m: 'w' },
      '.u.': { l: '.', r: '.', m: 'smile' },
      'TT':  { l: 'T', r: 'T' },
      '@@':  { l: '@', r: '@' },
      '**':  { l: '*', r: '*' },
      '$$':  { l: '$', r: '$' },
      '<3':  { l: 'heart', r: 'heart' },
      'stars': { l: 'star', r: 'star' },
      'music': { l: 'note', r: 'note' },
      'flower': { l: 'flower', r: 'flower' },
      'big': { l: 'big', r: 'big', m: 'smile' },
      ';)':  { l: '^', r: 'o' }
    };

    /* One glyph, k its half-size, in the eye colour (some have their own). */
    function glyph(pal, ch, x, k, alpha, hue) {
      var lw = Math.max(2.2, k * 0.34);
      ctx.save();
      ctx.translate(x, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      var col = hsla(pal.eye, 86, alpha.toFixed(3));
      var soft = hsla(pal.eye, 70, (alpha * 0.25).toFixed(3));
      function strokeTwice(path) {
        // a soft wide pass under a crisp one: the glow
        ctx.beginPath(); path(); ctx.strokeStyle = soft; ctx.lineWidth = lw * 2.4; ctx.stroke();
        ctx.beginPath(); path(); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
      }
      function dot(px, py, r, c) { ctx.fillStyle = c || col; ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill(); }
      switch (ch) {
        case '^': strokeTwice(function () { ctx.moveTo(-k * 0.8, k * 0.35); ctx.lineTo(0, -k * 0.45); ctx.lineTo(k * 0.8, k * 0.35); }); break;
        case '-': strokeTwice(function () { ctx.moveTo(-k * 0.85, 0); ctx.lineTo(k * 0.85, 0); }); break;
        case 'x': strokeTwice(function () { ctx.moveTo(-k * 0.65, -k * 0.65); ctx.lineTo(k * 0.65, k * 0.65); ctx.moveTo(k * 0.65, -k * 0.65); ctx.lineTo(-k * 0.65, k * 0.65); }); break;
        case '+': strokeTwice(function () { ctx.moveTo(-k * 0.75, 0); ctx.lineTo(k * 0.75, 0); ctx.moveTo(0, -k * 0.75); ctx.lineTo(0, k * 0.75); }); break;
        case '=': strokeTwice(function () { ctx.moveTo(-k * 0.8, -k * 0.32); ctx.lineTo(k * 0.8, -k * 0.32); ctx.moveTo(-k * 0.8, k * 0.32); ctx.lineTo(k * 0.8, k * 0.32); }); break;
        case '.': dot(0, k * 0.1, k * 0.32); break;
        case 'o': strokeTwice(function () { ctx.arc(0, 0, k * 0.55, 0, TAU); }); break;
        case 'O':
          dot(0, 0, k * 0.85);
          dot(-k * 0.3, -k * 0.3, k * 0.25, 'hsla(0,0%,100%,' + (0.85 * alpha).toFixed(3) + ')');
          break;
        case 'big':
          // big shiny eyes
          dot(0, 0, k * 0.95);
          dot(-k * 0.32, -k * 0.35, k * 0.3, 'hsla(0,0%,100%,' + (0.9 * alpha).toFixed(3) + ')');
          dot(k * 0.3, k * 0.25, k * 0.12, 'hsla(0,0%,100%,' + (0.8 * alpha).toFixed(3) + ')');
          break;
        case '>': strokeTwice(function () { ctx.moveTo(-k * 0.55, -k * 0.6); ctx.lineTo(k * 0.55, 0); ctx.lineTo(-k * 0.55, k * 0.6); }); break;
        case '<': strokeTwice(function () { ctx.moveTo(k * 0.55, -k * 0.6); ctx.lineTo(-k * 0.55, 0); ctx.lineTo(k * 0.55, k * 0.6); }); break;
        case 'u': strokeTwice(function () { ctx.moveTo(-k * 0.6, -k * 0.5); ctx.lineTo(-k * 0.6, 0); ctx.arc(0, 0, k * 0.6, Math.PI, 0, true); ctx.lineTo(k * 0.6, -k * 0.5); }); break;
        case '3': strokeTwice(function () {
          ctx.moveTo(-k * 0.5, -k * 0.75);
          ctx.quadraticCurveTo(k * 0.75, -k * 0.85, k * 0.45, -k * 0.2);
          ctx.quadraticCurveTo(k * 0.25, 0, -k * 0.05, 0);
          ctx.moveTo(-k * 0.05, 0);
          ctx.quadraticCurveTo(k * 0.25, 0, k * 0.45, k * 0.2);
          ctx.quadraticCurveTo(k * 0.75, k * 0.85, -k * 0.5, k * 0.75);
        }); break;
        case 'T':
          strokeTwice(function () { ctx.moveTo(-k * 0.75, -k * 0.55); ctx.lineTo(k * 0.75, -k * 0.55); ctx.moveTo(0, -k * 0.55); ctx.lineTo(0, k * 0.55); });
          // a tear running down
          var tear = (clock * 0.8 + x * 0.01) % 1;
          dot(0, k * (0.7 + tear * 0.9), k * 0.16 * (1 - tear * 0.4), 'hsla(200,95%,72%,' + (alpha * (1 - tear)).toFixed(3) + ')');
          break;
        case '@':
          lw *= 0.6;                         // a spiral needs a fine line, or it blurs into a blob
          strokeTwice(function () {
          for (var i = 0; i <= 36; i++) {
            var a = i / 36 * TAU * 1.7 + clock * 6, rr = k * (0.12 + 0.72 * i / 36);
            if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
          }
        }); break;
        case '*': strokeTwice(function () {
          for (var j = 0; j < 3; j++) {
            var an = j * Math.PI / 3 + Math.PI / 2 + clock * 0.8;
            ctx.moveTo(Math.cos(an) * k * 0.75, Math.sin(an) * k * 0.75); ctx.lineTo(-Math.cos(an) * k * 0.75, -Math.sin(an) * k * 0.75);
          }
        }); break;
        case '$':
          ctx.restore();
          ctx.save();
          ctx.translate(x, 0);
          ctx.font = '800 ' + Math.round(k * 2.1) + 'px "Segoe UI", sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillStyle = 'hsla(140,85%,62%,' + alpha.toFixed(3) + ')';
          ctx.fillText('$', 0, k * 0.08);
          break;
        case 'heart':
          var hk = k * 0.95 * (1 + (G ? G.kick : 0) * 0.15);
          ctx.beginPath();
          ctx.moveTo(0, hk * 0.75);
          ctx.bezierCurveTo(-hk * 1.25, -hk * 0.05, -hk * 0.6, -hk * 1.05, 0, -hk * 0.38);
          ctx.bezierCurveTo(hk * 0.6, -hk * 1.05, hk * 1.25, -hk * 0.05, 0, hk * 0.75);
          ctx.fillStyle = 'hsla(345,95%,68%,' + alpha.toFixed(3) + ')';
          ctx.fill();
          break;
        case 'star':
          ctx.beginPath();
          for (var q = 0; q < 10; q++) {
            var rr2 = q % 2 ? k * 0.42 : k * 0.95, an2 = q * Math.PI / 5 - Math.PI / 2;
            if (q === 0) ctx.moveTo(Math.cos(an2) * rr2, Math.sin(an2) * rr2); else ctx.lineTo(Math.cos(an2) * rr2, Math.sin(an2) * rr2);
          }
          ctx.closePath();
          ctx.fillStyle = 'hsla(48,100%,66%,' + alpha.toFixed(3) + ')';
          ctx.fill();
          break;
        case 'note': ctx.restore(); eyeNote(x, k * 1.6, alpha, hue); return;
        case 'flower': ctx.restore(); eyeFlower(x, k * 1.6, alpha, hue); return;
      }
      ctx.restore();
    }

    /* A mouth for the faces that have one: _ (deadpan), w (cat), a small smile. */
    function faceMouth(pal, m, k, alpha) {
      var y = R * 0.30;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = hsla(pal.eye, 86, alpha.toFixed(3));
      ctx.lineWidth = Math.max(2, k * 0.3);
      ctx.beginPath();
      if (m === '_') { ctx.moveTo(-k * 0.6, y); ctx.lineTo(k * 0.6, y); }
      else if (m === 'w') {
        ctx.moveTo(-k * 0.8, y - k * 0.2); ctx.quadraticCurveTo(-k * 0.4, y + k * 0.45, 0, y - k * 0.05);
        ctx.quadraticCurveTo(k * 0.4, y + k * 0.45, k * 0.8, y - k * 0.2);
      } else { ctx.arc(0, y - k * 0.35, k * 0.6, 0.2 * Math.PI, 0.8 * Math.PI); }
      ctx.stroke();
      ctx.restore();
    }

    // sunglasses across both eyes, with a glint that sweeps by
    function shades(dx, w, alpha) {
      var lw = w * 1.55, lh = w * 1.05, hue = Math.round(themeHue(clock * 0.06));
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.fillStyle = '#0b0d14';
      ctx.strokeStyle = 'hsl(' + hue + ',90%,65%)';
      ctx.lineWidth = Math.max(1.5, R * 0.025);
      ctx.beginPath(); ctx.moveTo(-dx, -lh * 0.32); ctx.lineTo(dx, -lh * 0.32); ctx.stroke();
      [-1, 1].forEach(function (side) {
        var x = side * dx;
        ctx.beginPath();
        ctx.moveTo(x - lw / 2, -lh / 2);
        ctx.lineTo(x + lw / 2, -lh / 2);
        ctx.quadraticCurveTo(x + lw / 2, lh / 2, x, lh / 2);
        ctx.quadraticCurveTo(x - lw / 2, lh / 2, x - lw / 2, -lh / 2);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        var sweep = ((clock * 0.7) % 1.6) - 0.3;
        if (sweep > 0 && sweep < 1) {
          ctx.save(); ctx.clip();
          ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = lw * 0.18;
          var gx = x - lw / 2 + sweep * lw * 1.4;
          ctx.beginPath(); ctx.moveTo(gx, -lh); ctx.lineTo(gx - lh * 0.6, lh); ctx.stroke();
          ctx.restore();
        }
      });
      ctx.restore();
    }

    /* Dancing, it wears LED goggles over its eyes: a dark glass band edged in
     * the song's colours. Inside, its eyes - in whatever look the song calls
     * for - or, while the main lines of the song are sung, the words, lit as
     * they are sung and scrolling along. */
    function drawVisor(pal, f, amount) {
      var vw = Math.min(f.eyeDx * 2 + R * 0.72, R * 1.5), vh = R * 0.50, rr = vh * 0.38;
      // they drop down onto the face, and lift off again
      ctx.save();
      ctx.globalAlpha *= Math.min(1, amount * 1.4);
      ctx.translate(0, -(1 - easeOutBack(amount)) * R * 0.55);
      // the goggles stay on the face, even mid-turn
      var off = rig.body.x - f.x, room = Math.max(0, R * 0.86 - vw / 2);   // clear of the headphone cups
      if (Math.abs(off) > room) ctx.translate(off - Math.sign(off) * room, 0);
      var hueA = Math.round(themeHue(clock * 0.06)), hueB = Math.round(themeHue(clock * 0.06 + 0.5));

      // the strap round the head
      var toBody = rig.body.x - f.x;
      ctx.strokeStyle = 'hsla(' + pal.hue + ',25%,12%,0.95)';
      ctx.lineWidth = R * 0.07;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-vw / 2, 0); ctx.lineTo(toBody - R * 1.0, R * 0.02);
      ctx.moveTo(vw / 2, 0); ctx.lineTo(toBody + R * 1.0, R * 0.02);
      ctx.stroke();

      // the glass
      ctx.beginPath();
      ctx.moveTo(-vw / 2 + rr, -vh / 2);
      ctx.arcTo(vw / 2, -vh / 2, vw / 2, vh / 2, rr);
      ctx.arcTo(vw / 2, vh / 2, -vw / 2, vh / 2, rr);
      ctx.arcTo(-vw / 2, vh / 2, -vw / 2, -vh / 2, rr);
      ctx.arcTo(-vw / 2, -vh / 2, vw / 2, -vh / 2, rr);
      ctx.closePath();
      ctx.fillStyle = 'rgba(6,8,16,0.94)';
      ctx.fill();
      var edge = ctx.createLinearGradient(-vw / 2, 0, vw / 2, 0);
      edge.addColorStop(0, 'hsl(' + hueA + ',95%,62%)');
      edge.addColorStop(1, 'hsl(' + hueB + ',95%,62%)');
      ctx.strokeStyle = edge;
      ctx.lineWidth = Math.max(1.5, R * 0.03 * (1 + (G ? G.kick : 0) * 0.6));
      ctx.stroke();

      ctx.save();
      ctx.clip();
      // the eyes, fading out as the words come in
      var wordsA = smoothstep(0.3, 1, amount);
      // the words: the line being sung slides up into place as the last one
      // slides away; the light wipes across it smoothly as it is sung
      if (wordsA > 0.01 && lyricNow && lyricNow.text) {
        var size = Math.round(vh * 0.44), pad = vh * 0.3, inner = vw - pad * 2;
        ctx.font = '800 ' + size + 'px "Segoe UI", "Nirmala UI", "Malgun Gothic", sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        var swap = smoothstep(0, 0.32, clock - lyricAt);         // 0 -> 1 as a new line arrives
        var y = Math.sin(clock * 2.4) * vh * 0.025;
        var before = ctx.globalAlpha;
        if (lyricPrev && lyricPrev.text && swap < 1) {
          ctx.globalAlpha = before * wordsA * (1 - swap);
          drawLine(lyricPrev, -vw / 2 + pad + prevScroll, y - swap * vh * 0.7, 1);
        }
        var text = lyricNow.text;
        var total = ctx.measureText(text).width;
        var sungW = wipeWidth(text, clamp(lyricNow.progress || 0, 0, 1));
        // keep the word being sung a little left of centre, so the line flows past
        var target = total <= inner ? (inner - total) / 2 : clamp(inner * 0.42 - sungW, inner - total, 0);
        if (visorScroll > 1e8) visorScroll = total <= inner ? target : 0;
        visorScroll += (target - visorScroll) * Math.min(1, lastDt * 9);
        ctx.globalAlpha = before * wordsA * (lyricPrev ? swap : 1);
        drawLine(lyricNow, -vw / 2 + pad + visorScroll, y + (lyricPrev ? (1 - swap) * vh * 0.7 : 0), sungW);
        ctx.globalAlpha = before;
        // soft edges, so words slide in and out of the glass
        [-1, 1].forEach(function (side) {
          var ex = side * vw / 2, fade = ctx.createLinearGradient(ex, 0, ex - side * pad * 1.2, 0);
          fade.addColorStop(0, 'rgba(6,8,16,1)');
          fade.addColorStop(1, 'rgba(6,8,16,0)');
          ctx.fillStyle = fade;
          ctx.fillRect(side < 0 ? ex : ex - pad * 1.2, -vh / 2, pad * 1.2, vh);
        });
      }

      // one line: dim, with the sung part lit by a wipe that ends exactly at sungW
      // (a fraction 0..1 of the line when given as one)
      function drawLine(l, x, ly, sungW) {
        var w = ctx.measureText(l.text).width;
        var lit = sungW <= 1 ? w * sungW : sungW;
        ctx.fillStyle = 'rgba(255,255,255,0.38)';
        ctx.fillText(l.text, x, ly);
        if (lit > 0.5) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x - 2, ly - vh, lit + 2, vh * 2);
          ctx.clip();
          var grad = ctx.createLinearGradient(x, 0, x + Math.max(1, w), 0);
          grad.addColorStop(0, 'hsl(' + hueA + ',100%,74%)');
          grad.addColorStop(1, 'hsl(' + hueB + ',100%,78%)');
          ctx.fillStyle = grad;
          ctx.fillText(l.text, x, ly);
          ctx.restore();
          // a soft edge where the light is
          if (lit < w - 1) {
            var edgeG = ctx.createLinearGradient(x + lit - 6, 0, x + lit + 6, 0);
            edgeG.addColorStop(0, 'hsla(' + hueB + ',100%,80%,0)');
            edgeG.addColorStop(0.5, 'hsla(' + hueB + ',100%,85%,0.55)');
            edgeG.addColorStop(1, 'hsla(' + hueB + ',100%,80%,0)');
            ctx.fillStyle = edgeG;
            ctx.fillRect(x + lit - 6, ly - vh * 0.3, 12, vh * 0.6);
          }
        }
      }
      // LED lines across the glass
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      for (var ly = -vh / 2; ly < vh / 2; ly += 3) ctx.fillRect(-vw / 2, ly, vw, 1);
      // a glint across the top
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(-vw / 2, -vh / 2, vw, vh * 0.18);
      ctx.restore();
      ctx.restore();
    }

    /* How wide the sung part of a line is, progress 0..1 of its letters,
     * moving smoothly through each letter rather than letter by letter. */
    function wipeWidth(text, progress) {
      var exact = progress * text.length, i = Math.floor(exact), f = exact - i;
      var a = ctx.measureText(text.slice(0, i)).width;
      if (i >= text.length) return a;
      return a + (ctx.measureText(text.slice(0, i + 1)).width - a) * f;
    }

    function easeOutBack(t) {
      t = clamp(t, 0, 1);
      var c = 1.70158;
      return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
    }

    /* Drawing around an eye's centre, scaled and turned: how one symbol goes
     * and the next arrives. */
    function around(x, scale, turn, draw) {
      if (scale <= 0.01) return;
      ctx.save();
      ctx.translate(x, 0);
      ctx.rotate(turn);
      ctx.scale(scale, scale);
      ctx.translate(-x, 0);
      draw();
      ctx.restore();
    }

    function drawEyes(pal) {
      var f = rig.face;
      var g = s.glow.v;
      var open = clamp(s.eyeOpen.v * (1 + gaze.wide), 0, 2) * (1 - blink * 0.94);
      var w = R * 0.20 * s.eyeW.v * rig.pose.faceW;
      var h = Math.max(R * 0.025, R * 0.40 * open);
      if (f.show < 0.02) return;            // turned away, mid-spin
      var curve = clamp(s.eyeCurve.v + gaze.smile, -1, 1);
      if (act && (act.kind === 'eat' || act.kind === 'pet')) curve = 1;                    // ^ ^
      // eyes squeezed shut through the middle of a yawn or a stretch
      if (act && (act.kind === 'yawn' || act.kind === 'stretch') && actT > 0.3 && actT < ACT_LEN[act.kind] - 0.3) h = R * 0.025;
      var solid = 1 - Math.min(1, Math.abs(curve));
      // dancing, the song picks the look
      var look = danceAmount() > 0.5 && G ? G.eyes() : null;

      ctx.save();
      ctx.globalAlpha = f.show;
      ctx.translate(f.x, f.eyeY);
      ctx.rotate(rig.tilt * 0.6);

      if (look && danceAmount() > 0.5) {
        // a new look: the old one shrinks and spins away, the new one pops in
        var key = look.style + ':' + look.side;
        if (key !== shownKey) { prevLook = shownLook; shownLook = { style: look.style, side: look.side }; shownKey = key; lookAt = clock; }
        var p = (clock - lookAt) / 0.38;
        var want = lyricNow && lyricNow.main ? 1 : 0;
        visorText += (want - visorText) * Math.min(1, lastDt * 5);
        var eyesA = 1 - smoothstep(0.05, 0.35, visorText);
        if (eyesA > 0.01) {
          var keep = ctx.globalAlpha;
          ctx.globalAlpha = keep * eyesA;
          var outT = clamp(p / 0.45, 0, 1), inT = clamp((p - 0.25) / 0.75, 0, 1);
          [-1, 1].forEach(function (side) {
            var x = side * f.eyeDx;
            if (p < 1 && prevLook && outT < 1) around(x, 1 - outT * outT, side * outT * 1.4, function () { drawOneEye(pal, side, x, w, h, g, prevLook); });
            around(x, p < 1 ? easeOutBack(inT) : 1, p < 1 ? -side * (1 - inT) * 0.6 : 0, function () { drawOneEye(pal, side, x, w, h, g, shownLook); });
          });
          if (FACES[shownLook.style] && FACES[shownLook.style].m) {
            around(0, p < 1 ? easeOutBack(inT) : 1, 0, function () { faceMouth(pal, FACES[shownLook.style].m, w * 0.75, g); });
          }
          if (prevLook && p < 1 && FACES[prevLook.style] && FACES[prevLook.style].m && outT < 1) {
            around(0, 1 - outT * outT, 0, function () { faceMouth(pal, FACES[prevLook.style].m, w * 0.75, g); });
          }
          if (shownLook.style === 'shades') around(0, p < 1 ? easeOutBack(inT) : 1, 0, function () { shades(f.eyeDx, w, 1); });
          else if (prevLook && prevLook.style === 'shades' && p < 1) around(0, 1 - outT, 0, function () { shades(f.eyeDx, w, 1); });
          ctx.globalAlpha = keep;
        }
        if (visorText > 0.01) drawVisor(pal, f, visorText);
        ctx.restore();
        return;
      }

      [-1, 1].forEach(function (side) {
        var x = side * f.eyeDx;
        drawOneEye(pal, side, x, w, h, g, look, curve, solid, true);
      });

      if (look && look.style === 'shades') shades(f.eyeDx, w, 1);

      // a yawn (and the big one in a stretch), or chomping a cookie
      var yawnOpen = act && (act.kind === 'yawn' || act.kind === 'stretch') ? Math.sin(Math.PI * clamp(actT / ACT_LEN[act.kind], 0, 1)) : 0;
      var chomp = act && act.kind === 'eat' && actT > 0.6 ? Math.abs(Math.sin((actT - 0.6) * 9)) : 0;
      if (yawnOpen > 0.05 || chomp > 0.05) {
        var oy = R * 0.42, ow = R * (0.10 + yawnOpen * 0.08 + chomp * 0.06), oh = R * (0.06 + yawnOpen * 0.16 + chomp * 0.10);
        ctx.fillStyle = 'hsla(' + pal.hue + ',40%,6%,0.95)';
        ctx.strokeStyle = hsla(pal.eye, 80, (0.8 * g).toFixed(3));
        ctx.lineWidth = Math.max(1.5, R * 0.035);
        ctx.beginPath(); ctx.ellipse(0, oy, ow, oh, 0, 0, TAU); ctx.fill(); ctx.stroke();
      }

      // a mouth only while it is actually talking
      if (voice > 0.02) {
        var mw = R * (0.20 + voice * 0.16);
        var mh = R * (0.04 + voice * 0.17);
        ctx.strokeStyle = hsla(pal.eye, 86, (Math.min(1, voice) * 0.8 * g).toFixed(3));
        ctx.lineWidth = Math.max(2, R * 0.055);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.ellipse(0, R * 0.46, mw, mh, 0, 0.08 * Math.PI, 0.92 * Math.PI);
        ctx.stroke();
      }

      ctx.restore();
    }

    /* One eye, in its look: the mood's own open-or-curved eye, or a dancing
     * symbol. `withHalo` false inside the goggles, where the glass is the glow. */
    function drawOneEye(pal, side, x, w, h, g, look, curve, solid, withHalo) {
      if (curve === undefined) { curve = 1; solid = 0; }
      if (withHalo) {
        var spread = Math.max(w, h) * 1.7;
        var glow = ctx.createRadialGradient(x, 0, 0, x, 0, spread);
        glow.addColorStop(0, hsla(pal.eye, 66, (0.24 * g).toFixed(3)));
        glow.addColorStop(1, hsla(pal.eye, 58, '0'));
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(x, 0, spread, 0, TAU); ctx.fill();
      }
      var style = look ? look.style : 'mood';
      if (FACES[style]) {
        var face = FACES[style];
        glyph(pal, side < 0 ? face.l : face.r, x, w * 0.75, g, Math.round(themeHue(clock * 0.06 + (side > 0 ? 0.3 : 0))));
        return;
      }
      if (style === 'wink') style = side === look.side ? 'happy' : 'open';
      if (blink > 0.5 && (style === 'open' || style === 'glossy' || style === 'dots')) style = 'closed';
      var hue = Math.round(themeHue(clock * 0.06 + (side > 0 ? 0.3 : 0)));
      var big = w * 1.3;                            // symbols read better a size up
      if (withHalo && (style === 'uwu' || style === 'hearts' || style === 'glossy')) blush(x, w, g);
      switch (style) {
        case 'shades': break;                         // drawn across both eyes by the caller
        case 'happy': eyeArc(pal, x, w, 1, g); break;
        case 'open': eyeOpen(pal, x, w * 1.06, R * 0.40 * 1.12, g); break;
        case 'stars': eyeStar(x, big, g, hue); break;
        case 'hearts': eyeHeart(x, big, g); break;
        case 'closed': eyeLine(pal, x, w, g, 'closed', side); break;
        case 'squint': eyeLine(pal, x, w, g, 'squint', side); break;
        case 'sparkle': eyeSparkle(x, big, g, hue); break;
        case 'flame': eyeFlame(x, big, g); break;
        case 'dizzy': eyeDizzy(pal, x, w, g); break;
        case 'flower': eyeFlower(x, big, g, hue); break;
        case 'moon': eyeMoon(x, big, g); break;
        case 'note': eyeNote(x, big, g, hue); break;
        case 'glossy': eyeGlossy(pal, x, w, g); break;
        case 'uwu': eyeUwu(pal, x, w, g); break;
        case 'dots': eyeDots(pal, x, w, g); break;
        case 'cross': eyeCross(pal, x, w, g); break;
        case 'bolt': eyeBolt(x, big, g); break;
        case 'diamond': eyeDiamond(x, big, g, hue); break;
        default:
          if (solid > 0.01) eyeOpen(pal, x, w, h, solid * g);
          if (Math.abs(curve) > 0.01) eyeArc(pal, x, w, curve, g);
      }
    }

    /* ---- frame ----------------------------------------------------------- */

    function update(dt) {
      clock += dt;
      breath += dt * 1.25;
      lastDt = dt;

      if (G) G.update(dt);
      if (act) { actT += dt; if (actT >= ACT_LEN[act.kind]) act = null; }
      for (var bi = bits.length - 1; bi >= 0; bi--) {
        var bt = bits[bi];
        bt.age += dt;
        if (bt.target) {
          // the cookie flies to the mouth
          var u = clamp(bt.age / bt.life, 0, 1);
          bt.x = bt.fromX + (bt.target.x - bt.fromX) * u;
          bt.y = bt.fromY + (bt.target.y - bt.fromY) * u - Math.sin(Math.PI * u) * 0.5;
        } else {
          bt.x += bt.vx * dt; bt.y += bt.vy * dt;
          if (bt.kind === 'crumb') bt.vy += 2.5 * dt;
          else bt.vx += Math.cos(bt.age * 3 + bt.wob) * dt * 0.3;
        }
        if (bt.age > bt.life) bits.splice(bi, 1);
      }

      var f = 60 * dt;
      for (var key in s) s[key].step(f);
      s.flash.target = 0;
      s.wiggle.target = 0;

      // the eyes follow the cursor, and only the cursor
      var tx = 0, ty = 0;
      if (target) {
        tx = clamp((target.x - cx) / (W * 0.5), -1, 1);
        ty = clamp((target.y - cy) / (H * 0.5), -1, 1);
      }
      s.lookX.target = tx * s.lookGain.v;
      s.lookY.target = ty * s.lookGain.v;

      if (state !== 'sleep') {
        blinkAt -= dt;
        // now and then a quick double blink, like a real one
        if (blinkAt <= 0) { blink = 1; blinkAt = Math.random() < 0.25 ? 0.28 : 2.6 + Math.random() * 4.5; }
      }

      // a little gesture now and then while it has nothing to do
      var idle = (state === 'idle' || state === 'alert') && danceAmount() < 0.05;
      if (!gesture && idle) {
        gestureIn -= dt;
        if (gestureIn <= 0) {
          gesture = state === 'alert' ? 'smile' : GESTURES[Math.floor(Math.random() * GESTURES.length)];
          gestureT = 0;
          gestureIn = 8 + Math.random() * 10;
        }
      }
      var gx = 0, gy = 0, gsmile = 0, gwide = 0;
      if (gesture) {
        gestureT += dt;
        var u = gestureT / 2.2, bump = Math.sin(Math.PI * clamp(u, 0, 1));
        if (gesture === 'glance') { gx = Math.sin(TAU * clamp(u, 0, 1)) * 0.9; gy = bump * 0.1; }
        else if (gesture === 'curious') { gy = -bump * 0.55; gwide = bump * 0.22; }
        else if (gesture === 'smile') gsmile = bump * 0.75;
        else if (gesture === 'sleepy') gwide = -bump * 0.5;
        if (u >= 1 || !idle) gesture = null;
      }
      var ease = Math.min(1, dt * 6);
      gaze.x += (gx - gaze.x) * ease; gaze.y += (gy - gaze.y) * ease;
      gaze.smile += (gsmile - gaze.smile) * ease; gaze.wide += (gwide - gaze.wide) * ease;
      blink = Math.max(0, blink - dt * 6.5);
      voice = Math.max(0, voice - dt * 2.4);
    }

    function render() {
      ctx.clearRect(0, 0, W, H);
      rig = buildRig();
      var pal = palette();

      drawShadow(pal);
      // no ring of bars round it while it dances: the dance is the visual

      var clothes = WD.byId(WD.OUTFITS, outfit.outfit);
      var clothCol = WD.CLOTH[outfit.outfitColour || clothes.colour || 'blue'] || WD.CLOTH.blue;
      if (clothes.draw && clothes.behind) {
        pal.cloth = clothCol; pal.clothId = outfit.outfitColour || clothes.colour;
        clothes.draw(ctx, rig, pal);
      }

      drawGlass(pal);

      if (clothes.draw && !clothes.behind) {
        pal.cloth = clothCol; pal.clothId = outfit.outfitColour || clothes.colour;
        clothes.draw(ctx, rig, pal);
      }

      drawEyes(pal);

      var face = WD.byId(WD.FACES, outfit.face);
      if (face.draw) {
        pal.cloth = WD.CLOTH[outfit.faceColour || face.colour || 'dark'] || WD.CLOTH.dark;
        face.draw(ctx, rig, pal);
      }

      if (G) G.drawHeadphones(ctx, rig, pal);

      var hat = WD.byId(WD.HATS, outfit.hat);
      if (hat.draw) {
        pal.cloth = WD.CLOTH[outfit.hatColour || hat.colour || 'red'] || WD.CLOTH.red;
        hat.draw(ctx, rig, pal);
      }

      // no antenna: a clean, round head


      if (G) G.drawAir(ctx, rig);
      drawBits();
    }

    /* Hearts, crumbs and a cookie, in units of R around the body. */
    function drawBits() {
      if (!bits.length) return;
      var b = rig.body;
      ctx.save();
      bits.forEach(function (bt) {
        var x = b.x + bt.x * R, y = b.y + bt.y * R, k = R * bt.r;
        ctx.globalAlpha = Math.min(1, bt.age * 6) * (1 - clamp((bt.age - bt.life * 0.6) / (bt.life * 0.4), 0, 1));
        ctx.beginPath();
        if (bt.kind === 'heart') {
          ctx.moveTo(x, y + k * 0.75);
          ctx.bezierCurveTo(x - k * 1.25, y - k * 0.05, x - k * 0.6, y - k * 1.05, x, y - k * 0.38);
          ctx.bezierCurveTo(x + k * 0.6, y - k * 1.05, x + k * 1.25, y - k * 0.05, x, y + k * 0.75);
          ctx.fillStyle = 'hsl(345,95%,68%)';
          ctx.fill();
        } else if (bt.kind === 'cookie') {
          ctx.arc(x, y, k, 0, TAU);
          ctx.fillStyle = 'hsl(32,70%,52%)';
          ctx.fill();
          ctx.fillStyle = 'hsl(25,55%,22%)';
          [[-0.35, -0.2], [0.3, -0.35], [0.1, 0.3], [-0.2, 0.35], [0.4, 0.15]].forEach(function (c) {
            ctx.beginPath(); ctx.arc(x + c[0] * k, y + c[1] * k, k * 0.13, 0, TAU); ctx.fill();
          });
        } else {
          ctx.arc(x, y, k, 0, TAU);
          ctx.fillStyle = 'hsl(32,65%,48%)';
          ctx.fill();
        }
      });
      ctx.restore();
    }

    function puff(kind, n, from) {
      for (var i = 0; i < n; i++) {
        var side = Math.random() < 0.5 ? -1 : 1;
        bits.push({
          kind: kind, x: (from ? from.x : side * (0.5 + Math.random() * 0.5)), y: from ? from.y : -0.5 - Math.random() * 0.4,
          vx: kind === 'crumb' ? (Math.random() - 0.5) * 1.2 : side * (0.05 + Math.random() * 0.1),
          vy: kind === 'crumb' ? -0.6 - Math.random() * 0.5 : -(0.35 + Math.random() * 0.25),
          age: 0, life: kind === 'crumb' ? 0.9 : 1.6, r: kind === 'crumb' ? 0.025 : 0.08 + Math.random() * 0.05, wob: Math.random() * TAU
        });
      }
    }

    var complained = false;
    var saving = false;          // battery saver: fewer frames
    /* Drawn at 60 frames a second while something is happening - dancing,
     * talking, a mood changing - and 30 at rest. A 144 Hz screen would
     * otherwise have it redrawing 144 times a second for a creature that is
     * mostly breathing, and the whole computer pays for that. */
    function frame(now) {
      if (!running) return;
      var lively = danceAmount() > 0.01 || voice > 0.01 || state !== 'idle' || blink > 0 || gesture;
      // battery saver: half that - 30 a second at most, 15 at rest
      var gap = saving ? (lively ? 32 : 65) : (lively ? 15 : 31);
      if (now - lastT < gap) { raf = global.requestAnimationFrame(frame); return; }
      var dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
      lastT = now;
      try {
        update(dt);
        render();
      } catch (err) {
        // One bad frame must never leave the creature frozen for the rest of
        // the session, which is exactly what an escaping throw would do here.
        lastError = String(err && err.message) + ' | ' +
                    String((err && err.stack) || '').split(/\r?\n/).slice(1, 3).join(' <- ');
        if (!complained) { complained = true; console.error('nim frame:', err); }
      }
      raf = global.requestAnimationFrame(frame);
    }

    /* ---- api ------------------------------------------------------------- */

    function applyMood(name) {
      var m = MOODS[name] || MOODS.idle;
      s.eyeOpen.target = m.eyeOpen;
      s.eyeW.target = m.eyeW;
      s.eyeCurve.target = m.eyeCurve;
      s.bob.target = m.bob;
      s.squash.target = m.squash;
      s.glow.target = m.glow;
      s.antenna.target = m.antenna;
      s.tilt.target = m.tilt;
      s.lookGain.target = m.lookGain;
    }

    var api = {
      get state() { return state; },

      setState: function (name) {
        if (!MOODS[name] || name === state) return api;
        state = name;
        applyMood(name);
        if (name === 'happy') { s.flash.set(0.5); s.wiggle.nudge(0.02); }
        if (name === 'alert') { gesture = 'smile'; gestureT = 0; }
        return api;
      },

      /* Canvas pixels. On the desktop this is the real cursor translated into
       * the window, so it watches you wherever you are on screen. */
      lookAt: function (x, y) {
        target = (x === null || x === undefined) ? null : { x: x, y: y };
        return api;
      },

      speak: function (amount) {
        voice = clamp(voice + (amount === undefined ? 0.5 : amount), 0, 1.6);
        if (state !== 'speaking') api.setState('speaking');
        return api;
      },

      /* It has no arms, so its greeting is a wiggle rather than a wave. */
      wave: function (seconds) {
        var n = 0;
        var swing = setInterval(function () {
          s.wiggle.nudge(n % 2 ? 0.025 : -0.025);   // the target is pulled back to 0 every frame
          if (++n > 3) { clearInterval(swing); s.wiggle.target = 0; }
        }, 220);
        return api;
      },

      blinkNow: function () { blink = 1; blinkAt = 2 + Math.random() * 3; return api; },

      /* A good stretch: up tall, a big yawn, and back. (Health breaks.) */
      stretch: function () { act = { kind: 'stretch' }; actT = 0; return api; },
      /* A yawn (late at night). */
      yawn: function () { if (!act) { act = { kind: 'yawn' }; actT = 0; } return api; },
      /* A cookie: it flies in, gets eaten, crumbs and hearts. */
      feed: function () {
        act = { kind: 'eat' }; actT = 0;
        bits.push({ kind: 'cookie', fromX: 1.6, fromY: -1.2, x: 1.6, y: -1.2, target: { x: 0, y: 0.42 }, age: 0, life: 0.6, r: 0.16 });
        setTimeout(function () { puff('crumb', 7, { x: 0, y: 0.42 }); }, 700);
        setTimeout(function () { puff('heart', 3); }, 1500);
        return api;
      },
      /* Being petted: a happy wriggle and hearts. */
      pet: function () { act = { kind: 'pet' }; actT = 0; puff('heart', 4); s.flash.set(0.3); return api; },

      /* Dance to music: call every frame with what music.js reports (energy,
       * bass, a count of hits, the beat length, drops, 24 bands) while a song
       * plays, and with null when it stops. */
      groove: function (m) {
        if (G) G.feed(m ? {
          energy: clamp(m.energy || 0, 0, 1), bass: clamp(m.bass || 0, 0, 1), beat: m.beat,
          period: m.period || 0, drops: m.drops || 0, beatAt: m.beatAt || 0, beatPeriod: m.beatPeriod || 0, at: m.at || 0, drive: m.drive === undefined ? 0.2 : m.drive, bands: m.bands || [], track: String(m.track || ''),
          mood: String(m.mood || '')
        } : null);
        return api;
      },

      get dancing() { return danceAmount() > 0.05; },

      /* Acts out a sung line: 'love', 'jump', 'fire', 'night', ... (music.js actsFor). */
      act: function (name) { if (G) G.act(name); return api; },

      /* Holds one of the dancing looks (for the wardrobe and for trying them). */
      showEyes: function (style, side) { if (G) G.showEyes(style, side); return api; },

      /* The hook: true while one of its lines is sung, false between, null
       * when there are no lyrics to tell. */
      hook: function (on) { if (G) G.hook(on); return api; },

      /* The lyric line, as { text, progress 0..1 through it, main: a line of the
       * hook }, or null. Main lines are shown in its goggles while it dances. */
      lyric: function (l) {
        var text = l && l.text ? String(l.text) : '';
        var cur = lyricNow ? lyricNow.text : '';
        if (text !== cur) {
          lyricPrev = lyricNow;
          lyricNow = text ? { text: text, progress: 0, main: false } : null;
          lyricAt = clock;
          prevScroll = visorScroll > 1e8 ? 0 : visorScroll;
          visorScroll = 1e9;                  // a new line starts from its own beginning
        }
        if (lyricNow) { lyricNow.progress = l.progress || 0; lyricNow.main = !!l.main; }
        return api;
      },

      /* The middle of its body right now (it moves when it dances), in canvas
       * pixels, and its size. */
      bodyPoint: function () { return rig ? { x: rig.body.x, y: rig.body.y, r: R } : { x: cx, y: cy, r: R }; },

      /* The ground under it, in canvas pixels: where its shadow falls. */
      footPoint: function () { return { x: cx, y: cy + R * 1.42, r: R }; },

      /* The top of its head right now, in canvas pixels - the point
       * everything that grows out of Nim grows from. */
      sparkPoint: function () {
        return rig ? { x: rig.body.x - Math.sin(rig.tilt) * R, y: rig.body.y - Math.cos(rig.tilt) * R * rig.sy } : { x: cx, y: cy - R };
      },

      debug: function () {
        return {
          anchor: rig ? {
            x: Math.round(rig.body.x - Math.sin(rig.tilt) * R),
            y: Math.round(rig.body.y - Math.cos(rig.tilt) * R)
          } : null,
          canvas: { W: W, H: H, cx: Math.round(cx), cy: Math.round(cy), R: Math.round(R) },
          dancing: danceAmount(),
          running: running,
          lastError: lastError
        };
      },

      setOutfit: function (partial) { Object.assign(outfit, partial || {}); return api; },

      /* Battery saver: the same creature, drawn half as often. */
      saver: function (on) { saving = !!on; return api; },

      /* A smaller or bigger Nim, and where in its box it stands. */
      setSize: function (newScale, newAnchor) {
        if (Number.isFinite(newScale) && newScale > 0.3 && newScale < 2) scale = newScale;
        if (newAnchor && Number.isFinite(newAnchor.x) && Number.isFinite(newAnchor.y)) anchor = { x: newAnchor.x, y: newAnchor.y };
        resize();
        return api;
      },
      getOutfit: function () { return Object.assign({}, outfit); },

      /* Waking up: the glow and the eyes come up together, no startle. */
      wake: function () {
        s.glow.set(0.05); s.eyeOpen.set(0); s.bob.set(0.2);
        api.setState('idle');
        return api;
      },

      start: function () {
        if (running) return api;
        running = true; lastT = global.performance.now();
        raf = global.requestAnimationFrame(frame);
        return api;
      },
      stop: function () { running = false; global.cancelAnimationFrame(raf); return api; },
      resize: resize,
      destroy: function () { api.stop(); global.removeEventListener('resize', resize); }
    };

    resize();
    global.addEventListener('resize', resize);
    // the window event alone misses a canvas whose own box changes, which is
    // most of them: side panels, split views, anything laid out with grid
    if (global.ResizeObserver) new global.ResizeObserver(resize).observe(canvas);
    api.start();
    return api;
  }

  global.createNim = createNim;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createNim: createNim };
}(typeof window !== 'undefined' ? window : this));
