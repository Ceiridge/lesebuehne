import { describe, expect, test } from 'bun:test';
import { JobQueue } from '@lesebuehne/core';
import { activity, activityHistory, HISTORY_POINTS, kindOfKey, recordActivity, resetActivity, sampleActivity } from '../../src/ai/activity.ts';

describe('info panel data', () => {
  test('activity totals count new, cached and failed work; recent keeps the newest first', () => {
    resetActivity(1000);
    recordActivity({ kind: 'speech', outcome: 'new', ms: 3000, audioSeconds: 6, label: 'Habe Mut.' });
    recordActivity({ kind: 'speech', outcome: 'cached', ms: 5, audioSeconds: 4 });
    recordActivity({ kind: 'image', outcome: 'new', ms: 60000, count: 4 });
    recordActivity({ kind: 'plan', outcome: 'failed', ms: 0, sectionId: 's1' });
    const log = activity.value;
    expect(log.since).toBe(1000);
    expect(log.totals.speech).toMatchObject({ new: 1, cached: 1, failed: 0, ms: 3000, audioSeconds: 6 });
    expect(log.totals.image).toMatchObject({ new: 1, pictures: 4 });
    expect(log.totals.plan.failed).toBe(1);
    expect(log.recent.map((e) => e.kind)).toEqual(['plan', 'image', 'speech', 'speech']);
  });

  test('queue keys map to kinds; history keeps ten minutes of samples', () => {
    expect(['style', 'plan:a', 'regen:a', 'anim:a:r', 'img:a', 'images:3'].map(kindOfKey)).toEqual(['style', 'plan', 'plan', 'animation', 'image', 'image']);
    resetActivity();
    for (let i = 0; i < HISTORY_POINTS + 5; i++) sampleActivity({ at: i, running: 1, queued: 0 });
    expect(activityHistory.value).toHaveLength(HISTORY_POINTS);
    expect(activityHistory.value[0]!.at).toBe(5);
  });

  test('JobQueue.snapshot lists running and waiting jobs, next first', async () => {
    const q = new JobQueue(1);
    const hold = new Promise<void>(() => undefined);
    void q.enqueue({ key: 'a', priority: 5, run: () => hold }).catch(() => undefined);
    void q.enqueue({ key: 'b', priority: 9, run: () => hold }).catch(() => undefined);
    void q.enqueue({ key: 'c', priority: 1, run: () => hold }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(q.snapshot()).toEqual({ concurrency: 1, running: ['c'], queued: ['a', 'b'] });
    q.retain(new Set());
  });
});
