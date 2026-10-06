'use strict';
/*
 * The Dots: what Nim is using right now, as a small row of lights under it.
 *
 * Each dot is something real - the local mind it is thinking with, its ears,
 * or the part of the computer a tool is working on. They are drawn from the one
 * shared state, so a dot lights up exactly when the runtime starts a tool in
 * its category and goes when the task is over; nothing here guesses.
 *
 * They are there only while something is happening. Idle, there are none - no
 * dots for things that are merely available, and none for what the creature
 * already shows by itself (speaking, dancing to a song).
 *
 *   active    glowing softly: in use right now
 *   waiting   ringed in amber: the question on the surface is about this
 *   failed    ringed in red
 *   done      steady: finished, until the task closes
 *   hover     names itself
 *   click     opens a small card with what it is doing and what you can do
 *
 * The window is click-through except where Nim is drawn, so the dots report
 * their own rectangles to the main process to be clickable.
 */
(function (global) {
  'use strict';

  var KINDS = {
    qwen:      { name: 'Qwen',      sub: 'local mind',   color: '#c08cff' },
    whisper:   { name: 'Ears',      sub: 'Whisper, on this PC', color: '#7fe3d0' },
    browser:   { name: 'Browser',   sub: 'the web',      color: '#5fd8ff' },
    files:     { name: 'Files',     sub: 'your files',   color: '#6ee7a8' },
    system:    { name: 'System',    sub: 'apps and PC',  color: '#8fb3ff' },
    media:     { name: 'Music',     sub: 'playback',     color: '#ff8fc8' },
    memory:    { name: 'Memory',    sub: 'remembered',   color: '#ffd36e' },
    reminders: { name: 'Reminders', sub: 'later',        color: '#ffb36e' },
    ai:        { name: 'Writing',   sub: 'composing',    color: '#d0a8ff' },
    code:      { name: 'Project',   sub: 'code',         color: '#5fe0c8' },
    vision:    { name: 'Screen',    sub: 'looking',      color: '#7fd0ff' }
  };
  var ORDER = ['whisper', 'qwen', 'browser', 'files', 'system', 'media', 'memory', 'reminders', 'ai', 'code', 'vision'];
  var GAP = 20;           // between dots, in pixels

  var STATUS_TEXT = {
    ready: 'Ready', off: 'Not running', slow: 'Working (slower mode)', unknown: 'Checking...',
    active: 'Working now', done: 'Finished', waiting: 'Waiting for you', failed: 'Failed'
  };

  function createDots(host, opts) {
    var dots = {};          // kind -> { el, status }
    var card = null, cardKind = null;
    var state = null;

    function center() { return opts.center(); }

    function ensure(kind) {
      if (dots[kind]) return dots[kind];
      var el = document.createElement('button');
      el.className = 'nim-dot';
      el.style.setProperty('--c', KINDS[kind].color);
      el.dataset.name = KINDS[kind].name;
      el.setAttribute('aria-label', KINDS[kind].name);
      el.addEventListener('click', function (e) { e.stopPropagation(); openCard(kind); });
      host.appendChild(el);
      dots[kind] = { el: el, status: 'active' };
      return dots[kind];
    }

    function remove(kind) {
      var d = dots[kind];
      if (!d) return;
      d.el.remove();
      delete dots[kind];
      if (cardKind === kind) closeCard();
    }

    /* Which dots exist follows the state exactly: what Nim is thinking with,
     * hearing with, or working on right now - and nothing else. */
    function update(s) {
      state = s;
      var want = {};
      if (s.thinkingWith === 'ollama') want.qwen = 'active';
      if (s.phase === 'transcribing') want.whisper = 'active';
      // what it is working with; a question waiting for you shows as 'waiting'
      // on the part of the computer it is about (the state marks it so)
      Object.keys(s.activity || {}).forEach(function (cat) {
        if (KINDS[cat]) want[cat] = s.activity[cat];
      });

      Object.keys(dots).forEach(function (k) { if (!(k in want)) remove(k); });
      Object.keys(want).forEach(function (k) {
        var d = ensure(k);
        d.status = want[k];
        d.el.dataset.status = want[k];
      });
      if (card) fillCard();
      layout();
    }

    /* A short row, centred under the creature, in a fixed order so a dot never
     * jumps about when another comes or goes. */
    function layout() {
      var keys = ORDER.filter(function (k) { return dots[k]; });
      var c = center();
      var boxes = [];
      keys.forEach(function (k, i) {
        var x = c.x + (i - (keys.length - 1) / 2) * GAP;
        var y = c.y;
        dots[k].el.style.transform = 'translate(' + (x - 5).toFixed(1) + 'px,' + (y - 5).toFixed(1) + 'px)';
        boxes.push({ x: x - 10, y: y - 10, w: 20, h: 20 });
      });
      if (card) {
        var r = card.getBoundingClientRect();
        boxes.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
      opts.reportHitboxes(boxes);
    }
    global.addEventListener('resize', layout);

    /* ---- the card ---------------------------------------------------------- */

    function openCard(kind) {
      if (cardKind === kind) { closeCard(); return; }
      closeCard();
      cardKind = kind;
      card = document.createElement('div');
      card.className = 'dot-card';
      card.style.setProperty('--c', KINDS[kind].color);
      host.appendChild(card);
      fillCard();
      layout();
    }

    function closeCard() {
      if (card) card.remove();
      card = null; cardKind = null;
      layout();
    }

    function fillCard() {
      var kind = cardKind, d = dots[kind];
      if (!d || !card) return;
      var s = state || {};
      var lines = [];
      var status = kind === 'qwen' ? 'active'
                 : kind === 'whisper' ? 'active'
                 : (s.activity || {})[kind] || d.status;
      lines.push('<b>' + KINDS[kind].name + '</b> <span class="sub">' + KINDS[kind].sub + '</span>');
      lines.push('<div class="st">' + escapeHtml(STATUS_TEXT[status] || status || '') + '</div>');
      if (s.task && s.task.current && s.task.current.category === kind && s.phase === 'working') {
        lines.push('<div class="now">' + escapeHtml(s.label || '') + '</div>');
      }
      if (kind === 'whisper') lines.push('<div class="now">Nothing you say leaves this computer.</div>');
      if (kind === 'qwen') lines.push('<div class="now">Thinking on this computer, with Qwen.</div>');
      var actions = [];
      if (s.phase === 'working' || s.phase === 'thinking') actions.push(['stop', 'Stop']);
      actions.push(['open', 'Open Nim']);
      card.innerHTML = lines.join('') + '<div class="acts">' + actions.map(function (a) {
        return '<button data-act="' + a[0] + '">' + a[1] + '</button>';
      }).join('') + '</div>';
      Array.prototype.forEach.call(card.querySelectorAll('button'), function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          opts.onAction(b.dataset.act, kind);
          closeCard();
        });
      });
      var c = center();
      card.style.transform = 'translate(' + Math.max(6, c.x - 100) + 'px,' + Math.max(6, c.y - 150) + 'px)';
    }

    function escapeHtml(t) {
      return String(t).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; });
    }

    document.addEventListener('click', function () { if (card) closeCard(); });

    /* What each dot is showing, for the self-test that checks the Dots agree
     * with the state. */
    function snapshot() {
      var out = {};
      Object.keys(dots).forEach(function (k) { out[k] = dots[k].status; });
      return out;
    }

    return { update: update, closeCard: closeCard, snapshot: snapshot };
  }

  global.createDots = createDots;
}(typeof window !== 'undefined' ? window : this));
