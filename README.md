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

## Setup

```bash
npm install
npx playwright install chromium
npm run lounge -- setup
```

`setup` discovers your 2026 leagues, picks a completed draft to simulate against, caches the
Sleeper player dataset and normalizes the picks. No API key is needed — Sleeper's read API is
public, and the Director runs through your existing Claude Code authentication.

## Commands

```bash
npm run lounge -- simulate --next              # next stored pick through the full pipeline
npm run lounge -- simulate --pick 74           # a specific pick (74 = Kyle Pitts)
npm run lounge -- react --latest --format mp4
npm run lounge -- react --latest --format gif
npm run lounge -- screenshot --latest
npm run lounge -- history import               # 2025 rosters + championship membership
npm run lounge -- watch                        # poll the live slow draft
```

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
