import { execFile } from 'node:child_process';
import { SuuntoError, type ErrorCode } from '../errors.js';
import type { Athlete, RecentWorkoutList, RecoveryEntry } from './types.js';

/**
 * A thin wrapper around the `suuntool` CLI for read-only training context —
 * completed workouts, recovery, HR zones. Everything a coach would want to
 * know before prescribing the next session.
 *
 * suuntool has no equivalent for anything this server writes: every mutation
 * it supports touches an activity that already happened. So this is
 * deliberately not a `GuideBackend` — it is a separate, read-only port, wrapping
 * a separate tool, for a separate resource.
 *
 * Invocation always passes an argv array to `execFile`, never a shell string —
 * the only other subprocess call in this codebase's lineage
 * (peaksclub-app/api/test/global-setup.ts) follows the same rule, and it is
 * what makes a workout title containing `$(...)` inert instead of dangerous.
 */

const EXIT_CODE_MAP: Record<number, ErrorCode> = {
  2: 'USAGE',
  3: 'NETWORK',
  4: 'AUTH_EXPIRED',
  5: 'SERVER',
  6: 'NOT_FOUND',
  7: 'FORBIDDEN',
};

/** The shape suuntool writes to stderr on failure in `--format json` mode. */
interface SuuntoolErrorBody {
  error?: { code?: string; message?: string; hint?: string };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Matches `child_process.execFile`'s promisified signature closely enough to fake in tests. */
export type ExecFn = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<ExecResult>;

function defaultExec(): ExecFn {
  return (command, args, options) =>
    new Promise((resolve, reject) => {
      execFile(command, args, options, (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
}

export interface SuuntoolCliOptions {
  /** Defaults to `suuntool`, resolved via PATH. Override for a pinned install. */
  binary?: string;
  timeoutMs?: number;
  exec?: ExecFn;
}

export class SuuntoolCli {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly exec: ExecFn;

  constructor(options: SuuntoolCliOptions = {}) {
    this.binary = options.binary ?? 'suuntool';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.exec = options.exec ?? defaultExec();
  }

  async whoami(): Promise<Athlete> {
    return this.runJson<Athlete>(['whoami']);
  }

  async recentWorkouts(options: { limit?: number; since?: string } = {}): Promise<RecentWorkoutList> {
    const args = ['workouts', 'list'];
    if (options.limit !== undefined) args.push('--limit', String(options.limit));
    if (options.since !== undefined) args.push('--since', options.since);
    return this.runJson<RecentWorkoutList>(args);
  }

  /**
   * Recovery entries, newest last. Always raw NDJSON on the wire — suuntool
   * never routes wellness streams through its JSON envelope, even with
   * `--format json` — so this is parsed line by line rather than as one blob.
   */
  async recovery(options: { since?: string } = {}): Promise<RecoveryEntry[]> {
    const args = ['wellness', 'recovery'];
    if (options.since !== undefined) args.push('--since', options.since);
    const { stdout } = await this.run(args);
    return parseNdjson<RecoveryEntry>(stdout);
  }

  private async runJson<T>(args: string[]): Promise<T> {
    const { stdout } = await this.run([...args, '--format', 'json']);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new SuuntoError({
        code: 'SERVER',
        message: `suuntool ${args[0]} produced output that was not JSON`,
        details: stdout.slice(0, 300),
      });
    }
  }

  private async run(args: string[]): Promise<ExecResult> {
    try {
      return await this.exec(this.binary, args, {
        timeout: this.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (cause) {
      throw this.toSuuntoError(cause, args);
    }
  }

  private toSuuntoError(cause: unknown, args: string[]): SuuntoError {
    const err = cause as NodeJS.ErrnoException & {
      code?: string | number;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };

    if (err.code === 'ENOENT') {
      return new SuuntoError({
        code: 'USAGE',
        message: `"${this.binary}" is not installed or not on PATH`,
        hint: 'Install it: go install github.com/tajchert/suuntool@latest, or brew install --cask tajchert/tap/suuntool',
      });
    }

    if (err.killed || err.signal === 'SIGTERM') {
      return new SuuntoError({
        code: 'NETWORK',
        message: `suuntool ${args.join(' ')} timed out after ${this.timeoutMs}ms`,
        hint: 'Raise the timeout, or retry — a hung request is not a stable failure.',
      });
    }

    const stderr = err.stderr ?? '';
    const parsed = parseErrorBody(stderr);
    // exec's numeric exit code IS suuntool's own documented exit code — see
    // its README's exit-code table, which this taxonomy's 2-7 mirror exactly.
    const exitCode = typeof err.code === 'number' ? err.code : undefined;
    const mapped = exitCode !== undefined ? EXIT_CODE_MAP[exitCode] : undefined;
    const message = parsed?.message ?? (stderr.trim() || `suuntool ${args.join(' ')} failed`);

    return new SuuntoError({
      code: mapped ?? 'SERVER',
      message,
      ...(parsed?.hint ? { hint: parsed.hint } : {}),
    });
  }
}

function parseErrorBody(
  stderr: string,
): { message?: string | undefined; hint?: string | undefined } | undefined {
  const line = stderr.trim().split('\n').pop();
  if (!line?.startsWith('{')) return undefined;
  try {
    const body = JSON.parse(line) as SuuntoolErrorBody;
    if (!body.error) return undefined;
    return { message: body.error.message, hint: body.error.hint };
  } catch {
    return undefined;
  }
}

/** Parse NDJSON, skipping blank lines. A malformed line fails loudly with its content. */
export function parseNdjson<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      throw new SuuntoError({
        code: 'SERVER',
        message: 'suuntool produced a malformed NDJSON line',
        details: trimmed.slice(0, 300),
      });
    }
  }
  return out;
}
