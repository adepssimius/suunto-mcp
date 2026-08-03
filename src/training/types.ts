/**
 * Training-context types, mirroring the wire shapes `suuntool` decodes from the
 * Sports-Tracker API (`internal/api/endpoints/{user,workouts,wellness}.go`).
 *
 * Field names are kept as suuntool's JSON output has them — the CLI's
 * `--format json` marshals its Go structs directly, with no additional
 * envelope — so these types double as the parser's contract.
 */

export interface Athlete {
  username: string;
  userKey: string;
  email?: string;
  country?: string;
  emailVerified: boolean;
}

export interface WorkoutHrData {
  max?: number;
  hrmax?: number;
  avg?: number;
  userMaxHR?: number;
  workoutAvgHR?: number;
  workoutMaxHR?: number;
}

export interface WorkoutTss {
  trainingStressScore?: number;
  calculationMethod?: string;
  intensityFactor?: number;
  normalizedPower?: number;
  averageGradeAdjustedPace?: number;
}

export interface RecentWorkout {
  key: string;
  activityId: number;
  /** Unix ms. */
  startTime: number;
  /** Seconds. */
  totalTime: number;
  /** Metres. */
  totalDistance: number;
  totalAscent: number;
  totalDescent: number;
  hrdata?: WorkoutHrData;
  tss?: WorkoutTss;
}

export interface RecentWorkoutList {
  items: RecentWorkout[];
  /** Pagination cursor: unix ms of the oldest item returned. */
  until: number;
}

/**
 * One entry from `wellness recovery`'s NDJSON stream. suuntool passes these
 * fields through **unnormalized** — three unit quirks worth knowing before
 * using this for anything:
 *
 *  - `hrAvg`/`hrMin`/`hrMax` are in **Hz** (beats per second), not BPM.
 *    Multiply by 60.
 *  - `quality`, `balance` are **0..1 fractions**, not percentages.
 *    Multiply by 100.
 *  - durations are seconds (float).
 *
 * `toBpm`/`toPercent` below do the conversion; nothing in this file does it
 * silently, because a raw Hz value that happens to look plausible as BPM
 * (a resting HR of roughly 1) is exactly the kind of thing that passes review.
 */
export interface RecoveryEntry {
  timestamp: number;
  hrAvg?: number;
  hrMin?: number;
  hrMax?: number;
  quality?: number;
  balance?: number;
  [key: string]: unknown;
}

/** beats-per-second → BPM. */
export function toBpm(hz: number): number {
  return Math.round(hz * 60);
}

/** 0..1 fraction → 0..100 percent, one decimal place. */
export function toPercent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}
