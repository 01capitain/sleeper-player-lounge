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
npm run demo -- --stub --no-open    # free: no LLM call, no window
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

npm run lounge -- react --latest --format mp4    # free — no Director call
npm run lounge -- react --pick 74 --format gif
npm run lounge -- screenshot --latest

npm run lounge -- watch                          # poll every 25s until Ctrl-C
npm run lounge -- watch --once                   # one poll, then exit
npm run lounge -- watch --league <id> --interval 30

npm run lounge -- history import                 # the Simulation league chain
npm run lounge -- history import --target        # hotelkit Fantasies instead
npm run lounge -- history import --league <id>
```

### `--stub` costs nothing

`demo`, `simulate` and `watch` all accept `--stub`, which swaps the `claude -p` Director for
a deterministic canned one. Same pipeline, same renderer, same files on disk, no LLM call and
no cost. It is how the test suite exercises the pipeline, and it is the right way to check a
render change.

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

## Cost

The Director shells out to `claude -p` with a deliberately minimal flag set — around
**$0.004 per pick**, roughly $1 to replay a full 241-pick draft. See ADR 0001; dropping any
of those flags silently multiplies the cost by up to 15x.
