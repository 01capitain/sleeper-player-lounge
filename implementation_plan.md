# Players Lounge — Implementation Plan

## 1. Goal

Build a local-first companion for the **hotelkit Fantasies** Sleeper slow draft. Every new draft pick becomes a fictional `Players Lounge` group-chat event in which the drafted NFL player, relevant teammates and a recurring cast of star players react. The result can be exported as a PNG, GIF or MP4 and shared manually in the real league chat.

The project should be easy to run on a company workstation, safe to keep in a private Git repository, and deterministic enough that dialogue history and fantasy history survive restarts.

## 2. Non-goals for the first prototype

- Do not auto-post into Sleeper chat.
- Do not build a hosted service.
- Do not add a database.
- Do not ingest arbitrary multi-year roster history into prompts.
- Do not perfectly model real player personalities.
- Do not make a pixel-perfect fake Sleeper screenshot; use fictional Players Lounge branding.

## 3. Source-of-truth architecture

The LLM is **not memory**. Local files are memory.

```text
Sleeper API
   ↓
Sleeper importer / pick detector
   ↓
Normalized pick event
   ↓
Context builder
 ┌──────────────────────────┐
 │ current NFL metadata     │
 │ star-player profiles     │
 │ 2025 fantasy history     │
 │ championship membership  │
 │ relationships            │
 │ recent lounge messages   │
 │ running jokes/rivalries  │
 └──────────────────────────┘
   ↓
LLM Lounge Director
   ↓ strict Reaction JSON
JSONL persistence
   ↓
HTML renderer → Playwright → PNG / frames → ffmpeg → MP4/GIF
```

## 4. Important historical-memory rules

These are product requirements, not suggestions:

- Only **2025** is usable as ordinary fantasy-roster history.
- Any roster history from **2024 or earlier is ignored**.
- Exception: championship roster membership is remembered for every available historical season.
- Any dialogue referring to historical fantasy context must state the season explicitly.
- A player who disappointed his manager in 2025 may acknowledge it and hope 2026 goes better.
- Shared 2025 roster history is relevant: players can recognize former fantasy teammates.
- Shared older roster history is irrelevant unless they were on that season's winning roster.

## 5. Required recurring cast

At minimum the Lounge regulars must include:

### Aaron Rodgers
- high activity
- veteran / dry tone
- recurring Green Bay nostalgia
- can play elder-statesman role

As of the handoff date, NFL.com lists Rodgers as an active Pittsburgh Steelers QB for 2026 and reports that he says 2026 will be his final NFL season. Runtime metadata should still be refreshed from Sleeper rather than hardcoded.

### Travis Kelce
- very high activity
- frequent Taylor Swift references
- references may use eras/tours/friendship-bracelet/song-title-adjacent ideas
- never reproduce song lyrics
- natural banter with Mahomes and other TEs

NFL.com lists Kelce on the 2026 Kansas City Chiefs roster. Runtime metadata remains authoritative.

### Kyle Pitts
- high activity
- persistent **league-specific** lore: hotelkit Fantasies remembers him as a great draft bust
- self-aware about being drafted again
- can hope this season finally goes better
- other TEs / Falcons teammates may tease him

NFL.com reports Pitts remains with Atlanta for 2026. Runtime metadata remains authoritative.

The seed file already includes ~15 regulars across QB/RB/WR/TE. Treat it as editable creative data.

## 6. Sleeper integration

Use Sleeper's public API without auth for read operations.

Known user:
- username: `01capitain`
- user id: `471439689564286976`
- target league: `hotelkit Fantasies`
- target state at handoff: pre-draft

### Prototype simulation league selection

Do **not** require a manually supplied league id.

On setup:
1. Fetch the user's 2026 NFL leagues.
2. Fetch drafts for each league.
3. Find a draft with status `complete` and one or more picks.
4. Exclude `hotelkit Fantasies` while it is pre-draft.
5. Prefer the most recently completed draft.
6. Save selection to `data/simulation/selected-draft.json`.
7. Normalize its picks into `data/simulation/picks.jsonl`.

