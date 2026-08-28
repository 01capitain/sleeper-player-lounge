# Verified Sleeper facts

Fetched live from the Sleeper public API on 2026-08-28. Recorded here because the
development sandbox has no network egress — treat this file as the offline source of
truth for ids and shapes. Re-verify with `npm run lounge -- setup` before relying on
anything time-sensitive (league status especially).

## User

- username `01capitain`, user_id `471439689564286976`

## 2026 leagues

| league_id | name | status | draft_id | previous_league_id | rosters |
|---|---|---|---|---|---|
| 1389387602825576448 | hotelkit Fantasies | `pre_draft` | 1389387602825576449 | 1257418705789272064 | 8 |
| 1389356983177465856 | Defensive Bros | `in_season` | 1389356983177465857 | 1250143800488120320 | 14 |
| 1383332770389958656 | AFFC Conference League 4 | `pre_draft` | 1383332771358867456 | null | 12 |

Only Defensive Bros has a completed draft. See ADR 0002.

## Simulation draft — Defensive Bros 2026

- draft_id `1389356983177465857`, status `complete`, type `snake`, season 2026
- settings: 17 rounds, 14 teams; `slot_to_roster_id` has 14 entries
- **241 picks** on `/draft/{id}/picks` (not 238 — do not assume rounds x teams)
- pick objects carry `pick_no`, `round`, `draft_slot`, `player_id`, `picked_by` (a user_id),
  and a `metadata` object with `first_name` / `last_name`

Required cast is all present, so the section 15 demo scenarios need no `synthetic: true` picks:

| Player | player_id | pick_no | round | picked_by |
|---|---|---|---|---|
| Kyle Pitts | 7553 | 74 | 6 | 609109430927175680 |
| Travis Kelce | 1466 | 119 | 9 | 1253837548522844160 |
| Aaron Rodgers | 96 | 229 | 17 | 851531953642532864 |

First three picks: 1 Jahmyr Gibbs (`9221`), 2 Bijan Robinson (`9509`), 3 Jonathan Taylor (`6813`).

## League history chains

**Defensive Bros** — one season deep only:
- 2026 `1389356983177465856` -> 2025 `1250143800488120320` (complete, 14 rosters, draft `1250143802098724864`) -> **`previous_league_id` is null**

Consequence: Championship Membership for Defensive Bros can only ever cover 2025. That is
enough to exercise the code path, but the importer must handle a chain of length 1 without
error, and must not assume multiple championship seasons exist.

**hotelkit Fantasies** — three seasons deep:
- 2026 `1389387602825576448` (8 rosters)
- 2025 `1257418705789272064` (complete, 10 rosters, draft `1257418705789272065`)
- 2024 `1124839028152107008` (complete, 14 rosters, draft `1124839028152107009`)
- 2023 `992215537729728512`

Roster counts change every season, so Manager identity must be resolved by Sleeper
`user_id`, never by `roster_id` or draft slot.

## Endpoint shapes confirmed

`/league/{id}/matchups/{week}` — each roster object has keys
`points`, `players`, `roster_id`, `custom_points`, `matchup_id`, `starters`,
`starters_points`, `players_points`. **`players_points` is a `player_id -> points` map in
that league's own scoring**, which is what the 2025 performance classifier consumes.
Example entries: `"4046": 27.72`, `"6813": 30.1`, `"8155": 15.5`.

`/league/{id}/winners_bracket` — array of match objects. The championship match is the one
with `"p": 1`; its `"w"` field is the winning **roster_id**. Note `"r"` is the round number
and `"l"` the losing roster — do not mistake `r` for the result. For hotelkit 2025 the
championship match is `{"p":1,"m":6,"r":3,"l":2,"w":1,"t1":1,"t2":2}`, so roster 1 won.

`/league/{id}/users` — hotelkit 2025 returned **15 users for 10 rosters**, so the user list
is not 1:1 with rosters and must be joined against `/league/{id}/rosters` via `owner_id`.
`metadata.team_name` is frequently absent; fall back to `display_name`.

`/players/nfl` — ~5MB, cache to `data/cache/sleeper-players.json` with a long TTL.

Headshots: `https://sleepercdn.com/content/nfl/players/{player_id}.jpg` (transparent cutouts,
not verified reachable from the sandbox — the renderer must degrade to a monogram avatar).

## Addendum — gaps closed 2026-08-28

Recorded after the first import agent flagged these as reasoned-but-unobserved.

### Draft ordering fields (Defensive Bros 2026 draft)

```
start_time  1787245270875
last_picked 1787250468820
created     1785611027095
```

All three are present, so the selection precedence `last_picked -> start_time -> created`
is observed, not assumed. `last_picked` is the only field that means "finished at" — a slow
draft can start weeks before it ends, so ordering on `start_time` would be wrong.

### `draft_order` semantics — CONFIRMED

Keys are **user_id**, values are the **slot number**:

```json
{ "1253448521177108480": 1, "1251814728901087232": 2, "1252021942492344320": 3 }
```

So it is `user_id -> slot`, NOT `slot -> user_id`. Invert it to go from slot to manager.
Note `slot_to_roster_id` is present on the draft *detail* endpoint (`/draft/{id}`) but not on
the league's draft *list* endpoint (`/league/{id}/drafts`).

### Pick object shape — CONFIRMED

Top-level keys, complete:
`draft_id`, `draft_slot`, `is_keeper`, `metadata`, `pick_no`, `picked_by`, `player_id`,
`reactions`, `roster_id`, `round`

**There is no timestamp on a pick.** `Pick.pickedAt` must stay null/omitted rather than be
fabricated; the only time-like value is `metadata.news_updated`, which is about the player's
news feed, not the pick. The live watcher must therefore order by `pick_no`, never by time.

`metadata` is richer than expected and carries what the normalizer needs even without the
5MB players dataset:

```json
{
  "first_name": "Travis", "last_name": "Kelce", "player_id": "1466",
  "position": "TE", "team": "KC", "status": "Active", "number": "87",
  "years_exp": "13", "injury_status": "", "news_updated": "1786588814418",
  "sport": "nfl", "team_abbr": "", "team_changed_at": ""
}
```

Verified current NFL metadata for the required Regulars (matches `docs/sources.md`):

| Player | player_id | position | team |
|---|---|---|---|
| Aaron Rodgers | 96 | QB | PIT |
| Travis Kelce | 1466 | TE | KC |
| Kyle Pitts | 7553 | TE | ATL |

### hotelkit Fantasies 2026 managers — the Manager Alias targets

Eight managers, real ids and names:

| user_id | display_name | team_name |
|---|---|---|
| 471439689564286976 | 01capitain | Ja'Marr-io Kart Chase |
| 871378632227131392 | frearless | The Jolly Rodgers |
| 871390226608758784 | MWRCorny | Jo-ju Brothers |
| 871438999288467456 | PiJ | Winless Wonders |
| 871442069296734208 | bergnermikey | Waddle u doing stepbro |
| 872389075758452736 | obsti5 | BigTruzz |
| 872413972094210048 | Genius11 | Nix ist los |
| 1001524703443415040 | NYJ1000 | *(none — fall back to display_name)* |

Sorted ascending by `user_id` this is the exact order the alias modulo rule walks. Note the
2025 league had 15 users for 10 rosters while 2026 has 8 — further confirmation that Manager
identity must be resolved by `user_id` and never by roster or slot.
