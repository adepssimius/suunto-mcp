import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile/compile.js';
import { validateGuide } from '../src/domain/guide-schema.js';
import type { Guide, GuideFieldsStep, GuideRepeatStep } from '../src/domain/guide.js';
import type { Workout } from '../src/domain/workout.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/pyramid-interval.guide.json', import.meta.url)), 'utf8'),
) as Guide;

const OPTIONS = {
  owner: 'CoachingPlatform',
  url: 'https://www.coachingplatform.com/planwebsitetoreadmore/123456789',
};

/**
 * Suunto's own published sample guide, used two ways:
 *
 *  1. as proof that our model of the wire format accepts real Suunto output, and
 *  2. as the target for the compiler, via an equivalent domain workout.
 *
 * The compiler deliberately makes different *cosmetic* choices than the sample
 * (which metrics share the screen), so this asserts the training-meaningful
 * skeleton — step order, triggers, titles, repeat structure, target values —
 * rather than byte equality, which would only be testing our own opinions.
 */
describe('official Pyramid interval sample', () => {
  it('validates against our guide schema', () => {
    const result = validateGuide(fixture);
    if (!result.ok) console.error(result.issues);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a guide with a misspelled step type, the way the server does', () => {
    const broken = structuredClone(fixture) as unknown as { steps: Array<{ type: string }> };
    broken.steps[1]!.type = 'notfication'; // the exact typo from Suunto's 400 example
    const result = validateGuide(broken);
    expect(result.ok).toBe(false);
  });

  it('rejects nested repeats', () => {
    const broken = structuredClone(fixture) as unknown as { steps: unknown[] };
    broken.steps[4] = {
      type: 'repeat',
      times: 2,
      steps: [{ type: 'repeat', times: 2, steps: [{ type: 'fields', title: 'x' }] }],
    };
    expect(validateGuide(broken).ok).toBe(false);
  });

  it('rejects a step title over 13 characters', () => {
    const broken = structuredClone(fixture) as unknown as {
      steps: Array<{ title?: string }>;
    };
    broken.steps[0]!.title = 'way too long a title';
    expect(validateGuide(broken).ok).toBe(false);
  });
});

/** The same session expressed the way a coach would describe it. */
const pyramidWorkout: Workout = {
  title: 'Pyramid interval',
  description: 'Hard session which impacts an-aerobic threshold pace',
  shortDescription: 'Hard session',
  activities: ['CROSS_COUNTRY_SKIING'],
  date: '2021-05-28',
  externalId: '123456789',
  finalMessage: 'Good Job',
  steps: [
    {
      type: 'step',
      role: 'warmup',
      duration: { kind: 'time', seconds: 600 },
      intensity: { kind: 'hr', basis: 'bpm', min: 104, max: 148 },
    },
    {
      type: 'step',
      role: 'work',
      duration: { kind: 'time', seconds: 300 },
      intensity: { kind: 'hr', basis: 'bpm', min: 145, max: 155 },
      note: 'Interval #1 5min @ 90%',
      lapOnStart: true,
      title: '5 min int',
    },
    {
      type: 'repeat',
      times: 3,
      note: 'Interval set 3x1min / 1min',
      steps: [
        {
          type: 'step',
          role: 'work',
          duration: { kind: 'time', seconds: 60 },
          intensity: { kind: 'hr', basis: 'bpm', min: 170, max: 185 },
          lapOnStart: true,
        },
        {
          type: 'step',
          role: 'rest',
          duration: { kind: 'time', seconds: 60 },
          intensity: { kind: 'hr', basis: 'bpm', min: 130, max: 145 },
          note: 'Rest',
          lapOnStart: true,
        },
      ],
    },
    {
      type: 'step',
      role: 'cooldown',
      duration: { kind: 'time', seconds: 600 },
      intensity: { kind: 'hr', basis: 'bpm', min: 130, max: 145 },
      lapOnStart: true,
    },
  ],
};

