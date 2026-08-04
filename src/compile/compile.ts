import { ACTIVITY_IDS, MAX_ACTIVITIES, prefersPaceOverSpeed } from '../domain/activities.js';
import {
  countSteps,
  type Guide,
  type GuideField,
  type GuideFieldsStep,
  type GuideManifest,
  type GuideNotificationStep,
  type GuideStep,
  type GuideTrigger,
} from '../domain/guide.js';
import { fit, LIMITS, sanitize } from '../domain/limits.js';
import {
  type AthleteProfile,
  type Duration,
  type Intensity,
  type SimpleStep,
  type Step,
  type Workout,
  WorkoutSchema,
} from '../domain/workout.js';
import { deriveExternalId, normalizeExternalId } from './external-id.js';
import {
  paceRangeToSpeedRange,
  perMinuteToHertz,
  resolveHeartRate,
  resolvePower,
} from './units.js';

/**
 * Lowering from the coach-facing domain model into the SuuntoPlus Guide format.
 *
 * Almost every interesting decision in this file exists because the guide format
 * is a *display* format, not a training format. It has no step roles, no notion
 * of a percentage, no nesting, and a 13-character title budget. Everything a
 * coach would call structure has to be re-expressed as screens, triggers and
 * target gauges.
 */

export interface CompileOptions {
  /** Creator name. For the Cloud API this must match the OAuth application name. */
  owner: string;
  /** Link back to the source plan. Required by the schema. */
  url: string;
  /** Only needed when the workout uses percentage-based targets. */
  profile?: AthleteProfile;
}

export interface CompileResult {
  guide: Guide;
  manifest: GuideManifest;
  /** Non-fatal observations: truncations, dropped detail, budget pressure. */
  warnings: string[];
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

const DEFAULT_URL = 'https://github.com/local/suunto-mcp';

export function compile(input: unknown, options: CompileOptions): CompileResult {
  const parsed = WorkoutSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new CompileError(`invalid workout: ${issues}`);
  }
  const workout = parsed.data;
  const warnings: string[] = [];
  const profile = options.profile ?? {};

  const activities = workout.activities.map((name) => ACTIVITY_IDS[name]);
  if (activities.length > MAX_ACTIVITIES) {
    throw new CompileError(`a guide may declare at most ${MAX_ACTIVITIES} activities`);
  }

  const ctx: LoweringContext = {
    profile,
    usePaceUnits: prefersPaceOverSpeed(activities),
    warnings,
  };

  const steps: GuideStep[] = flattenTopLevel(workout.steps, warnings).flatMap<GuideStep>((step) => {
    if (step.type !== 'repeat') return lowerStep(step, ctx);

    const out: GuideStep[] = [];
    // A block-level note fires once, before the first repetition — attaching it
    // to the first child instead would replay it on every lap.
    if (step.note) {
      const text = fit(step.note, LIMITS.text);
      if (text) out.push({ type: 'notification', fields: [{ type: 'text', value: text }] });
    }
    out.push({
      type: 'repeat',
      times: step.times,
      steps: step.steps.flatMap((child) => lowerStep(child, ctx)),
    });
    return out;
  });

  // A trailing step with no trigger is how the format expresses "you're done";
  // the watch simply rests on this screen.
  if (workout.finalMessage) {
    const title = fit(workout.finalMessage, LIMITS.stepTitle);
    if (title) steps.push({ type: 'fields', title });
  }

  const total = countSteps(steps);
  if (total > LIMITS.steps) {
    throw new CompileError(
      `guide has ${total} steps, exceeding the limit of ${LIMITS.steps}. ` +
        `Use repeat blocks instead of writing every interval out, or split the session.`,
    );
  }
  if (total > LIMITS.steps * 0.8) {
    warnings.push(`step count ${total} is close to the ${LIMITS.steps} limit`);
  }

