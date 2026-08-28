/* ==========================================================================
   Players Lounge — browser-side render script
   Plain classic script (NOT an ES module) so it loads over file:// with no
   server, no bundler and no network access. Exposes window.LOUNGE.

   Payload shape:
   {
     pick: { season, pickNo, round?, playerId?, playerName, managerName },
     previousMessages: [ { speakerName, speakerPlayerId, text, headshotUrl?, teamChip? } ],
     reactions:        [ { speakerPlayerId, speakerName, text, delayMs,
                           teamChip?, headshotUrl? } ],
     watermark: string,
     memberCount?: number,      // header subline override
     statusLine?: string        // status card 2nd line override
   }

   API:
     LOUNGE.render(payload)      final state, everything visible, no animation
     LOUNGE.reset(payload)       previous messages + status card only,
                                 every reaction bubble hidden
     LOUNGE.showTyping(speakerPlayerId)
     LOUNGE.hideTyping()
     LOUNGE.revealNext()         -> true if a bubble was revealed, else false
     LOUNGE.messageCount()       -> number of reaction bubbles
     LOUNGE.revealedCount()      -> number currently revealed
     LOUNGE.ready                true once the script has initialised

   Determinism contract for the Playwright driver:
   - Nothing reveals itself. There are no setTimeout/setInterval calls in this
     file. A bubble becomes visible only when revealNext() is called.
   - revealNext() always hides the typing indicator first (a bubble arriving
     is what ends "typing"), then reveals exactly one bubble.
   - The reveal transition is 150ms (see .row in lounge.css). Wait >=200ms
     before capturing a settled frame.
   - Auto-scroll is instant (scrollTop assignment), never smooth.
   ========================================================================== */

