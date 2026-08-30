/* ==========================================================================
   Players Lounge - desktop draft board, browser side.

   Plain classic script (NOT an ES module) so the built file works over
   file:// with no server and no network, exactly like templates/render.js.

   IT DOES NOT TEMPLATE THE CHAT. templates/render.js is inlined immediately
   above this file and is the single source of the announcement card, the
   bubbles and the avatars. For each scene this script lends render.js the
   element ids it expects (previous / status / reactions / typing), calls
   window.LOUNGE.render(payload), then takes those ids back so the next scene
   can borrow them. The chat pane is therefore built by exactly the code the
   PNG and MP4 exports drive - a redesign of the card lands here for free.

   What this file owns: selection, filtering, scrolling, and the rewind that
   re-hides one scene's bubbles and lets them arrive again on the beats
   buildTimeline() gives the video encoder.

   Embedded contract (written by src/render/desktop.ts):
     window.__BOARD__ = {
       pickCount, sceneCount, watermark,
       scenes: [ { anchorId, eventId, pickNo, timestamp, exportCommand,
                   messageCount, payload, timeline: { events, durationMs } } ]
     }
   ========================================================================== */

(function () {
  'use strict';

  var DATA = window.__BOARD__ || { scenes: [], pickCount: 0, sceneCount: 0 };

  /** How long a jumped-to scene stays highlighted. */
  var HIGHLIGHT_MS = 1500;
  /** The lounge canvas is authored at the 1080px master width. */
  var CANVAS_WIDTH = 1080;
  /** Longest .is-arriving chain in lounge.css is 680ms. */
  var ARRIVAL_MS = 720;

  function $(id) { return document.getElementById(id); }
  function all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  var els = {
    canvas: $('lounge-canvas'),
    chatScroll: $('chat-scroll'),
    filter: $('filter'),
    scenesOnly: $('scenes-only'),
    visibleCount: $('visible-count'),
    boardEmpty: $('board-empty'),
    dock: $('dock'),
    dockIdle: $('dock-idle'),
    dockLive: $('dock-live'),
    dockNo: $('dock-no'),
    dockPlayer: $('dock-player'),
    dockMeta: $('dock-meta'),
    dockNote: $('dock-note'),
    replay: $('replay'),
    jump: $('jump'),
    exportCmd: $('export-cmd'),
    copy: $('copy'),
    chatSub: $('chat-sub-text'),
    live: $('live'),
    liveLabel: $('live-label')
  };

  var picks = all('.pick');
  var scenes = {};          // anchorId -> scene record from DATA
  var state = {
    selected: null,         // the selected .pick element
    timers: [],             // pending replay beats
    highlight: null
  };

  /* ======================================================================
     Building the transcript
     ====================================================================== */

  /**
   * Lend render.js the ids it looks up, let it build, then take them back.
   * The ids only have to be unique at the instant render() runs, which is
   * why they are stripped before the next scene is created.
   */
  function buildScenes() {
    var api = window.LOUNGE;
    if (!els.canvas || !api || !api.ready) return;

    // Build at the master width: render.js measures the hero name against its
    // real column, and that column is 1080px wide in every export.
    document.documentElement.style.setProperty('--canvas-zoom', '1');

    (DATA.scenes || []).forEach(function (scene) {
      var section = el('section', 'scene');
      section.id = scene.anchorId;
      section.setAttribute('data-pick', String(scene.pickNo));

      var thread = el('div', 'scene-thread');
      var marker = el('div', 'scene-marker');
      var label = el('span', 'scene-marker-label');
      label.textContent = 'Pick ' + scene.pickNo + ' \u00b7 ' +
        ((scene.payload && scene.payload.pick && scene.payload.pick.managerName) || '');
      marker.appendChild(label);
      marker.appendChild(el('span', 'scene-marker-rule'));
      // Formatted in Node from the Reaction's own createdAt. Absent when that
      // Reaction predates the field or carried something unparseable - the
      // scene then simply has no clock, never the words "Invalid Date".
      if (scene.timestamp) {
        marker.appendChild(el('span', 'scene-time')).textContent = scene.timestamp;
      }
      thread.appendChild(marker);

      var previous = el('div');   previous.id = 'previous';
      var status = el('div');     status.id = 'status';
      var reactions = el('div');  reactions.id = 'reactions';
      var typing = el('div', 'row is-hidden'); typing.id = 'typing';
      var typingAvatar = el('div'); typingAvatar.id = 'typing-avatar';
      var bubble = el('div', 'typing-bubble');
      bubble.setAttribute('aria-label', 'typing');
      bubble.appendChild(el('i')); bubble.appendChild(el('i')); bubble.appendChild(el('i'));
      typing.appendChild(typingAvatar);
      typing.appendChild(bubble);

      thread.appendChild(previous);
      thread.appendChild(status);
      thread.appendChild(reactions);
      thread.appendChild(typing);
      section.appendChild(thread);
      els.canvas.appendChild(section);

      // their code, their DOM, measured against a real 1080px column
      api.render(scene.payload);

      previous.parentNode.removeChild(previous);   // always empty in this view
      status.removeAttribute('id');
      status.className = 'scene-status';
      reactions.removeAttribute('id');
      reactions.className = 'scene-rows';
      typing.removeAttribute('id');
      typing.className = 'row typing-row is-hidden';
      typingAvatar.removeAttribute('id');
      typingAvatar.className = 'typing-avatar';

      // Tag each bubble with its speaker so a rewind can borrow that
      // speaker's own avatar for the typing indicator.
      var rows = reactions.children;
      (scene.payload.reactions || []).forEach(function (message, index) {
        if (rows[index]) rows[index].setAttribute('data-speaker', String(message.speakerPlayerId));
      });

      scenes[scene.anchorId] = scene;
    });

    if (DATA.watermark) {
      var mark = el('div', 'watermark');
      var span = document.createElement('span');
      span.textContent = DATA.watermark;
      mark.appendChild(span);
      els.canvas.appendChild(mark);
    }
  }

  /* ======================================================================
     Scene helpers
     ====================================================================== */

  function sceneEl(anchorId) { return anchorId ? document.getElementById(anchorId) : null; }

  function sceneRows(anchorId) {
    var scene = sceneEl(anchorId);
    return scene ? all('.scene-rows > .row', scene) : [];
  }

  function typingRow(anchorId) {
    var scene = sceneEl(anchorId);
    return scene ? scene.querySelector('.typing-row') : null;
  }

  /* ======================================================================
     Rewind - the same beats the MP4 encoder walks
     ====================================================================== */

  function clearTimers() {
    state.timers.forEach(clearTimeout);
    state.timers = [];
  }

  function resetScene(anchorId, arriving) {
    sceneRows(anchorId).forEach(function (row) { row.classList.add('is-hidden'); });
    hideTyping(anchorId);
    if (!arriving) return;
    // Replay the card's entrance too: lounge.css drives it entirely from
    // .is-arriving, which reset() adds and render() never does.
    var card = sceneEl(anchorId) ? sceneEl(anchorId).querySelector('.status-card') : null;
    if (!card) return;
    card.classList.remove('is-arriving');
    void card.offsetHeight;
    card.classList.add('is-arriving');
    state.timers.push(setTimeout(function () {
      card.classList.remove('is-arriving');
    }, ARRIVAL_MS));
  }

  function showScene(anchorId) {
    sceneRows(anchorId).forEach(function (row) {
      row.classList.remove('is-hidden');
      row.classList.remove('is-entering');
    });
    hideTyping(anchorId);
  }

  function showTyping(anchorId, speakerPlayerId) {
    var scene = sceneEl(anchorId);
    var row = typingRow(anchorId);
    if (!scene || !row) return;
    var slot = row.querySelector('.typing-avatar');
    var source = scene.querySelector(
      '.scene-rows > .row[data-speaker="' + cssEscape(String(speakerPlayerId)) + '"] .avatar'
    );
    if (slot) {
      while (slot.firstChild) slot.removeChild(slot.firstChild);
      if (source) slot.appendChild(source.cloneNode(true));
    }
    row.classList.remove('is-hidden');
    keepInView(row);
  }

  function hideTyping(anchorId) {
    var row = typingRow(anchorId);
    if (row) row.classList.add('is-hidden');
  }

  function revealNext(anchorId) {
    hideTyping(anchorId);
    var rows = sceneRows(anchorId);
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].classList.contains('is-hidden')) continue;
      var row = rows[i];
      row.classList.add('is-entering');
      row.classList.remove('is-hidden');
      void row.offsetHeight;      // commit the entering state, then transition
      row.classList.remove('is-entering');
      keepInView(row);
      return true;
    }
    return false;
  }

  function keepInView(row) {
    if (!row || !row.scrollIntoView) return;
    try {
      row.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    } catch (e) {
      row.scrollIntoView(false);
    }
  }

  function replay(anchorId) {
    var scene = scenes[anchorId];
    if (!scene || !scene.timeline) return;
    clearTimers();
    jumpTo(anchorId, true);
    resetScene(anchorId, true);

    (scene.timeline.events || []).forEach(function (ev) {
      state.timers.push(setTimeout(function () {
        var action = ev.action || {};
        if (action.kind === 'reset') resetScene(anchorId, true);
        else if (action.kind === 'showTyping') showTyping(anchorId, action.speakerPlayerId);
        else if (action.kind === 'hideTyping') hideTyping(anchorId);
        else if (action.kind === 'reveal') revealNext(anchorId);
      }, ev.atMs));
    });

    // However the timeline ends, the scene ends complete: a rewind must never
    // leave the transcript missing bubbles.
    state.timers.push(setTimeout(function () {
      showScene(anchorId);
      // A reload mid-replay would cut the beats off, so the countdown only
      // resumes once the scene has finished playing.
      live.busy = false;
      resetCountdown();
    }, (scene.timeline.durationMs || 0) + 80));

    live.busy = true;
    renderLive();
  }

  /* ======================================================================
     Selection
     ====================================================================== */

  /**
   * Smooth is legible for a nearby scene and useless for a distant one: the
   * transcript is tens of thousands of pixels tall, and gliding across all of
   * it takes seconds the reader did not ask for. Anything further than a
   * couple of screens jumps, and the highlight is what says "you are here".
   */
  function scrollBehaviourFor(scene, instant) {
    if (instant) return 'instant';
    var view = els.chatScroll ? els.chatScroll.clientHeight : 0;
    var offset = Math.abs(scene.getBoundingClientRect().top);
    return view > 0 && offset > view * 2.5 ? 'instant' : 'smooth';
  }

  function jumpTo(anchorId, instant) {
    var scene = sceneEl(anchorId);
    if (!scene) return;
    all('.scene.is-selected').forEach(function (s) { s.classList.remove('is-selected'); });
    scene.classList.add('is-selected');

    // Positioned by measurement rather than scrollIntoView: the canvas is
    // zoomed, and both rects are in the same visual space, so the delta is
    // exact where scrollIntoView's own alignment is not.
    var scroller = els.chatScroll;
    if (scroller) {
      var delta = scene.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      var top = Math.max(0, scroller.scrollTop + delta - 10);
      try {
        scroller.scrollTo({ top: top, behavior: scrollBehaviourFor(scene, instant) });
      } catch (e) {
        scroller.scrollTop = top;
      }
    }
    clearTimeout(state.highlight);
    scene.classList.add('is-target');
    state.highlight = setTimeout(function () {
      scene.classList.remove('is-target');
    }, HIGHLIGHT_MS);
  }

  /**
   * Select a pick, and - only when asked - take the transcript to it.
   *
   * A click asks (opts.jump): going to a player's chat is the whole reason to
   * click him, and making that two actions was busywork. Arrowing does not:
   * running down a list of two hundred picks must not fling the transcript
   * around, so the keyboard browses the board and Enter is what commits.
   */
  function select(pick, opts) {
    opts = opts || {};
    if (!pick) return;
    if (state.selected) state.selected.classList.remove('is-selected');
    state.selected = pick;
    pick.classList.add('is-selected');
    if (opts.scrollBoard !== false) {
      try {
        pick.scrollIntoView({ behavior: opts.instant ? 'instant' : 'smooth', block: 'nearest' });
      } catch (e) {
        pick.scrollIntoView(false);
      }
    }
    fillDock(pick);
    if (opts.jump) jumpToPick(pick, opts.instant === true);
    syncLiveToSelection();
  }

  /**
   * Take the transcript to a pick's scene. A pick with no Reaction has nothing
   * to go to, so the chat stays exactly where the reader left it.
   */
  function jumpToPick(pick, instant) {
    if (!pick) return;
    var anchorId = pick.getAttribute('data-anchor');
    if (!anchorId) {
      all('.scene.is-selected').forEach(function (s) { s.classList.remove('is-selected'); });
      return;
    }
    clearTimers();
    showScene(anchorId);
    jumpTo(anchorId, instant === true);
  }

  function fillDock(pick) {
    var anchorId = pick.getAttribute('data-anchor');
    var scene = anchorId ? scenes[anchorId] : null;
    els.dockIdle.hidden = true;
    els.dockLive.hidden = false;
    els.dock.setAttribute('data-state', scene ? 'scene' : 'no-scene');

    els.dockNo.textContent = '#' + pick.getAttribute('data-pick');
    els.dockPlayer.textContent = pick.getAttribute('data-player') || '';
    els.dockMeta.textContent = pick.getAttribute('data-summary') || '';

    while (els.dockNote.firstChild) els.dockNote.removeChild(els.dockNote.firstChild);

    if (scene) {
      els.replay.disabled = false;
      els.jump.disabled = false;
      els.copy.disabled = false;
      els.copy.hidden = false;
      els.exportCmd.hidden = false;
      els.exportCmd.textContent = scene.exportCommand;
      els.dockNote.textContent =
        scene.messageCount + ' message' + (scene.messageCount === 1 ? '' : 's') + ' \u00b7 ' +
        (Math.round((scene.timeline.durationMs || 0) / 100) / 10) + 's on the export timeline';
    } else {
      els.replay.disabled = true;
      els.jump.disabled = true;
      els.copy.disabled = true;
      els.copy.hidden = true;
      els.exportCmd.hidden = true;
      els.exportCmd.textContent = '';
      els.dockNote.appendChild(
        document.createTextNode('No Lounge scene for this pick yet \u2014 direct one with '));
      var code = el('span', 'cmd-inline');
      code.textContent = pick.getAttribute('data-hint') || '';
      els.dockNote.appendChild(code);
      els.dockNote.appendChild(document.createTextNode(', then rebuild the board.'));
    }
  }

  /* ======================================================================
     Clipboard - file:// is not a secure context, so the fallback is the
     path that actually runs here.
     ====================================================================== */

  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ======================================================================
     Filtering
     ====================================================================== */

  function applyFilter() {
    var needle = (els.filter && els.filter.value ? els.filter.value : '').trim().toLowerCase();
    var scenesOnly = !!(els.scenesOnly && els.scenesOnly.checked);
    var visible = 0;

    picks.forEach(function (pick) {
      var haystack = pick.getAttribute('data-search') || '';
      var hit = (!needle || haystack.indexOf(needle) !== -1) &&
                (!scenesOnly || pick.hasAttribute('data-anchor'));
      pick.classList.toggle('is-filtered', !hit);
      if (hit) visible += 1;
    });

    all('.round').forEach(function (round) {
      var any = all('.pick', round).some(function (p) {
        return !p.classList.contains('is-filtered');
      });
      round.classList.toggle('is-empty', !any);
    });

    if (els.boardEmpty) els.boardEmpty.hidden = visible !== 0;
    if (els.visibleCount) {
      els.visibleCount.textContent = visible === DATA.pickCount
        ? DATA.pickCount + ' picks'
        : visible + ' / ' + DATA.pickCount + ' picks';
    }
  }

  /* ======================================================================
     Keyboard
     ====================================================================== */

  function visiblePicks() {
    return picks.filter(function (p) { return !p.classList.contains('is-filtered'); });
  }

  function step(delta) {
    var list = visiblePicks();
    if (list.length === 0) return;
    var index = state.selected ? list.indexOf(state.selected) : -1;
    var next = index === -1
      ? (delta > 0 ? 0 : list.length - 1)
      : Math.min(list.length - 1, Math.max(0, index + delta));
    select(list[next]);
  }

  function onKeydown(event) {
    var typing = event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName || '');
    if (event.key === '/' && !typing) {
      event.preventDefault();
      if (els.filter) els.filter.focus();
      return;
    }
    if (typing) {
      if (event.key === 'Escape' && els.filter) {
        els.filter.value = '';
        els.filter.blur();
        applyFilter();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); step(1); }
    else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); step(-1); }
    else if (event.key === 'Enter' && state.selected) {
      // Enter commits the arrow-key browse. preventDefault stops the focused
      // pick button firing its own click, which would select a different row
      // than the one the arrows landed on.
      event.preventDefault();
      jumpToPick(state.selected, false);
    }
    else if (event.key === 'r' && state.selected) {
      var anchorId = state.selected.getAttribute('data-anchor');
      if (anchorId) replay(anchorId);
    }
  }

  /** querySelector needs numeric ids escaped. */
  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return value.replace(/["\\]/g, '\\$&');
  }

  /* ======================================================================
     Fit and boot
     ====================================================================== */

  function fitCanvas() {
    if (!els.canvas || !els.chatScroll) return;
    var width = els.chatScroll.clientWidth;
    if (!width) return;
    document.documentElement.style.setProperty(
      '--canvas-zoom', String(Math.max(0.2, width / CANVAS_WIDTH))
    );
  }

  /* ======================================================================
     Live refresh

     The board is a static file with no server, so it cannot be told that a
     pick landed — it can only reload and find out. `lounge watch --board`
     rewrites the file after every pick; this reloads it on a timer.

     The whole design problem is that a reload is destructive to whatever the
     reader is doing. Three rules keep it out of the way:

       - Reading an older scene pauses it. Selecting anything that is not the
         newest pick means the reader went looking for something, and yanking
         them back to the newest pick mid-read is the one unforgivable
         behaviour here. Returning to the newest pick resumes.
       - Replaying pauses it, and the replay's own beats resume it.
       - The selected pick rides in location.hash, so a reload that DOES
         happen while something is selected comes back to it rather than
         jumping to the newest.
     ====================================================================== */

  var live = {
    seconds: Number(DATA.refreshSeconds) || 0,
    timer: null,
    remaining: 0,
    paused: false,
    /** Set while a replay is running, so its beats are never cut off. */
    busy: false
  };

  function liveEnabled() { return live.seconds > 0 && els.live; }

  function renderLive() {
    if (!liveEnabled()) return;
    var paused = live.paused || live.busy;
    els.live.classList.toggle('is-paused', paused);
    els.live.setAttribute('aria-pressed', paused ? 'false' : 'true');
    if (els.liveLabel) {
      els.liveLabel.textContent = paused ? 'Paused' : 'Live ' + live.remaining + 's';
    }
  }

  function liveTick() {
    if (live.paused || live.busy) { renderLive(); return; }
    live.remaining -= 1;
    if (live.remaining > 0) { renderLive(); return; }
    // Carry the selection across the reload so we come back where we were.
    var anchorId = state.selected && state.selected.getAttribute('data-anchor');
    try {
      location.replace(anchorId ? '#' + anchorId : location.pathname + location.search);
      location.reload();
    } catch (e) {
      location.reload();
    }
  }

  function resetCountdown() {
    live.remaining = live.seconds;
    renderLive();
  }

  function setPaused(paused) {
    live.paused = paused;
    if (!paused) resetCountdown();
    else renderLive();
  }

  /** Pause while the reader is on anything but the newest pick. */
  function syncLiveToSelection() {
    if (!liveEnabled()) return;
    var newest = null;
    picks.forEach(function (p) { if (p.hasAttribute('data-anchor')) newest = p; });
    setPaused(state.selected !== null && state.selected !== newest);
  }

  function startLive() {
    if (!liveEnabled()) return;
    els.live.hidden = false;
    resetCountdown();
    live.timer = setInterval(liveTick, 1000);
    els.live.addEventListener('click', function () { setPaused(!live.paused); });
    // A hidden tab should not spend the countdown; coming back should not
    // reload instantly either, so the countdown simply restarts.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) resetCountdown();
    });
  }

  function boot() {
    buildScenes();
    fitCanvas();
    window.addEventListener('resize', fitCanvas);

    picks.forEach(function (pick) {
      pick.addEventListener('click', function () { select(pick, { jump: true }); });
    });

    if (els.filter) els.filter.addEventListener('input', applyFilter);
    if (els.scenesOnly) els.scenesOnly.addEventListener('change', applyFilter);

    if (els.replay) {
      els.replay.addEventListener('click', function () {
        if (!state.selected) return;
        var anchorId = state.selected.getAttribute('data-anchor');
        if (anchorId) replay(anchorId);
      });
    }
    if (els.jump) {
      els.jump.addEventListener('click', function () {
        jumpToPick(state.selected, false);
      });
    }
    if (els.copy) {
      els.copy.addEventListener('click', function () {
        var text = els.exportCmd ? els.exportCmd.textContent : '';
        var label = els.copy.textContent;
        copyText(text).then(function (ok) {
          els.copy.textContent = ok ? 'Copied' : 'Select it';
          setTimeout(function () { els.copy.textContent = label; }, 1400);
        });
      });
    }

    document.addEventListener('keydown', onKeydown);

    if (els.chatSub) {
      els.chatSub.textContent = DATA.sceneCount + ' scene' +
        (DATA.sceneCount === 1 ? '' : 's') + ' \u00b7 draft night';
    }

    applyFilter();

    // Land on the newest scene: that is the activity a reader came for. Unless
    // a live refresh put an anchor in the hash, which means the reader was
    // already somewhere specific and the reload should be invisible to them.
    var lastScene = null;
    picks.forEach(function (p) { if (p.hasAttribute('data-anchor')) lastScene = p; });

    var wanted = null;
    var hash = (location.hash || '').replace(/^#/, '');
    if (hash) {
      picks.forEach(function (p) {
        if (p.getAttribute('data-anchor') === hash) wanted = p;
      });
    }
    var landing = wanted || lastScene;
    if (landing) select(landing, { instant: true, jump: true });

    startLive();

    document.documentElement.setAttribute('data-board-ready', 'true');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
