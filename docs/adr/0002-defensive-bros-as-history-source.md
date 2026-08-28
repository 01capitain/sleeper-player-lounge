# Fantasy-history milestones are validated against Defensive Bros, not the target league

The target league `hotelkit Fantasies` is `pre_draft` for 2026, so it produces no Picks to react to. Of the operator's three 2026 leagues, exactly one has a completed draft: `Defensive Bros` (league `1389356983177465856`, draft `1389356983177465857`, snake, 17 rounds x 14 teams = 238 picks, status `complete`, league `in_season`).

Defensive Bros also has a 2025 predecessor (`1250143800488120320`), so it carries its own real Fantasy Memory. We therefore validate Milestones D and E against Defensive Bros' own history and its own Managers, rather than against fixtures or assumptions.

## Consequences

The history importer is league-agnostic: it accepts any league id and walks `previous_league_id` backwards. Both chains are importable — Defensive Bros for Simulation, and hotelkit Fantasies (2026 -> `1257418705789272064` 2025 -> `1124839028152107008` 2024 -> `992215537729728512` 2023) for live operation.

Because Defensive Bros' Managers are not hotelkit Managers, a Manager Alias overlay maps Simulation draft slots onto hotelkit Managers on demand. It exists to make demo assets legible to the hotelkit audience and to give Kyle Pitts' hotelkit-specific League Lore somewhere to land. It is off by default; unaliased Simulation uses real Defensive Bros Managers.

Roster counts differ across the hotelkit chain (8 in 2026, 10 in 2025, 14 in 2024), so Manager continuity is resolved by Sleeper `user_id`, never by roster id or slot.

2025 performance classification uses `players_points` from `/v1/league/{id}/matchups/{week}`, which reports exact per-player points in that league's own scoring, compared against the player's 2025 draft slot. This keeps the classifier deterministic and league-accurate rather than inferred.
