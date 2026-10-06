'use strict';
/*
 * The floating surface: the part of Nim that talks in words.
 *
 * It is not a panel that appears. It is the light above Nim's head growing:
 * collapsed, it is that light; when Nim has something to say it rises and
 * stretches into a pill, grows into a card if there is more to show, and folds
 * back into the light when it is done. Width, height, position and openness are
 * all springs - the same physics the creature's body uses - so every change of
 * shape is one continuous movement rather than a box swapping for another box.
 *
 * It lives in Nim's own window, anchored to the creature, so wherever you drag
 * Nim it comes along; and a thin thread always ties it back to the head.
 *
 * What it shows comes from surface-model.js, which reads the one shared state.
 * This file only draws: content, shape, motion, and which rectangle is
 * clickable (the window is click-through everywhere else).
 */
(function (global) {
  'use strict';

  var GAP = 30;            // between the bottom of the surface and the light
  var MAX_W = 292;
  var DOT = 10;            // the collapsed size: about the size of the light itself
  var EDGE = 8;

  /* A damped spring in pixels per second. Stiff enough to feel quick, damped
   * just under critical so a change of shape settles with the faintest give. */
  function Spring(v, k, d) { this.v = v; this.t = v; this.vel = 0; this.k = k || 260; this.d = d || 26; }
  Spring.prototype.step = function (dt) {
    var a = (this.t - this.v) * this.k - this.vel * this.d;
    this.vel += a * dt;
    this.v += this.vel * dt;
  };
  Spring.prototype.snap = function (v) { this.v = this.t = v; this.vel = 0; };
  Spring.prototype.settled = function () { return Math.abs(this.t - this.v) < 0.3 && Math.abs(this.vel) < 2; };

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function createSurface(host, opts) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'surface-thread');
    var thread = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(thread);
    host.appendChild(svg);

    var shell = el('div', 'surface', host);
    var inner = el('div', 'surface-inner', shell);
    var row = el('div', 'surface-row', inner);
    var glyph = el('span', 'surface-glyph', row);
    var title = el('span', 'surface-title', row);
    var meta = el('span', 'surface-meta', row);
    var detail = el('div', 'surface-detail', inner);
    var meter = el('div', 'surface-meter', inner);
    for (var i = 0; i < 18; i++) el('i', '', meter);
    var bar = el('div', 'surface-bar', inner);
    var fill = el('i', '', bar);
    var input = el('input', 'surface-input', inner);
    input.type = 'text';
    input.placeholder = 'Ask Nim to do something...';
    input.autocomplete = 'off';
    input.spellcheck = false;
    var actions = el('div', 'surface-actions', inner);

    // the shape: where the bottom-centre sits, how big it is, how open it is
    var x = new Spring(0, 240, 26), y = new Spring(0, 240, 26);
    var w = new Spring(DOT, 300, 27), h = new Spring(DOT, 300, 27);
    var open = new Spring(0, 200, 24);
    var current = { mode: 'hidden' };
    var natural = { w: DOT, h: DOT };
    var shown = false, seeded = false, last = 0, focused = false;

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { opts.onAction('dismiss'); return; }
      if (e.key !== 'Enter') return;
      var text = input.value.trim();
      input.value = '';
      if (text) opts.onSubmit(text); else opts.onAction('dismiss');
    });

    function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

    /* The content is laid out at its natural size, off to one side, and the
     * springs then carry the shell to that size - the content never jumps. */
    function measure() {
      // laid out at its own natural width (up to the most the surface can be),
      // not squeezed into the shell's current size - which mid-animation is the
      // size of a dot - then fixed there while the shell springs to fit it
      inner.style.width = 'max-content';
      inner.style.maxWidth = (MAX_W - 2) + 'px';
      var r = inner.getBoundingClientRect();
      var w = Math.min(MAX_W, Math.max(current.input ? MAX_W : 120, Math.ceil(r.width) + 2));
      inner.style.width = (w - 2) + 'px';
      natural = { w: w, h: Math.ceil(inner.getBoundingClientRect().height) + 2 };
    }

    function update(v) {
      var was = current.mode;
      current = v;
      shell.dataset.mode = v.mode;
      setText(glyph, v.glyph || '');
      glyph.style.display = v.glyph ? '' : 'none';
      setText(title, v.title || '');
      title.style.display = v.title ? '' : 'none';
      setText(meta, v.meta || '');
      meta.style.display = v.meta ? '' : 'none';
      row.style.display = v.glyph || v.title || v.meta ? '' : 'none';
      setText(detail, v.detail || '');
      detail.style.display = v.detail ? '' : 'none';
      meter.style.display = v.meter ? '' : 'none';
      bar.style.display = v.progress ? '' : 'none';
      if (v.progress) fill.style.width = Math.round(100 * v.progress.done / Math.max(1, v.progress.total)) + '%';
      input.style.display = v.input ? '' : 'none';

      var key = (v.actions || []).map(function (a) { return a[0]; }).join(',');
      if (actions.dataset.key !== key) {
        actions.dataset.key = key;
        actions.innerHTML = '';
        (v.actions || []).forEach(function (a) {
          var b = el('button', 'surface-btn ' + a[0], actions);
          b.textContent = a[1];
          b.addEventListener('click', function (e) { e.stopPropagation(); opts.onAction(a[0]); });
        });
      }
      actions.style.display = (v.actions || []).length ? '' : 'none';

      var visible = v.mode !== 'hidden';
      if (visible) {
        if (!shown) {
          // grow out of the light: start as the light itself
          var a = opts.anchor();
          x.snap(a.x); y.snap(a.y); w.snap(DOT); h.snap(DOT); open.snap(0);
          shown = true;
          shell.style.display = '';
          svg.style.display = '';
        }
        measure();                     // laid out only once it is displayed
      }
      open.t = visible ? 1 : 0;

      // typing needs the keyboard; everything else must leave it where it is
      var wantFocus = !!v.input;
      if (wantFocus !== focused) {
        focused = wantFocus;
        opts.focus(wantFocus);
        if (wantFocus) setTimeout(function () { input.focus(); }, 60);
        else input.blur();
      }
      if (was !== v.mode && opts.onModeChange) opts.onModeChange(v.mode, was);
    }

    function setLevel(v) {
      if (!current.meter) return;
      var bars = meter.children;
      for (var i = 0; i < bars.length; i++) {
        var from = Math.abs(i - (bars.length - 1) / 2) / ((bars.length - 1) / 2);
        bars[i].style.height = Math.max(10, Math.min(100, v * 120 * (1 - from * 0.55))) + '%';
      }
    }

    function frame(now) {
      var dt = Math.min(0.033, (now - (last || now)) / 1000);
      last = now;
      if (shown) {
        var a = opts.anchor();
        var bounds = opts.bounds();
        var visible = open.t > 0.5;
        var tw = visible ? natural.w : DOT;
        var th = visible ? natural.h : DOT;
        // sit above the light, centred on it, but never past the window's edge
        var tx = Math.max(EDGE + tw / 2, Math.min(bounds.w - EDGE - tw / 2, a.x));
        var ty = visible ? Math.max(EDGE + th, a.y - GAP) : a.y;
        x.t = tx; y.t = ty; w.t = tw; h.t = th;
        if (!seeded) { x.snap(tx); y.snap(ty); seeded = true; }
        [x, y, w, h, open].forEach(function (s) { s.step(dt); });

        var o = Math.max(0, Math.min(1, open.v));
        var ww = Math.max(DOT, w.v), hh = Math.max(DOT, h.v);
        shell.style.width = ww.toFixed(1) + 'px';
        shell.style.height = hh.toFixed(1) + 'px';
        shell.style.transform = 'translate(' + (x.v - ww / 2).toFixed(1) + 'px,' + (y.v - hh).toFixed(1) + 'px)';
        shell.style.borderRadius = Math.min(hh / 2, 18).toFixed(1) + 'px';
        shell.style.opacity = Math.min(1, o * 1.6).toFixed(3);
        inner.style.opacity = Math.max(0, (o - 0.55) / 0.45).toFixed(3);

        // the thread from the surface back to the light, slack as it moves
        var bx = x.v, by = y.v, mx = (bx + a.x) / 2 + (x.vel * 0.02), my = (by + a.y) / 2;
        thread.setAttribute('d', 'M' + bx.toFixed(1) + ' ' + by.toFixed(1) +
                                 ' Q' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1));
        thread.style.opacity = (o * 0.55).toFixed(3);

        opts.reportBox(o > 0.3 ? { x: x.v - ww / 2, y: y.v - hh, w: ww, h: hh } : null);

        // fully folded back into the light: stop drawing it at all
        if (open.t === 0 && o < 0.02 && w.settled()) {
          shown = false; seeded = false;
          shell.style.display = 'none';
          svg.style.display = 'none';
          opts.reportBox(null);
        }
      }
      global.requestAnimationFrame(frame);
    }
    shell.style.display = 'none';
    svg.style.display = 'none';
    global.requestAnimationFrame(frame);

    return {
      update: update,
      setLevel: setLevel,
      get mode() { return current.mode; },
      get open() { return open.v; }
    };
  }

  global.createSurface = createSurface;
}(typeof window !== 'undefined' ? window : this));
