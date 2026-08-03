import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SuuntoError } from '../errors.js';

/**
 * On-disk session persistence, following `suuntool`'s conventions exactly:
 * XDG-aware path, `0700` directory, `0600` file, and an explicit env override
 * so tests never touch the real one.
 *
 * Matching its layout is not cosmetic — we read suuntool's own session file to
 * borrow an already-authenticated Sports-Tracker session rather than asking for
 * a password we have no business handling.
 */

/** Resolve `$XDG_CONFIG_HOME/<app>/<file>`, falling back to `~/.config`. */
export function configPath(app: string, file: string): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, app, file);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SuuntoError({
      code: 'USAGE',
      message: `could not read ${path}: ${(cause as Error).message}`,
    });
  }
}

/**
 * Write with `0600` before any secret reaches the file.
 *
 * `writeFileSync`'s mode argument only applies when creating, so an existing
 * world-readable file would silently keep its permissions. The explicit
 * `chmodSync` closes that window.
 */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------------------
// suuntool's session — read only, never written
// ---------------------------------------------------------------------------

/**
 * The shape `suuntool` persists. Field names are its wire names, including the
 * all-lowercase `sessionkey`.
 */
export interface SuuntoolSession {
  sessionkey: string;
  username?: string;
  email?: string;
  userKey?: string;
  country?: string;
  server_time_offset_ms?: number;
  saved_at?: string;
}

export function suuntoolSessionPath(): string {
  const override = process.env['SUUNTOOL_SESSION_FILE'];
  if (override && override.length > 0) return override;
  return configPath('suuntool', 'session.json');
}

/**
 * Borrow suuntool's session if the user has one.
 *
 * We only ever read this file. Logging in is suuntool's job — it prompts for a
 * password on a no-echo TTY and never accepts one on a command line, and there
 * is no version of this server that should be handling that credential itself.
 */
export function loadSuuntoolSession(): SuuntoolSession | undefined {
  const session = readJson<SuuntoolSession>(suuntoolSessionPath());
  if (!session?.sessionkey) return undefined;
  return session;
}

/** Session is absent or unusable — phrased as the fix, not the failure. */
export function noSuuntoolSessionError(): SuuntoError {
  return new SuuntoError({
    code: 'AUTH_EXPIRED',
    message: 'no Suunto session available',
    hint: `Install suuntool and run: suuntool login --email you@example.com (session is read from ${suuntoolSessionPath()})`,
  });
}

// ---------------------------------------------------------------------------
// Our own session — Cloud API OAuth tokens
// ---------------------------------------------------------------------------

export interface CloudSession {
  accessToken: string;
  refreshToken?: string | undefined;
  /** Epoch milliseconds. */
  expiresAt: number;
  username?: string | undefined;
  saved_at?: string | undefined;
}

export function cloudSessionPath(): string {
  const override = process.env['SUUNTO_MCP_SESSION_FILE'];
  if (override && override.length > 0) return override;
  return configPath('suunto-mcp', 'session.json');
}

export function loadCloudSession(): CloudSession | undefined {
  const session = readJson<CloudSession>(cloudSessionPath());
  if (!session?.accessToken) return undefined;
  return session;
}

export function saveCloudSession(session: CloudSession): void {
  writeJson(cloudSessionPath(), { ...session, saved_at: new Date().toISOString() });
}

export function clearCloudSession(): void {
  rmSync(cloudSessionPath(), { force: true });
}

/**
 * Treat a token as expired a minute early, so a call that passes the check
 * doesn't expire mid-flight.
 */
const EXPIRY_SKEW_MS = 60_000;

export function isExpired(session: CloudSession, now = Date.now()): boolean {
  return session.expiresAt - EXPIRY_SKEW_MS <= now;
}
