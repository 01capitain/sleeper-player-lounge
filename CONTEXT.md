# Players Lounge

A local-first companion for a Sleeper fantasy-football slow draft. Every draft pick becomes a fictional group-chat scene in which NFL players react, rendered as a shareable image or video.

## Language

**Players Lounge**:
The fictional group chat in which NFL players react to draft picks. Deliberately not a replica of any real chat product.
_Avoid_: the chat, the group, Sleeper chat

**Pick**:
A single normalized selection made in a Sleeper draft, identified by an `eventId` of `{draftId}:{pickNo}:{playerId}`.
_Avoid_: selection, draft event

**Reaction**:
The director's complete answer to one Pick: an ordered set of Messages plus the Pick it responds to. One Reaction per Pick, always.
_Avoid_: response, generation, completion

**Message**:
One chat bubble inside a Reaction. Has a Speaker, text, a `delayMs` reveal offset, and a `reason` justifying its presence.
_Avoid_: line, bubble, utterance

**Speaker**:
The NFL player sending a Message. Always a real NFL player, never a Manager.
_Avoid_: actor, character, participant

**Manager**:
A human owner of a fantasy roster. Managers make Picks; they never appear as Speakers.
_Avoid_: user, owner, player

**Director**:
The component that turns a Context into a validated Reaction. Currently a `claude -p` subprocess.
_Avoid_: LLM, model, generator, AI

**Context**:
The compact, deliberately bounded bundle of facts assembled for one Pick and handed to the Director. What is absent from the Context cannot be said.
_Avoid_: prompt, payload, input

**Regular**:
A recurring cast member of the Lounge with a persistent personality profile. Regulars are ambient: they are in the Lounge for every Pick and may comment on Picks that have nothing to do with them. Being drafted is not a precondition for speaking, and Regulars are not more likely to speak because they were drafted. A Regular carrying an Appearance Gate is the one exception.
_Avoid_: star, celebrity, character

**Activity**:
A Regular's baseline propensity to speak on any given Pick, independent of relevance. Drives how often they appear across a draft, not whether a specific Pick concerns them.
_Avoid_: frequency, weight, chattiness

**Appearance Gate**:
An explicit per-Regular condition that must hold before that Regular enters the sampling pool. The single, deliberate exception to the ambient rule, for a Regular whose one joke stops landing when he turns up everywhere. Being the drafted player always bypasses it, and a gated Regular's League Lore leaves the Context with him.
_Avoid_: filter, relevance check, whitelist

**Roster Teammate**:
A player the drafting Manager already selected in the current draft. The new Pick lands on his fantasy team, so he either welcomes the upgrade or sees his starting spot contested. Distinct from an NFL teammate and from a 2025 fantasy teammate.
_Avoid_: teammate, roster-mate, squad member

**Fantasy Memory**:
The intentionally narrow set of historical facts a Speaker may reference: full 2025 roster history, plus championship-roster membership from any season. Nothing else.
_Avoid_: history, memory, past

**Championship Membership**:
Being on a season's winning fantasy roster. The only pre-2025 fact that survives into Fantasy Memory, and deliberately the weakest: it barely raises a Speaker's odds, and a Reaction carries at most one championship line, never as its opening Message.
_Avoid_: title, ring, win

**Season Literal**:
The explicit four-digit year a Message must contain whenever it draws on Fantasy Memory. "You had me in 2025" is valid; "back together again" is not.
_Avoid_: season reference, year mention

**Simulation**:
Replaying an already-completed draft from another league to exercise the pipeline before the target league drafts. Output is always marked `simulated: true`.
_Avoid_: test mode, dry run, replay

**Manager Alias**:
An optional deterministic overlay mapping Simulation draft slots onto target-league Managers, so target-league Fantasy Memory can be exercised during Simulation.
_Avoid_: mapping, persona, stand-in

**League Lore**:
A persistent, league-specific running joke attached to a player, independent of any season's statistics. Kyle Pitts' bust reputation is the canonical instance.
_Avoid_: joke, meme, story
