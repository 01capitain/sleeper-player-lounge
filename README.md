# Players Lounge

A local-first companion for the **hotelkit Fantasies** Sleeper slow draft. Every draft pick
becomes a scene in a fictional NFL group chat — the drafted player reacts, teammates pile on,
and a recurring cast of stars comments — rendered as a shareable PNG, GIF or MP4.

Nothing is posted automatically. You export an asset and drop it in the real league chat yourself.

## How it works

```
Sleeper API → pick detector → Context builder → Director (claude -p) → Reaction JSON
                                                                            ↓
                                                    HTML → Playwright → PNG / MP4 / GIF
```

The LLM is **not** the memory. Local files are. Every fact a player is allowed to reference
must be present in the Context assembled for that pick; anything absent cannot be said.

## Run it

```bash
npm install
npx playwright install chromium
npm run demo
```

That is the whole thing. `demo` runs `setup` for you if it has never run, picks a draft
pick worth looking at (Kyle Pitts, Travis Kelce or Aaron Rodgers — it says which and why),
generates the scene, renders a PNG in about three seconds, prints the dialogue and opens
the image.

No API key is needed. Sleeper's read API is public, and the Director runs through your
existing Claude Code authentication.

```bash
npm run demo -- --stub --no-open    # no Director call, no window
npm run demo -- --pick 229          # Aaron Rodgers, 82 picks past his ADP
npm run demo -- --format mp4        # the animated version instead
```

## Commands

Everything below is `npm run lounge -- <command>`. Add `--verbose` to any of them for
debug logging on stderr; stdout only ever carries content, so piping it is safe.

| Command | What it does |
|---|---|
| `demo` | The one to run first. Sets up, directs one scene, renders it, opens it. |
| `setup` | Discover leagues, select the Simulation draft, cache players, normalize picks. |
| `simulate` | Replay stored Picks through the full pipeline. |
| `react` | Re-render an existing Reaction in another format. Never calls the Director. |
| `screenshot` | `react --format png`. |
| `board` | Build the desktop draft board: every pick beside the whole Lounge transcript. |
| `watch` | Poll the live slow draft and process new Picks as they land. |
| `history import` | Build Fantasy Memory: 2025 rosters and championship rosters. |

```bash
npm run demo                                     # start here

npm run lounge -- setup                          # --force to bypass every cache
npm run lounge -- simulate --next                # next pick after the last processed one
npm run lounge -- simulate --pick 74             # 74 = Kyle Pitts
npm run lounge -- simulate --all --limit 5       # batch; shares one chromium
npm run lounge -- simulate --next --alias        # map draft slots onto hotelkit managers
npm run lounge -- simulate --next --no-render    # generate and persist only

npm run lounge -- react --latest --format mp4
npm run lounge -- react --latest --format html  # animates in a browser, one self-contained file    # never calls the Director
npm run lounge -- react --pick 74 --format gif
npm run lounge -- screenshot --latest

npm run lounge -- board                          # -> output/board.html
npm run lounge -- board --open                   # build it and open it
npm run lounge -- board --limit 60               # only the last 60 picks
npm run lounge -- board --out /tmp/draft.html

npm run lounge -- watch                          # poll every 25s until Ctrl-C
npm run lounge -- watch --once                   # one poll, then exit
npm run lounge -- watch --league <id> --interval 30

npm run lounge -- history import                 # the Simulation league chain
npm run lounge -- history import --target        # hotelkit Fantasies instead
npm run lounge -- history import --league <id>
```

### The draft board

`board` writes one self-contained HTML file — `output/board.html` by default — that puts the
whole draft on a desktop page: the board on the left, the entire Lounge transcript on the
right.

- **Every pick is listed**, grouped by round, with its position, NFL team and drafting
  manager. There is no ADP column: ADP still drives the Director's reach/slide signals, but
  during a live draft the difference to a preseason average is not what you are looking at.
- **Picks that have a Reaction are marked `Scene`.** Clicking one selects it *and* jumps the
  transcript to that pick's announcement, briefly highlighting it. Picks with no Reaction are
  still shown, greyed and inert against the transcript; selecting one tells you the
  `simulate --pick N` that would direct it.
- **The chat says who owns him now.** A speaker the draft has already claimed wears his
  fantasy manager — `RB · Bark to the Kamara` — instead of his NFL club. A player still on the
  board keeps the usual `KC · TE`, and a scene never shows an owner from a *later* pick.
- **Every message is timestamped.** Each scene carries a `28 Aug 2026 · 18:15` header and each
  bubble an `HH:MM`, read from the Reaction's `createdAt` plus that message's own `delayMs`, so
  the clock ascends exactly as the animation does. Reactions stored without a `createdAt`
  simply have no clock.
