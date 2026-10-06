/*
 * Nim's wardrobe.
 *
 * Everything Nim can wear or be coloured as. Each item is a small drawing
 * routine handed the rig - the joint positions worked out by nim.js for this
 * exact frame - so clothes follow the body while it bobs, sways and waves
 * instead of being stuck on top as a sticker.
 *
 * Adding an item is adding one entry to a list. Nothing else needs to change.
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;

  /* ---- small drawing helpers ---------------------------------------------- */

  function blob(ctx, x, y, hw, hh, r) {
    r = Math.min(r === undefined ? hh * 0.6 : r, hw, hh);
    ctx.beginPath();
    ctx.moveTo(x - hw + r, y - hh);
    ctx.arcTo(x + hw, y - hh, x + hw, y + hh, r);
    ctx.arcTo(x + hw, y + hh, x - hw, y + hh, r);
    ctx.arcTo(x - hw, y + hh, x - hw, y - hh, r);
    ctx.arcTo(x - hw, y - hh, x + hw, y - hh, r);
    ctx.closePath();
  }

  function capsule(ctx, a, b, w) {
    ctx.lineCap = 'round';
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function dot(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  /* ---- colours ------------------------------------------------------------ */

  /* Each colour is a whole look, not a tint: the glass lit from the top left
   * (top) through to its deep underside (deep), a sheen of colour drifting
   * across it, a glowing edge, and eyes that suit it. Colours are [hue,
   * saturation %, lightness %]. base, dark and glow are for the swatches. */
  var SKINS = [
    { id: 'aurora', name: 'Aurora', base: '#7b6cf6', dark: '#1d2350', glow: '#7fe3ff',
      top: [262, 72, 58], mid: [248, 62, 34], deep: [232, 65, 15],
      sheen: [[190, 100, 68], [268, 100, 72], [328, 100, 70]], rim: [[190, 100, 72], [268, 95, 75], [328, 100, 74]], eye: [190, 100, 80] },
    { id: 'ocean', name: 'Ocean', base: '#2fa8e6', dark: '#0b2147', glow: '#6ff2f2',
      top: [198, 90, 56], mid: [212, 78, 32], deep: [222, 75, 14],
      sheen: [[180, 100, 65], [200, 100, 70], [230, 100, 75]], rim: [[178, 100, 70], [200, 100, 72], [225, 100, 76]], eye: [180, 100, 80] },
    { id: 'candy', name: 'Candy', base: '#f06bc4', dark: '#2c1748', glow: '#ffb3e0',
      top: [322, 85, 64], mid: [292, 58, 38], deep: [268, 58, 17],
      sheen: [[340, 100, 75], [300, 100, 74], [260, 100, 76]], rim: [[340, 100, 78], [300, 100, 76], [260, 100, 80]], eye: [330, 60, 85] },
    { id: 'sunset', name: 'Sunset', base: '#f7883a', dark: '#2d1640', glow: '#ffd27a',
      top: [26, 95, 60], mid: [348, 72, 42], deep: [282, 58, 17],
      sheen: [[40, 100, 66], [10, 100, 66], [320, 100, 70]], rim: [[42, 100, 70], [12, 100, 70], [320, 100, 74]], eye: [42, 100, 80] },
    { id: 'mint', name: 'Mint', base: '#3fd6a6', dark: '#08262f', glow: '#a0ffe0',
      top: [160, 70, 52], mid: [172, 62, 28], deep: [195, 65, 12],
      sheen: [[150, 100, 68], [175, 100, 64], [200, 100, 70]], rim: [[150, 90, 70], [175, 95, 68], [200, 100, 72]], eye: [155, 80, 80] },
    { id: 'lilac', name: 'Lilac', base: '#b58cf0', dark: '#231b3d', glow: '#e2ccff',
      top: [275, 60, 66], mid: [265, 42, 40], deep: [255, 45, 18],
      sheen: [[290, 100, 80], [260, 90, 78], [220, 90, 78]], rim: [[290, 90, 80], [260, 90, 80], [220, 90, 80]], eye: [270, 70, 85] },
    { id: 'rose', name: 'Rose', base: '#f27a96', dark: '#2e1426', glow: '#ffc2cf',
      top: [350, 80, 66], mid: [335, 52, 38], deep: [320, 50, 16],
      sheen: [[10, 100, 76], [345, 100, 74], [320, 100, 72]], rim: [[10, 100, 78], [345, 100, 76], [320, 100, 76]], eye: [345, 70, 85] },
    { id: 'midnight', name: 'Midnight', base: '#3a4166', dark: '#0b0e1c', glow: '#8fc6ff',
      top: [232, 30, 34], mid: [234, 32, 18], deep: [236, 40, 8],
      sheen: [[205, 100, 70], [255, 100, 72], [290, 100, 72]], rim: [[205, 80, 70], [255, 80, 72], [290, 80, 72]], eye: [205, 100, 80] }
  ];

  var CLOTH = {
    red:    { base: '#ff7b7b', dark: '#d9544f' },
    blue:   { base: '#7eb6ff', dark: '#4f87d9' },
    green:  { base: '#86dfa6', dark: '#4fae73' },
    yellow: { base: '#ffd86e', dark: '#d9ae3c' },
    purple: { base: '#c79bff', dark: '#9668d6' },
    dark:   { base: '#3c4458', dark: '#272d3c' },
    white:  { base: '#f2f5fb', dark: '#cdd4e0' }
  };

  /* ---- hats --------------------------------------------------------------- */

  var HATS = [
    { id: 'none', name: 'Nothing', draw: null },

    {
      id: 'beanie', name: 'Beanie', colour: 'red',
      draw: function (ctx, rig, pal) {
        var h = rig.head, c = pal.cloth;
        ctx.save();
        ctx.translate(h.x, h.y);
        ctx.rotate(rig.tilt);
        ctx.fillStyle = c.base;
        ctx.beginPath();
        ctx.arc(0, -h.r * 0.16, h.r * 0.95, Math.PI * 1.04, Math.PI * 1.96);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = c.dark;                       // the folded brim
        blob(ctx, 0, -h.r * 0.30, h.r * 0.97, h.r * 0.15, h.r * 0.12);
        ctx.fill();
        ctx.fillStyle = pal.skinGlow;                 // bobble
        dot(ctx, 0, -h.r * 1.12, h.r * 0.17);
        ctx.restore();
      }
    },

    {
      id: 'cap', name: 'Cap', colour: 'blue',
      draw: function (ctx, rig, pal) {
        var h = rig.head, c = pal.cloth;
        ctx.save();
        ctx.translate(h.x, h.y);
        ctx.rotate(rig.tilt);
        ctx.fillStyle = c.base;
        ctx.beginPath();
        ctx.arc(0, -h.r * 0.18, h.r * 0.92, Math.PI, TAU);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = c.dark;                       // peak, out to the left
        ctx.beginPath();
        ctx.ellipse(-h.r * 0.62, -h.r * 0.18, h.r * 0.62, h.r * 0.17, 0, Math.PI, TAU);
        ctx.fill();
        ctx.fillStyle = c.dark;
        dot(ctx, 0, -h.r * 1.06, h.r * 0.10);
        ctx.restore();
      }
    },

    {
      id: 'crown', name: 'Crown', colour: 'yellow',
      draw: function (ctx, rig, pal) {
        var h = rig.head, c = pal.cloth;
        ctx.save();
        ctx.translate(h.x, h.y - h.r * 0.74);
        ctx.rotate(rig.tilt);
        var w = h.r * 0.72, t = h.r * 0.40;
        ctx.fillStyle = c.base;
        ctx.beginPath();
        ctx.moveTo(-w, 0);
        ctx.lineTo(-w, -t * 0.55);
        ctx.lineTo(-w * 0.5, -t * 0.15);
        ctx.lineTo(0, -t);
        ctx.lineTo(w * 0.5, -t * 0.15);
        ctx.lineTo(w, -t * 0.55);
        ctx.lineTo(w, 0);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fff6d0';
        dot(ctx, 0, -t * 0.92, h.r * 0.07);
        ctx.restore();
      }
    },

    {
      id: 'bow', name: 'Bow', colour: 'rose',
      draw: function (ctx, rig, pal) {
        var h = rig.head;
        var c = CLOTH[pal.clothId] || { base: '#ffb3c6', dark: '#df8097' };
        ctx.save();
        ctx.translate(h.x + h.r * 0.46, h.y - h.r * 0.70);
        ctx.rotate(rig.tilt - 0.28);
        ctx.fillStyle = c.base;
        ctx.beginPath(); ctx.ellipse(-h.r * 0.22, 0, h.r * 0.22, h.r * 0.15, -0.3, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.ellipse(h.r * 0.22, 0, h.r * 0.22, h.r * 0.15, 0.3, 0, TAU); ctx.fill();
        ctx.fillStyle = c.dark;
        dot(ctx, 0, 0, h.r * 0.09);
        ctx.restore();
      }
    },

    {
      id: 'headphones', name: 'Headphones', colour: 'dark',
      draw: function (ctx, rig, pal) {
        var h = rig.head, c = pal.cloth;
        ctx.save();
        ctx.translate(h.x, h.y);
        ctx.rotate(rig.tilt);
        ctx.strokeStyle = c.base;
        ctx.lineWidth = h.r * 0.13;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, 0, h.r * 0.98, Math.PI * 1.12, Math.PI * 1.88);
        ctx.stroke();
        ctx.fillStyle = c.dark;
        blob(ctx, -h.r * 0.96, -h.r * 0.05, h.r * 0.17, h.r * 0.27, h.r * 0.12); ctx.fill();
        blob(ctx,  h.r * 0.96, -h.r * 0.05, h.r * 0.17, h.r * 0.27, h.r * 0.12); ctx.fill();
        ctx.restore();
      }
    },

    {
      id: 'antenna', name: 'Antenna', colour: 'green',
      draw: function (ctx, rig, pal) {
        var h = rig.head;
        ctx.save();
        ctx.translate(h.x, h.y);
        ctx.rotate(rig.tilt + Math.sin(rig.clock * 2.2) * 0.14);
        ctx.strokeStyle = pal.skinDark;
        ctx.lineWidth = h.r * 0.07;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(0, -h.r * 0.92);
        ctx.quadraticCurveTo(h.r * 0.10, -h.r * 1.30, 0, -h.r * 1.46);
        ctx.stroke();
        var g = ctx.createRadialGradient(0, -h.r * 1.5, 0, 0, -h.r * 1.5, h.r * 0.42);
        g.addColorStop(0, pal.cloth.base);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        dot(ctx, 0, -h.r * 1.5, h.r * 0.42);
        ctx.fillStyle = '#ffffff';
        dot(ctx, 0, -h.r * 1.5, h.r * 0.11);
        ctx.restore();
      }
    }
  ];

  /* ---- things on the face -------------------------------------------------- */

  var FACES = [
    { id: 'none', name: 'Nothing', draw: null },

    {
      id: 'glasses', name: 'Round glasses', colour: 'dark',
      draw: function (ctx, rig, pal) {
        var f = rig.face, r = f.eyeR * 1.25;
        ctx.save();
        ctx.strokeStyle = pal.cloth.base;
        ctx.lineWidth = Math.max(1.4, f.eyeR * 0.17);
        ctx.beginPath(); ctx.arc(f.x - f.eyeDx, f.eyeY, r, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(f.x + f.eyeDx, f.eyeY, r, 0, TAU); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(f.x - f.eyeDx + r, f.eyeY);
        ctx.lineTo(f.x + f.eyeDx - r, f.eyeY);
        ctx.stroke();
        ctx.restore();
      }
    },

    {
      id: 'shades', name: 'Sunglasses', colour: 'dark',
      draw: function (ctx, rig, pal) {
        var f = rig.face, w = f.eyeR * 1.5, h = f.eyeR * 1.05;
        ctx.save();
        ctx.fillStyle = pal.cloth.base;
        blob(ctx, f.x - f.eyeDx, f.eyeY, w, h, h * 0.55); ctx.fill();
        blob(ctx, f.x + f.eyeDx, f.eyeY, w, h, h * 0.55); ctx.fill();
        ctx.strokeStyle = pal.cloth.base;
        ctx.lineWidth = Math.max(1.4, f.eyeR * 0.2);
        ctx.beginPath();
        ctx.moveTo(f.x - f.eyeDx + w, f.eyeY);
        ctx.lineTo(f.x + f.eyeDx - w, f.eyeY);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.22)';     // a glint, so they read as glass
        blob(ctx, f.x - f.eyeDx - w * 0.35, f.eyeY - h * 0.3, w * 0.3, h * 0.2, h * 0.2); ctx.fill();
        ctx.restore();
      }
    }
  ];

  /* ---- clothes ------------------------------------------------------------- */

  var OUTFITS = [
    { id: 'none', name: 'Nothing', draw: null },

    {
      id: 'tee', name: 'T-shirt', colour: 'blue', sleeves: 'short',
      draw: function (ctx, rig, pal) {
        var t = rig.torso, c = pal.cloth;
        ctx.save();
        ctx.fillStyle = c.base;
        blob(ctx, t.x, t.y + t.hh * 0.12, t.hw * 1.03, t.hh * 0.86, t.hw * 0.52);
        ctx.fill();
        ctx.fillStyle = c.dark;                      // collar
        blob(ctx, t.x, t.y - t.hh * 0.66, t.hw * 0.42, t.hh * 0.13, t.hh * 0.1);
        ctx.fill();
        ctx.restore();
      }
    },

    {
      id: 'hoodie', name: 'Hoodie', colour: 'purple', sleeves: 'long',
      draw: function (ctx, rig, pal) {
        var t = rig.torso, h = rig.head, c = pal.cloth;
        ctx.save();
        // a full shape behind the head; the head covers the middle and what is
        // left reads as a hood sitting round it
        ctx.fillStyle = c.dark;
        ctx.beginPath();
        ctx.ellipse(h.x, h.y + h.r * 0.16, h.r * 1.11, h.r * 1.07, rig.tilt, 0, TAU);
        ctx.fill();
        ctx.fillStyle = c.base;
        blob(ctx, t.x, t.y + t.hh * 0.12, t.hw * 1.07, t.hh * 0.9, t.hw * 0.5);
        ctx.fill();
        ctx.strokeStyle = c.dark;                    // pocket
        ctx.lineWidth = Math.max(1.5, t.hw * 0.08);
        ctx.beginPath();
        ctx.arc(t.x, t.y + t.hh * 0.22, t.hw * 0.42, Math.PI * 0.12, Math.PI * 0.88);
        ctx.stroke();
        ctx.restore();
      }
    },

    {
      id: 'scarf', name: 'Scarf', colour: 'red',
      draw: function (ctx, rig, pal) {
        var t = rig.torso, c = pal.cloth;
        ctx.save();
        ctx.fillStyle = c.base;
        blob(ctx, t.x, t.y - t.hh * 0.72, t.hw * 0.86, t.hh * 0.19, t.hh * 0.16);
        ctx.fill();
        ctx.fillStyle = c.dark;                      // the loose end
        blob(ctx, t.x + t.hw * 0.46, t.y - t.hh * 0.18, t.hw * 0.17, t.hh * 0.46, t.hw * 0.14);
        ctx.fill();
        ctx.restore();
      }
    },

    {
      id: 'overalls', name: 'Overalls', colour: 'dark',
      draw: function (ctx, rig, pal) {
        var t = rig.torso, c = pal.cloth;
        ctx.save();
        ctx.fillStyle = c.base;
        blob(ctx, t.x, t.y + t.hh * 0.3, t.hw * 1.02, t.hh * 0.7, t.hw * 0.42);
        ctx.fill();
        ctx.strokeStyle = c.base;                    // straps over the shoulders
        ctx.lineWidth = Math.max(2, t.hw * 0.17);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(t.x - t.hw * 0.46, t.y - t.hh * 0.72);
        ctx.lineTo(t.x - t.hw * 0.40, t.y - t.hh * 0.05);
        ctx.moveTo(t.x + t.hw * 0.46, t.y - t.hh * 0.72);
        ctx.lineTo(t.x + t.hw * 0.40, t.y - t.hh * 0.05);
        ctx.stroke();
        ctx.fillStyle = c.dark;
        dot(ctx, t.x - t.hw * 0.40, t.y - t.hh * 0.02, t.hw * 0.08);
        dot(ctx, t.x + t.hw * 0.40, t.y - t.hh * 0.02, t.hw * 0.08);
        ctx.restore();
      }
    },

    {
      id: 'cape', name: 'Cape', colour: 'red', behind: true,
      draw: function (ctx, rig, pal) {
        var t = rig.torso, c = pal.cloth;
        var sway = Math.sin(rig.clock * 1.6) * t.hw * 0.18;
        ctx.save();
        ctx.fillStyle = c.dark;
        ctx.beginPath();
        ctx.moveTo(t.x - t.hw * 0.86, t.y - t.hh * 0.7);
        ctx.quadraticCurveTo(t.x - t.hw * 1.5 + sway, t.y + t.hh * 0.9,
                             t.x + sway * 1.4, t.y + t.hh * 1.5);
        ctx.quadraticCurveTo(t.x + t.hw * 1.5 + sway, t.y + t.hh * 0.9,
                             t.x + t.hw * 0.86, t.y - t.hh * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  ];

  /* ---- shoes --------------------------------------------------------------- */

  var SHOES = [
    { id: 'none', name: 'Bare feet', draw: null },

    {
      id: 'sneakers', name: 'Sneakers', colour: 'white',
      draw: function (ctx, rig, pal) {
        var c = pal.cloth;
        rig.legs.forEach(function (leg) {
          ctx.save();
          ctx.translate(leg.foot.x, leg.foot.y);
          ctx.fillStyle = c.base;
          blob(ctx, leg.side * rig.U * 0.04, 0, rig.U * 0.20, rig.U * 0.12, rig.U * 0.08);
          ctx.fill();
          ctx.fillStyle = c.dark;                    // the sole
          blob(ctx, leg.side * rig.U * 0.04, rig.U * 0.07, rig.U * 0.21, rig.U * 0.05, rig.U * 0.04);
          ctx.fill();
          ctx.restore();
        });
      }
    },

    {
      id: 'boots', name: 'Boots', colour: 'dark',
      draw: function (ctx, rig, pal) {
        var c = pal.cloth;
        rig.legs.forEach(function (leg) {
          ctx.save();
          ctx.strokeStyle = c.base;
          capsule(ctx, leg.knee, leg.foot, rig.U * 0.20);
          ctx.translate(leg.foot.x, leg.foot.y);
          ctx.fillStyle = c.base;
          blob(ctx, leg.side * rig.U * 0.05, rig.U * 0.01, rig.U * 0.21, rig.U * 0.12, rig.U * 0.07);
          ctx.fill();
          ctx.restore();
        });
      }
    }
  ];

  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }

  global.NIM_WARDROBE = {
    SKINS: SKINS,
    CLOTH: CLOTH,
    HATS: HATS,
    FACES: FACES,
    OUTFITS: OUTFITS,
    SHOES: SHOES,
    byId: byId,
    helpers: { blob: blob, capsule: capsule, dot: dot }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.NIM_WARDROBE;
}(typeof window !== 'undefined' ? window : this));
