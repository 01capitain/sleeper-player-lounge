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
    &order_by=adp_dd_half_ppr
```

`player_id` is top-level on each row; the value is `stats.adp_dd_half_ppr`, which is genuinely
half-PPR rather than format-agnostic.

## It is an artifact, not a runtime lookup

`scripts/build-adp.mjs` fetches this once and writes `data/players/adp.json`, which is
committed. The app only ever reads it, and `ensurePlayerCache` merges it onto the players
dataset so consumers see one enriched record instead of joining two sources. Re-running the
script refreshes the artifact in place.

This keeps reactions reproducible — the same pick always sees the same ADP, so a replayed
draft does not silently change its jokes as the market moves — and keeps a live HTTP
dependency off the hot path while a real draft is running.

## Unranked means unranked

Sleeper parks undrafted players at a **1000** sentinel. The builder drops those and anything
missing, so absence from the artifact means genuinely unranked. Nothing downstream ever sees
a large number that would read as a 900-pick fall, and there is **no `search_rank` fallback**:
no ADP, no claim. A missing signal is always better than a wrong one.

## Consequences

Draft-surprise signals are silent until the artifact is built. That is the intended failure
mode — the Lounge still reacts to every pick, it just does not comment on value.

The builder is self-diagnosing: it prints every `adp_*` field found in the payload with usable
counts, and refuses to write if the requested field is absent, rather than emitting an empty
artifact. It also range-checks Josh Allen on every run as a canary against exactly the
regression that motivated this decision.
