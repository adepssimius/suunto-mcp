import { loadSuuntoolSession, noSuuntoolSessionError } from '../auth/session.js';
import { errorForStatus, networkError, SuuntoError } from '../errors.js';
import type { PackedGuide } from '../package/zip.js';
import type { BackendCapabilities, GuideBackend, GuideRef, ListOptions } from './port.js';

/**
 * The private Sports-Tracker guides API — confirmed by static analysis of the
 * Suunto Android app (v6.11.8), documented in full in `docs/private-guides-api.md`.
 * Read that file before touching this one; every constant and shape below is
 * traced to a specific decompiled source file, not guessed.
 *
 * The headline finding that makes this backend cheap: it is NOT on
 * `cloudapi.suunto.com`. It's on the same Sports-Tracker/ASKO backend
 * `suuntool` already talks to, using the same `STTAuthorization` session
 * header and the same `{error, payload, metadata}` envelope suuntool's Go code
 * calls "Asko". So this backend borrows a `suuntool` session rather than
 * running any auth flow of its own — see `loadSuuntoolSession`.
 *
 * Genuinely undocumented and unsanctioned. Scope strictly to the
 * authenticated account's own data, and prefer `CloudApiGuideBackend` the
 * moment a subscription key exists.
 */

export const PRIVATE_API_BASE = 'https://api.sports-tracker.com/apiserver/v1';

/**
 * Static, app-wide value found on the Retrofit method's `@Headers` annotation
 * — not per-account. Whether the server actually enforces it or just logs it
 * is unconfirmed; sending it costs nothing.
 */
const CLIENT_ID = '5c2fa984-4425-4e72-8f7c-deeaa454b9c6';

interface AskoEnvelope<T> {
  error: { description?: string } | null;
  payload: T | null;
  metadata?: { ts?: string };
}

interface RemoteGuideInfo {
  id: string;
  catalogueId?: string;
  fileModificationTime: number;
  name: string;
  owner: string;
  ownerId?: string;
  description?: string;
  shortDescription?: string;
  richText?: string;
  localDate?: string;
  url?: string;
  iconUrl?: string;
  backgroundUrl?: string;
  activities?: number[];
  pinned: boolean;
}

export interface PrivateApiOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Override the session lookup — tests supply a fixed key instead of reading a real file. */
  sessionKey?: string;
}

export class PrivateApiGuideBackend implements GuideBackend {
  readonly name = 'private';
  readonly capabilities: BackendCapabilities = {
    create: true,
    update: true,
    remove: true,
    list: true,
    // localDate lives in guide.json itself, same mechanism as the other backends.
    schedule: true,
  };

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly fixedSessionKey: string | undefined;

  constructor(options: PrivateApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? PRIVATE_API_BASE).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.fixedSessionKey = options.sessionKey;
  }

  async create(packed: PackedGuide): Promise<GuideRef> {
    const payload = await this.request<RemoteGuideInfo>('POST', 'suuntoplus/guides/files', packed.zip);
    return toRef(payload);
  }

  async update(id: string, packed: PackedGuide): Promise<GuideRef> {
    const payload = await this.request<RemoteGuideInfo>(
      'PUT',
      `suuntoplus/guides/files/${encodeURIComponent(id)}`,
      packed.zip,
    );
    return toRef(payload);
  }

  async remove(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `suuntoplus/guides/files/${encodeURIComponent(id)}`);
  }

  /**
   * Unlike the documented Cloud API, this endpoint takes no offset/limit/since
   * — the mobile client fetches everything and caches it locally. We fetch the
   * full list too and apply `options` as a client-side filter, same as
   * `FileGuideBackend`, so callers see consistent behavior across backends.
   */
  async list(options: ListOptions = {}): Promise<GuideRef[]> {
    const payload = await this.request<RemoteGuideInfo[]>('GET', 'suuntoplus/guides/items');
    let refs = (payload ?? []).map(toRef);
    refs.sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0));

    if (options.since !== undefined) {
      const since = options.since;
      refs = refs.filter((r) => (r.modificationTime ?? 0) >= since);
    }
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    return refs.slice(offset, offset + limit);
  }

  private async request<T>(method: string, path: string, body?: Uint8Array): Promise<T> {
    const sessionKey = this.fixedSessionKey ?? loadSuuntoolSession()?.sessionkey;
    if (!sessionKey) throw noSuuntoolSessionError();

    const headers: Record<string, string> = {
      STTAuthorization: sessionKey,
      'Client-Id': CLIENT_ID,
    };
    if (body) headers['Content-Type'] = 'application/zip';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body) init.body = body;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${path}`, init);
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new SuuntoError({
          code: 'NETWORK',
          message: `request timed out after ${this.timeoutMs}ms`,
          hint: 'Raise the timeout, or retry.',
        });
      }
      throw networkError(cause);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) throw errorForStatus(response.status, text);
    if (!text) return undefined as T;

    let envelope: AskoEnvelope<T>;
    try {
      envelope = JSON.parse(text) as AskoEnvelope<T>;
    } catch {
      throw new SuuntoError({
        code: 'SERVER',
        message: 'response was not JSON',
        details: text.slice(0, 300),
        http: response.status,
      });
    }

    if (envelope.error?.description) {
      throw new SuuntoError({ code: 'SERVER', message: envelope.error.description, http: response.status });
    }
    return envelope.payload as T;
  }
}

function toRef(info: RemoteGuideInfo): GuideRef {
  return {
    id: info.id,
    name: info.name,
    // Not a bug: this DTO genuinely has no externalId field. See
    // docs/private-guides-api.md — server-side dedup on it is unverified here.
    externalId: undefined,
    localDate: info.localDate,
    pinned: info.pinned,
    modificationTime: info.fileModificationTime,
  };
}
