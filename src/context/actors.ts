/**
 * Actor selection — who is *eligible* to speak about one Pick.
 *
 * implementation_plan.md §9 fixes the candidate ordering:
 *
 *   mandatory : the drafted player (always, ranked first — §14 product rule)
 *   strong    : one relevant current NFL teammate, when one exists
 *   strong    : one player already on the drafting Manager's roster in THIS
 *               draft, when one exists — the pick landed on his own team, so he
 *               either welcomes the upgrade or worries about his starting spot
 *   optional  : Regulars, 2025 fantasy teammates, championship teammates,
 *               position rivals, running-joke participants
 *
 * THE DESIGN RULE THIS FILE EXISTS TO ENFORCE
 * -------------------------------------------
 * **Regulars are ambient.** CONTEXT.md: "Regulars are in the Lounge for every
 * Pick and may comment on Picks that have nothing to do with them." So every
 * Regular enters the sampling pool on *every* Pick with a weight equal to their
 * `activity` (0.70–0.95). Relevance — NFL teammate, position rival, shared 2025
 * roster, a live running joke — is a *bonus that raises their odds*, never a
 * *gate that admits them*. Kelce turning up to mock a Round 12 kicker is the
 * normal case, and `actorWeight()` is written so that an entirely unconnected
 * Regular still outweighs a connected non-Regular.
 *
 * THE ONE EXCEPTION: AN APPEARANCE GATE
 * -------------------------------------
 * A Regular may carry an `appearance` gate in `star-players.json`. A gated
 * Regular is not ambient: he enters the pool only on Picks his gate admits
 * (`gateAllows`). The gate exists for a cast member with a single joke, whose
 * joke stops being funny at the fifth repetition — Kyle Pitts counting tight
 * ends on a Round 12 kicker. Being the drafted player always bypasses the gate.
 * No other relevance signal can open it, and no gate ever applies to a Regular
 * who has none.
 *
 * Selection is deterministic given a seed (derived from the Pick's `eventId`),
 * so reruns and tests reproduce exactly. This module decides who is *eligible*;
 * the Director decides who actually speaks.
 */
import type {
  AppearanceGate,
  NflTeammate,
  Pick,
  ReactionRulesConfig,
  RunningJoke,
  StarPlayer,
} from '../types.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The minimum identity of anyone who could be offered to the Director. */
export interface ActorRef {
  playerId: string;
  name: string;
  position?: string | null;
  nflTeam?: string | null;
}

/** Why a candidate is in the pool at all. Mirrors §9's candidate ordering. */
export type ActorRole =
  | 'drafted_player'
  | 'nfl_teammate'
  | 'roster_teammate'
  | 'regular'
  | 'fantasy_2025_teammate'
  | 'championship_teammate'
  | 'position_rival'
  | 'running_joke';

/** A candidate Speaker, with the weight and the human-readable reasons behind it. */
export interface SelectedActor extends ActorRef {
  role: ActorRole;
  /** `StarPlayer.key` when this actor is a Regular. */
  starKey?: string;
  /** The full Regular profile, when this actor is a Regular. */
  star?: StarPlayer;
  /** True only for the drafted player. */
  mandatory: boolean;
  /** The sampling weight this actor was drawn with. */
  weight: number;
  /** Plain-English justifications, e.g. `ambient regular`, `NFL teammate`. */
  reasons: string[];
}

/** Every relevance flag that can raise a candidate's odds. None of them gate. */
export interface ActorRelevance {
  /** Current NFL teammate of the drafted player. */
  isNflTeammate?: boolean;
  /** Seeded `position_rivals` relationship with the drafted player. */
  isPositionRival?: boolean;
  /** Same fantasy position as the drafted player. */
  samePosition?: boolean;
  /** Already on the drafting Manager's roster in THIS draft. */
  sharedRosterThisDraft?: boolean;
  /** Shares the drafted player's fantasy position on that same roster. */
  competesForStartingSpot?: boolean;
  /** Shared a 2025 fantasy roster with the drafted player. */
  sharedRoster2025?: boolean;
  /** Shared a championship roster with the drafted player, any season. */
  sharedChampionship?: boolean;
  /** 0..1 strength of the liveliest running joke this actor participates in. */
  runningJokeStrength?: number;
  /** `StarPlayer.required` — Rodgers / Kelce / Pitts. */
  isRequiredRegular?: boolean;
}

