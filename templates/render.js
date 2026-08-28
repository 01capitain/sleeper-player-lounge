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
                                 (the announcement is settled immediately)
     LOUNGE.reset(payload)       previous messages + announcement only,
                                 every reaction bubble hidden; the
                                 announcement plays its <=680ms entrance
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
    speakers: {}     // speakerPlayerId -> { name, headshotUrl, teamChip }
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

  /* --- draft announcement ------------------------------------------------
     The centrepiece. buildStatusCard() is the single place the card is
     built; lounge.css owns everything about how it is lit.

     Two things are read from state.speakers rather than from `pick`, because
     the payload carries them on the drafted player's own reaction row:
     his headshot and his team/position chip. Both are optional and both
     degrade on their own - no headshot falls back to the monogram plate, an
     unknown or absent team falls back to the amber house accent. */

  /* "KC · TE" | { team: 'KC' } | "" -> "KC". Anything that is not a 2-3
     letter abbreviation returns "", which leaves the card unkeyed and
     therefore on the house accent. */
  function teamAbbrev(chip) {
    if (!chip) return '';
    var raw = typeof chip === 'string' ? chip.split('·')[0] : chip.team;
    raw = String(raw == null ? '' : raw).trim().toUpperCase();
    return /^[A-Z]{2,3}$/.test(raw) ? raw : '';
  }

  /* "Travis Kelce" -> given "Travis", family "Kelce" (the hero line).
     Everything after the first token stays together, so "Marvin Harrison Jr."
     reads HARRISON JR. and a mononym keeps its single big line. */
  function splitName(name) {
    var cleaned = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    if (!cleaned) return { given: '', family: 'A Player' };
    var i = cleaned.indexOf(' ');
    if (i < 0) return { given: '', family: cleaned };
    return { given: cleaned.slice(0, i), family: cleaned.slice(i + 1) };
  }

  /* Fit `node` to its column, measured rather than guessed, so a 30-character
     surname is handled as reliably as a 5-character one.

     First choice is one line, as large as it will go. If even the floor will
     not fit on one line the text is allowed to wrap, and then takes the
     largest size whose wrapped block is still `maxLines` tall - which reads
     far better than a single line pinned at the floor.

     Runs synchronously against real layout, so the node must already be in
     the document. */
  function fitLine(node, maxPx, minPx, maxLines) {
    if (!node) return;
    node.style.whiteSpace = 'nowrap';
    node.style.fontSize = maxPx + 'px';
    var avail = node.clientWidth;
    if (!avail) {                       // not laid out (detached / hidden)
      node.style.whiteSpace = '';
      node.style.fontSize = '';
      return;
    }

    var size = shrinkToWidth(node, maxPx, minPx, avail);
    if (node.scrollWidth <= avail) return;   // one line, as big as it goes

    /* Too long for one line even at the floor, so it has to wrap - but never
       through the middle of a word. The size is capped at whatever the
       longest unbreakable run can take (a word, or one hyphenated part of
       one), which is what makes it break at the hyphen instead of chopping
       a surname in half, and then lowered until the block fits `maxLines`. */
    var style = getComputedStyle(node);
    var ratio = (parseFloat(style.lineHeight) || size) / (parseFloat(style.fontSize) || size);
    var limit = Math.max(1, maxLines || 2);
    var full = node.textContent;

    node.textContent = longestRun(full);
    size = shrinkToWidth(node, maxPx, minPx, avail);
    node.textContent = full;

    node.style.whiteSpace = 'normal';
    while (size > minPx && lineCount(node, ratio * size) > limit) {
      size -= 2;
      node.style.fontSize = size + 'px';
    }
  }

  /* Largest even px size at or below maxPx that keeps `node` on one line. */
  function shrinkToWidth(node, maxPx, minPx, avail) {
    var size = maxPx;
    node.style.fontSize = size + 'px';
    while (size > minPx && node.scrollWidth > avail) {
      size -= 2;
      node.style.fontSize = size + 'px';
    }
    return size;
  }

  /* The longest stretch of text a line break cannot fall inside. Hyphens are
     break opportunities, so "Featherstonehaugh-Wollensky" counts as two. */
  function longestRun(text) {
    var longest = '';
    String(text == null ? '' : text).split(/\s+/).forEach(function (word) {
      var segments = word.split('-');
      for (var i = 0; i < segments.length; i++) {
        var run = i < segments.length - 1 ? segments[i] + '-' : segments[i];
        if (run.length > longest.length) longest = run;
      }
    });
    return longest;
  }

  /* Rendered line count. scrollHeight overshoots line-height * lines (this
     hero is set tight, at 0.96, so glyphs spill past their line boxes), which
     is why this rounds rather than dividing exactly. */
  function lineCount(node, lineHeightPx) {
    if (!(lineHeightPx > 0)) return 1;
    return Math.max(1, Math.round(node.scrollHeight / lineHeightPx));
  }

  /* Read off the card, not the root: the density fit can lower the hero
     ceiling on the card itself, and this must see that value. */
  function cssPx(node, name, fallback) {
    var raw = getComputedStyle(node).getPropertyValue(name).trim();
    var n = parseFloat(raw);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  /** Size the hero lines to the card. Run it after the card is laid out. */
  function fitAnnouncement(card) {
    if (!card) return;
    fitLine(card.querySelector('.announce-given'),
            cssPx(card, '--fs-given', 34), cssPx(card, '--fs-given-min', 22), 2);
    fitLine(card.querySelector('.announce-family'),
            cssPx(card, '--fs-hero', 116), cssPx(card, '--fs-hero-min', 40), 2);
  }

  /**
   * Build the announcement.
   * @param pick        payload.pick
   * @param statusLine  optional override of the credit line
   * @param arriving    true on reset() — plays the entrance; render() never
   *                    passes it, so the still PNG is settled on frame one.
   */
  function buildStatusCard(pick, statusLine, arriving) {
    var p = pick || {};
    var card = el('div', 'status-card announce');
    if (arriving) card.classList.add('is-arriving');

    var subject = state.speakers[String(p.playerId)] || {};
    var team = teamAbbrev(subject.teamChip);
    if (team) card.setAttribute('data-team', team);

    /* --- light, behind everything --- */
    var lights = el('div', 'announce-stage');
    lights.setAttribute('aria-hidden', 'true');
    lights.appendChild(el('div', 'announce-beam'));
    lights.appendChild(el('div', 'announce-pool'));
    lights.appendChild(el('div', 'announce-sweep'));
    card.appendChild(lights);

    /* --- copy --- */
    var copy = el('div', 'announce-copy');

    var eyebrow = el('div', 'status-eyebrow');
    eyebrow.appendChild(el('span', 'announce-flag', 'Draft Update'));
    var bits = [];
    if (p.round != null) bits.push('Round ' + p.round);
    if (p.pickNo != null) bits.push('Pick ' + p.pickNo);
    if (bits.length) eyebrow.appendChild(el('span', 'announce-coords', bits.join(' · ')));
    copy.appendChild(eyebrow);

    var parts = splitName(p.playerName);
    var hero = el('div', 'announce-hero');
    if (parts.given) hero.appendChild(el('span', 'announce-given', parts.given));
    hero.appendChild(el('span', 'announce-family', parts.family));
    copy.appendChild(hero);

    copy.appendChild(el('div', 'status-rule'));

    var line = el('div', 'status-line');
    if (statusLine) {
      line.textContent = statusLine;
    } else {
      line.appendChild(el('span', 'announce-credit', 'Selected by'));
      line.appendChild(el('span', 'picked', p.managerName || 'a manager'));
    }
    copy.appendChild(line);
    card.appendChild(copy);

    /* --- portrait: headshot if we have one, monogram plate if not --- */
    var portrait = el('div', 'announce-portrait');
    portrait.appendChild(
      buildAvatar(p.playerId, p.playerName, subject.headshotUrl).node);
    var plate = chipText(subject.teamChip);
    if (plate) portrait.appendChild(el('div', 'announce-team', plate));
    card.appendChild(portrait);

    return card;
  }

  /* --- scrolling and density -------------------------------------------- */

  function scrollToBottom() {
    var n = nodes();
    if (n.scroll) n.scroll.scrollTop = n.scroll.scrollHeight;
  }

  /* Thread density steps, loosest first. See "density fit" in lounge.css. */
  var DENSITY_STEPS = ['is-tight', 'is-tighter', 'is-tightest'];

  /**
   * Keep the announcement on canvas.
   *
   * The thread is bottom-pinned, so a long enough set of reaction bubbles
   * pushes the announcement up behind the header. When that happens the chat
   * is tightened a step at a time — the announcement itself is never shrunk,
   * because it is the point of the export.
   *
   * Deterministic: a bounded loop over a fixed list, measured against real
   * layout, run once per populate() with every bubble present. The chosen
   * density therefore holds for the whole scene, so revealNext() can never
   * cause type to resize between two captured frames.
   */
  function fitThread() {
    var n = nodes();
    if (!n.scroll || !n.status) return;
    for (var i = 0; i < DENSITY_STEPS.length; i++) {
      n.scroll.classList.remove(DENSITY_STEPS[i]);
    }
    var card = n.status.firstElementChild;
    if (!card) return;

    for (var step = 0; step <= DENSITY_STEPS.length; step++) {
      scrollToBottom();
      if (card.getBoundingClientRect().top >=
          n.scroll.getBoundingClientRect().top) return;
      if (step < DENSITY_STEPS.length) n.scroll.classList.add(DENSITY_STEPS[step]);
    }
  }

  /* --- population ------------------------------------------------------- */

  function indexSpeakers(payload) {
    var map = {};
    function add(m) {
      if (!m || m.speakerPlayerId == null) return;
      map[String(m.speakerPlayerId)] = {
        name: m.speakerName,
        headshotUrl: m.headshotUrl,
        teamChip: m.teamChip
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

    // draft announcement (animates on reset, settled on render)
    clear(n.status);
    var card = buildStatusCard(payload.pick, payload.statusLine, hideReactions === true);
    n.status.appendChild(card);

    // reaction bubbles — built visible so the density fit below sees the
    // whole scene, then hidden again when this is a reset()
    clear(n.reactions);
    var subjectId = payload.pick && payload.pick.playerId != null
      ? String(payload.pick.playerId) : null;
    (payload.reactions || []).forEach(function (m) {
      var row = buildRow(m, {
        subject: subjectId != null && String(m.speakerPlayerId) === subjectId
      });
      n.reactions.appendChild(row);
      state.rows.push(row);
    });

    /* Size the hero, then choose the density, then size the hero again.
       The first pass is what lets fitThread() measure a realistically tall
       card - unsized, a long surname wraps at the 116px ceiling and reads as
       four lines, which would tighten the chat for no reason. The second pass
       exists because the tightest density step lowers the hero ceiling on the
       card itself; it can only ever make the card shorter than the height the
       density step was chosen against, never taller. */
    fitAnnouncement(card);
    fitThread();
    fitAnnouncement(card);

    if (hideReactions) {
      state.rows.forEach(function (row) { row.classList.add('is-hidden'); });
    } else {
      state.revealed = state.rows.length;
    }

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