  const name = fitWarn(workout.title, LIMITS.name, 'title', warnings);
  const description = fitWarn(workout.description, LIMITS.description, 'description', warnings);
  const shortDescription = fitWarn(
    workout.shortDescription ?? workout.title,
    LIMITS.shortDescription,
    'shortDescription',
    warnings,
  );
  const owner = fit(options.owner, LIMITS.owner);
  if (!owner) throw new CompileError('owner is required and must contain renderable characters');

  const externalId = workout.externalId
    ? normalizeExternalId(workout.externalId)
    : deriveExternalId(workout);

  const guide: Guide = {
    name,
    description,
    shortDescription,
    ...(workout.date ? { localDate: workout.date } : {}),
    type: 'sequence',
    activities,
    usage: 'workout',
    owner,
    url: (options.url || DEFAULT_URL).slice(0, LIMITS.url),
    externalId,
    steps,
  };

  const manifest: GuideManifest = {
    name,
    type: 'sequence',
    owner,
    description,
  };

  return { guide, manifest, warnings };
}

// ---------------------------------------------------------------------------
// Repeat flattening
// ---------------------------------------------------------------------------

interface FlatRepeat {
  type: 'repeat';
  times: number;
  steps: SimpleStep[];
  note?: string;
}

/**
 * The guide format forbids nested repeats, but coaches nest constantly — a
 * pyramid is naturally "3 sets of (2 × 400m, 1 × 800m)".
 *
 * We keep the *outermost* repeat as a real repeat and expand everything inside
 * it into literal steps. Keeping the outer block matters for the step budget: a
 * repeat contributes its children once regardless of `times`, so
 * `repeat(20, [a, b])` costs 3 steps while its full expansion costs 40.
 */
function flattenTopLevel(steps: readonly Step[], warnings: string[]): Array<SimpleStep | FlatRepeat> {
  return steps.map((step) =>
    step.type === 'step'
      ? step
      : {
          type: 'repeat' as const,
          times: step.times,
          steps: expandSteps(step.steps, warnings),
          ...(step.note ? { note: step.note } : {}),
        },
  );
}

/**
 * Fully expand a step list, unrolling every repeat into literal steps.
 *
 * A note on an inner repeat announces that sub-block, so it moves onto the first
 * step of each repetition — which is where it would have fired anyway. If that
 * step already carries its own note we keep the more specific one and say so,
 * rather than silently discarding either.
 */
