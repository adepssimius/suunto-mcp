import type { TokenProvider } from '../backends/cloud-api.js';
import { networkError, SuuntoError } from '../errors.js';
import { type CloudSession, isExpired, loadCloudSession, saveCloudSession } from './session.js';

export const OAUTH_TOKEN_URL = 'https://cloudapi-oauth.suunto.com/oauth/token';
export const OAUTH_AUTHORIZE_URL = 'https://cloudapi-oauth.suunto.com/oauth/authorize';

/**
 * Cloud API tokens, backed by the on-disk session.
 *
 * Access tokens last 24 hours, so an MCP server left running across a day will
 * hit expiry mid-session. Refresh is handled transparently *when a refresh token
 * exists* — that is a token exchange the user already consented to, not a new
 * credential prompt.
 *
 * What it deliberately will not do is re-authenticate from scratch. Following
 * suuntool's rule: a dead session surfaces as AUTH_EXPIRED with instructions.
 * Silently restarting an OAuth flow from inside a tool call would be both
 * useless (there is no browser here) and the wrong instinct.
 */
export class SessionTokenProvider implements TokenProvider {
  private cached: CloudSession | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly clientId?: string,
    private readonly clientSecret?: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async accessToken(): Promise<string> {
    const session = this.cached ?? loadCloudSession();
    if (!session) throw noCloudSessionError();
    this.cached = session;

    if (!isExpired(session)) return session.accessToken;

    if (!session.refreshToken) {
      throw new SuuntoError({
        code: 'AUTH_EXPIRED',
        message: 'the Suunto access token has expired and there is no refresh token',
        hint: 'Re-run the OAuth flow and store a fresh token.',
      });
    }

    // Collapse concurrent refreshes: several tool calls can notice the same
    // expiry at once, and refresh tokens are often single-use.
    this.inFlight ??= this.refresh(session).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refresh(session: CloudSession): Promise<string> {
    if (!this.clientId || !this.clientSecret) {
      throw new SuuntoError({
        code: 'AUTH_EXPIRED',
        message: 'the access token has expired and no OAuth client is configured to refresh it',
        hint: 'Set SUUNTO_CLIENT_ID and SUUNTO_CLIENT_SECRET, or store a fresh access token.',
      });
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken!,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (cause) {
      throw networkError(cause);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new SuuntoError({
        code: 'AUTH_EXPIRED',
        message: `token refresh failed (HTTP ${response.status})`,
        hint: 'The refresh token may have been used or revoked. Re-run the OAuth flow.',
        http: response.status,
        details: text.slice(0, 300),
      });
    }

    const parsed = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!parsed.access_token) {
      throw new SuuntoError({
        code: 'AUTH_EXPIRED',
        message: 'token refresh returned no access_token',
      });
    }

    const refreshed: CloudSession = {
      accessToken: parsed.access_token,
      // Providers may or may not rotate the refresh token; keep the old one if not.
      refreshToken: parsed.refresh_token ?? session.refreshToken,
      expiresAt: Date.now() + (parsed.expires_in ?? 86_400) * 1000,
      ...(session.username ? { username: session.username } : {}),
    };
    saveCloudSession(refreshed);
    this.cached = refreshed;
    return refreshed.accessToken;
  }
}

export function noCloudSessionError(): SuuntoError {
  return new SuuntoError({
    code: 'AUTH_EXPIRED',
    message: 'no Suunto Cloud API session',
    hint: 'Set SUUNTO_ACCESS_TOKEN, or complete the OAuth flow to store a session.',
  });
}