describe('compiling the equivalent domain workout', () => {
  const { guide, manifest, warnings } = compile(pyramidWorkout, OPTIONS);

  it('produces a schema-valid guide', () => {
    const result = validateGuide(guide);
    if (!result.ok) console.error(result.issues);
    expect(result).toEqual({ ok: true });
    expect(warnings).toEqual([]);
  });

  it('reproduces the sample metadata', () => {
    expect(guide.name).toBe(fixture.name);
    expect(guide.description).toBe(fixture.description);
    expect(guide.shortDescription).toBe(fixture.shortDescription);
    expect(guide.type).toBe('sequence');
    expect(guide.usage).toBe('workout');
    expect(guide.owner).toBe(fixture.owner);
    expect(guide.localDate).toBe('2021-05-28');
    expect(guide.activities).toEqual([3]);
    expect(guide.externalId).toBe('123456789');
  });

  it('reproduces the sample step sequence', () => {
    expect(guide.steps.map((s) => s.type)).toEqual([
      'fields', // 10 min warmup
      'notification', // Interval #1 5min @ 90%
      'fields', // 5 min
      'notification', // Interval set 3x1min / 1min
      'repeat',
      'fields', // cooldown
      'fields', // Good Job
    ]);
    expect(guide.steps.map((s) => s.type)).toEqual(fixture.steps.map((s) => s.type));
  });

  it('reproduces the sample triggers', () => {
    const triggers = guide.steps
      .filter((s): s is GuideFieldsStep => s.type === 'fields')
      .map((s) => s.trigger?.value);
    expect(triggers).toEqual([600, 300, 600, undefined]);
  });

  it('reproduces the repeat block, with the lap marks in the same places', () => {
    const repeat = guide.steps.find((s): s is GuideRepeatStep => s.type === 'repeat')!;
    const expected = fixture.steps.find((s): s is GuideRepeatStep => s.type === 'repeat')!;

    expect(repeat.times).toBe(3);
    expect(repeat.times).toBe(expected.times);
    expect(repeat.steps.map((s) => s.type)).toEqual(expected.steps.map((s) => s.type));
    expect(repeat.steps.map((s) => s.createManualLap ?? false)).toEqual(
      expected.steps.map((s) => s.createManualLap ?? false),
    );
  });

  it('generates the sample step titles', () => {
    const titles = guide.steps
      .filter((s): s is GuideFieldsStep => s.type === 'fields')
      .map((s) => s.title);
    expect(titles).toEqual(['10 min warmup', '5 min int', 'Cooldown', 'Good Job']);

    const repeat = guide.steps.find((s): s is GuideRepeatStep => s.type === 'repeat')!;
    expect(repeat.steps.filter((s) => s.type === 'fields').map((s) => s.title)).toEqual([
      '1 min int',
      '1 min rest',
    ]);
  });

  it('carries the notification text through', () => {
    const notes = guide.steps
      .filter((s) => s.type === 'notification')
      .map((s) => s.fields[0]?.value);
    expect(notes).toEqual(['Interval #1 5min @ 90%', 'Interval set 3x1min / 1min']);
  });

  it('emits the sample heart-rate targets, including the midpoints', () => {
    const targets = guide.steps
      .filter((s): s is GuideFieldsStep => s.type === 'fields')
      .flatMap((s) => s.fields ?? [])
      .filter((f) => f.type === 'targetHeartRate');

    expect(targets).toEqual([
      { type: 'targetHeartRate', value: 126, min: 104, max: 148 },
      { type: 'targetHeartRate', value: 150, min: 145, max: 155 },
      { type: 'targetHeartRate', value: 138, min: 130, max: 145 },
    ]);
  });

  it('pairs every timed step with a matching countdown field', () => {
    for (const step of guide.steps) {
      if (step.type !== 'fields' || !step.trigger) continue;
      const countdown = (step.fields ?? []).find((f) => f.type === 'stepDurationCountdown');
      expect(countdown?.value).toBe(step.trigger.value);
    }
  });

  it('builds a manifest whose owner matches the guide', () => {
    expect(manifest).toEqual({
      name: 'Pyramid interval',
      type: 'sequence',
      owner: 'CoachingPlatform',
      description: 'Hard session which impacts an-aerobic threshold pace',
    });
  });
});
