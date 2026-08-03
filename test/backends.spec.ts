import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudApiGuideBackend, StaticTokenProvider } from '../src/backends/cloud-api.js';
import { FileGuideBackend } from '../src/backends/file.js';
import { PrivateApiGuideBackend } from '../src/backends/private-api.js';
import { compile } from '../src/compile/compile.js';
import { isSuuntoError, SuuntoError } from '../src/errors.js';
import { pngDimensions, solidPng } from '../src/package/icon.js';
import { packGuide } from '../src/package/zip.js';
import type { Workout } from '../src/domain/workout.js';

const OPTIONS = { owner: 'suunto-mcp', url: 'https://example.com/plan' };

const workout: Workout = {
  title: 'Easy 40',
  description: 'Forty easy minutes, conversational throughout',
  activities: ['RUNNING'],
  steps: [{ type: 'step', role: 'work', duration: { kind: 'time', seconds: 2400 } }],
} as Workout;

function pack(overrides: Partial<Workout> = {}) {
  const { guide, manifest } = compile({ ...workout, ...overrides }, OPTIONS);
  return packGuide(guide, manifest);
}

describe('guide archive', () => {
  it('contains exactly the three files Suunto expects', () => {
    const entries = unzipSync(pack().zip);
    expect(Object.keys(entries).sort()).toEqual(['guide.json', 'icon.png', 'manifest.json']);
  });

  it('generates a valid 300x300 icon', () => {
    const entries = unzipSync(pack().zip);
    expect(pngDimensions(entries['icon.png']!)).toEqual({ width: 300, height: 300 });
  });

  it('packs the same workout to identical bytes', () => {
    expect(Buffer.from(pack().zip)).toEqual(Buffer.from(pack().zip));
  });

  it('rejects an icon that is not 300x300', () => {
    const { guide, manifest } = compile(workout, OPTIONS);
    expect(() => packGuide(guide, manifest, { icon: solidPng(undefined, 128) })).toThrow(
      /must be 300x300/,
    );
  });

  it('rejects an icon that is not a PNG', () => {
    const { guide, manifest } = compile(workout, OPTIONS);
    expect(() => packGuide(guide, manifest, { icon: new Uint8Array([1, 2, 3]) })).toThrow(
      /must be a PNG/,
    );
  });

  /**
   * Suunto matches the manifest's owner against the OAuth application name, and
   * rejects a mismatch with a message that mentions neither file.
   */
  it('rejects a manifest whose owner disagrees with the guide', () => {
    const { guide, manifest } = compile(workout, OPTIONS);
    expect(() => packGuide(guide, { ...manifest, owner: 'somebody-else' })).toThrow(
      /does not match/,
    );
  });
});

describe('FileGuideBackend', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'suunto-file-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a guide through the filesystem', async () => {
    const backend = new FileGuideBackend(dir);
    const packed = pack({ date: '2026-08-10' });
    const ref = await backend.create(packed);

    expect(ref.name).toBe('Easy 40');
    expect(ref.localDate).toBe('2026-08-10');

    // Listing reads the guide back out of its own archive rather than a
    // sidecar index, so this proves the zip is genuinely readable.
    const listed = await backend.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe('Easy 40');
    expect(listed[0]!.externalId).toBe(packed.guide.externalId);
  });

  it('overwrites rather than accumulating for an unchanged session', async () => {
    const backend = new FileGuideBackend(dir);
    await backend.create(pack());
    await backend.create(pack());
    expect(await backend.list()).toHaveLength(1);
  });

  it('reports NOT_FOUND for updating or deleting a missing guide', async () => {
    const backend = new FileGuideBackend(dir);
    await expect(backend.update('missing', pack())).rejects.toThrow(/no guide/);
    await expect(backend.remove('missing')).rejects.toThrow(/no guide/);
  });

  it('ignores a corrupt archive rather than failing the whole listing', async () => {
    const backend = new FileGuideBackend(dir);
    await backend.create(pack());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'garbage.zip'), 'not a zip');
    expect(await backend.list()).toHaveLength(1);
  });
});

