import { z } from 'zod';
import { ACTIVITY_IDS, type ActivityName } from '../domain/activities.js';
import { LIMITS } from '../domain/limits.js';
import { SimpleStepSchema } from '../domain/workout.js';

/**
 * Tool input schemas.
 *
 * These mirror the domain model with one deliberate difference: repeats nest to
 * a fixed depth of two rather than recursively.
 *
 * The domain uses `z.lazy` for genuine recursion, which is right for an internal
 * model but produces a `$ref`-laden JSON Schema at the tool boundary — and a
 * model reading a self-referential schema writes worse tool calls than one
 * reading a flat, explicit one. Two levels covers real training structure
 * ("3 sets of (4×400m, 800m)"); anything deeper is expressible by unrolling, and
 * Suunto forbids nested repeats on the wire anyway.
 */

const ActivityNameSchema = z.enum(Object.keys(ACTIVITY_IDS) as [ActivityName, ...ActivityName[]]);

const InnerRepeatSchema = z.object({
  type: z.literal('repeat'),
  times: z.number().int().min(1).max(LIMITS.repeatTimes),
  steps: z.array(SimpleStepSchema).min(1),
  note: z.string().optional().describe('Announced once before the block, not per repetition'),
});

const OuterRepeatSchema = z.object({
  type: z.literal('repeat'),
  times: z.number().int().min(1).max(LIMITS.repeatTimes),
  steps: z.array(z.union([SimpleStepSchema, InnerRepeatSchema])).min(1),
  note: z.string().optional().describe('Announced once before the block, not per repetition'),
});

export const McpStepSchema = z.union([SimpleStepSchema, OuterRepeatSchema]);

/**
 * Exposed as a raw shape because `registerTool` takes one, and because a
 * top-level object of named arguments reads better in a tool listing than a
 * single opaque `workout` blob.
 */
export const workoutShape = {
  title: z.string().min(1).describe(`Guide name, max ${LIMITS.name} chars`),
  description: z
    .string()
    .min(1)
    .describe(`Shown in the Suunto app listing, max ${LIMITS.description} chars`),
  shortDescription: z
    .string()
    .optional()
    .describe(`Shown on the watch itself, max ${LIMITS.shortDescription} chars. Defaults to title`),
  activities: z
    .array(ActivityNameSchema)
    .min(1)
    .optional()
    .describe('Sports this guide offers itself for. The first drives pace-vs-speed display'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('yyyy-MM-dd. Pins the guide to a date in the Suunto calendar'),
  steps: z.array(McpStepSchema).min(1).describe('The session, in order'),
  finalMessage: z
    .string()
    .optional()
    .describe(`Closing screen shown when the session ends, max ${LIMITS.stepTitle} chars`),
  externalId: z
    .string()
    .max(LIMITS.externalId)
    .optional()
    .describe('Stable id for idempotent re-pushes. Derived from the session when omitted'),
} as const;

export const athleteProfileShape = {
  maxHr: z.number().int().positive().max(260).optional(),
  restHr: z.number().int().positive().max(150).optional(),
  thresholdHr: z.number().int().positive().max(260).optional().describe('Lactate threshold HR'),
  ftp: z.number().positive().max(2000).optional().describe('Functional threshold power, watts'),
  thresholdPaceSecPerKm: z.number().positive().max(3600).optional(),
} as const;

export const AthleteProfileArg = z
  .object(athleteProfileShape)
  .optional()
  .describe('Required only when the workout uses pctMax, pctLthr or pctFtp targets');
