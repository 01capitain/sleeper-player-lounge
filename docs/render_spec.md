# Reaction Renderer Specification

## Goal
Generate a shareable "Players Lounge" reaction asset after a Sleeper draft pick.

## Formats
- PNG: static final chat state.
- MP4: preferred animated format.
- GIF: convenience export for chat clients that handle GIFs better.

## Visual concept
A fictional mobile group-chat interface inspired by modern chat apps, but not an exact Sleeper clone. It must clearly read `Players Lounge` and include a subtle `Fantasy parody` mark.

## Animation timeline
1. Show previous few Lounge messages dimmed above the fold.
2. Insert a centered draft status card.
3. Pause ~500–900ms.
4. Optional typing indicator.
5. Reveal messages one by one according to `delayMs`.
6. Hold the final state 1.0–1.5 seconds.

## Draft status card
Example:

`DRAFT UPDATE · Round 4 · Pick 3`
`Max selected Travis Kelce`

## Player presentation
- avatar/headshot circle
- player name
- compact chat bubble
- optional team/position chip, but avoid visual clutter

Use current player metadata/headshots from Sleeper at runtime when available. Do not store binary NFL imagery in Git unless licensing/usage has been intentionally reviewed.

## Technical recommendation
- HTML/CSS/TypeScript template
- Playwright for deterministic rendering
- ffmpeg for MP4/GIF encoding
- 1080x1920 master canvas, downscale for chat sharing if desired

## CLI target
`npm run lounge -- react --latest --format mp4`
`npm run lounge -- react --pick 31 --format gif`
`npm run lounge -- screenshot --latest`