- **Replay** re-animates the selected scene on the *same* `buildTimeline()` beats the MP4
  encoder walks, so a rewind shows what an export would produce — down to the announcement
  card's entrance.
- The selected pick's export command (`npm run lounge -- react --pick N --format mp4`) sits in
  the dock with a copy button.
- Keyboard: `↑`/`↓` move *without* moving the transcript, `↵` jumps to the selected pick's
  chat, `R` replays, `/` focuses the filter. There is also a *Lounge scenes only* toggle.

The chat pane is not a re-implementation: `templates/lounge.css` and `templates/render.js` are
inlined at build time and build the transcript, so it is exactly the renderer the PNG and MP4
exports drive. **The board changes nothing about those exports** — they remain chat-only,
1080x1920, one scene per file. The owner chip and the per-message clock are opt-in payload
fields (`pick.teamChip`, `reactions[].timestamp`) that only the board ever sets, so a PNG or
MP4 is byte-for-byte what it was before either existed. Like the `html` format, the page is fully inlined and makes zero
network requests, so it can be moved, emailed or shared as-is.

### `--stub`

`demo`, `simulate` and `watch` all accept `--stub`, which runs the pipeline without invoking
the Director: the `claude -p` subprocess is swapped for a deterministic canned one. Same
pipeline, same renderer, same files on disk, offline and repeatable. It is how the test suite
exercises the pipeline, and it is the right way to check a render change.

### Watching a live draft

`watch` compares the draft against `state.lastProcessedPickNo` and processes anything new in
ascending **pick number** — Sleeper picks carry no timestamp, so there is no arrival order to
sort by. Every Pick is deduped by its `eventId` (`{draftId}:{pickNo}:{playerId}`), which is
recorded on disk, so restarting the watcher never re-reacts to a pick. A `pre_draft` league is
not an error: the watcher says so and waits. Ctrl-C finishes the pick in flight, closes
chromium and exits cleanly.

## Documentation

| File | What it holds |
|---|---|
| `CONTEXT.md` | Domain glossary — the project's ubiquitous language |
| `implementation_plan.md` | The original build plan and milestone order |
| `docs/adr/` | Architectural decisions and why they were made |
| `docs/sleeper-facts.md` | Verified live API ids and response shapes |
| `docs/director_prompt.md` | The director's behavioural contract |
| `docs/render_spec.md` | Renderer specification |
| `prompts/director.system.md` | The system prompt actually sent at runtime |

## Product rules

These are requirements, not preferences. They are enforced by the test suite.

- The drafted player always reacts.
- Between 2 and 6 messages per pick.
- **2025** is the only ordinary fantasy-roster history. 2024 and earlier is invisible.
- Except championship-roster membership, which is remembered from any season.
- Any message drawing on fantasy history must name the season as a four-digit year.
- A player who disappointed his 2025 manager may hope 2026 goes better.
- Kyle Pitts carries permanent league-specific bust lore, independent of statistics.
- Travis Kelce makes Taylor Swift references but never quotes lyrics.
- Reprocessing the same pick never produces a duplicate reaction.
- This is a fictional parody interface, not a replica of Sleeper's UI.

## Output formats

Every format is produced from the same stored Reaction, so switching format
never re-invokes the Director.

| Format | What it is |
|---|---|
| `png` | The final chat state. Fastest, and the demo default. |
| `mp4` | H.264 / yuv420p, 1080x1920. The preferred thing to share. |
| `gif` | Downscaled to 540px for chat clients that prefer GIFs. |
| `html` | One self-contained file that animates in a browser. |

The `html` build plays the **same timeline the MP4 encoder uses**, so it is the
quickest way to judge pacing before committing to an encode. CSS, JavaScript,
the payload and the headshots are all inlined, so the file works from `file://`
with no server and no network — you can move it, email it or drop it in a shared
folder and it still plays. It has Replay and Show-final controls and scales to
the window.

## The board writes a directory, not a file

`lounge board` writes `output/board.html` plus an `output/headshots/` folder it
references relatively. Keep them together, or move them together.

This differs deliberately from `--format html`, which inlines its headshots as
data URIs so a single scene can be moved or emailed intact. The board cannot
afford that: a player who speaks in twenty scenes was embedded twenty times
over, which put a 38-scene board at **7.9 MB** and growing linearly with the
transcript. Writing each photo once dropped the page to **371 KB** with a 2.8 MB
sidecar shared across every scene — so page size now tracks cast size rather
than scene count.
