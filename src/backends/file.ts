import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import type { Guide } from '../domain/guide.js';
import { SuuntoError } from '../errors.js';
import type { PackedGuide } from '../package/zip.js';
import type { BackendCapabilities, GuideBackend, GuideRef, ListOptions } from './port.js';

/**
 * Writes guide archives to a directory instead of uploading them.
 *
 * This is the backend that works today, with no credentials of any kind, and it
 * is what makes the compiler end-to-end testable while the Cloud API key is
 * pending. The zips it writes are the real thing — importable by hand, and
 * byte-identical to what the cloud backend would upload.
 *
 * It can list and delete what *it* wrote; it obviously cannot see what is on
 * your watch, which is exactly the sort of thing the capability flags exist to
 * say out loud.
 */
export class FileGuideBackend implements GuideBackend {
  readonly name = 'file';
  readonly capabilities: BackendCapabilities = {
    create: true,
    update: true,
    remove: true,
    list: true,
    // localDate is written into guide.json, so scheduling survives a later
    // manual import.
    schedule: true,
  };

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  async create(packed: PackedGuide): Promise<GuideRef> {
    const id = this.idFor(packed.guide);
    const path = this.pathFor(id);
    writeFileSync(path, packed.zip);
    return this.refFor(id, packed.guide);
  }

  async update(id: string, packed: PackedGuide): Promise<GuideRef> {
    const path = this.pathFor(id);
    if (!this.exists(id)) {
      throw new SuuntoError({
        code: 'NOT_FOUND',
        message: `no guide "${id}" in ${this.directory}`,
      });
    }
    writeFileSync(path, packed.zip);
    return this.refFor(id, packed.guide);
  }

  async remove(id: string): Promise<void> {
    if (!this.exists(id)) {
      throw new SuuntoError({
        code: 'NOT_FOUND',
        message: `no guide "${id}" in ${this.directory}`,
      });
    }
    rmSync(this.pathFor(id));
  }

  async list(options: ListOptions = {}): Promise<GuideRef[]> {
    const files = readdirSync(this.directory).filter((f) => f.endsWith('.zip'));
    const refs: GuideRef[] = [];

    for (const file of files) {
      // Read the guide back out of its own archive rather than keeping a
      // sidecar index — a second copy of the truth is a second thing to drift.
      const guide = this.readGuide(join(this.directory, file));
      if (!guide) continue;
      refs.push(this.refFor(file.replace(/\.zip$/, ''), guide));
    }

    refs.sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0));

    const since = options.since;
    const filtered =
      since === undefined ? refs : refs.filter((r) => (r.modificationTime ?? 0) >= since);

    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    return filtered.slice(offset, offset + limit);
  }

  private readGuide(path: string): Guide | undefined {
    try {
      const entries = unzipSync(readFileSync(path));
      const raw = entries['guide.json'];
      if (!raw) return undefined;
      return JSON.parse(new TextDecoder().decode(raw)) as Guide;
    } catch {
      // A corrupt or hand-edited zip should not take out a listing.
      return undefined;
    }
  }

  private refFor(id: string, guide: Guide): GuideRef {
    return {
      id,
      name: guide.name,
      externalId: guide.externalId,
      localDate: guide.localDate,
      pinned: false,
      modificationTime: this.mtime(id),
    };
  }

  private mtime(id: string): number | undefined {
    try {
      return Math.round(statSync(this.pathFor(id)).mtimeMs);
    } catch {
      return undefined;
    }
  }

  private exists(id: string): boolean {
    return readdirSync(this.directory).includes(`${id}.zip`);
  }

  private pathFor(id: string): string {
    return join(this.directory, `${id}.zip`);
  }

  /**
   * Use the guide's own `externalId` as the filename so that re-compiling the
   * same session overwrites rather than accumulates — the local mirror of the
   * server-side dedup the Cloud API gives us for free.
   */
  private idFor(guide: Guide): string {
    const raw = guide.externalId ?? guide.name;
    const safe = raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
    if (!safe) throw new SuuntoError({ code: 'USAGE', message: 'cannot derive a filename' });
    return safe;
  }
}