// ---------------------------------------------------------------------------
// The weighting formula (exported separately so it is unit-testable)
// ---------------------------------------------------------------------------

/**
 * Bonus multipliers added on top of a candidate's baseline propensity.
 * Every one of these is additive and bounded, so no single relevance signal can
 * dominate a Regular's ambient `activity`.
 */
export const RELEVANCE_BONUS = {
  /**
   * The strongest signal in the formula: this pick just landed on his own
   * fantasy team. He has an opinion either way, and it is about 2026 rather
   * than about a past season.
   */
  sharedRosterThisDraft: 1.1,
  nflTeammate: 0.9,
  sharedRoster2025: 0.7,
  positionRival: 0.5,
  /** On top of `sharedRosterThisDraft`: same roster AND same position. */
  competesForStartingSpot: 0.45,
  /** Scaled by the joke's `strength`. */
  runningJoke: 0.4,
  samePosition: 0.25,
  /**
   * Deliberately small. A ring is the oldest fact in Fantasy Memory and the
   * least interesting thing anyone in the room can bring up, so it barely moves
   * the odds — it used to sit at 0.6, which made "we won it together" the
   * default angle for whole rounds at a time.
   */
  sharedChampionship: 0.2,
  requiredRegular: 0.15,
} as const;

/**
 * Baseline propensity for a candidate who is not a Regular. Deliberately well
 * below the Regulars' 0.70–0.95 `activity` band: a connected non-Regular
 * (0.35 x 1.7 = 0.595) still sits under an entirely unconnected Regular (0.70+),
 * which is what keeps the Lounge feeling inhabited rather than event-driven.
 */
export const BASE_NON_REGULAR_ACTIVITY = 0.35;

/** Slightly higher baseline for the strong candidate: a current NFL teammate. */
export const BASE_NFL_TEAMMATE_ACTIVITY = 0.5;

/**
 * Baseline for someone already on the drafting Manager's roster this draft.
 * With the roster bonus he lands at 0.6 x 2.1 = 1.26 — above the chattiest
 * Regular — which is the point: the players whose own team just changed are the
 * ones with something at stake in the pick.
 */
export const BASE_ROSTER_TEAMMATE_ACTIVITY = 0.6;

/**
 * `weight = activity * (1 + sum(bonuses))`.
 *
 * `activity` alone is a complete, valid weight — that is the ambient rule in one
 * line. Bonuses only ever multiply upward; nothing here can drive a weight to
 * zero, so no relevance check can ever exclude a Regular from the pool.
 */
export function actorWeight(activity: number, relevance: ActorRelevance = {}): number {
  const base = clamp01(activity);
  let bonus = 0;
  if (relevance.sharedRosterThisDraft === true) bonus += RELEVANCE_BONUS.sharedRosterThisDraft;
  if (relevance.competesForStartingSpot === true) {
    bonus += RELEVANCE_BONUS.competesForStartingSpot;
  }
  if (relevance.isNflTeammate === true) bonus += RELEVANCE_BONUS.nflTeammate;
  if (relevance.sharedRoster2025 === true) bonus += RELEVANCE_BONUS.sharedRoster2025;
  if (relevance.sharedChampionship === true) bonus += RELEVANCE_BONUS.sharedChampionship;
  if (relevance.isPositionRival === true) bonus += RELEVANCE_BONUS.positionRival;
  if (relevance.samePosition === true) bonus += RELEVANCE_BONUS.samePosition;
  if (relevance.isRequiredRegular === true) bonus += RELEVANCE_BONUS.requiredRegular;
  const joke = clamp01(relevance.runningJokeStrength ?? 0);
  if (joke > 0) bonus += RELEVANCE_BONUS.runningJoke * joke;
  return base * (1 + bonus);
}

