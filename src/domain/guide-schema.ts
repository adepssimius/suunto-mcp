import { z } from 'zod';
import type { GuideTrigger } from './guide.js';
import { LIMITS } from './limits.js';

/**
 * Runtime validation of the SuuntoPlus Guide wire format.
 *
 * This exists to catch a malformed guide *before* it reaches Suunto, because the
 * server's rejection is a single unstructured string —
 * `{"error":{"description":"Invalid step type: 'notfication'"}}` — with no path
 * to the offending step. On a 40-step guide that is a miserable thing to debug.
 *
 * It doubles as the proof that our model of the format is right: the schema is
 * exercised against Suunto's own published sample guide in the test suite.
 */

const COUNTDOWN_FIELDS = ['stepDurationCountdown', 'stepDistanceCountdown'] as const;

const MEASUREMENT_FIELDS = [
  'heartRate',
  'speed',
  'pace',
  'power',
  'altitude',
  'distance',
  'duration',
  'temperature',
  'cadence',
  'strokeRate',
  'strokes',
  'energy',
  'ascent',
  'descent',
  'verticalSpeed',
  'swolf',
  'ascentTime',
  'descentTime',
] as const;

const TARGET_FIELDS = [
  'targetHeartRate',
  'targetSpeed',
  'targetPace',
  'targetPower',
  'targetCadence',
] as const;

export const GUIDE_FIELD_TYPES = [
  ...COUNTDOWN_FIELDS,
  ...MEASUREMENT_FIELDS,
  ...TARGET_FIELDS,
  'text',
] as const;

const GuideFieldSchema = z
  .object({
    type: z.enum(GUIDE_FIELD_TYPES),
    value: z.union([z.number(), z.string()]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    window: z.enum(['workout', 'step', 'manualLap']).optional(),
    aggregate: z.enum(['average', 'min', 'max']).optional(),
    title: z.string().max(LIMITS.fieldTitle).optional(),
  })
  .refine((f) => f.type !== 'text' || typeof f.value === 'string', {
    message: 'a text field requires a string value',
  })
  .refine((f) => f.type === 'text' || typeof f.value !== 'string', {
    message: 'only a text field may carry a string value',
  })
  .refine(
    (f) => typeof f.value !== 'string' || f.value.length <= LIMITS.text,
    { message: `text value exceeds ${LIMITS.text} characters` },
  )
  .refine((f) => f.min === undefined || f.max === undefined || f.min <= f.max, {
    message: 'field min must be <= max',
  });

/**
 * Recursive: a compound trigger's `triggers` array holds more triggers,
 * including further compounds. Confirmed live in a real Runna guide as the
 * mechanism that lets an athlete press lap to skip a duration/distance step
 * early — see the comment on `GuideTrigger` in `guide.ts`.
 */
const GuideTriggerSchema: z.ZodType<GuideTrigger> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('stepDuration'), value: z.number().positive() }),
    z.object({ type: z.literal('stepDistance'), value: z.number().positive() }),
    z.object({ type: z.literal('manualLap') }),
    z.object({
      type: z.enum(['or', 'and']),
      triggers: z.array(GuideTriggerSchema).min(1),
    }),
  ]),
);

const GuideFieldsStepSchema = z.object({
  type: z.literal('fields'),
  trigger: GuideTriggerSchema.optional(),
  title: z.string().max(LIMITS.stepTitle).optional(),
  createManualLap: z.boolean().optional(),
  fields: z.array(GuideFieldSchema).optional(),
});

const GuideNotificationStepSchema = z.object({
  type: z.literal('notification'),
  createManualLap: z.boolean().optional(),
  fields: z.array(GuideFieldSchema).min(1),
});

/** Repeat children are explicitly restricted — the format forbids nested repeats. */
const GuideRepeatStepSchema = z.object({
  type: z.literal('repeat'),
  times: z.number().int().min(1).max(LIMITS.repeatTimes),
  steps: z
    .array(z.discriminatedUnion('type', [GuideFieldsStepSchema, GuideNotificationStepSchema]))
    .min(1)
    .max(LIMITS.steps),
});

export const GuideStepSchema = z.discriminatedUnion('type', [
  GuideFieldsStepSchema,
  GuideNotificationStepSchema,
  GuideRepeatStepSchema,
]);

export const GuideSchema = z.object({
  name: z.string().min(1).max(LIMITS.name),
  description: z.string().min(1).max(LIMITS.description),
  shortDescription: z.string().min(1).max(LIMITS.shortDescription),
  type: z.literal('sequence'),
  usage: z.literal('workout'),
  owner: z.string().min(1).max(LIMITS.owner),
  url: z.string().min(1).max(LIMITS.url),
  activities: z.array(z.number().int().nonnegative()).min(1).max(100).optional(),
  localDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'localDate must be yyyy-MM-dd')
    .optional(),
  externalId: z.string().min(1).max(LIMITS.externalId).optional(),
  richText: z.string().max(100_000).optional(),
  steps: z.array(GuideStepSchema).min(1).max(LIMITS.steps),
});

export const GuideManifestSchema = z.object({
  name: z.string().min(1).max(LIMITS.name),
  type: z.literal('sequence'),
  owner: z.string().min(1).max(LIMITS.owner),
  description: z.string().min(1).max(LIMITS.description),
});

export interface GuideValidationIssue {
  path: string;
  message: string;
}

/**
 * Validate a guide, returning every problem at once rather than the first.
 * A caller fixing a generated guide wants the whole list.
 */
export function validateGuide(
  guide: unknown,
): { ok: true } | { ok: false; issues: GuideValidationIssue[] } {
  const result = GuideSchema.safeParse(guide);
  if (result.success) return { ok: true };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}
