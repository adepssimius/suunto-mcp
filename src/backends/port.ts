import type { PackedGuide } from '../package/zip.js';
import { SuuntoError } from '../errors.js';

/**
 * The transport boundary.
 *
 * The three ways to get a guide onto a watch genuinely differ in what they can
 * do — the local file backend cannot list what is on your watch, and the private
 * mobile API may not support the same operations as the Cloud API. So
 * capabilities are declared rather than assumed, and the MCP layer reports an
 * honest "this backend cannot do that" instead of failing somewhere confusing.
 */

export interface BackendCapabilities {
  create: boolean;
  update: boolean;
  remove: boolean;
  list: boolean;
  /** Pin a guide to a calendar date via `localDate`. */
  schedule: boolean;
}

/** What a backend knows about a stored guide. */
export interface GuideRef {
  id: string;
  name: string;
  externalId?: string | undefined;
  localDate?: string | undefined;
  pinned?: boolean | undefined;
  modificationTime?: number | undefined;
}

export interface ListOptions {
  limit?: number | undefined;
  offset?: number | undefined;
  /** Epoch ms; return only guides modified at or after this time. */
  since?: number | undefined;
}

export interface GuideBackend {
  readonly name: string;
  readonly capabilities: BackendCapabilities;

  create(packed: PackedGuide): Promise<GuideRef>;
  update(id: string, packed: PackedGuide): Promise<GuideRef>;
  remove(id: string): Promise<void>;
  list(options?: ListOptions): Promise<GuideRef[]>;
}

export function requireCapability(
  backend: GuideBackend,
  capability: keyof BackendCapabilities,
): void {
  if (backend.capabilities[capability]) return;
  throw new SuuntoError({
    code: 'UNSUPPORTED',
    message: `the ${backend.name} backend cannot ${capability} guides`,
    hint: describeAlternative(capability),
  });
}

function describeAlternative(capability: keyof BackendCapabilities): string {
  switch (capability) {
    case 'list':
    case 'remove':
    case 'update':
      return 'Configure the cloud backend (SUUNTO_SUBSCRIPTION_KEY) to manage guides already on your account.';
    case 'schedule':
      return 'Omit the date, or use a backend that supports calendar pinning.';
    case 'create':
      return 'Configure a backend that can write.';
  }
}

/** Unsupported operations still need a body; this keeps the backends terse. */
export function unsupported(backendName: string, capability: string): never {
  throw new SuuntoError({
    code: 'UNSUPPORTED',
    message: `the ${backendName} backend cannot ${capability} guides`,
  });
}
