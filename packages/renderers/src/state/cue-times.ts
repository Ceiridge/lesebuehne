import { tokenTime, type Timeline, type VisualPlan } from '@lesebuehne/core';

/**
 * Book time (τ, seconds at 1.0×) of every cue: the first occurrence of the anchor phrase in its
 * sentence, the first token overlapping it, and that token's time (B9). Cues on sentences that are
 * not on the time axis fall back to the previous cue time. Times never decrease in cue order.
 */
export function resolveCueTimes(plan: VisualPlan, timeline: Timeline): number[] {
  const times: number[] = [];
  let last = 0;
  for (const [k, cue] of plan.cues.entries()) {
    const index = timeline.indexOf.get(cue.anchor.sentenceId);
    const entry = index === undefined ? undefined : timeline.entries[index];
    let t = k === 0 ? (entry?.start ?? 0) : last;
    if (entry) {
      const at = entry.sentence.text.indexOf(cue.anchor.phrase);
      const offset = entry.sentence.start + Math.max(0, at);
      const tokenIndex = entry.sentence.tokens.findIndex((tok) => tok.end > offset);
      t = tokenIndex < 0 ? entry.start : tokenTime(entry, tokenIndex);
    }
    last = Math.max(last, t);
    times.push(last);
  }
  return times;
}