(function () {
  'use strict';

  var DEFAULT_WATERMARK = 'Players Lounge • Fantasy parody';

  /* --- deterministic monogram colour ------------------------------------
     FNV-1a 32-bit over the speaker id, indexed into a curated hue ring.
     A curated ring (rather than hash % 360) keeps every avatar inside the
     dark theme's comfortable range - muddy olive/yellow hues are excluded
     because white monogram letters wash out on them. Same id -> same hue,
     forever, with no lookup table to maintain. */
  var HUES = [352, 336, 316, 292, 268, 250, 232, 208, 190, 168, 142, 24];

  function hash32(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function hueFor(id) {
    return HUES[hash32(String(id == null ? '' : id)) % HUES.length];
  }

  function initialsFor(name) {
    var cleaned = String(name == null ? '' : name)
      .replace(/[^A-Za-zÀ-ɏ0-9'\- ]/g, ' ')
      .trim();
    if (!cleaned) return '?';
    var parts = cleaned.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    var first = parts[0].charAt(0);
    var last = parts[parts.length - 1].charAt(0);
    return (first + last).toUpperCase();
  }

  /* --- tiny DOM helpers ------------------------------------------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function $(id) { return document.getElementById(id); }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /* --- state ------------------------------------------------------------ */

  var state = {
    payload: null,
    rows: [],        // reaction rows, in order
    revealed: 0,
    speakers: {}     // speakerPlayerId -> { name, headshotUrl }
  };

  function nodes() {
    return {
      stage: $('stage'),
      scroll: $('scroll'),
      previous: $('previous'),
      status: $('status'),
      reactions: $('reactions'),
      typing: $('typing'),
      typingAvatar: $('typing-avatar'),
      title: $('lounge-title'),
      sub: $('lounge-sub-text'),
      mark: $('watermark-text')
    };
  }

  /* --- avatar ----------------------------------------------------------- */

  function buildAvatar(speakerId, speakerName, headshotUrl) {
    var hue = hueFor(speakerId);
    var av = el('div', 'avatar');
    av.style.setProperty('--h', String(hue));
    av.appendChild(el('span', 'mono', initialsFor(speakerName)));

    if (headshotUrl) {
      var img = el('img', 'shot');
      img.alt = '';
      img.decoding = 'sync';
      // Hide the monogram up front so a transparent-cutout headshot never
      // shows letters through it; fall back the moment loading fails.
      av.classList.add('has-shot');
      img.addEventListener('error', function () {
        av.classList.remove('has-shot');
        if (img.parentNode) img.parentNode.removeChild(img);
      });
      img.src = headshotUrl;
      av.appendChild(img);
    }
    return { node: av, hue: hue };
  }

  /* --- rows ------------------------------------------------------------- */

  function buildRow(msg, opts) {
    opts = opts || {};
    var row = el('div', 'row');
    if (opts.past) row.classList.add('is-past');
    if (opts.subject) row.classList.add('is-subject');

    var av = buildAvatar(msg.speakerPlayerId, msg.speakerName, msg.headshotUrl);
    row.appendChild(av.node);

    var body = el('div', 'row-body');
    var meta = el('div', 'row-meta');

    var name = el('span', 'speaker', msg.speakerName || 'Unknown');
    name.style.setProperty('--h', String(av.hue));
    meta.appendChild(name);

    var chip = chipText(msg.teamChip);
    if (chip) meta.appendChild(el('span', 'chip', chip));

    body.appendChild(meta);
    body.appendChild(el('div', 'bubble', msg.text || ''));
    row.appendChild(body);
    return row;
  }

  function chipText(chip) {
    if (!chip) return '';
    if (typeof chip === 'string') return chip.trim();
    var bits = [];
    if (chip.team) bits.push(String(chip.team));
    if (chip.position) bits.push(String(chip.position));
    return bits.join(' · ');
  }

  /* --- status card ------------------------------------------------------ */

  function buildStatusCard(pick, statusLine) {
    var p = pick || {};
    var card = el('div', 'status-card');

    var bits = ['DRAFT UPDATE'];
    if (p.round != null) bits.push('Round ' + p.round);
    if (p.pickNo != null) bits.push('Pick ' + p.pickNo);
    card.appendChild(el('div', 'status-eyebrow', bits.join(' · ')));

    var line = el('div', 'status-line');
    if (statusLine) {
      line.textContent = statusLine;
    } else {
      line.appendChild(document.createTextNode(
        (p.managerName || 'A manager') + ' selected '));
      line.appendChild(el('span', 'picked', p.playerName || 'a player'));
    }
    card.appendChild(line);
    card.appendChild(el('div', 'status-rule'));
    return card;
  }

  /* --- scrolling -------------------------------------------------------- */

  function scrollToBottom() {
    var n = nodes();
    if (n.scroll) n.scroll.scrollTop = n.scroll.scrollHeight;
  }

  /* --- population ------------------------------------------------------- */

  function indexSpeakers(payload) {
    var map = {};
    function add(m) {
      if (!m || m.speakerPlayerId == null) return;
      map[String(m.speakerPlayerId)] = {
        name: m.speakerName,
        headshotUrl: m.headshotUrl
      };
    }
    (payload.previousMessages || []).forEach(add);
    (payload.reactions || []).forEach(add);
    return map;
  }

  function populate(payload, hideReactions) {
    payload = payload || {};
    var n = nodes();

    state.payload = payload;
    state.rows = [];
    state.revealed = 0;
    state.speakers = indexSpeakers(payload);

    // header subline
    if (n.sub) {
      var members = payload.memberCount != null
        ? payload.memberCount
        : Object.keys(state.speakers).length;
      n.sub.textContent = members + ' members · draft night';
    }

    // watermark
    if (n.mark) n.mark.textContent = payload.watermark || DEFAULT_WATERMARK;

    // previous Lounge messages, dimmed
    clear(n.previous);
    (payload.previousMessages || []).forEach(function (m) {
      n.previous.appendChild(buildRow(m, { past: true }));
    });

    // draft status card
    clear(n.status);
    n.status.appendChild(buildStatusCard(payload.pick, payload.statusLine));

    // reaction bubbles
    clear(n.reactions);
    var subjectId = payload.pick && payload.pick.playerId != null
      ? String(payload.pick.playerId) : null;
    (payload.reactions || []).forEach(function (m) {
      var row = buildRow(m, {
        subject: subjectId != null && String(m.speakerPlayerId) === subjectId
      });
      if (hideReactions) row.classList.add('is-hidden');
      n.reactions.appendChild(row);
      state.rows.push(row);
    });
    if (!hideReactions) state.revealed = state.rows.length;

    hideTyping();
    scrollToBottom();
  }

  /* --- typing ----------------------------------------------------------- */

  function showTyping(speakerPlayerId) {
    var n = nodes();
    if (!n.typing || !n.typingAvatar) return;
    var info = state.speakers[String(speakerPlayerId)] || {};
    clear(n.typingAvatar);
    var av = buildAvatar(speakerPlayerId, info.name, info.headshotUrl);
    n.typingAvatar.appendChild(av.node);
    n.typing.classList.remove('is-hidden');
    scrollToBottom();
  }

  function hideTyping() {
    var n = nodes();
    if (n.typing) n.typing.classList.add('is-hidden');
  }

  /* --- reveal ----------------------------------------------------------- */

  function revealNext() {
    hideTyping();
    if (state.revealed >= state.rows.length) return false;
    var row = state.rows[state.revealed];
    state.revealed += 1;

    row.classList.add('is-entering');
    row.classList.remove('is-hidden');
    // force layout so the entering state is committed before we transition
    void row.offsetHeight;
    row.classList.remove('is-entering');

    scrollToBottom();
    return true;
  }

  /* --- public API ------------------------------------------------------- */

  window.LOUNGE = {
    render: function (payload) { populate(payload, false); },
    reset: function (payload) { populate(payload, true); },
    showTyping: showTyping,
    hideTyping: hideTyping,
    revealNext: revealNext,
    messageCount: function () { return state.rows.length; },
    revealedCount: function () { return state.revealed; },
    scrollToBottom: scrollToBottom,
    // exposed for the driver / tests
    hueFor: hueFor,
    initialsFor: initialsFor,
    ready: false
  };

  window.LOUNGE.ready = true;
})();
