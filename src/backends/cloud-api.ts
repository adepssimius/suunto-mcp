import { errorForStatus, networkError, SuuntoError } from '../errors.js';
import type { PackedGuide } from '../package/zip.js';
import type { BackendCapabilities, GuideBackend, GuideRef, ListOptions } from './port.js';

/**
 * The documented Suunto Cloud API. See docs/cloud-api.md for the full contract.
 *
 * Written against the published spec ahead of having a subscription key, and
 * exercised against a local mock in the tests — the same discipline suuntool
 * applies, where CI never touches the real backend and write paths are only ever
 * smoke-tested by hand against a personal account.
 */

export const CLOUD_API_BASE = 'https://cloudapi.suunto.com';

/** Supplies a bearer token, refreshing it if the provider knows how. */
export interface TokenProvider {
  accessToken(): Promise<string>;
}

export interface CloudApiOptions {
  subscriptionKey: string;
  tokens: TokenProvider;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The `{error, payload, metadata}` envelope every Cloud API response uses. */
interface Envelope<T> {
  error: { description?: string } | null;
  payload: T | null;
  metadata?: { ts?: string };
}

interface GuidePayload {
  id: string;
  name: string;
  externalId?: string;
  localDate?: string;
  pinned?: boolean;
  modificationTime?: number;
  fileModificationTime?: number;
}

export class CloudApiGuideBackend implements GuideBackend {
  readonly name = 'cloud';
  readonly capabilities: BackendCapabilities = {
    create: true,
    update: true,
    remove: true,
    list: true,
    schedule: true,
  };

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CloudApiOptions) {
    this.baseUrl = (options.baseUrl ?? CLOUD_API_BASE).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async create(packed: PackedGuide): Promise<GuideRef> {
    const payload = await this.request<GuidePayload>('POST', '/v2/guides/files', packed.zip);
    return toRef(payload);
  }

  async update(id: string, packed: PackedGuide): Promise<GuideRef> {
    // Note: this replaces guide *content* only. `pinned`, `id` and `username`
    // are metadata the file upload does not touch.
    const payload = await this.request<GuidePayload>(
      'PUT',
      `/v2/guides/files/${encodeURIComponent(id)}`,
      packed.zip,
    );
    return toRef(payload);
  }

  async remove(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/v2/guides/files/${encodeURIComponent(id)}`);
  }

  async list(options: ListOptions = {}): Promise<GuideRef[]> {
    const params = new URLSearchParams();
    if (options.offset !== undefined) params.set('offset', String(options.offset));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.since !== undefined) params.set('fileSince', String(options.since));
    const query = params.size > 0 ? `?${params.toString()}` : '';

    const payload = await this.request<GuidePayload[]>('GET', `/v2/guides/items${query}`);
    return (payload ?? []).map(toRef);
  }

  private async request<T>(method: string, path: string, body?: Uint8Array): Promise<T> {
    const token = await this.options.tokens.accessToken();

    const headers: Record<string, string> = {
      Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      'Ocp-Apim-Subscription-Key': this.options.subscriptionKey,
    };
    // The API takes the archive as a raw binary body, not multipart.
    if (body) headers['Content-Type'] = 'application/zip';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Built imperatively rather than by conditional spread: under
    // exactOptionalPropertyTypes an optional spread widens `body` to include
    // undefined, which RequestInit does not accept.
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body) init.body = body;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
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

    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new SuuntoError({
        code: 'SERVER',
        message: 'response was not JSON',
        details: text.slice(0, 300),
        http: response.status,
      });
    }

    // A 2xx carrying an error description is worth surfacing rather than
    // returning a null payload that fails confusingly later.
    if (envelope.error?.description) {
      throw new SuuntoError({
        code: 'SERVER',
        message: envelope.error.description,
        http: response.status,
      });
    }
    return envelope.payload as T;
  }
}

function toRef(payload: GuidePayload): GuideRef {
  return {
    id: payload.id,
    name: payload.name,
    externalId: payload.externalId,
    localDate: payload.localDate,
    pinned: payload.pinned,
    modificationTime: payload.fileModificationTime ?? payload.modificationTime,
  };
}

/**
 * A token provider for a static token — the shape you get from
 * `SUUNTO_ACCESS_TOKEN` while testing, before the OAuth dance is wired up.
 */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async accessToken(): Promise<string> {
    return this.token;
  }
}
