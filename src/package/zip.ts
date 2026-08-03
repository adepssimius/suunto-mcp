import { zipSync } from 'fflate';
import type { Guide, GuideManifest } from '../domain/guide.js';
import { GuideManifestSchema, validateGuide } from '../domain/guide-schema.js';
import { SuuntoError } from '../errors.js';
import { ICON_SIZE, isPng, pngDimensions, solidPng } from './icon.js';

/**
 * Build the guide archive the Cloud API expects: a flat zip of exactly three
 * files — `manifest.json`, `guide.json`, `icon.png`.
 *
 * Validation happens here rather than at the HTTP boundary because the server's
 * rejection is a single unstructured sentence with no path to the offending
 * step. Catching it locally is the difference between "field
 * steps.4.steps.1.fields.0: text value exceeds 54 characters" and "Invalid step
 * type", 400.
 */

/**
 * A fixed timestamp for every entry, so the same guide packs to the same bytes.
 *
 * Mid-1980 rather than the start of it: the ZIP DOS date field cannot encode
 * anything before 1980, and fflate reads the year with local-time
 * `getFullYear()`. A UTC-midnight 1980-01-01 is therefore 1979 for every
 * timezone behind UTC, and fflate rejects it. Noon on 15 June is more than a day
 * from either boundary, so no offset can push it out of range.
 *
 * (The encoded DOS time still reflects the local clock, so the bytes are stable
 * on a given machine rather than across timezones — which is all that
 * change-detection needs.)
 */
const ZIP_EPOCH = new Date(Date.UTC(1980, 5, 15, 12, 0, 0));

export interface PackOptions {
  /** Custom icon. Must be a 300×300 PNG. A flat colour is generated otherwise. */
  icon?: Uint8Array;
}

export interface PackedGuide {
  zip: Uint8Array;
  guide: Guide;
  manifest: GuideManifest;
}

export function packGuide(
  guide: Guide,
  manifest: GuideManifest,
  options: PackOptions = {},
): PackedGuide {
  const guideCheck = validateGuide(guide);
  if (!guideCheck.ok) {
    throw new SuuntoError({
      code: 'INVALID_GUIDE',
      message: `guide failed validation (${guideCheck.issues.length} issue(s))`,
      hint: 'Fix the fields listed in details; the server reports only the first problem it hits.',
      details: guideCheck.issues,
    });
  }

  const manifestCheck = GuideManifestSchema.safeParse(manifest);
  if (!manifestCheck.success) {
    throw new SuuntoError({
      code: 'INVALID_GUIDE',
      message: 'manifest failed validation',
      details: manifestCheck.error.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
      })),
    });
  }

  // The manifest's owner is what Suunto matches against the OAuth application
  // name; a mismatch between the two files is rejected at upload with a message
  // that does not mention either.
  if (manifest.owner !== guide.owner) {
    throw new SuuntoError({
      code: 'INVALID_GUIDE',
      message: `manifest owner "${manifest.owner}" does not match guide owner "${guide.owner}"`,
    });
  }

  const icon = resolveIcon(options.icon);

  const zip = zipSync(
    {
      'manifest.json': encode(manifest),
      'guide.json': encode(guide),
      'icon.png': icon,
    },
    // Fixed mtime so the same guide always packs to identical bytes, which keeps
    // "has this actually changed?" answerable by comparison. It has to be
    // 1980-01-01 rather than the Unix epoch: the ZIP format's DOS timestamp
    // cannot represent anything earlier, and fflate rejects it outright.
    { mtime: ZIP_EPOCH, level: 9 },
  );

  return { zip, guide, manifest };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function resolveIcon(icon: Uint8Array | undefined): Uint8Array {
  if (!icon) return solidPng();

  if (!isPng(icon)) {
    throw new SuuntoError({ code: 'USAGE', message: 'icon must be a PNG' });
  }
  const dimensions = pngDimensions(icon);
  if (!dimensions) {
    throw new SuuntoError({ code: 'USAGE', message: 'could not read the icon PNG header' });
  }
  if (dimensions.width !== ICON_SIZE || dimensions.height !== ICON_SIZE) {
    throw new SuuntoError({
      code: 'USAGE',
      message: `icon must be ${ICON_SIZE}x${ICON_SIZE}, got ${dimensions.width}x${dimensions.height}`,
    });
  }
  return icon;
}