Then the CLI can replay picks one at a time.

### Live slow-draft detection

For MVP, polling is fine.
- poll draft picks every 20–30 seconds
- compare max processed pick number with local state
- process new picks in order
- update `data/lounge/state.json`

Avoid duplicate reactions by using a deterministic event id such as:
`{draftId}:{pickNo}:{playerId}`

## 7. Current player metadata

Fetch Sleeper's NFL players dataset and cache locally, e.g.:
`data/cache/sleeper-players.json`

Use it for:
- display name
- NFL team
- position
- headshot/avatar lookup fields when available
- teammate selection

Star-player personality files should not duplicate dynamic team data unnecessarily.

## 8. Fantasy-history importer

### 2025 history
Find the 2025 predecessor of the hotelkit Fantasies league using Sleeper league metadata / previous league id where available. Import final rosters and manager identities.

Build `data/fantasy-history/last-season.json`:

```json
{
  "season": 2025,
  "players": {
    "PLAYER_ID": {
      "managerId": "...",
      "managerName": "...",
      "teamFinish": 4,
      "champion": false,
      "performance": "disappointing",
      "sharedRosterPlayerIds": ["..."]
    }
  }
}
```

### Performance classification
For the fast prototype, use a deterministic heuristic rather than an LLM:
- compare actual 2025 fantasy output / positional finish to draft cost if that historical data is readily available
- if draft-cost data is not conveniently available, initially support manual overrides plus a neutral default
- the importer must never invent "disappointing" purely from vibes

Add an override file later if useful:
`data/fantasy-history/performance-overrides.json`

Kyle Pitts' league-specific `draft bust` lore lives separately and does not depend on this generic performance classifier.

### Championship memory
Walk back through accessible predecessor leagues as far as Sleeper data permits.
For each season:
1. identify champion roster
2. store manager + full final roster
3. create reverse player → championships lookup

Do not import other old roster relationships.

## 9. Context builder

Given one normalized pick, construct a compact context object containing:

- pick information
- drafting manager + current drafted roster
- drafted player's current NFL teammates
- 0–3 relevant Lounge regulars
- 2025 history of the drafted player
- 2025 shared-fantasy-teammate relationships relevant to candidate speakers
- championship memberships of relevant speakers
- last ~20 Lounge messages
- active running jokes/rivalries
- basic draft signals such as position run / stack / obvious fall when available

### Actor selection order
Mandatory candidate:
1. drafted player

Strong candidate:
2. one relevant current NFL teammate

Optional candidates:
3. recurring Lounge stars
4. 2025 fantasy teammates
5. shared championship teammates
6. position rivals
7. players involved in an active running joke

The director should usually output 2–6 messages, not use everyone.

## 10. Director / LLM interface

Create an adapter so provider choice is replaceable:

```ts
interface LoungeDirector {
  generateReaction(context: LoungeContext): Promise<Reaction>;
}
```

Start with whichever local/company-approved OpenAI-compatible endpoint is easiest. Keep provider configuration in environment variables, never Git.

Validate every response against `schemas/reaction.schema.json` before persisting/rendering.

Retry once on invalid JSON; if still invalid, write a failed-event record and do not corrupt message history.

## 11. Persistence

Use append-only JSONL for chronological event history:
- `data/lounge/messages.jsonl`
- `data/lounge/reactions.jsonl`
- `data/simulation/picks.jsonl`

Use small JSON files for derived/current state:
- `data/lounge/state.json`
- `data/players/relationships.seed.json`
- `data/fantasy-history/last-season.json`
- `data/fantasy-history/champions.json`

Git-friendly principles:
- stable ids
- one JSON object per JSONL line
- ISO timestamps
- pretty-print normal JSON files
- no generated videos committed by default
- add `output/` and large caches to `.gitignore`

## 12. Renderer

