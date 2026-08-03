#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { SessionTokenProvider } from '../auth/cloud-tokens.js';
import { loadCloudSession, loadSuuntoolSession, suuntoolSessionPath } from '../auth/session.js';
import { CloudApiGuideBackend, StaticTokenProvider } from '../backends/cloud-api.js';
import { FileGuideBackend } from '../backends/file.js';
import type { GuideBackend } from '../backends/port.js';
import { PrivateApiGuideBackend } from '../backends/private-api.js';
import type { AthleteProfile } from '../domain/workout.js';
import { SuuntoolCli } from '../training/suuntool-cli.js';
import { buildServer } from './server.js';

/**
 * Entry point for `suunto-mcp` over stdio.
 *
 * Configuration is validated once, at startup, and a bad configuration is a hard
 * exit rather than a server that runs in a half-usable state — an MCP server
 * that starts successfully and then fails every call is much harder to diagnose
 * than one that refuses to start and says why.
 */

/** Empty env vars read as absent: `FOO=` in a shell profile should not count. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const EnvSchema = z.object({
  SUUNTO_MCP_BACKEND: z.enum(['file', 'cloud', 'private']).default('file'),
  SUUNTO_MCP_OUTPUT_DIR: optional(z.string()),
  SUUNTO_OWNER: optional(z.string().max(64)),
  SUUNTO_URL: optional(z.url()),
  SUUNTO_SUBSCRIPTION_KEY: optional(z.string()),
  SUUNTO_ACCESS_TOKEN: optional(z.string()),
  SUUNTO_CLIENT_ID: optional(z.string()),
  SUUNTO_CLIENT_SECRET: optional(z.string()),
  SUUNTO_TRAINING_CONTEXT: z.enum(['suuntool', 'off']).default('off'),
  SUUNTOOL_BINARY: optional(z.string()),
  SUUNTO_MAX_HR: optional(z.coerce.number().int().positive().max(260)),
  SUUNTO_REST_HR: optional(z.coerce.number().int().positive().max(150)),
  SUUNTO_THRESHOLD_HR: optional(z.coerce.number().int().positive().max(260)),
  SUUNTO_FTP: optional(z.coerce.number().positive().max(2000)),
});

function loadEnv() {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    // stderr, always: stdout is the MCP protocol channel and any stray byte
    // written there corrupts the stream.
    console.error('Invalid suunto-mcp configuration:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

function buildBackend(env: ReturnType<typeof loadEnv>): GuideBackend {
  if (env.SUUNTO_MCP_BACKEND === 'file') {
    const dir =
      env.SUUNTO_MCP_OUTPUT_DIR ?? join(homedir(), '.local', 'share', 'suunto-mcp', 'guides');
    return new FileGuideBackend(dir);
  }

  if (env.SUUNTO_MCP_BACKEND === 'private') {
    if (!loadSuuntoolSession()) {
      console.error(
        `No suuntool session found at ${suuntoolSessionPath()}. Run: suuntool login`,
      );
      process.exit(1);
    }
    // Genuinely undocumented and unsanctioned — see docs/private-guides-api.md.
    // Loud on every start, not just in the README, since this is the one
    // backend whose behavior was never confirmed against a live account.
    console.error(
      'suunto-mcp: using the PRIVATE guides API (undocumented, unsanctioned). ' +
        'Scope strictly to your own account. Prefer SUUNTO_MCP_BACKEND=cloud once you have a subscription key.',
    );
    return new PrivateApiGuideBackend();
  }

  if (!env.SUUNTO_SUBSCRIPTION_KEY) {
    console.error(
      'SUUNTO_MCP_BACKEND=cloud requires SUUNTO_SUBSCRIPTION_KEY ' +
        '(developer portal > Your subscriptions).',
    );
    process.exit(1);
  }

  // A static token is the quickest way to try the API by hand; the session
  // provider is what survives the 24-hour token lifetime.
  const tokens = env.SUUNTO_ACCESS_TOKEN
    ? new StaticTokenProvider(env.SUUNTO_ACCESS_TOKEN)
    : new SessionTokenProvider(env.SUUNTO_CLIENT_ID, env.SUUNTO_CLIENT_SECRET);

  if (!env.SUUNTO_ACCESS_TOKEN && !loadCloudSession()) {
    console.error(
      'No Suunto Cloud session. Set SUUNTO_ACCESS_TOKEN, or complete the OAuth flow first.',
    );
    process.exit(1);
  }

  return new CloudApiGuideBackend({
    subscriptionKey: env.SUUNTO_SUBSCRIPTION_KEY,
    tokens,
  });
}

function buildProfile(env: ReturnType<typeof loadEnv>): AthleteProfile | undefined {
  const profile: AthleteProfile = {
    ...(env.SUUNTO_MAX_HR !== undefined ? { maxHr: env.SUUNTO_MAX_HR } : {}),
    ...(env.SUUNTO_REST_HR !== undefined ? { restHr: env.SUUNTO_REST_HR } : {}),
    ...(env.SUUNTO_THRESHOLD_HR !== undefined ? { thresholdHr: env.SUUNTO_THRESHOLD_HR } : {}),
    ...(env.SUUNTO_FTP !== undefined ? { ftp: env.SUUNTO_FTP } : {}),
  };
  return Object.keys(profile).length > 0 ? profile : undefined;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const argv = new Set(process.argv.slice(2));

  const backend = buildBackend(env);
  const profile = buildProfile(env);
  const trainingContext =
    env.SUUNTO_TRAINING_CONTEXT === 'suuntool'
      ? new SuuntoolCli({ ...(env.SUUNTOOL_BINARY ? { binary: env.SUUNTOOL_BINARY } : {}) })
      : undefined;

  const server = buildServer({
    backend,
    owner: env.SUUNTO_OWNER ?? 'suunto-mcp',
    url: env.SUUNTO_URL ?? 'https://github.com/local/suunto-mcp',
    ...(profile ? { profile } : {}),
    ...(trainingContext ? { trainingContext } : {}),
    allowWrite: argv.has('--allow-write'),
    allowDestructive: argv.has('--allow-destructive'),
  });

  const tiers = [
    'read',
    argv.has('--allow-write') ? 'write' : null,
    argv.has('--allow-write') && argv.has('--allow-destructive') ? 'destructive' : null,
  ]
    .filter(Boolean)
    .join('+');
  console.error(`suunto-mcp: backend=${backend.name} tiers=${tiers}`);

  await server.connect(new StdioServerTransport());
}

main().catch((cause: unknown) => {
  console.error('suunto-mcp failed to start:', cause instanceof Error ? cause.message : cause);
  process.exit(1);
});
