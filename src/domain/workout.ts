import { z } from 'zod';
import { ACTIVITY_IDS, type ActivityName } from './activities.js';
import { LIMITS } from './limits.js';

/**
 * The internal representation of a structured workout.
 *
 * This is deliberately *not* the Suunto guide format. It is the shape a coach
 * (or an LLM) naturally thinks in — roles, repeats, pace ranges in min/km — and
 * the compiler in `src/compile` lowers it into the much lower-level guide
 * format. Keeping the two apart is what lets a second backend (the private
 * mobile API, whose payload shape differs) reuse everything above the lowering.
 */

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

export const DurationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), seconds: z.number().int().positive().max(86_400) }),
  z.object({ kind: z.literal('distance'), meters: z.number().positive().max(1_000_000) }),
  /** Open-ended: the step ends when the athlete presses the lap button. */
  z.object({ kind: z.literal('lap') }),
]);
export type Duration = z.infer<typeof DurationSchema>;

// ---------------------------------------------------------------------------
// Intensity targets
// ---------------------------------------------------------------------------

/**
 * Pace bounds are named by *meaning*, not by numeric order.
 *
 * This matters more than it looks. Pace and speed are reciprocal, so the faster
 * bound of a pace range becomes the *upper* bound in m/s. Calling these fields
 * `min`/`max` in pace-space and then feeding them into `min`/`max` in
 * speed-space is the single easiest bug to write in this whole system. With
 * `fast`/`slow` there is no ordering to preserve — only a conversion.
 */
export const PaceTargetSchema = z
  .object({
    kind: z.literal('pace'),
    /** Seconds per kilometre at the fast end (the smaller number). */
    fastSecPerKm: z.number().positive().max(3600),
    /** Seconds per kilometre at the slow end (the larger number). */
    slowSecPerKm: z.number().positive().max(3600),
  })
  .refine((t) => t.fastSecPerKm <= t.slowSecPerKm, {
    message: 'fastSecPerKm must be <= slowSecPerKm (fast pace is the smaller number)',
  });

export const SpeedTargetSchema = z
  .object({
    kind: z.literal('speed'),
    minMps: z.number().positive().max(50),
    maxMps: z.number().positive().max(50),
  })
  .refine((t) => t.minMps <= t.maxMps, { message: 'minMps must be <= maxMps' });

export const HeartRateTargetSchema = z
  .object({
    kind: z.literal('hr'),
    /**
     * `bpm` is absolute. `pctMax` and `pctLthr` are resolved against the
     * athlete profile at compile time — the guide format has no notion of a
     * percentage, so an unresolvable percentage is a hard compile error rather
     * than a silently dropped target.
     */
    basis: z.enum(['bpm', 'pctMax', 'pctLthr']),
    min: z.number().positive().max(260),
    max: z.number().positive().max(260),
  })
  .refine((t) => t.min <= t.max, { message: 'min must be <= max' });

export const PowerTargetSchema = z
  .object({
    kind: z.literal('power'),
    basis: z.enum(['watts', 'pctFtp']),
    min: z.number().positive().max(2000),
    max: z.number().positive().max(2000),
  })
  .refine((t) => t.min <= t.max, { message: 'min must be <= max' });

export const CadenceTargetSchema = z
  .object({
    kind: z.literal('cadence'),
    /** Steps or revolutions per minute. Converted to Hertz at compile time. */
    minPerMin: z.number().positive().max(300),
    maxPerMin: z.number().positive().max(300),
  })
  .refine((t) => t.minPerMin <= t.maxPerMin, { message: 'minPerMin must be <= maxPerMin' });

export const IntensitySchema = z.union([
  PaceTargetSchema,
  SpeedTargetSchema,
  HeartRateTargetSchema,
  PowerTargetSchema,
  CadenceTargetSchema,
]);
export type Intensity = z.infer<typeof IntensitySchema>;
export type PaceTarget = z.infer<typeof PaceTargetSchema>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * The role a step plays in the session.
 *
 * The guide format has no equivalent field — there is no WARMUP step type. Roles
 * exist purely so the compiler can pick sensible titles, decide where to insert
 * lap marks, and choose which metrics to put on screen.
 */
export const StepRoleSchema = z.enum([
  'warmup',
  'work',
  'rest',
  'recovery',
  'cooldown',
  'other',
]);
export type StepRole = z.infer<typeof StepRoleSchema>;