Implement one vertical mobile layout first.

Preferred stack:
- Node.js + TypeScript
- HTML/CSS
- Playwright
- ffmpeg

Renderer inputs are deterministic Reaction JSON + recent-message history.

MVP commands:

```bash
npm run lounge -- simulate --next
npm run lounge -- simulate --pick 31
npm run lounge -- react --latest --format mp4
npm run lounge -- react --latest --format gif
npm run lounge -- screenshot --latest
npm run lounge -- watch
```

`simulate --next` should take the next stored pick from a completed draft and run the full director + renderer pipeline.

## 13. Prototype milestone order

### Milestone A — data works without an LLM
1. create TS project + config loader
2. Sleeper league discovery
3. auto-select completed simulation draft
4. normalize picks
5. load star profiles
6. render a hardcoded reaction JSON to PNG

Definition of done: one real historical pick from another 2026 league renders as a Players Lounge screenshot.

### Milestone B — generated reaction
1. implement context builder
2. implement LLM adapter
3. validate Reaction JSON
4. persist JSONL
5. render generated reaction

Definition of done: `simulate --next` produces a believable reaction image for the next real completed-draft pick.

### Milestone C — animation
1. typing indicator
2. timed message arrival
3. Playwright frame/video capture
4. ffmpeg MP4
5. GIF conversion

Definition of done: one CLI command outputs a shareable 6–10 second reaction asset.

### Milestone D — fantasy history
1. import 2025 roster history
2. champion roster importer across available predecessor seasons
3. shared-roster context
4. explicit-season validation / prompt rules

Definition of done: generated dialogue can correctly say e.g. `You had me in 2025` or `We were both on the 2023 championship roster`, and never uses unspecified historical roster memories.

### Milestone E — live slow draft
1. target `hotelkit Fantasies`
2. polling watcher
3. idempotent new-pick processing
4. `--no-render` and `--format` options

Definition of done: a new slow-draft pick creates exactly one reaction asset locally.

## 14. Validation tests

Add automated tests for these product rules:

- drafted player is always present in reaction candidates / output
- <= 6 messages
- historical 2025 reference includes literal `2025`
- championship reference includes its literal season
- no non-championship roster history before 2025 reaches the prompt
- Kyle Pitts profile always contains league bust lore
- Taylor-Swift-related Kelce prompts prohibit lyrics
- repeated processing of same pick creates no duplicate event
- target pre-draft league is not selected for simulation
- a completed alternate 2026 draft can be replayed

## 15. Suggested first demo scenarios

After importing the completed simulation draft, locate picks involving these situations if present:
1. Kyle Pitts drafted → exercise league-specific bust lore.
2. Travis Kelce drafted → Taylor/pop-culture voice + teammate reaction.
3. Aaron Rodgers drafted → Green Bay nostalgia.
4. Any player who was on the same manager's 2025 hotelkit Fantasies roster → explicit 2025 callback.
5. Any former champion → explicit championship-year callback.

If the simulation draft does not contain one of the required stars, create a synthetic pick event for renderer/director testing only; clearly mark it `synthetic: true`.

## 16. Configuration / secrets

Commit:
- `.env.example`
- league/user config
- profiles, prompts, schemas

Do not commit:
- API keys
- company endpoint credentials
- generated videos
- large transient caches

Suggested env vars:

```env
LOUNGE_LLM_BASE_URL=
LOUNGE_LLM_API_KEY=
LOUNGE_LLM_MODEL=
```

Sleeper read API requires no secret.

## 17. Handoff status

Prepared assets include:
- app configuration
- ~15 star-player profiles
- required Rodgers/Kelce/Pitts personas
- seed relationships
- strict director prompt
- 2025 history template
- all-years championship-memory template
- pick/reaction/history JSON schemas
- renderer specification
- simulation selection rules
- empty JSONL persistence files

The implementation agent should start at **Milestone A** and resist adding infrastructure before the first real Sleeper pick is rendered.
