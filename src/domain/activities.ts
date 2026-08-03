/**
 * Suunto / Sports-Tracker ActivityType IDs.
 *
 * These are the values that go into a guide's `activities` array. The map is
 * transcribed from the shipping APK's wire enum (com.stt.android.suunto), by way
 * of tajchert/suuntool's `internal/api/endpoints/activity_types.go`.
 *
 * IDs 89 and 98 are genuine gaps in the enum, not omissions here.
 */
export const ACTIVITY_IDS = {
  WALKING: 0,
  RUNNING: 1,
  CYCLING: 2,
  CROSS_COUNTRY_SKIING: 3,
  MOUNTAIN_BIKING: 10,
  HIKING: 11,
  ROLLER_SKATING: 12,
  DOWNHILL_SKIING: 13,
  PADDLING: 14,
  ROWING: 15,
  INDOOR: 17,
  OUTDOOR_GYM: 20,
  SWIMMING: 21,
  TRAIL_RUNNING: 22,
  GYM: 23,
  NORDIC_WALKING: 24,
  CLIMBING: 29,
  SNOWBOARDING: 30,
  SKI_TOURING: 31,
  FITNESS_CLASS: 32,
  YOGA: 51,
  INDOOR_CYCLING: 52,
  TREADMILL: 53,
  CROSSFIT: 54,
  CROSSTRAINER: 55,
  ROLLER_SKIING: 56,
  INDOOR_ROWING: 57,
  STRETCHING: 58,
  TRACK_AND_FIELD: 59,
  ORIENTEERING: 60,
  SUP: 61,
  MULTISPORT: 68,
  SNOWSHOEING: 65,
  TREKKING: 70,
  KAYAKING: 72,
  CIRCUIT_TRAINING: 73,
  TRIATHLON: 74,
  ADVENTURE_RACING: 80,
  MOUNTAINEERING: 83,
  OPENWATER_SWIMMING: 85,
  SWIMRUN: 92,
  DUATHLON: 93,
  AQUATHLON: 94,
  OBSTACLE_RACING: 95,
  GRAVEL_CYCLING: 99,
  JUMP_ROPE: 102,
  TRACK_RUNNING: 103,
  CALISTHENICS: 104,
  E_BIKING: 105,
  E_MTB: 106,
  BACKCOUNTRY_SKIING: 107,
  WHEELCHAIR: 108,
  HAND_CYCLING: 109,
  BIATHLON: 111,
  CYCLOCROSS: 114,
  VERTICAL_RUN: 115,
  SKI_MOUNTAINEERING: 116,
  SKATE_SKIING: 117,
  CLASSIC_SKIING: 118,
  PILATES: 120,
} as const;

export type ActivityName = keyof typeof ACTIVITY_IDS;

/** A guide may declare at most 100 activities. */
export const MAX_ACTIVITIES = 100;

/**
 * Sports where a distance-based step and a pace target are meaningful. Used to
 * decide whether to emit `targetPace` (m/s, shown as min/km on the watch) or
 * `targetSpeed` (m/s, shown as km/h) for a speed-shaped intensity.
 */
const PACE_SPORTS = new Set<number>([
  ACTIVITY_IDS.RUNNING,
  ACTIVITY_IDS.TRAIL_RUNNING,
  ACTIVITY_IDS.TRACK_RUNNING,
  ACTIVITY_IDS.TREADMILL,
  ACTIVITY_IDS.VERTICAL_RUN,
  ACTIVITY_IDS.WALKING,
  ACTIVITY_IDS.HIKING,
  ACTIVITY_IDS.TREKKING,
  ACTIVITY_IDS.NORDIC_WALKING,
  ACTIVITY_IDS.SWIMMING,
  ACTIVITY_IDS.OPENWATER_SWIMMING,
  ACTIVITY_IDS.ORIENTEERING,
]);

/** True when the primary activity is conventionally paced rather than speed-based. */
export function prefersPaceOverSpeed(activityIds: readonly number[]): boolean {
  const first = activityIds[0];
  return first !== undefined && PACE_SPORTS.has(first);
}