function expandSteps(steps: readonly Step[], warnings: string[]): SimpleStep[] {
  const out: SimpleStep[] = [];
  for (const step of steps) {
    if (step.type === 'step') {
      out.push(step);
      continue;
    }
    const inner = expandSteps(step.steps, warnings);
    const first = inner[0];
    if (step.note && first) {
      if (first.note) {
        warnings.push(
          `note on a nested repeat ("${step.note}") was dropped: its first step already has the note "${first.note}"`,
        );
      } else {
        inner[0] = { ...first, note: step.note };
      }
    }
    for (let i = 0; i < step.times; i += 1) out.push(...inner);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step lowering
// ---------------------------------------------------------------------------

interface LoweringContext {
  profile: AthleteProfile;
  /** Emit `targetPace` (min/km) rather than `targetSpeed` (km/h). */
  usePaceUnits: boolean;
  warnings: string[];
}

/**
 * A single domain step becomes one `fields` step, optionally preceded by a
 * `notification` popup carrying its note. The notification is a separate step in
 * this format — it is not a property of the step it introduces.
 */
function lowerStep(
  step: SimpleStep,
  ctx: LoweringContext,
): Array<GuideFieldsStep | GuideNotificationStep> {
  const out: Array<GuideFieldsStep | GuideNotificationStep> = [];

  if (step.note) {
    const text = fit(step.note, LIMITS.text);
    if (text) {
      out.push({
        type: 'notification',
        ...(step.lapOnStart ? { createManualLap: true } : {}),
        fields: [{ type: 'text', value: text }],
      });
    }
  }

  const fieldsStep: GuideFieldsStep = { type: 'fields' };

  const trigger = triggerFor(step.duration, step.allowSkip !== false);
  if (trigger) fieldsStep.trigger = trigger;

  const title = fit(step.title ?? generateTitle(step), LIMITS.stepTitle);
  if (title) fieldsStep.title = title;

  // Two independent reasons a fields step gets a manual lap mark:
  //  (a) lapOnStart — an explicit request to log one at this step's start,
  //      regardless of the trigger. Exactly how Suunto's own official PDF
  //      sample uses it: createManualLap:true on a step with an ordinary flat
  //      stepDuration trigger, no OR/manualLap in sight.
  //  (b) the trigger itself can be satisfied by a manual lap press (allowSkip).
  //      Confirmed live, paired 1:1, in a real Runna guide — without this the
  //      OR+manualLap trigger is present but pressing lap does nothing.
  // The two are independent, not one subsuming the other — case (a) is what
  // the official sample uses on a step with no skip capability at all.
  if ((step.lapOnStart && !step.note) || triggerAllowsManualLap(trigger)) {
    fieldsStep.createManualLap = true;
  }

  const fields = buildFields(step, ctx);
  if (fields.length > 0) fieldsStep.fields = fields;

  out.push(fieldsStep);
  return out;
}

function triggerFor(duration: Duration, allowSkip: boolean): GuideTrigger | undefined {
  switch (duration.kind) {
    case 'time':
      return withSkip({ type: 'stepDuration', value: duration.seconds }, allowSkip);
    case 'distance':
      return withSkip({ type: 'stepDistance', value: duration.meters }, allowSkip);
    case 'lap':
      return { type: 'manualLap' };
  }
}

/**
 * Wrap a duration/distance trigger so a manual lap press also ends the step
 * early, matching the compound `{type:'or', triggers:[...]}` form confirmed
 * live in a real Runna guide. A flat trigger isn't wrong — it's exactly what
 * Suunto's own official PDF sample uses — it just means the athlete can never
 * skip ahead, which turned out to be the surprising choice, not the expected
 * one, when a user compared this compiler's output against a working guide.
 */
function withSkip(base: GuideTrigger, allowSkip: boolean): GuideTrigger {
  if (!allowSkip) return base;
  return { type: 'or', triggers: [base, { type: 'manualLap' }] };
}

function triggerAllowsManualLap(trigger: GuideTrigger | undefined): boolean {
  if (!trigger) return false;
  if (trigger.type === 'manualLap') return true;
  if (trigger.type === 'or' || trigger.type === 'and') {
    return trigger.triggers.some(triggerAllowsManualLap);
  }
  return false;
}

/**
 * Choose what goes on the watch face for a step.
 *
 * The display adapts to field count, and the documented layouts are "3 fields +
 * optional target" and "5 fields + optional target". We stay at the smaller
 * layout — target, the metric being targeted, heart rate for context, and the
 * countdown — because bigger digits matter more mid-interval than extra data.
 */
function buildFields(step: SimpleStep, ctx: LoweringContext): GuideField[] {
  const fields: GuideField[] = [];

  if (step.intensity) {
    fields.push(targetField(step.intensity, ctx));
    const live = liveMetricFor(step.intensity, ctx);
    if (live) fields.push({ type: live });
  }

  // Heart rate is worth showing on almost any step; skip it only when it is
  // already the target metric and would therefore appear twice.
  if (!step.intensity || step.intensity.kind !== 'hr') {
    fields.push({ type: 'heartRate' });
  }

  const countdown = countdownField(step.duration);
  if (countdown) fields.push(countdown);

  return fields;
}

/**
 * The countdown field duplicates the trigger's value. That redundancy is in the
 * format by design: the trigger ends the step, the field is what the athlete
 * actually sees ticking down.
 */
function countdownField(duration: Duration): GuideField | undefined {
  switch (duration.kind) {
    case 'time':
      return { type: 'stepDurationCountdown', value: duration.seconds };
    case 'distance':
      return { type: 'stepDistanceCountdown', value: duration.meters };
    case 'lap':
      return undefined;
  }
}

function liveMetricFor(intensity: Intensity, ctx: LoweringContext): string | undefined {
  switch (intensity.kind) {
    case 'pace':
      return ctx.usePaceUnits ? 'pace' : 'speed';
    case 'speed':
      return 'speed';
    case 'hr':
      return 'heartRate';
    case 'power':
      return 'power';
    case 'cadence':
      return 'cadence';
  }
}

function midpoint(min: number, max: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(((min + max) / 2) * factor) / factor;
}

function targetField(intensity: Intensity, ctx: LoweringContext): GuideField {
  switch (intensity.kind) {
    case 'pace': {
      // Bounds invert here: the fast pace is the high speed. See units.ts.
      const { min, max } = paceRangeToSpeedRange(intensity);
      return {
        type: ctx.usePaceUnits ? 'targetPace' : 'targetSpeed',
        value: midpoint(min, max, 2),
        min,
        max,
      };
    }
    case 'speed':
      return {
        type: 'targetSpeed',
        value: midpoint(intensity.minMps, intensity.maxMps, 2),
        min: intensity.minMps,
        max: intensity.maxMps,
      };
    case 'hr': {
      const min = resolveHeartRate(intensity.basis, intensity.min, ctx.profile);
      const max = resolveHeartRate(intensity.basis, intensity.max, ctx.profile);
      return { type: 'targetHeartRate', value: Math.round((min + max) / 2), min, max };
    }
    case 'power': {
      const min = resolvePower(intensity.basis, intensity.min, ctx.profile);
      const max = resolvePower(intensity.basis, intensity.max, ctx.profile);
      return { type: 'targetPower', value: Math.round((min + max) / 2), min, max };
    }
    case 'cadence': {
      // Hertz, not rpm. 180 spm is 3.0.
      const min = perMinuteToHertz(intensity.minPerMin);
      const max = perMinuteToHertz(intensity.maxPerMin);
      return { type: 'targetCadence', value: midpoint(min, max, 3), min, max };
    }
  }
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/** Human label for a duration, kept short enough to survive the 13-char budget. */
export function durationLabel(duration: Duration): string {
  switch (duration.kind) {
    case 'time': {
      const s = duration.seconds;
      // Whole minutes read as minutes even when short: a 60-second interval is
      // "1 min", not "60 s". Only genuinely sub-minute steps get seconds.
      if (s >= 3600 && s % 3600 === 0) return `${s / 3600} h`;
      if (s % 60 === 0) return `${s / 60} min`;
      if (s < 120) return `${s} s`;
      // Ragged durations over two minutes read better as m:ss than as a
      // rounded minute count, which would show 2:30 as "3 min".
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    case 'distance': {
      const m = duration.meters;
      if (m < 1000) return `${Math.round(m)} m`;
      const km = m / 1000;
      return Number.isInteger(km) ? `${km} km` : `${km.toFixed(1)} km`;
    }
    case 'lap':
      return 'Lap';
  }
}

/**
 * Generate a step title from its role and duration, mirroring the phrasing in
 * Suunto's own sample guide ("10 min warmup", "1 min int", "1 min rest").
 */
function generateTitle(step: SimpleStep): string {
  const d = durationLabel(step.duration);
  switch (step.role) {
    case 'warmup':
      return `${d} warmup`;
    case 'work':
      return `${d} int`;
    case 'rest':
      return `${d} rest`;
    case 'recovery':
      return `${d} rec`;
    case 'cooldown':
      return 'Cooldown';
    case 'other':
      return d;
  }
}

function fitWarn(value: string, max: number, label: string, warnings: string[]): string {
  const clean = sanitize(value);
  const fitted = fit(value, max);
  if (fitted.length < clean.length) {
    warnings.push(`${label} truncated to ${max} characters: "${fitted}"`);
  }
  if (!fitted) {
    throw new CompileError(`${label} is empty after removing unsupported characters`);
  }
  return fitted;
}