export const SimpleStepSchema = z.object({
  type: z.literal('step'),
  role: StepRoleSchema.default('work'),
  duration: DurationSchema,
  intensity: IntensitySchema.optional(),
  /** Overrides the generated step title. Truncated to 13 characters. */
  title: z.string().optional(),
  /** Shown as a notification popup before the step begins. */
  note: z.string().optional(),
  /**
   * Force a lap mark on the notification introducing this step (if `note` is
   * set). Independent of whether the step itself can be skipped early — see
   * `allowSkip`, which governs that.
   */
  lapOnStart: z.boolean().optional(),
  /**
   * Whether pressing the watch's lap button ends this step early, before its
   * duration/distance target is reached. Treated as true when omitted (see
   * `compile.ts`'s `step.allowSkip !== false`, not a zod default — that would
   * make the field required on every hand-authored step object, for no
   * benefit): a real, live-verified guide (from Runna, a Suunto partner)
   * always grants this, so locking a step is the surprising choice a coach
   * opts into, not the default an athlete should be denied by omission. Has
   * no effect on a `duration.kind === 'lap'` step, which is already lap-only.
   */
  allowSkip: z.boolean().optional(),
});
export type SimpleStep = z.infer<typeof SimpleStepSchema>;

export interface RepeatBlock {
  type: 'repeat';
  times: number;
  steps: Step[];
  /**
   * Shown as a notification once, immediately before the block begins — not
   * once per repetition. This is how you announce "Interval set 3x1min / 1min"
   * without it firing on every lap.
   *
   * Explicitly `| undefined` because `exactOptionalPropertyTypes` is on and
   * zod's `.optional()` widens its output to include `undefined`.
   */
  note?: string | undefined;
}
export type Step = SimpleStep | RepeatBlock;

/**
 * Repeat blocks nest in the domain even though the guide format forbids nesting.
 * A coach describing a pyramid naturally nests; the compiler flattens.
 */
export const RepeatBlockSchema: z.ZodType<RepeatBlock> = z.lazy(() =>
  z.object({
    type: z.literal('repeat'),
    times: z.number().int().min(1).max(LIMITS.repeatTimes),
    steps: z.array(StepSchema).min(1),
    note: z.string().optional(),
  }),
);

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([SimpleStepSchema, RepeatBlockSchema]),
);

// ---------------------------------------------------------------------------
// Athlete profile
// ---------------------------------------------------------------------------

/** Needed only to resolve percentage-based targets into absolutes. */
export const AthleteProfileSchema = z.object({
  maxHr: z.number().int().positive().max(260).optional(),
  restHr: z.number().int().positive().max(150).optional(),
  /** Lactate-threshold heart rate, the basis for `pctLthr`. */
  thresholdHr: z.number().int().positive().max(260).optional(),
  /** Functional threshold power, the basis for `pctFtp`. */
  ftp: z.number().positive().max(2000).optional(),
  thresholdPaceSecPerKm: z.number().positive().max(3600).optional(),
});
export type AthleteProfile = z.infer<typeof AthleteProfileSchema>;

// ---------------------------------------------------------------------------
// Workout
// ---------------------------------------------------------------------------

const ActivityNameSchema = z.enum(
  Object.keys(ACTIVITY_IDS) as [ActivityName, ...ActivityName[]],
);

export const WorkoutSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  /** Falls back to a truncation of `title` when omitted. */
  shortDescription: z.string().optional(),
  /** Sports this guide offers itself for. First entry drives pace-vs-speed choice. */
  activities: z.array(ActivityNameSchema).min(1).max(100).default(['RUNNING']),
  /** `yyyy-MM-dd`. Pins the guide to a date in the Suunto calendar. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be yyyy-MM-dd')
    .optional(),
  steps: z.array(StepSchema).min(1),
  /**
   * A closing screen with no trigger, shown once the last step completes
   * (Suunto's own sample ends on "Good Job"). Omit for no closing screen.
   */
  finalMessage: z.string().optional(),
  /**
   * Stable identity for this workout. When omitted the compiler derives one by
   * hashing date + title + step structure, which is what gives us idempotent
   * re-pushes (the server rejects a duplicate externalId with 409).
   */
  externalId: z.string().max(LIMITS.externalId).optional(),
});
export type Workout = z.infer<typeof WorkoutSchema>;
