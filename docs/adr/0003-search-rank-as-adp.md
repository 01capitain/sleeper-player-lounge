# `search_rank` is the ADP proxy, and it is never used to grade past seasons

Draft reactions need an expectation to compare a pick against — "he fell", "that's a
reach" — and the league's own draft slot is a poor baseline. hotelkit Fantasies is an
**8-team league**, so its draft cost reflects only eight managers' opinions across ~15
rounds; one manager reaching badly skews a player's apparent expectation.

Sleeper's public API exposes no ADP field. A full player object was pulled and inspected:
44 keys, none named `adp` or `average_draft_position`. The closest available signal is
**`search_rank`** (Travis Kelce = 93), Sleeper's own global ordering. We use it as the ADP
proxy.

## Consequences

`search_rank` is **format-agnostic** — there is no 0.5-PPR variant — so it approximates a
consensus board rather than this league's scoring. Good enough for "he went 30 picks early";
not a substitute for real format-specific ADP if that ever matters.

`search_rank` reflects the **current season only**, which is exactly what a draft signal
wants and exactly what a historical grade must not use. A player who busted in 2025 carries
a *depressed* rank in 2026 precisely because he busted; grading his 2025 season against his
2026 rank would quietly cancel the disappointment — and the 2025 letdown is the storyline the
Lounge is built around. So `search_rank` drives draft signals and never touches the
2025 performance classifier, which continues to compare in-league points against 2025 draft
cost. No historical ADP is imported or required.

The surprise threshold is expressed in **rounds, not picks**, because a flat pick count means
different things at different table sizes: 12 picks is a round and a half in an 8-team league
but under a full round in a 14-team one. `surpriseThreshold = max(3, round(teams * 1.25))`,
so callers must pass the real team count — 8 for hotelkit Fantasies, 14 for the Defensive
Bros simulation draft.

Detection is symmetric. A reach is reported alongside a fall, because a reach is usually the
funnier of the two: somebody at the table has to defend it.

Players with no `search_rank`, or parked at Sleeper's out-of-range sentinel values, produce
no claim at all. A guessed signal becomes a fabricated joke.
