# Simulation fixture

The first implementation should populate `picks.jsonl` automatically from a completed 2026 Sleeper draft owned by Sleeper user `01capitain`.

Selection algorithm:
1. Fetch `/v1/user/471439689564286976/leagues/nfl/2026`.
2. Fetch draft(s) for each league via `/v1/league/{league_id}/drafts`.
3. Prefer a draft whose `status` is `complete` and has picks.
4. Exclude the target league `hotelkit Fantasies` while it is pre-draft.
5. Store the chosen league/draft metadata in `selected-draft.json`.
6. Normalize picks into `picks.jsonl`.

This avoids hardcoding a simulation league and lets the prototype start against whichever of the user's other 2026 drafts is already complete.
