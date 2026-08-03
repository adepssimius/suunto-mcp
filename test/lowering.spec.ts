import { describe, expect, it } from 'vitest';
import { compile, CompileError } from '../src/compile/compile.js';
import { validateGuide } from '../src/domain/guide-schema.js';
import type { GuideFieldsStep, GuideRepeatStep } from '../src/domain/guide.js';
import type { Step, Workout } from '../src/domain/workout.js';

const OPTIONS = { owner: 'suunto-mcp', url: 'https://example.com/plan' };

function workout(steps: Step[], extra: Partial<Workout> = {}): Workout {
  return {
    title: 'Session',
    description: 'A session',
    activities: ['RUNNING'],
    steps,
    ...extra,
  } as Workout;
}

const min = (seconds: number) => ({ kind: 'time' as const, seconds });

describe('repeat flattening', () => {
  /**
   * The format forbids nested repeats, but a pyramid is naturally nested. The
   * outer block must survive as a real repeat (it is what keeps the step count
   * down) while everything inside it is unrolled.
   */
  it('unrolls a nested repeat while keeping the outer block', () => {
    const { guide } = compile(
      workout([
        {
          type: 'repeat',
          times: 3,
          steps: [
            { type: 'repeat', times: 2, steps: [{ type: 'step', role: 'work', duration: min(60) }] },
            { type: 'step', role: 'rest', duration: min(90) },
          ],
        },
      ]),
      OPTIONS,
    );

    expect(validateGuide(guide)).toEqual({ ok: true });

    const repeat = guide.steps.find((s): s is GuideRepeatStep => s.type === 'repeat')!;
    expect(repeat.times).toBe(3);
    // 2 unrolled work steps + 1 rest step
    expect(repeat.steps).toHaveLength(3);
    expect(repeat.steps.map((s) => (s as GuideFieldsStep).trigger?.value)).toEqual([60, 60, 90]);
  });

  it('unrolls repeats nested three deep', () => {
    const { guide } = compile(
      workout([
        {
          type: 'repeat',
          times: 2,
          steps: [
            {
              type: 'repeat',
              times: 2,
              steps: [
                { type: 'repeat', times: 2, steps: [{ type: 'step', role: 'work', duration: min(30) }] },
              ],
            },
          ],
        },
      ]),
      OPTIONS,
    );
    const repeat = guide.steps.find((s): s is GuideRepeatStep => s.type === 'repeat')!;
    expect(repeat.times).toBe(2);
    expect(repeat.steps).toHaveLength(4); // 2 × 2 unrolled
  });

  it('emits a block note once, before the repeat rather than inside it', () => {
    const { guide } = compile(
      workout([
        {
          type: 'repeat',
          times: 5,
          note: 'Main set 5x400',
          steps: [{ type: 'step', role: 'work', duration: { kind: 'distance', meters: 400 } }],
        },
      ]),
      OPTIONS,
    );

    expect(guide.steps.map((s) => s.type)).toEqual(['notification', 'repeat']);
    const repeat = guide.steps[1] as GuideRepeatStep;
    expect(repeat.steps.some((s) => s.type === 'notification')).toBe(false);
  });

  it('moves an inner block note onto the first step of each repetition', () => {
    const { guide, warnings } = compile(
      workout([
        {
          type: 'repeat',
          times: 2,
          steps: [
            {
              type: 'repeat',
              times: 2,
              note: 'Surge',
              steps: [{ type: 'step', role: 'work', duration: min(60) }],
            },
          ],
        },
      ]),
      OPTIONS,
    );
    expect(warnings).toEqual([]);
    const repeat = guide.steps.find((s): s is GuideRepeatStep => s.type === 'repeat')!;
    // Each of the 2 unrolled repetitions gets its notification + fields pair.
    expect(repeat.steps.map((s) => s.type)).toEqual([
      'notification',
      'fields',
      'notification',
      'fields',
    ]);
  });

  it('warns rather than silently dropping a colliding inner note', () => {
    const { warnings } = compile(
      workout([
        {
          type: 'repeat',
          times: 2,
          steps: [
            {
              type: 'repeat',
              times: 1,
              note: 'Block note',
              steps: [{ type: 'step', role: 'work', duration: min(60), note: 'Step note' }],
            },
          ],
        },
      ]),
      OPTIONS,
    );
    expect(warnings.join(' ')).toMatch(/Block note.*dropped.*Step note/);
  });
});

