/**
 * The timeline is the whole animation, compiled before a browser is ever
 * launched. It is pure, so the spec's ordering guarantees can be asserted here
 * rather than inferred from captured frames.
 */
import { describe, expect, it } from 'vitest';

import { toRenderPayload, type RenderPayload } from '../payload.js';
import {
  buildTimeline,
  frameCountFor,
  MIN_REVEAL_GAP_MS,
  STATUS_PAUSE_MS,
  type Timeline,
} from '../video.js';
import { stubReaction } from './fixtures.js';

function payloadWithDelays(delays: number[]): RenderPayload {
  const reaction = stubReaction();
  return toRenderPayload({
    ...reaction,
    reactions: delays.map((delayMs, index) => {
      const source = reaction.reactions[index % reaction.reactions.length];
      if (!source) throw new Error('fixture has no messages');
      return { ...source, speakerPlayerId: `speaker-${index}`, delayMs };
    }),
  });
}

function times(timeline: Timeline, kind: string): number[] {
  return timeline.events.filter((e) => e.action.kind === kind).map((e) => e.atMs);
}

describe('buildTimeline', () => {
  it('opens with a reset at t=0 — previous messages and the status card', () => {
    const timeline = buildTimeline(toRenderPayload(stubReaction()));
    expect(timeline.events[0]).toEqual({ atMs: 0, action: { kind: 'reset' } });
  });

  it('emits events in non-decreasing time order', () => {
    const timeline = buildTimeline(toRenderPayload(stubReaction()));
    const at = timeline.events.map((event) => event.atMs);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('reveals every Message exactly once, in payload order', () => {
    const timeline = buildTimeline(toRenderPayload(stubReaction()));
    const revealed = timeline.events
      .filter((event) => event.action.kind === 'reveal')
      .map((event) => (event.action.kind === 'reveal' ? event.action.index : -1));
    expect(revealed).toEqual([0, 1, 2, 3]);
  });

  it('pauses on the status card before the first beat', () => {
    const timeline = buildTimeline(toRenderPayload(stubReaction()));
    const firstBeat = timeline.events[1];
    expect(firstBeat?.atMs).toBeGreaterThanOrEqual(500);
    expect(firstBeat?.atMs).toBe(STATUS_PAUSE_MS);
  });

  it('lands on the configured 8s duration for a typical Reaction', () => {
    const timeline = buildTimeline(toRenderPayload(stubReaction()), { durationSeconds: 8 });
    expect(timeline.durationMs).toBe(8000);
  });

  it('respects the schema\'s 7000ms delayMs ceiling without overrunning', () => {
    const timeline = buildTimeline(payloadWithDelays([0, 2000, 5000, 7000]), {
      durationSeconds: 8,
    });
    expect(timeline.durationMs).toBe(8000);
    expect(Math.max(...timeline.events.map((event) => event.atMs))).toBeLessThan(8000);
  });

  it('holds the final state for 1.0-1.5s after the last reveal', () => {
    const timeline = buildTimeline(toRenderPayload(stubReaction()));
    const lastReveal = Math.max(...times(timeline, 'reveal'));
    const hold = timeline.durationMs - lastReveal;
    expect(hold).toBeGreaterThanOrEqual(1000);
    expect(hold).toBeLessThanOrEqual(1500);
  });

  it('precedes each reveal with a typing indicator by default', () => {
    const timeline = buildTimeline(toRenderPayload(stubReaction()));
    expect(times(timeline, 'showTyping')).toHaveLength(4);
    const reveals = times(timeline, 'reveal');
    times(timeline, 'showTyping').forEach((typingAt, index) => {
      expect(typingAt).toBeLessThan(reveals[index] ?? 0);
    });
  });

  it('omits typing indicators when the config disables them', () => {
    const timeline = buildTimeline(toRenderPayload(stubReaction()), {
      showTypingIndicators: false,
    });
    expect(times(timeline, 'showTyping')).toEqual([]);
    expect(times(timeline, 'reveal')[0]).toBe(STATUS_PAUSE_MS);
  });

  it('spaces bubbles out when the Director sends identical delays', () => {
    const timeline = buildTimeline(payloadWithDelays([0, 0, 0, 0]));
    const reveals = times(timeline, 'reveal');
    for (let i = 1; i < reveals.length; i += 1) {
      expect((reveals[i] ?? 0) - (reveals[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        MIN_REVEAL_GAP_MS,
      );
    }
  });

  it('keeps reveals monotonic when delays arrive out of order', () => {
    const timeline = buildTimeline(payloadWithDelays([3000, 1000, 2000]));
    const reveals = times(timeline, 'reveal');
    expect([...reveals].sort((a, b) => a - b)).toEqual(reveals);
  });

  it('never compresses pacing beyond the 0.5x clamp, even for a short target', () => {
    const timeline = buildTimeline(toRenderPayload(stubReaction()), { durationSeconds: 2 });
    // 4 messages spread over 4.6s cannot be told in 2s; the clamp protects the
    // reading rhythm and the clip simply runs longer than asked.
    expect(timeline.durationMs).toBeGreaterThan(2000);
    expect(timeline.durationMs).toBeLessThan(8000);
  });

  it('stretches a fast Reaction towards the target duration', () => {
    const timeline = buildTimeline(payloadWithDelays([0, 400, 800]), { durationSeconds: 8 });
    expect(timeline.durationMs).toBeGreaterThan(4000);
  });

  it('degrades to card-plus-hold when a Reaction somehow has no Messages', () => {
    const timeline = buildTimeline(payloadWithDelays([]));
    expect(timeline.events).toHaveLength(1);
    expect(timeline.durationMs).toBe(STATUS_PAUSE_MS + 1200);
  });
});

describe('frameCountFor', () => {
  it('covers the whole timeline at the capture rate', () => {
    expect(frameCountFor(8000, 12)).toBe(96);
    expect(frameCountFor(2750, 4)).toBe(11);
  });

  it('always produces at least one frame', () => {
    expect(frameCountFor(0, 12)).toBe(1);
  });
});
