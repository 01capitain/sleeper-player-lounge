# ADP is a precomputed artifact from the projections route, not `search_rank`

ADR 0003 used the player object's `search_rank` as an ADP proxy. That is wrong. `search_rank`
is a talent/search ordering, not a draft position — it ranks **Josh Allen around 4th overall**,
where his real half-PPR ADP sits in the 20s-40s. Comparing a pick against it would manufacture
a ~30-pick "he fell" on a completely ordinary pick, and a fabricated signal becomes a
fabricated joke.

Real ADP comes instead from Sleeper's projections route:

```
GET https://api.sleeper.com/projections/nfl/2026/1
    ?season_type=regular
    &position[]=QB&position[]=RB&position[]=WR&position[]=TE
    &order_by=adp_dd_ppr
```

`player_id` is top-level on each row and the value is `stats.adp_dd_ppr`.

**The route exposes no half-PPR ADP.** We probed all ten plausible `order_by` values
(`adp_dd_half_ppr`, `adp_half_ppr`, `adp_std`, `adp_2qb`, `adp_dynasty_half_ppr`, `adp_rookie`
and others): every one returns the identical 3114-row payload carrying only `adp_dd_ppr`, so
`order_by` is silently ignored. Full-PPR ADP in a 0.5-PPR league mildly overrates pass-catching
backs and slot receivers — a few board positions of drift, against the ~30-position error
`search_rank` produced. We accept the mismatch and record it rather than pretend it is exact.

The values are an **ordinal consensus board**, not true averages: 456 ranked players occupying
the contiguous integers 1..456 with no gaps. So "he went 30 picks early" means 30 board
positions.

## It is an artifact, not a runtime lookup

`scripts/build-adp.mjs` fetches this once and writes `data/players/adp.json`, which is
committed. The app only ever reads it, and `ensurePlayerCache` merges it onto the players
dataset so consumers see one enriched record instead of joining two sources. Re-running the
script refreshes the artifact in place.

This keeps reactions reproducible — the same pick always sees the same ADP, so a replayed
draft does not silently change its jokes as the market moves — and keeps a live HTTP
dependency off the hot path while a real draft is running.

## Unranked means unranked

Sleeper parks undrafted players at **two** sentinels: the documented 1000, and an
undocumented **999** used by exactly 11 players. A naive `>= 1000` check lets all 11 through as
apparently-real ADPs of 999, which would fabricate enormous falls. The builder therefore drops
anything at or above **900** — safely past any real draft, since a 14-team 17-round league is
238 picks and the real board tops out at 456. Absence from the artifact means genuinely
unranked. Nothing downstream ever sees
a large number that would read as a 900-pick fall, and there is **no `search_rank` fallback**:
no ADP, no claim. A missing signal is always better than a wrong one.

## Consequences

Draft-surprise signals are silent until the artifact is built. That is the intended failure
mode — the Lounge still reacts to every pick, it just does not comment on value.

The builder is self-diagnosing: it prints every `adp_*` field found in the payload with usable
counts, and refuses to write if the requested field is absent, rather than emitting an empty
artifact. It also range-checks Josh Allen on every run as a canary against exactly the
regression that motivated this decision; he currently lands at ADP 33, overall #33.
