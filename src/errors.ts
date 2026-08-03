/**
 * Typed errors with stable codes.
 *
 * Codes 2–7 are deliberately identical to `suuntool`'s, including their exit
 * codes, so anyone who has driven that CLI reads ours without relearning
 * anything — and so a shell pipeline can branch on the same numbers regardless
 * of which tool produced them. Codes 8+ cover things suuntool has no equivalent
 * for, because it never creates a guide.
 *
 * The rule inherited from suuntool that matters most: **never paper over a 401**.
 * A rejected session surfaces as AUTH_EXPIRED with a hint telling the user how
 * to fix it. No silent re-authentication, ever — an agent that quietly re-auths
 * turns an expired credential into a mystery.
 */
export type ErrorCode =
  | 'USAGE'
  | 'NETWORK'
  | 'AUTH_EXPIRED'
  | 'SERVER'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'INVALID_GUIDE'
  | 'UNSUPPORTED';

const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE: 2,
  NETWORK: 3,
  AUTH_EXPIRED: 4,
  SERVER: 5,
  NOT_FOUND: 6,
  FORBIDDEN: 7,
  // Beyond suuntool's range.
  CONFLICT: 8,
  INVALID_GUIDE: 9,
  UNSUPPORTED: 10,
};

export interface SuuntoErrorInit {
  code: ErrorCode;
  message: string;
  /** Actionable next step, shown to the user and to the model. */
  hint?: string;
  http?: number;
  /** Structured detail — e.g. per-field validation issues. */
  details?: unknown;
}

export class SuuntoError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly http: number | undefined;
  readonly details: unknown;

  constructor(init: SuuntoErrorInit) {
    super(init.message);
    this.name = 'SuuntoError';
    this.code = init.code;
    this.hint = init.hint;
    this.http = init.http;
    this.details = init.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  /**
   * The shape handed back to the model on a failed tool call. Keeping it
   * structured rather than a flat string is what lets an agent decide between
   * retrying, re-authenticating, and giving up.
   */
  toPayload(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.http ? { http: this.http } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export function isSuuntoError(value: unknown): value is SuuntoError {
  return value instanceof SuuntoError;
}

/**
 * Map an HTTP status onto the taxonomy. Mirrors `suuntool`'s `client.go:Do()`,
 * which is the single place that file maps status codes — worth preserving,
 * because a surprising exit code should only ever have one place to look.
 *
 * 429 lands on SERVER, as it does in suuntool: it is transient and retryable,
 * and we do not parse Retry-After.
 */
export function errorForStatus(status: number, body: string): SuuntoError {
  const snippet = body.length > 300 ? `${body.slice(0, 300)}…` : body;

  switch (status) {
    case 400:
      return new SuuntoError({
        code: 'INVALID_GUIDE',
        message: describeServerError(snippet) ?? 'the guide was rejected as invalid',
        hint: 'Validate locally first — the server reports only the first problem it finds.',
        http: 400,
      });
    case 401:
      return new SuuntoError({
        code: 'AUTH_EXPIRED',
        message: 'session rejected',
        hint: 'Re-authenticate, then retry.',
        http: 401,
      });
    case 403:
      return new SuuntoError({ code: 'FORBIDDEN', message: snippet, http: 403 });
    case 404:
      return new SuuntoError({ code: 'NOT_FOUND', message: snippet, http: 404 });
    case 409:
      return new SuuntoError({
        code: 'CONFLICT',
        message: 'a guide with this externalId already exists',
        hint: 'Update the existing guide instead of creating a new one.',
        http: 409,
      });
    default:
      if (status >= 500) {
        return new SuuntoError({ code: 'SERVER', message: snippet, http: status });
      }
      return new SuuntoError({
        code: 'SERVER',
        message: `unexpected HTTP ${status}: ${snippet}`,
        http: status,
      });
  }
}

/** Pull the description out of Suunto's `{"error":{"description":"…"}}` envelope. */
function describeServerError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { description?: unknown } };
    const description = parsed.error?.description;
    return typeof description === 'string' ? description : undefined;
  } catch {
    return undefined;
  }
}

/** Wrap a transport-level failure. Distinct from a server error: do not retry blindly. */
export function networkError(cause: unknown): SuuntoError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new SuuntoError({
    code: 'NETWORK',
    message,
    hint: 'Check connectivity, or raise the request timeout.',
  });
}