describe('CloudApiGuideBackend', () => {
  const envelope = (payload: unknown) =>
    new Response(JSON.stringify({ error: null, payload, metadata: { ts: '1' } }), { status: 200 });

  function backendWith(fetchImpl: typeof fetch) {
    return new CloudApiGuideBackend({
      subscriptionKey: 'test-key',
      tokens: new StaticTokenProvider('test-token'),
      fetchImpl,
    });
  }

  it('posts the archive as a raw binary body with both auth headers', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: null, payload: { id: 'abc', name: 'Easy 40' } }), {
        status: 201,
      }),
    );
    const packed = pack();
    const ref = await backendWith(fetchImpl as unknown as typeof fetch).create(packed);

    expect(ref).toMatchObject({ id: 'abc', name: 'Easy 40' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cloudapi.suunto.com/v2/guides/files');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/zip');
    // Raw bytes, not multipart or base64.
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(init.body as Uint8Array)).toEqual(Buffer.from(packed.zip));
  });

  /**
   * The 409 is the whole idempotency story: re-pushing an unchanged session
   * must be distinguishable from a real failure so a sync can skip it.
   */
  it('maps 409 to CONFLICT with a usable hint', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { description: 'Conflict' }, payload: null }), {
        status: 409,
      }),
    );
    try {
      await backendWith(fetchImpl as unknown as typeof fetch).create(pack());
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect(isSuuntoError(cause)).toBe(true);
      const error = cause as SuuntoError;
      expect(error.code).toBe('CONFLICT');
      expect(error.exitCode).toBe(8);
      expect(error.hint).toMatch(/Update the existing guide/);
    }
  });

  it('surfaces the server description on a 400', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { description: "Invalid step type: 'notfication'" }, payload: null }),
        { status: 400 },
      ),
    );
    await expect(backendWith(fetchImpl as unknown as typeof fetch).create(pack())).rejects.toThrow(
      /Invalid step type/,
    );
  });

  it('maps 401 to AUTH_EXPIRED with suuntool-compatible exit code 4', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    try {
      await backendWith(fetchImpl as unknown as typeof fetch).list();
      expect.unreachable('should have thrown');
    } catch (cause) {
      const error = cause as SuuntoError;
      expect(error.code).toBe('AUTH_EXPIRED');
      expect(error.exitCode).toBe(4);
    }
  });

  /** 429 lands on SERVER, as it does in suuntool: transient, retryable. */
  it('maps 429 to SERVER', async () => {
    const fetchImpl = vi.fn(async () => new Response('slow down', { status: 429 }));
    try {
      await backendWith(fetchImpl as unknown as typeof fetch).list();
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect((cause as SuuntoError).code).toBe('SERVER');
      expect((cause as SuuntoError).exitCode).toBe(5);
    }
  });

  it('builds list query parameters', async () => {
    const fetchImpl = vi.fn(async () => envelope([]));
    await backendWith(fetchImpl as unknown as typeof fetch).list({
      limit: 10,
      offset: 20,
      since: 1_700_000_000_000,
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
    expect(url).toContain('fileSince=1700000000000');
  });

  it('prefers fileModificationTime when mapping a listing', async () => {
    const fetchImpl = vi.fn(async () =>
      envelope([
        { id: 'a', name: 'A', modificationTime: 1, fileModificationTime: 2, externalId: 'x' },
      ]),
    );
    const guides = await backendWith(fetchImpl as unknown as typeof fetch).list();
    expect(guides[0]).toMatchObject({ id: 'a', modificationTime: 2, externalId: 'x' });
  });

  it('wraps a transport failure as NETWORK, distinct from a server error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    try {
      await backendWith(fetchImpl as unknown as typeof fetch).list();
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect((cause as SuuntoError).code).toBe('NETWORK');
      expect((cause as SuuntoError).exitCode).toBe(3);
    }
  });

  it('treats a 2xx carrying an error description as a failure', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { description: 'something odd' }, payload: null }), {
        status: 200,
      }),
    );
    await expect(backendWith(fetchImpl as unknown as typeof fetch).list()).rejects.toThrow(
      /something odd/,
    );
  });
});

/**
 * All mocked — this backend is genuinely undocumented and unsanctioned, and
 * suuntool's own contributing rules are explicit that write-side calls to the
 * real backend are exercised by hand against a personal account, never from
 * automation. No live request happens anywhere in this suite.
 */