describe('targets end to end', () => {
  /**
   * The inversion again, but through the whole compiler this time — a unit test
   * on the conversion would not catch the compiler wiring the bounds through
   * backwards.
   */
  it('emits an inverted pace range as targetPace in m/s', () => {
    const { guide } = compile(
      workout([
        {
          type: 'step',
          role: 'work',
          duration: { kind: 'distance', meters: 1000 },
          intensity: { kind: 'pace', fastSecPerKm: 255, slowSecPerKm: 265 },
        },
      ]),
      OPTIONS,
    );

    const target = (guide.steps[0] as GuideFieldsStep).fields!.find((f) =>
      f.type.startsWith('target'),
    )!;
    expect(target).toEqual({ type: 'targetPace', value: 3.85, min: 3.77, max: 3.92 });
  });

  it('uses targetSpeed rather than targetPace for a cycling guide', () => {
    const { guide } = compile(
      workout(
        [
          {
            type: 'step',
            role: 'work',
            duration: min(600),
            intensity: { kind: 'pace', fastSecPerKm: 120, slowSecPerKm: 150 },
          },
        ],
        { activities: ['CYCLING'] },
      ),
      OPTIONS,
    );
    const target = (guide.steps[0] as GuideFieldsStep).fields!.find((f) =>
      f.type.startsWith('target'),
    )!;
    expect(target.type).toBe('targetSpeed');
  });

  it('emits cadence in Hertz, not steps per minute', () => {
    const { guide } = compile(
      workout([
        {
          type: 'step',
          role: 'work',
          duration: min(300),
          intensity: { kind: 'cadence', minPerMin: 174, maxPerMin: 186 },
        },
      ]),
      OPTIONS,
    );
    const target = (guide.steps[0] as GuideFieldsStep).fields!.find((f) =>
      f.type.startsWith('target'),
    )!;
    expect(target).toEqual({ type: 'targetCadence', value: 3, min: 2.9, max: 3.1 });
  });

  it('resolves percentage targets against the athlete profile', () => {
    const { guide } = compile(
      workout([
        {
          type: 'step',
          role: 'work',
          duration: min(300),
          intensity: { kind: 'power', basis: 'pctFtp', min: 95, max: 105 },
        },
      ]),
      { ...OPTIONS, profile: { ftp: 280 } },
    );
    const target = (guide.steps[0] as GuideFieldsStep).fields!.find((f) =>
      f.type.startsWith('target'),
    )!;
    expect(target).toEqual({ type: 'targetPower', value: 280, min: 266, max: 294 });
  });

  it('fails loudly when a percentage target has no reference value', () => {
    expect(() =>
      compile(
        workout([
          {
            type: 'step',
            role: 'work',
            duration: min(300),
            intensity: { kind: 'hr', basis: 'pctMax', min: 85, max: 92 },
          },
        ]),
        OPTIONS,
      ),
    ).toThrow(/no maxHr/);
  });

  it('rejects a pace range whose bounds are the wrong way round', () => {
    expect(() =>
      compile(
        workout([
          {
            type: 'step',
            role: 'work',
            duration: min(300),
            intensity: { kind: 'pace', fastSecPerKm: 300, slowSecPerKm: 240 },
          },
        ]),
        OPTIONS,
      ),
    ).toThrow(CompileError);
  });
});

describe('durations and triggers', () => {
  it('maps each duration kind to the right trigger and countdown', () => {
    const { guide } = compile(
      workout([
        { type: 'step', role: 'work', duration: min(300) },
        { type: 'step', role: 'work', duration: { kind: 'distance', meters: 800 } },
        { type: 'step', role: 'recovery', duration: { kind: 'lap' } },
      ]),
      OPTIONS,
    );

    const steps = guide.steps as GuideFieldsStep[];
    expect(steps[0]!.trigger).toEqual({ type: 'stepDuration', value: 300 });
    expect(steps[0]!.fields!.some((f) => f.type === 'stepDurationCountdown')).toBe(true);

    expect(steps[1]!.trigger).toEqual({ type: 'stepDistance', value: 800 });
    expect(steps[1]!.fields!.some((f) => f.type === 'stepDistanceCountdown')).toBe(true);

    // An open step ends on the lap button and has nothing to count down.
    expect(steps[2]!.trigger).toEqual({ type: 'manualLap' });
    expect(steps[2]!.fields!.some((f) => f.type.endsWith('Countdown'))).toBe(false);
  });

  it('labels durations the way a coach reads them', () => {
    const { guide } = compile(
      workout([
        { type: 'step', role: 'work', duration: min(60) },
        { type: 'step', role: 'work', duration: min(45) },
        { type: 'step', role: 'work', duration: min(150) },
        { type: 'step', role: 'work', duration: min(3600) },
        { type: 'step', role: 'work', duration: { kind: 'distance', meters: 400 } },
        { type: 'step', role: 'work', duration: { kind: 'distance', meters: 1000 } },
        { type: 'step', role: 'work', duration: { kind: 'distance', meters: 1500 } },
      ]),
      OPTIONS,
    );
    expect((guide.steps as GuideFieldsStep[]).map((s) => s.title)).toEqual([
      '1 min int',
      '45 s int',
      '2:30 int',
      '1 h int',
      '400 m int',
      '1 km int',
      '1.5 km int',
    ]);
  });
});

