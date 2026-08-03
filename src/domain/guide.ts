/**
 * The SuuntoPlus Guide wire format — the compiler's output, not its input.
 *
 * Modelled on the authoritative "Pyramid interval" sample in Suunto's
 * `SuuntoplusGuideCloudAPI.pdf`, cross-checked against the field/limit reference
 * at apizone.suunto.com/suuntoplus-guide-description.
 *
 * One discrepancy between those two sources is worth knowing about: the field
 * reference documents a richer `transitions: [{condition, stepId}]` mechanism
 * (supporting `or`/`and`, `location`, `routeCompleted`), while the Cloud API
 * sample uses a flat per-step `trigger`. We emit `trigger`, because that is the
 * form in the document that also shows a 201 response. `transitions` is left for
 * later if we ever need conditional branching.
 */

export type GuideTriggerType = 'stepDuration' | 'stepDistance' | 'manualLap';

export interface GuideTrigger {
  type: GuideTriggerType;
  /** Seconds for `stepDuration`, metres for `stepDistance`. Absent for `manualLap`. */
  value?: number;
}

/** Scope for a measurement field. */
export type GuideWindow = 'workout' | 'step' | 'manualLap';
export type GuideAggregate = 'average' | 'min' | 'max';

export interface GuideField {
  type: string;
  /** Target fields: the midpoint. Countdown fields: the amount. Text: the string. */
  value?: number | string;
  min?: number;
  max?: number;
  window?: GuideWindow;
  aggregate?: GuideAggregate;
  title?: string;
}

export interface GuideFieldsStep {
  type: 'fields';
  trigger?: GuideTrigger;
  title?: string;
  createManualLap?: boolean;
  fields?: GuideField[];
}

export interface GuideNotificationStep {
  type: 'notification';
  createManualLap?: boolean;
  fields: GuideField[];
}

export interface GuideRepeatStep {
  type: 'repeat';
  times: number;
  /** Nested repeats are not permitted; the compiler flattens before emitting. */
  steps: Array<GuideFieldsStep | GuideNotificationStep>;
}

export type GuideStep = GuideFieldsStep | GuideNotificationStep | GuideRepeatStep;

export interface Guide {
  name: string;
  description: string;
  shortDescription: string;
  type: 'sequence';
  usage: 'workout';
  owner: string;
  url: string;
  activities?: number[];
  /** `yyyy-MM-dd`. Pins the guide to a calendar date in the Suunto app. */
  localDate?: string;
  /** Dedup key. A second guide with the same value is rejected with 409. */
  externalId?: string;
  richText?: string;
  steps: GuideStep[];
}

/** The second file in the zip. Its `owner` must match the OAuth application name. */
export interface GuideManifest {
  name: string;
  type: 'sequence';
  owner: string;
  description: string;
}

/**
 * Count steps the way the 1000-step limit does: a repeat block contributes its
 * own children once, not `times` copies.
 */
export function countSteps(steps: readonly GuideStep[]): number {
  let n = 0;
  for (const step of steps) {
    n += 1;
    if (step.type === 'repeat') n += step.steps.length;
  }
  return n;
}