/** Human-readable justifications for a relevance record, for the prompt. */
export function relevanceReasons(relevance: ActorRelevance): string[] {
  const out: string[] = [];
  if (relevance.sharedRosterThisDraft === true) {
    out.push('already on the drafting manager\'s roster in this draft');
  }
  if (relevance.competesForStartingSpot === true) {
    out.push('plays the drafted player\'s position on that same roster — the starting spot is now contested');
  }
  if (relevance.isNflTeammate === true) out.push('current NFL teammate of the drafted player');
  if (relevance.sharedRoster2025 === true) out.push('shared a 2025 fantasy roster with the drafted player');
  if (relevance.sharedChampionship === true) out.push('shared a championship roster with the drafted player');
  if (relevance.isPositionRival === true) out.push('position rival of the drafted player');
  else if (relevance.samePosition === true) out.push('plays the same position as the drafted player');
  if ((relevance.runningJokeStrength ?? 0) > 0) out.push('involved in an active running joke');
  return out;
}

// ---------------------------------------------------------------------------
// Appearance gates — the one exception to the ambient rule
// ---------------------------------------------------------------------------

/** What a gate is evaluated against: the Pick, plus where it sits at its position. */
export interface GateSubject {
  position?: string | null;
  nflTeam?: string | null;
  /** 1-based ordinal of the drafted player among his position in this draft. */
  positionDraftIndex?: number;
}

/**
 * Decide whether a gated Regular is admitted to this Pick.
 *
 * No gate means always admitted — that is the ambient rule, untouched. A gate
 * with conditions admits on ANY of them; a gate with no usable condition admits
 * nobody, because a gate whose data is missing must fail closed. `earlyAtPosition`
 * needs `positionDraftIndex`: without it we cannot tell the third tight end from
 * the thirtieth, and guessing would reopen the gate it exists to close.
 */