describe('watch display limits', () => {
  it('truncates over-long metadata and reports it', () => {
    const { guide, warnings } = compile(
      workout([{ type: 'step', role: 'work', duration: min(60) }], {
        title: 'A'.repeat(100),
        shortDescription: 'B'.repeat(100),
      }),
      OPTIONS,
    );
    expect(guide.name).toHaveLength(60);
    expect(guide.shortDescription).toHaveLength(23);
    expect(warnings.some((w) => w.includes('title truncated'))).toBe(true);
    expect(validateGuide(guide)).toEqual({ ok: true });
  });

  it('strips characters the watch cannot render', () => {
    const { guide } = compile(
      workout([{ type: 'step', role: 'work', duration: min(60) }], {
        title: 'Café — 5×400m [hard]',
        description: 'Naïve ~ pace',
      }),
      OPTIONS,
    );
    // Accents folded, em-dash and multiplication sign transliterated,
    // brackets normalised to parentheses.
    expect(guide.name).toBe('Cafe - 5x400m (hard)');
    expect(guide.description).toBe('Naive - pace');
  });

  it('keeps @ and % so interval notation survives', () => {
    const { guide } = compile(
      workout([{ type: 'step', role: 'work', duration: min(60), note: '5min @ 90% effort' }]),
      OPTIONS,
    );
    expect(guide.steps[0]).toMatchObject({
      type: 'notification',
      fields: [{ type: 'text', value: '5min @ 90% effort' }],
    });
  });

  it('rejects a guide that would exceed the 1000-step limit', () => {
    const many: Step[] = Array.from({ length: 501 }, () => ({
      type: 'step' as const,
      role: 'work' as const,
      duration: min(60),
      note: 'go',
    }));
    expect(() => compile(workout(many), OPTIONS)).toThrow(/exceeding the limit/);
  });

  it('counts a repeat block once, not once per repetition', () => {
    // 100 repetitions of 2 steps would be 200 steps unrolled, but the format
    // counts the block's children once — this must stay well under the limit.
    const { guide } = compile(
      workout([
        {
          type: 'repeat',
          times: 100,
          steps: [
            { type: 'step', role: 'work', duration: min(60) },
            { type: 'step', role: 'rest', duration: min(60) },
          ],
        },
      ]),
      OPTIONS,
    );
    expect(validateGuide(guide)).toEqual({ ok: true });
    expect((guide.steps[0] as GuideRepeatStep).steps).toHaveLength(2);
  });
});

describe('externalId', () => {
  const base = workout([{ type: 'step', role: 'work', duration: min(300) }], {
    date: '2026-08-04',
  });

  it('is deterministic for the same session', () => {
    expect(compile(base, OPTIONS).guide.externalId).toBe(compile(base, OPTIONS).guide.externalId);
  });

  it('changes when the session changes', () => {
    const harder = workout([{ type: 'step', role: 'work', duration: min(600) }], {
      date: '2026-08-04',
    });
    expect(compile(harder, OPTIONS).guide.externalId).not.toBe(
      compile(base, OPTIONS).guide.externalId,
    );
  });

  it('changes when the date changes, so a repeated session on a new day is a new guide', () => {
    const tomorrow = workout([{ type: 'step', role: 'work', duration: min(300) }], {
      date: '2026-08-05',
    });
    expect(compile(tomorrow, OPTIONS).guide.externalId).not.toBe(
      compile(base, OPTIONS).guide.externalId,
    );
  });

  /**
   * Identity tracks the session, not its presentation — otherwise re-wording a
   * description would orphan every guide already synced to the watch.
   */
  it('is unchanged by a reworded description', () => {
    const reworded = workout([{ type: 'step', role: 'work', duration: min(300) }], {
      date: '2026-08-04',
      description: 'Completely different wording here',
    });
    expect(compile(reworded, OPTIONS).guide.externalId).toBe(
      compile(base, OPTIONS).guide.externalId,
    );
  });

  it('honours an explicit externalId', () => {
    const pinned = workout([{ type: 'step', role: 'work', duration: min(300) }], {
      externalId: 'runna-week3-tuesday',
    });
    expect(compile(pinned, OPTIONS).guide.externalId).toBe('runna-week3-tuesday');
  });
});
