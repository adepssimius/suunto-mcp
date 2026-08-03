import { describe, expect, it, vi } from 'vitest';
import { summariseRecovery, summariseWorkout } from '../src/training/digest.js';
import { parseNdjson, SuuntoolCli, type ExecFn } from '../src/training/suuntool-cli.js';
import { toBpm, toPercent } from '../src/training/types.js';
import { isSuuntoError, SuuntoError } from '../src/errors.js';

/**
 * `suuntool` is an external binary this suite never assumes is installed —
 * every test injects a fake `exec`, which is also what proves the CLI wrapper
 * invokes it as an argv array rather than a shell string: a fake that echoed
 * its arguments back would show a single command string here if it were built
 * with string concatenation anywhere.
 */

function fakeExec(
  handler: (command: string, args: string[]) => { stdout?: string; stderr?: string; code?: number },
): ExecFn {
  return async (command, args) => {
    const result = handler(command, args);
    if (result.code !== undefined && result.code !== 0) {
      const error = new Error(`command failed`) as NodeJS.ErrnoException & { stderr?: string };
      error.code = result.code as unknown as string; // execFile puts the exit code here
      error.stderr = result.stderr ?? '';
      throw error;
    }
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

describe('SuuntoolCli', () => {
  it('calls whoami with --format json and parses the envelope-free JSON output', async () => {
    const exec = vi.fn(
      fakeExec(() => ({
        stdout: JSON.stringify({
          username: 'alice',
          userKey: 'k1',
          emailVerified: true,
        }),
      })),
    );
    const cli = new SuuntoolCli({ exec });
    const athlete = await cli.whoami();

    expect(athlete.username).toBe('alice');
    const [command, args] = exec.mock.calls[0]!;
    expect(command).toBe('suuntool');
    expect(args).toEqual(['whoami', '--format', 'json']);
  });

  it('passes --since and --limit through to workouts list', async () => {
    const exec = vi.fn(fakeExec(() => ({ stdout: JSON.stringify({ items: [], until: 0 }) })));
    const cli = new SuuntoolCli({ exec });
    await cli.recentWorkouts({ since: '14d', limit: 5 });

    const [, args] = exec.mock.calls[0]!;
    expect(args).toEqual(['workouts', 'list', '--limit', '5', '--since', '14d', '--format', 'json']);
  });

  it('parses recovery as NDJSON, never through the JSON envelope', async () => {
    const exec = vi.fn(
      fakeExec(() => ({
        stdout: [
          JSON.stringify({ timestamp: 1000, hrMin: 1, quality: 0.8 }),
          JSON.stringify({ timestamp: 2000, hrMin: 0.95, quality: 0.75 }),
          '', // trailing newline
        ].join('\n'),
      })),
    );
    const cli = new SuuntoolCli({ exec });
    const entries = await cli.recovery({ since: '7d' });

    expect(entries).toHaveLength(2);
    expect(entries[0]!.hrMin).toBe(1);
    // --format json must NOT be appended to a wellness call: the stream is raw
    // NDJSON regardless of --format, per suuntool's own docs, and passing the
    // flag anyway would misleadingly suggest it does something here.
    const [, args] = exec.mock.calls[0]!;
    expect(args).not.toContain('--format');
  });

  it('reports a friendly USAGE error when the binary is missing', async () => {
    const exec: ExecFn = async () => {
      const error = new Error('spawn suuntool ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    };
    const cli = new SuuntoolCli({ exec });

    try {
      await cli.whoami();
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect(isSuuntoError(cause)).toBe(true);
      const error = cause as SuuntoError;
      expect(error.code).toBe('USAGE');
      expect(error.message).toMatch(/not installed/);
      expect(error.hint).toMatch(/go install|brew install/);
    }
  });

  /**
   * suuntool's exit codes are numerically identical to this server's own
   * taxonomy (2-7) by design, so a session that has expired in suuntool's
   * session.json surfaces through exactly the same AUTH_EXPIRED code our own
   * Cloud API session does.
   */
  it('maps suuntool exit code 4 to AUTH_EXPIRED', async () => {
    const exec = vi.fn(
      fakeExec(() => ({
        code: 4,
        stderr: JSON.stringify({
          error: { code: 'AUTH_EXPIRED', message: 'session rejected', hint: 'Run: suuntool login' },
        }),
      })),
    );
    const cli = new SuuntoolCli({ exec });

    try {
      await cli.whoami();
      expect.unreachable('should have thrown');
    } catch (cause) {
      const error = cause as SuuntoError;
      expect(error.code).toBe('AUTH_EXPIRED');
      expect(error.exitCode).toBe(4);
      expect(error.hint).toBe('Run: suuntool login');
    }
  });

  it('maps suuntool exit code 6 to NOT_FOUND', async () => {
    const exec = fakeExec(() => ({ code: 6, stderr: '' }));
    const cli = new SuuntoolCli({ exec });
    try {
      await cli.recentWorkouts();
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect((cause as SuuntoError).code).toBe('NOT_FOUND');
    }
  });

  it('falls back to SERVER for an unrecognised or generic exit code', async () => {
    const exec = fakeExec(() => ({ code: 1, stderr: 'boom' }));
    const cli = new SuuntoolCli({ exec });
    try {
      await cli.whoami();
      expect.unreachable('should have thrown');
    } catch (cause) {
      const error = cause as SuuntoError;
      expect(error.code).toBe('SERVER');
      expect(error.message).toBe('boom');
    }
  });

  it('rejects non-JSON stdout with a clear message rather than propagating a parse error', async () => {
    const exec = fakeExec(() => ({ stdout: 'not json' }));
    const cli = new SuuntoolCli({ exec });
    await expect(cli.whoami()).rejects.toThrow(/not JSON/);
  });
});

describe('parseNdjson', () => {
  it('skips blank lines', () => {
    expect(parseNdjson('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('throws with the offending line on malformed NDJSON', () => {
    expect(() => parseNdjson('{"a":1}\nnot json\n')).toThrow(/malformed NDJSON/);
  });
});

describe('unit conversions', () => {
  /**
   * The whole reason these exist: hrMin/hrAvg arrive in beats *per second*.
   * A resting heart rate of ~1 reads as an obvious bug; a recovery quality of
   * 0.82 does not — which is exactly why both conversions are centralised
   * rather than left to whoever reads the field next.
   */
  it('converts Hz to BPM', () => {
    expect(toBpm(1)).toBe(60);
    expect(toBpm(0.833)).toBe(50);
  });

  it('converts a fraction to a percentage', () => {
    expect(toPercent(0.823)).toBe(82.3);
    expect(toPercent(1)).toBe(100);
  });
});

describe('digest summaries', () => {
  it('summarises a workout, preferring hrdata (already BPM) as-is', () => {
    const summary = summariseWorkout({
      key: 'abc',
      activityId: 1,
      startTime: Date.UTC(2026, 6, 1),
      totalTime: 2400,
      totalDistance: 8000,
      totalAscent: 50,
      totalDescent: 50,
      hrdata: { avg: 150.4, max: 178.9 },
      tss: { trainingStressScore: 62.3 },
    });

    expect(summary).toEqual({
      key: 'abc',
      activity: 'RUNNING',
      date: '2026-07-01',
      distanceKm: 8,
      durationMin: 40,
      avgHrBpm: 150,
      maxHrBpm: 179,
      trainingStressScore: 62,
    });
  });

  it('falls back to act=<id> for an unknown activity id', () => {
    const summary = summariseWorkout({
      key: 'x',
      activityId: 89, // a genuine gap in Suunto's enum
      startTime: 0,
      totalTime: 60,
      totalDistance: 0,
      totalAscent: 0,
      totalDescent: 0,
    });
    expect(summary.activity).toBe('act=89');
  });

  it('summarises recovery, converting Hz and fractions and preferring hrMin over hrAvg', () => {
    const summary = summariseRecovery({
      timestamp: Date.UTC(2026, 6, 1),
      hrMin: 0.9,
      hrAvg: 1.1,
      quality: 0.82,
      balance: 0.5,
    });
    expect(summary).toEqual({
      date: '2026-07-01',
      restingHrBpm: 54,
      recoveryQualityPercent: 82,
      balancePercent: 50,
    });
  });
});