export function gateAllows(
  gate: AppearanceGate | undefined,
  subject: GateSubject,
): boolean {
  if (!gate) return true;
  const teams = gate.nflTeams ?? [];
  if (teams.length > 0 && subject.nflTeam) {
    const team = subject.nflTeam.trim().toUpperCase();
    if (teams.some((entry) => entry.trim().toUpperCase() === team)) return true;
  }
  const early = gate.earlyAtPosition;
  if (
    early &&
    subject.position &&
    early.position.trim().toUpperCase() === subject.position.trim().toUpperCase() &&
    typeof subject.positionDraftIndex === 'number' &&
    subject.positionDraftIndex <= early.withinFirst
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Seeded PRNG — determinism is a requirement, not a convenience
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit. Turns an `eventId` into a stable numeric seed. */
export function hashSeed(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32. Small, fast, and identical across Node versions. */
export function createRng(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Weighted sampling without replacement (Efraimidis–Spirakis): draw one uniform
 * per item, key it as `u^(1/w)`, keep the largest keys. Higher weight means
 * better odds; a low weight is never zero odds, which is the ambient rule again.
 */
export function weightedSample<T>(
  items: readonly { item: T; weight: number }[],
  k: number,
  rng: () => number,
): T[] {
  if (k <= 0) return [];
  const keyed = items.map(({ item, weight }) => {
    const w = Math.max(weight, 1e-6);
    const u = Math.max(rng(), 1e-12);
    return { item, weight, key: Math.pow(u, 1 / w) };
  });
  keyed.sort((a, b) => b.key - a.key || b.weight - a.weight);
  return keyed.slice(0, k).map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectActorsInput {
  pick: Pick;
  /** Defaults to `hashSeed(pick.eventId)`. Same seed, same actors, always. */
  seed?: number | string;
  /** Every Regular in the cast. All of them enter the pool, every Pick. */
  regulars?: readonly StarPlayer[];
  /** Resolved Sleeper metadata per `StarPlayer.key`, when it is known. */
  starMeta?: Record<string, Partial<ActorRef>>;
  /** Current NFL teammates of the drafted player. */
  nflTeammates?: readonly NflTeammate[];
  /**
   * Players the drafting Manager already took in THIS draft. Their fantasy team
   * just changed, so they are the strong candidate alongside the NFL teammate.
   */
  currentRosterTeammates?: readonly ActorRef[];
  /**
   * 1-based ordinal of the drafted player among his position in this draft,
   * from `positionDraftIndex()`. Appearance gates need it; nothing else does.
   */
  positionDraftIndex?: number;
  /** Players who shared the drafted player's 2025 fantasy roster. */
  fantasyTeammates2025?: readonly ActorRef[];
  /** Players who shared a championship roster with the drafted player. */
  championshipTeammates?: readonly ActorRef[];
  /** Position rivals sourced from `relationships.seed.json` or elsewhere. */
  positionRivals?: readonly ActorRef[];
  /** Active Lounge jokes; `participants` may be star keys or Sleeper ids. */
  runningJokes?: readonly RunningJoke[];
  /**
   * History-derived relevance the caller already knows, keyed by star key or by
   * Sleeper player id. Merged on top of the flags this module derives itself.
   */
  relevance?: Record<string, Partial<ActorRelevance>>;
  rules?: Partial<ReactionRulesConfig>;
}

const DEFAULT_RULES: ReactionRulesConfig = {
  draftedPlayerMustReact: true,
  includeRelevantCurrentTeammates: true,
  includeCurrentRosterTeammates: true,
  minMessages: 2,
  targetMessages: 4,
  maxMessages: 6,
  maxRegularsPerReaction: 3,
  allowNoOptionalStarReaction: true,
};

/** Lower bound on how many candidates we hand the Director. */
export const MIN_CANDIDATES = 3;

/**
 * Choose the candidate Speakers for one Pick, in §9's order.
 *
 * The result is 3–6 candidates: the drafted player first and always, then one
 * relevant NFL teammate when one exists, then ambient Regulars and relationship
 * candidates sampled by weight. Deterministic for a given seed / `eventId`.
 */
export function selectActors(input: SelectActorsInput): SelectedActor[] {
  const rules = { ...DEFAULT_RULES, ...input.rules };
  const pick = input.pick;
  const seed =
    typeof input.seed === 'number'
      ? input.seed
      : hashSeed(input.seed ?? pick.eventId);
  const rng = createRng(seed);

  const minCandidates = Math.max(MIN_CANDIDATES, rules.minMessages);
  const maxCandidates = Math.max(minCandidates, rules.maxMessages);
  // Drawn first so the candidate count is stable no matter which pools are empty.
  const targetCount =
    minCandidates + Math.floor(rng() * (maxCandidates - minCandidates + 1));

  const taken = new Set<string>();
  const selected: SelectedActor[] = [];

  // Every non-mandatory candidate carrying a gated Regular profile is checked
  // against this subject. Ungated candidates never touch it.
  const gateSubject: GateSubject = {
    position: pick.position ?? null,
    nflTeam: pick.nflTeam ?? null,
    ...(input.positionDraftIndex !== undefined
      ? { positionDraftIndex: input.positionDraftIndex }
      : {}),
  };
  const admits = (star: StarPlayer | undefined): boolean =>
    gateAllows(star?.appearance, gateSubject);

  // --- 1. mandatory: the drafted player, always, ranked first ---------------
  const drafted: SelectedActor = {
    playerId: pick.playerId,
    name: pick.playerName,
    position: pick.position ?? null,
    nflTeam: pick.nflTeam ?? null,
    role: 'drafted_player',
    mandatory: true,
    weight: Number.POSITIVE_INFINITY,
    reasons: ['the drafted player — must send at least one message'],
  };
  const draftedStar = findStar(input.regulars ?? [], pick.playerName);
  if (draftedStar) {
    drafted.starKey = draftedStar.key;
    drafted.star = draftedStar;
    drafted.reasons.push('also a Lounge regular');
  }
  selected.push(drafted);
  taken.add(identityKey(drafted));
  taken.add(normalizeName(drafted.name));

  // --- 2. strong: one relevant current NFL teammate -------------------------
  const teammatePool = (input.nflTeammates ?? [])
    .filter((mate) => !taken.has(normalizeName(mate.name)) && mate.playerId !== pick.playerId)
    .filter((mate) => admits(findStar(input.regulars ?? [], mate.name)))
    .map((mate) => {
      const star = findStar(input.regulars ?? [], mate.name);
      const relevance = mergeRelevance(
        {
          isNflTeammate: true,
          samePosition: samePosition(mate.position, pick.position),
          isRequiredRegular: star?.required === true,
          runningJokeStrength: jokeStrength(input.runningJokes, [
            mate.playerId,
            star?.key,
          ]),
        },
        lookupRelevance(input.relevance, [mate.playerId, star?.key]),
      );
      const activity = star ? star.activity : BASE_NFL_TEAMMATE_ACTIVITY;
      const actor: SelectedActor = {
        playerId: mate.playerId,
        name: mate.name,
        position: mate.position ?? null,
        nflTeam: mate.nflTeam ?? pick.nflTeam ?? null,
        role: 'nfl_teammate',
        mandatory: false,
        weight: actorWeight(activity, relevance),
        reasons: unique([
          `current NFL teammate of ${pick.playerName}`,
          ...(star ? ['also a Lounge regular'] : []),
          ...relevanceReasons(relevance).filter((r) => !r.startsWith('current NFL teammate')),
        ]),
      };
      if (star) {
        actor.starKey = star.key;
        actor.star = star;
      }
      return { item: actor, weight: actor.weight };
    });

  if (rules.includeRelevantCurrentTeammates !== false && teammatePool.length > 0) {
    const [chosen] = weightedSample(teammatePool, 1, rng);
    if (chosen) {
      selected.push(chosen);
      taken.add(identityKey(chosen));
      taken.add(normalizeName(chosen.name));
    }
  }

  // --- 3. strong: one player already on this Manager's roster this draft ----
  // The pick landed on his own fantasy team, which is the liveliest angle in the
  // room: it is about 2026, not about a past season. Same position means the
  // starting spot is now contested, and `competesForStartingSpot` makes that the
  // likeliest roster-mate to be offered.
  const rosterPool = (input.currentRosterTeammates ?? [])
    .filter((mate) => !taken.has(normalizeName(mate.name)) && mate.playerId !== pick.playerId)
    .filter((mate) => admits(findStar(input.regulars ?? [], mate.name)))
    .map((mate) => {
      const star = findStar(input.regulars ?? [], mate.name);
      const competes = samePosition(mate.position, pick.position);
      const relevance = mergeRelevance(
        {
          sharedRosterThisDraft: true,
          competesForStartingSpot: competes,
          samePosition: competes,
          isNflTeammate: isSameTeam(mate.nflTeam, pick.nflTeam),
          isRequiredRegular: star?.required === true,
          runningJokeStrength: jokeStrength(input.runningJokes, [mate.playerId, star?.key]),
        },
        lookupRelevance(input.relevance, [mate.playerId, star?.key]),
      );
      const activity = star
        ? Math.max(star.activity, BASE_ROSTER_TEAMMATE_ACTIVITY)
        : BASE_ROSTER_TEAMMATE_ACTIVITY;
      const actor: SelectedActor = {
        playerId: mate.playerId,
        name: mate.name,
        position: mate.position ?? null,
        nflTeam: mate.nflTeam ?? null,
        role: 'roster_teammate',
        mandatory: false,
        weight: actorWeight(activity, relevance),
        reasons: unique([
          `already on ${pick.managerName}'s roster in this draft`,
          ...(star ? ['also a Lounge regular'] : []),
          ...relevanceReasons(relevance).filter(
            (reason) => !reason.startsWith('already on the drafting manager'),
          ),
        ]),
      };
      if (star) {
        actor.starKey = star.key;
        actor.star = star;
      }
      return { item: actor, weight: actor.weight };
    });

  if (rules.includeCurrentRosterTeammates !== false && rosterPool.length > 0) {
    const [chosen] = weightedSample(rosterPool, 1, rng);
    if (chosen) {
      selected.push(chosen);
      taken.add(identityKey(chosen));
      taken.add(normalizeName(chosen.name));
    }
  }

  // --- 4. optional: Regulars, sampled by activity on EVERY pick -------------
  // No relationship to the Pick is required or checked here. That is the point.
  const regularPool = (input.regulars ?? [])
    .filter((star) => !taken.has(normalizeName(star.name)))
    // The gate is the only thing in this file allowed to keep a Regular out.
    .filter((star) => admits(star))
    .map((star) => {
      const meta = input.starMeta?.[star.key];
      const nflTeam = meta?.nflTeam ?? null;
      const position = meta?.position ?? star.position;
      const playerId = meta?.playerId ?? starPseudoId(star.key);
      const relevance = mergeRelevance(
        {
          isNflTeammate: isSameTeam(nflTeam, pick.nflTeam),
          samePosition: samePosition(position, pick.position),
          isRequiredRegular: star.required,
          runningJokeStrength: jokeStrength(input.runningJokes, [star.key, playerId]),
        },
        lookupRelevance(input.relevance, [star.key, playerId]),
      );
      const actor: SelectedActor = {
        playerId,
        name: meta?.name ?? star.name,
        position,
        nflTeam,
        role: 'regular',
        starKey: star.key,
        star,
        mandatory: false,
        weight: actorWeight(star.activity, relevance),
        reasons: unique([
          `ambient Lounge regular (activity ${star.activity.toFixed(2)})`,
          ...relevanceReasons(relevance),
        ]),
      };
      return { item: actor, weight: actor.weight };
    });

  const regularSlots = Math.max(0, rules.maxRegularsPerReaction);
  const chosenRegulars = weightedSample(regularPool, regularSlots, rng);

  // --- 5-8. optional: relationship candidates ------------------------------
  const otherPool: { item: SelectedActor; weight: number }[] = [];
  const pushOther = (ref: ActorRef, role: ActorRole, relevance: ActorRelevance, reason: string) => {
    if (taken.has(normalizeName(ref.name))) return;
    if (otherPool.some((entry) => normalizeName(entry.item.name) === normalizeName(ref.name))) return;
    const star = findStar(input.regulars ?? [], ref.name);
    if (star && chosenRegulars.some((r) => r.starKey === star.key)) return;
    if (!admits(star)) return;
    const merged = mergeRelevance(
      {
        ...relevance,
        samePosition: samePosition(ref.position, pick.position),
        isNflTeammate: relevance.isNflTeammate ?? isSameTeam(ref.nflTeam, pick.nflTeam),
        runningJokeStrength: jokeStrength(input.runningJokes, [ref.playerId, star?.key]),
      },
      lookupRelevance(input.relevance, [ref.playerId, star?.key]),
    );
    const activity = star ? star.activity : BASE_NON_REGULAR_ACTIVITY;
    const actor: SelectedActor = {
      playerId: ref.playerId,
      name: ref.name,
      position: ref.position ?? null,
      nflTeam: ref.nflTeam ?? null,
      role,
      mandatory: false,
      weight: actorWeight(activity, merged),
      reasons: unique([reason, ...relevanceReasons(merged)]),
    };
    if (star) {
      actor.starKey = star.key;
      actor.star = star;
    }
    otherPool.push({ item: actor, weight: actor.weight });
  };

  // A second roster-mate is welcome, just not guaranteed a slot of his own.
  for (const ref of input.currentRosterTeammates ?? []) {
    pushOther(
      ref,
      'roster_teammate',
      {
        sharedRosterThisDraft: true,
        competesForStartingSpot: samePosition(ref.position, pick.position),
      },
      `already on ${pick.managerName}'s roster in this draft`,
    );
  }
  for (const ref of input.fantasyTeammates2025 ?? []) {
    pushOther(ref, 'fantasy_2025_teammate', { sharedRoster2025: true }, 'shared a 2025 fantasy roster with the drafted player');
  }
  for (const ref of input.championshipTeammates ?? []) {
    pushOther(ref, 'championship_teammate', { sharedChampionship: true }, 'shared a championship fantasy roster with the drafted player');
  }
  for (const ref of input.positionRivals ?? []) {
    pushOther(ref, 'position_rival', { isPositionRival: true }, 'position rival of the drafted player');
  }
  for (const joke of input.runningJokes ?? []) {
    for (const participant of joke.participants) {
      const star = findStarByKeyOrName(input.regulars ?? [], participant);
      if (star) {
        const meta = input.starMeta?.[star.key];
        pushOther(
          {
            playerId: meta?.playerId ?? starPseudoId(star.key),
            name: star.name,
            position: meta?.position ?? star.position,
            nflTeam: meta?.nflTeam ?? null,
          },
          'running_joke',
          { runningJokeStrength: joke.strength },
          `participant in the running joke "${joke.id}"`,
        );
      }
    }
  }

  // --- assemble -------------------------------------------------------------
  // The two strong slots are filled before this point, so `targetCount` alone
  // could leave no room at all for an optional candidate. The Lounge is never
  // empty (CONTEXT.md), so capacity always leaves at least one seat, still
  // inside `maxCandidates`.
  const capacity = Math.min(maxCandidates, Math.max(targetCount, selected.length + 1));
  const optional = [...chosenRegulars, ...weightedSample(otherPool, Math.max(0, capacity), rng)];
  optional.sort((a, b) => b.weight - a.weight);

  // The heaviest drawn Regular takes the reserved seat, ahead of the weight
  // order — otherwise the roster-mates and relationship candidates, which now
  // outweigh ambient `activity` by design, could crowd the Regulars out of a
  // full room entirely.
  const heaviestRegular = [...chosenRegulars].sort((a, b) => b.weight - a.weight)[0];
  const fillOrder = heaviestRegular ? [heaviestRegular, ...optional] : optional;

  for (const actor of fillOrder) {
    if (selected.length >= capacity) break;
    const key = identityKey(actor);
    if (taken.has(key) || taken.has(normalizeName(actor.name))) continue;
    taken.add(key);
    taken.add(normalizeName(actor.name));
    selected.push(actor);
  }

  // `allowNoOptionalStarReaction` is about the Director's output, not about
  // eligibility: when it is off we guarantee at least one Regular is offered.
  if (
    rules.allowNoOptionalStarReaction === false &&
    !selected.some((actor) => actor.role === 'regular') &&
    regularPool.length > 0
  ) {
    const [fallback] = weightedSample(regularPool, 1, rng);
    if (fallback && !taken.has(normalizeName(fallback.name))) {
      selected.push(fallback);
      taken.add(normalizeName(fallback.name));
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Stable pseudo-id for a Regular whose Sleeper id could not be resolved. */
export function starPseudoId(key: string): string {
  return `star:${key}`;
}

/** Case- and punctuation-insensitive name key, so "Ja'Marr Chase" matches. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
}

function identityKey(actor: ActorRef): string {
  return `id:${actor.playerId}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function samePosition(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toUpperCase() === b.toUpperCase();
}

function isSameTeam(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toUpperCase() === b.toUpperCase();
}

function findStar(regulars: readonly StarPlayer[], name: string): StarPlayer | undefined {
  const key = normalizeName(name);
  return regulars.find((star) => normalizeName(star.name) === key);
}

function findStarByKeyOrName(
  regulars: readonly StarPlayer[],
  value: string,
): StarPlayer | undefined {
  return (
    regulars.find((star) => star.key === value) ??
    regulars.find((star) => normalizeName(star.name) === normalizeName(value))
  );
}

function jokeStrength(
  jokes: readonly RunningJoke[] | undefined,
  identities: (string | undefined)[],
): number {
  if (!jokes || jokes.length === 0) return 0;
  const wanted = new Set(
    identities.filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  let best = 0;
  for (const joke of jokes) {
    for (const participant of joke.participants) {
      if (wanted.has(participant)) best = Math.max(best, clamp01(joke.strength));
    }
  }
  return best;
}

function lookupRelevance(
  table: Record<string, Partial<ActorRelevance>> | undefined,
  identities: (string | undefined)[],
): Partial<ActorRelevance> {
  if (!table) return {};
  let merged: Partial<ActorRelevance> = {};
  for (const identity of identities) {
    if (identity === undefined) continue;
    const entry = table[identity];
    if (entry) merged = mergeRelevance(merged, entry);
  }
  return merged;
}

function mergeRelevance(
  base: Partial<ActorRelevance>,
  extra: Partial<ActorRelevance>,
): ActorRelevance {
  return {
    isNflTeammate: extra.isNflTeammate ?? base.isNflTeammate,
    isPositionRival: extra.isPositionRival ?? base.isPositionRival,
    samePosition: extra.samePosition ?? base.samePosition,
    sharedRoster2025: extra.sharedRoster2025 ?? base.sharedRoster2025,
    sharedChampionship: extra.sharedChampionship ?? base.sharedChampionship,
    runningJokeStrength: Math.max(
      base.runningJokeStrength ?? 0,
      extra.runningJokeStrength ?? 0,
    ),
    isRequiredRegular: extra.isRequiredRegular ?? base.isRequiredRegular,
  };
}
