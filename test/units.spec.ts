import { describe, expect, it } from 'vitest';
import {
  ConversionError,
  formatPace,
  mpsToSecPerKm,
  paceRangeToSpeedRange,
  parseClock,
  perMinuteToHertz,
  resolveHeartRate,
  resolvePower,
  secPerKmToMps,
  secPerMileToSecPerKm,
} from '../src/compile/units.js';

describe('pace ↔ speed', () => {
  it('converts seconds per km to m/s', () => {
    expect(secPerKmToMps(255)).toBe(3.92); // 4:15/km
    expect(secPerKmToMps(265)).toBe(3.77); // 4:25/km
    expect(secPerKmToMps(300)).toBe(3.33); // 5:00/km
    expect(secPerKmToMps(240)).toBe(4.17); // 4:00/km
  });

  it('round-trips within rounding tolerance', () => {
    for (const secPerKm of [180, 240, 255, 300, 360, 420]) {
      expect(mpsToSecPerKm(secPerKmToMps(secPerKm))).toBeCloseTo(secPerKm, 0);
    }
  });

  it('rejects non-positive pace', () => {
    expect(() => secPerKmToMps(0)).toThrow(ConversionError);
    expect(() => secPerKmToMps(-1)).toThrow(ConversionError);
  });

  /**
   * The regression this whole naming scheme exists to prevent. A 4:15–4:25/km
   * range is 3.77–3.92 m/s: the FAST pace bound produces the HIGH speed bound.
   * Getting this backwards yields a guide that silently coaches the wrong
   * intensity, which is exactly the kind of bug that survives review.
   */
  it('inverts bounds when converting a pace range to a speed range', () => {
    const speed = paceRangeToSpeedRange({
      kind: 'pace',
      fastSecPerKm: 255, // 4:15
      slowSecPerKm: 265, // 4:25
    });

    expect(speed).toEqual({ min: 3.77, max: 3.92 });
    expect(speed.min).toBeLessThan(speed.max);
    // The fast pace must map to the max speed, never the min.
    expect(speed.max).toBe(secPerKmToMps(255));
    expect(speed.min).toBe(secPerKmToMps(265));
  });

  it('handles a degenerate (single-value) pace range', () => {
    const speed = paceRangeToSpeedRange({
      kind: 'pace',
      fastSecPerKm: 300,
      slowSecPerKm: 300,
    });
    expect(speed).toEqual({ min: 3.33, max: 3.33 });
  });

  it('converts miles to kilometres', () => {
    // 7:00/mi is about 4:21/km
    expect(secPerMileToSecPerKm(420)).toBeCloseTo(260.98, 1);
  });
});

describe('cadence', () => {
  /**
   * targetCadence is in Hertz, not rpm. 180 spm is 3.0 Hz. Passing 180 straight
   * through would ask the watch for 10,800 spm.
   */
  it('converts per-minute cadence to Hertz', () => {
    expect(perMinuteToHertz(180)).toBe(3);
    expect(perMinuteToHertz(90)).toBe(1.5);
    expect(perMinuteToHertz(174)).toBe(2.9);
    expect(perMinuteToHertz(200)).toBeCloseTo(3.333, 3);
  });

  it('rejects non-positive cadence', () => {
    expect(() => perMinuteToHertz(0)).toThrow(ConversionError);
  });
});

describe('percentage resolution', () => {
  const profile = { maxHr: 190, thresholdHr: 172, ftp: 280 };

  it('resolves heart rate bases', () => {
    expect(resolveHeartRate('bpm', 155, profile)).toBe(155);
    expect(resolveHeartRate('pctMax', 90, profile)).toBe(171);
    expect(resolveHeartRate('pctLthr', 100, profile)).toBe(172);
  });

  it('resolves power bases', () => {
    expect(resolvePower('watts', 250, profile)).toBe(250);
    expect(resolvePower('pctFtp', 105, profile)).toBe(294);
  });

  /**
   * A percentage with no reference must fail loudly. Silently dropping the
   * target would produce a guide that looks correct and coaches nothing.
   */
  it('throws a helpful error when the reference is missing', () => {
    expect(() => resolveHeartRate('pctMax', 90, {})).toThrow(ConversionError);
    expect(() => resolveHeartRate('pctMax', 90, {})).toThrow(/no maxHr/);
    expect(() => resolvePower('pctFtp', 105, {})).toThrow(/no ftp/);
  });
});

describe('clock parsing', () => {
  it('parses mm:ss, hh:mm:ss and bare seconds', () => {
    expect(parseClock('4:15')).toBe(255);
    expect(parseClock('0:45')).toBe(45);
    expect(parseClock('1:02:30')).toBe(3750);
    expect(parseClock('90')).toBe(90);
  });

  it('rejects malformed input', () => {
    expect(() => parseClock('4:15:30:00')).toThrow(ConversionError);
    expect(() => parseClock('fast')).toThrow(ConversionError);
    expect(() => parseClock('')).toThrow(ConversionError);
  });

  it('formats pace back to m:ss', () => {
    expect(formatPace(255)).toBe('4:15');
    expect(formatPace(300)).toBe('5:00');
    expect(formatPace(65)).toBe('1:05');
  });
});
