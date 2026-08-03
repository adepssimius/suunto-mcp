import type { AthleteProfile, PaceTarget } from '../domain/workout.js';

/**
 * Unit conversions between the coach-facing domain and the guide wire format.
 *
 * Suunto expresses every speed-shaped target in metres per second, and cadence
 * in Hertz. Neither is how anyone writes a training plan, so all of the
 * translation is concentrated here and unit-tested directly.
 */

const METRES_PER_KM = 1000;
const METRES_PER_MILE = 1609.344;

/** m/s is rounded to 2dp — enough to preserve a 1 s/km distinction at 4:00/km. */
const MPS_DECIMALS = 2;
/** Hz is rounded to 3dp; 1 spm at 180 spm is ~0.017 Hz. */
const HZ_DECIMALS = 3;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionError';
  }
}

// ---------------------------------------------------------------------------
// Pace and speed
// ---------------------------------------------------------------------------

/** Seconds per kilometre → metres per second. */
export function secPerKmToMps(secPerKm: number): number {
  if (secPerKm <= 0) throw new ConversionError(`pace must be positive, got ${secPerKm}`);
  return round(METRES_PER_KM / secPerKm, MPS_DECIMALS);
}

/** Metres per second → seconds per kilometre. */
export function mpsToSecPerKm(mps: number): number {
  if (mps <= 0) throw new ConversionError(`speed must be positive, got ${mps}`);
  return METRES_PER_KM / mps;
}

export function secPerMileToSecPerKm(secPerMile: number): number {
  return (secPerMile * METRES_PER_KM) / METRES_PER_MILE;
}

/**
 * Convert a pace range to a speed range, inverting the bounds.
 *
 * Pace and speed are reciprocal, so the *fast* end of a pace range produces the
 * *upper* speed bound:
 *
 *     4:15–4:25 /km  →  { min: 3.77, max: 3.92 } m/s
 *
 * The domain type names its fields `fast`/`slow` precisely so this function is
 * the only place the ordering flips, and so that flipping it is a visible act
 * rather than an accidental pass-through of two similarly-named fields.
 */
export function paceRangeToSpeedRange(target: PaceTarget): { min: number; max: number } {
  return {
    min: secPerKmToMps(target.slowSecPerKm),
    max: secPerKmToMps(target.fastSecPerKm),
  };
}

/**
 * Parse `"4:15"`, `"4:15.5"`, `"75"` or `"1:02:30"` into seconds.
 * Accepts mm:ss, hh:mm:ss, or a bare second count.
 */
export function parseClock(input: string): number {
  const trimmed = input.trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(trimmed)) {
    throw new ConversionError(`cannot parse "${input}" as a duration or pace`);
  }
  const parts = trimmed.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) {
    throw new ConversionError(`cannot parse "${input}" as a duration or pace`);
  }
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

/** Format seconds as `m:ss`, for display and error messages. */
export function formatPace(secPerKm: number): string {
  const total = Math.round(secPerKm);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/**
 * Steps (or revolutions) per minute → Hertz.
 *
 * `targetCadence` is documented in Hertz, which is genuinely surprising: a
 * typical running cadence of 180 spm is 3.0, not 180. Sending 180 would ask the
 * watch for 10,800 spm.
 */
export function perMinuteToHertz(perMinute: number): number {
  if (perMinute <= 0) throw new ConversionError(`cadence must be positive, got ${perMinute}`);
  return round(perMinute / 60, HZ_DECIMALS);
}

// ---------------------------------------------------------------------------
// Percentage resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a percentage-of-reference target into an absolute value.
 *
 * The guide format has no percentage representation, so an unresolvable
 * percentage has to be an error. Dropping the target silently would produce a
 * guide that looks fine and coaches nothing.
 */
export function resolvePercentage(
  percent: number,
  reference: number | undefined,
  referenceName: string,
): number {
  if (reference === undefined) {
    throw new ConversionError(
      `target is ${percent}% of ${referenceName}, but the athlete profile has no ${referenceName}. ` +
        `Set it in the profile, or express the target in absolute units.`,
    );
  }
  return Math.round((percent / 100) * reference);
}

export function resolveHeartRate(
  basis: 'bpm' | 'pctMax' | 'pctLthr',
  value: number,
  profile: AthleteProfile,
): number {
  switch (basis) {
    case 'bpm':
      return Math.round(value);
    case 'pctMax':
      return resolvePercentage(value, profile.maxHr, 'maxHr');
    case 'pctLthr':
      return resolvePercentage(value, profile.thresholdHr, 'thresholdHr');
  }
}

export function resolvePower(
  basis: 'watts' | 'pctFtp',
  value: number,
  profile: AthleteProfile,
): number {
  switch (basis) {
    case 'watts':
      return Math.round(value);
    case 'pctFtp':
      return resolvePercentage(value, profile.ftp, 'ftp');
  }
}
