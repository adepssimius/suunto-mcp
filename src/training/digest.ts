import { ACTIVITY_IDS } from '../domain/activities.js';
import type { RecentWorkout, RecoveryEntry } from './types.js';
import { toBpm, toPercent } from './types.js';

/**
 * Human-friendly renderings of the raw wire types, used by the
 * `get_recent_training` tool.
 *
 * Kept separate from `types.ts` because the raw shapes there are a faithful
 * transcription of suuntool's own structs — useful for anyone who wants the
 * unconverted wire data — while this file is where the unit conversions that
 * actually matter for coaching happen once, instead of at every call site.
 */

export interface WorkoutSummaryLine {
  key: string;
  activity: string;
  date: string;
  distanceKm: number;
  durationMin: number;
  avgHrBpm?: number;
  maxHrBpm?: number;
  trainingStressScore?: number;
}

export function summariseWorkout(workout: RecentWorkout): WorkoutSummaryLine {
  const activityName = ACTIVITY_ID_TO_NAME.get(workout.activityId) ?? `act=${workout.activityId}`;

  const line: WorkoutSummaryLine = {
    key: workout.key,
    activity: activityName,
    date: new Date(workout.startTime).toISOString().slice(0, 10),
    distanceKm: Math.round((workout.totalDistance / 1000) * 100) / 100,
    durationMin: Math.round(workout.totalTime / 60),
  };
  // hrdata is already in BPM on this endpoint — unlike wellness recovery, which
  // is in Hz. Different endpoints, different units; do not assume consistency.
  if (workout.hrdata?.avg !== undefined) line.avgHrBpm = Math.round(workout.hrdata.avg);
  if (workout.hrdata?.max !== undefined) line.maxHrBpm = Math.round(workout.hrdata.max);
  if (workout.tss?.trainingStressScore !== undefined) {
    line.trainingStressScore = Math.round(workout.tss.trainingStressScore);
  }
  return line;
}

export interface RecoverySummaryLine {
  date: string;
  restingHrBpm?: number;
  recoveryQualityPercent?: number;
  balancePercent?: number;
}

/**
 * Converts recovery entries out of their wire units. `hrAvg`/`hrMin` arrive in
 * Hz (beats per second) and `quality`/`balance` as 0..1 fractions — both
 * documented only in suuntool's `wellness --help`, not in any response body,
 * and both look plausible enough unconverted to pass an inattentive review (a
 * resting HR of "1" reads as an obvious bug; a recovery quality of "0.82"
 * does not).
 */
export function summariseRecovery(entry: RecoveryEntry): RecoverySummaryLine {
  const line: RecoverySummaryLine = {
    date: new Date(entry.timestamp).toISOString().slice(0, 10),
  };
  if (entry.hrMin !== undefined) line.restingHrBpm = toBpm(entry.hrMin);
  else if (entry.hrAvg !== undefined) line.restingHrBpm = toBpm(entry.hrAvg);
  if (entry.quality !== undefined) line.recoveryQualityPercent = toPercent(entry.quality);
  if (entry.balance !== undefined) line.balancePercent = toPercent(entry.balance);
  return line;
}

// Reverse lookup built once; activities.ts only exports name → id.
const ACTIVITY_ID_TO_NAME = new Map<number, string>(
  Object.entries(ACTIVITY_IDS).map(([name, id]) => [id, name]),
);