describe('PrivateApiGuideBackend', () => {
  const envelope = (payload: unknown) =>
    new Response(JSON.stringify({ error: null, payload, metadata: { ts: '1' } }), { status: 200 });

  function backendWith(fetchImpl: typeof fetch) {
    return new PrivateApiGuideBackend({ sessionKey: 'test-session-key', fetchImpl });
  }

  it('posts to suuntoplus/guides/files with STTAuthorization, Client-Id, and a raw zip body', async () => {
    const fetchImpl = vi.fn(async () =>
      envelope({ id: 'abc', name: 'Easy 40', fileModificationTime: 123, pinned: false }),
    );
    const packed = pack();
    const ref = await backendWith(fetchImpl as unknown as typeof fetch).create(packed);

    expect(ref).toMatchObject({ id: 'abc', name: 'Easy 40', modificationTime: 123, pinned: false });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.sports-tracker.com/apiserver/v1/suuntoplus/guides/files');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['STTAuthorization']).toBe('test-session-key');
    expect(headers['Client-Id']).toBe('5c2fa984-4425-4e72-8f7c-deeaa454b9c6');
    expect(headers['Content-Type']).toBe('application/zip');
    expect(Buffer.from(init.body as Uint8Array)).toEqual(Buffer.from(packed.zip));
  });

  it('always reports externalId as undefined, since the wire DTO has no such field', async () => {
    const fetchImpl = vi.fn(async () =>
      envelope({ id: 'abc', name: 'Easy 40', fileModificationTime: 1, pinned: false }),
    );
    const ref = await backendWith(fetchImpl as unknown as typeof fetch).create(pack());
    expect(ref.externalId).toBeUndefined();
  });

  it('PUTs to the guideId path for update', async () => {
    const fetchImpl = vi.fn(async () =>
      envelope({ id: 'abc', name: 'Easy 40', fileModificationTime: 1, pinned: false }),
    );
    await backendWith(fetchImpl as unknown as typeof fetch).update('abc', pack());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.sports-tracker.com/apiserver/v1/suuntoplus/guides/files/abc');
    expect(init.method).toBe('PUT');
  });

  it('DELETEs to the guideId path with no body', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await backendWith(fetchImpl as unknown as typeof fetch).remove('abc');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.sports-tracker.com/apiserver/v1/suuntoplus/guides/files/abc');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  /**
   * fetchAll() takes no pagination params on this endpoint — unlike the
   * documented Cloud API's offset/limit/fileSince, the mobile client fetches
   * everything and caches locally. This backend mirrors that: one GET with no
   * query string, then filters client-side, same as FileGuideBackend.
   */
  it('fetches the full list with no query parameters, then filters client-side', async () => {
    const fetchImpl = vi.fn(async () =>
      envelope([
        { id: 'a', name: 'A', fileModificationTime: 100, pinned: false },
        { id: 'b', name: 'B', fileModificationTime: 200, pinned: true },
      ]),
    );
    const guides = await backendWith(fetchImpl as unknown as typeof fetch).list({ since: 150 });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.sports-tracker.com/apiserver/v1/suuntoplus/guides/items');
    expect(guides).toHaveLength(1);
    expect(guides[0]!.id).toBe('b');
  });

  it('throws AUTH_EXPIRED with a suuntool-login hint when no session is available', async () => {
    // No sessionKey override and no real suuntool session file on this machine
    // (or one pointed at a nonexistent path) — either way, nothing to send.
    const backend = new PrivateApiGuideBackend({
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const originalEnv = process.env['SUUNTOOL_SESSION_FILE'];
    process.env['SUUNTOOL_SESSION_FILE'] = '/nonexistent/suuntool-session.json';
    try {
      await expect(backend.list()).rejects.toThrow(/no Suunto session/);
    } finally {
      if (originalEnv === undefined) delete process.env['SUUNTOOL_SESSION_FILE'];
      else process.env['SUUNTOOL_SESSION_FILE'] = originalEnv;
    }
  });

  it('maps 409 to CONFLICT', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { description: 'Conflict' }, payload: null }), {
        status: 409,
      }),
    );
    try {
      await backendWith(fetchImpl as unknown as typeof fetch).create(pack());
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect((cause as SuuntoError).code).toBe('CONFLICT');
    }
  });

  it('maps 401 to AUTH_EXPIRED', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    try {
      await backendWith(fetchImpl as unknown as typeof fetch).list();
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect((cause as SuuntoError).code).toBe('AUTH_EXPIRED');
    }
  });
});
