import { createHash } from 'node:crypto';
import type { Step, Workout } from '../domain/workout.js';
import { LIMITS } from '../domain/limits.js';

/**
 * Deterministic identity for a workout.
 *
 * `externalId` is the Cloud API's dedup key: pushing a guide whose `externalId`
 * already exists on the account returns 409 rather than creating a duplicate.
 * That makes a sync pipeline idempotent for free, provided the id is a pure
 * function of the workout's content.
 *
 * We hash the *domain* workout rather than the compiled guide, because identity
 * should track what the athlete is asked to do — not incidental changes in how
 * the compiler labels a screen. A compiler tweak that reworded a step title
 * should not orphan every guide already on the watch.
 *
 * Only the fields that change the session participate: date, title, and the
 * step structure. Descriptions and display text are deliberately excluded.
 */
export function deriveExternalId(workout: Workout): string {
  const canonical = JSON.stringify({
    date: workout.date ?? null,
    title: workout.title.trim().toLowerCase(),
    steps: canonicalSteps(workout.steps),
  });

  // 32 hex chars is 128 bits — far inside the 64-char budget, and collision
  // risk is irrelevant at the scale of one athlete's training history.
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Reduce steps to the parts that define the session. Key order is fixed rather
 * than relying on object literal order, so the hash is stable across refactors.
 */
function canonicalSteps(steps: readonly Step[]): unknown[] {
  return steps.map((step) => {
    if (step.type === 'repeat') {
      return { r: step.times, s: canonicalSteps(step.steps) };
    }
    return {
      role: step.role,
      dur: canonicalDuration(step),
      int: canonicalIntensity(step),
    };
  });
}

function canonicalDuration(step: Extract<Step, { type: 'step' }>): unknown {
  const d = step.duration;
  switch (d.kind) {
    case 'time':
      return ['t', d.seconds];
    case 'distance':
      return ['d', d.meters];
    case 'lap':
      return ['l'];
  }
}

function canonicalIntensity(step: Extract<Step, { type: 'step' }>): unknown {
  const i = step.intensity;
  if (!i) return null;
  switch (i.kind) {
    case 'pace':
      return ['p', i.fastSecPerKm, i.slowSecPerKm];
    case 'speed':
      return ['s', i.minMps, i.maxMps];
    case 'hr':
      return ['h', i.basis, i.min, i.max];
    case 'power':
      return ['w', i.basis, i.min, i.max];
    case 'cadence':
      return ['c', i.minPerMin, i.maxPerMin];
  }
}

/** Clamp a caller-supplied externalId to the documented budget. */
export function normalizeExternalId(id: string): string {
  return id.slice(0, LIMITS.externalId);
}
