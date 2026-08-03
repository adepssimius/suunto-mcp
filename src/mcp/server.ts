import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { GuideBackend } from '../backends/port.js';
import { requireCapability } from '../backends/port.js';
import { compile, type CompileOptions } from '../compile/compile.js';
import { ACTIVITY_IDS } from '../domain/activities.js';
import type { AthleteProfile } from '../domain/workout.js';
import { isSuuntoError, SuuntoError } from '../errors.js';
import { packGuide } from '../package/zip.js';
import { summariseRecovery, summariseWorkout } from '../training/digest.js';
import type { SuuntoolCli } from '../training/suuntool-cli.js';
import { AthleteProfileArg, workoutShape } from './schema.js';

/**
 * The MCP surface, tier-gated the way `suuntool` gates its own: read tools are
 * always available, writes need `--allow-write`, and destructive operations need
 * `--allow-destructive` on top of that.
 *
 * The gating is at *registration* time, not call time. A tool that is not
 * permitted simply is not in the listing, so the model never proposes an action
 * that is going to be refused — which is both fewer wasted turns and a much
 * clearer contract than a tool that exists but always fails.
 */

export interface ServerOptions {
  backend: GuideBackend;
  /** Creator name; must match the OAuth application name for the Cloud API. */
  owner: string;
  url: string;
  profile?: AthleteProfile;
  allowWrite?: boolean;
  allowDestructive?: boolean;
  transport?: Transport;
  /**
   * Optional read-only training context, backed by the `suuntool` CLI. Absent
   * by default: it depends on an external binary and an existing login this
   * server has no part in, so its tool is only registered when explicitly wired
   * up rather than assumed present.
   */
  trainingContext?: SuuntoolCli;
}

interface Deps {
  backend: GuideBackend;
  compileOptions: CompileOptions;
  trainingContext?: SuuntoolCli;
}

export function buildServer(options: ServerOptions): McpServer {
  const server = new McpServer({ name: 'suunto-mcp', version: '0.0.1' });

  const deps: Deps = {
    backend: options.backend,
    compileOptions: {
      owner: options.owner,
      url: options.url,
      ...(options.profile ? { profile: options.profile } : {}),
    },
    ...(options.trainingContext ? { trainingContext: options.trainingContext } : {}),
  };

  registerReadTools(server, deps);
  if (options.allowWrite) registerWriteTools(server, deps);
  if (options.allowWrite && options.allowDestructive) registerDestructiveTools(server, deps);

  return server;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Preserve the error's structure for the model rather than flattening it to a
 * sentence. A caller that can see `code: "CONFLICT"` knows to switch to
 * update_workout; one that sees only prose has to guess.
 */
function fail(cause: unknown): ToolResult {
  const error = isSuuntoError(cause)
    ? cause
    : new SuuntoError({
        code: 'SERVER',
        message: cause instanceof Error ? cause.message : String(cause),
      });
  return {
    content: [{ type: 'text', text: JSON.stringify(error.toPayload(), null, 2) }],
    isError: true,
  };
}

async function guard(fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (cause) {
    return fail(cause);
  }
}

/** Merge a per-call profile over the server default, so a caller can override. */
function optionsFor(deps: Deps, profile: AthleteProfile | undefined): CompileOptions {
  if (!profile) return deps.compileOptions;
  return {
    ...deps.compileOptions,
    profile: { ...(deps.compileOptions.profile ?? {}), ...profile },
  };
}

// ---------------------------------------------------------------------------
// Read tier
// ---------------------------------------------------------------------------

function registerReadTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'preview_workout',
    {
      title: 'Preview a workout',
      description:
        'Compile a structured workout into the SuuntoPlus guide format and return it WITHOUT uploading. ' +
        'Use this first: it surfaces unit conversions, truncated titles and validation errors, ' +
        'so mistakes are caught before anything reaches the watch.',
      inputSchema: { ...workoutShape, profile: AthleteProfileArg },
      annotations: { readOnlyHint: true },
    },
    async ({ profile, ...workout }) =>
      guard(() => {
        const { guide, manifest, warnings } = compile(workout, optionsFor(deps, profile));
        // Pack as well as compile: packing is where the guide is validated
        // against the wire schema, so previewing exercises the same path an
        // upload would.
        const packed = packGuide(guide, manifest);
        return {
          guide,
          manifest,
          warnings,
          zipBytes: packed.zip.byteLength,
          externalId: guide.externalId,
          summary: summarise(guide),
        };
      }),
  );

  server.registerTool(
    'list_workouts',
    {
      title: 'List guides',
      description: 'List structured workouts stored on the configured backend.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        since: z.number().int().optional().describe('Epoch ms; only guides modified at or after'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        requireCapability(deps.backend, 'list');
        const guides = await deps.backend.list(args);
        return { backend: deps.backend.name, count: guides.length, guides };
      }),
  );

  if (deps.trainingContext) {
    registerTrainingContextTool(server, deps.trainingContext);
  }

  server.registerTool(
    'describe_backend',
    {
      title: 'Describe the active backend',
      description:
        'Report which backend is active and which operations it supports. ' +
        'Check this before planning a sequence of changes — backends differ in what they can do.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(() => ({
        backend: deps.backend.name,
        capabilities: deps.backend.capabilities,
        owner: deps.compileOptions.owner,
        profile: deps.compileOptions.profile ?? null,
        activityTypes: Object.keys(ACTIVITY_IDS),
      })),
  );
}

/**
 * `get_recent_training` is registered separately from `registerReadTools`
 * rather than folded into it, because it depends on an optional collaborator
 * (`suuntool`, an external binary reading an external login) instead of the
 * server's own always-present backend. Keeping it a distinct function makes
 * that conditionality visible at the call site rather than buried in a branch.
 */
function registerTrainingContextTool(server: McpServer, cli: SuuntoolCli): void {
  server.registerTool(
    'get_recent_training',
    {
      title: 'Get recent training and recovery',
      description:
        'Fetch recently completed workouts and recovery readings via suuntool, so a new session ' +
        'can be prescribed with knowledge of recent load and recovery. Read-only: this reflects ' +
        "what already happened, never what's planned.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(14).describe('How far back to look'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) =>
      guard(async () => {
        const since = `${days}d`;
        const [athlete, workouts, recovery] = await Promise.all([
          cli.whoami(),
          cli.recentWorkouts({ since }),
          cli.recovery({ since }).catch((cause) => {
            // Recovery data is a bonus, not a precondition — a missing wellness
            // scope or an unsupported device should not fail the whole tool
            // when workout history alone still answers the question asked.
            if (isSuuntoError(cause) && cause.code === 'FORBIDDEN') return [];
            throw cause;
          }),
        ]);

        return {
          athlete: athlete.username,
          windowDays: days,
          workouts: workouts.items.map(summariseWorkout),
          recovery: recovery.map(summariseRecovery),
        };
      }),
  );
}

// ---------------------------------------------------------------------------
// Write tier
// ---------------------------------------------------------------------------

function registerWriteTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'create_workout',
    {
      title: 'Create a guide',
      description:
        'Compile a structured workout and upload it as a new SuuntoPlus guide. ' +
        'Returns CONFLICT if a guide with the same externalId already exists — ' +
        'use update_workout in that case.',
      inputSchema: { ...workoutShape, profile: AthleteProfileArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ profile, ...workout }) =>
      guard(async () => {
        requireCapability(deps.backend, 'create');
        const { guide, manifest, warnings } = compile(workout, optionsFor(deps, profile));
        if (guide.localDate) requireCapability(deps.backend, 'schedule');
        const packed = packGuide(guide, manifest);
        const ref = await deps.backend.create(packed);
        return { created: ref, warnings, summary: summarise(guide) };
      }),
  );

  server.registerTool(
    'update_workout',
    {
      title: 'Update a guide',
      description:
        'Replace the contents of an existing guide. Note that this updates guide content only — ' +
        'it does not change pinned state or ownership.',
      inputSchema: {
        id: z.string().min(1).describe('Guide id, as returned by list_workouts'),
        ...workoutShape,
        profile: AthleteProfileArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, profile, ...workout }) =>
      guard(async () => {
        requireCapability(deps.backend, 'update');
        const { guide, manifest, warnings } = compile(workout, optionsFor(deps, profile));
        const packed = packGuide(guide, manifest);
        const ref = await deps.backend.update(id, packed);
        return { updated: ref, warnings, summary: summarise(guide) };
      }),
  );
}

// ---------------------------------------------------------------------------
// Destructive tier
// ---------------------------------------------------------------------------

function registerDestructiveTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'delete_workout',
    {
      title: 'Delete a guide',
      description: 'Permanently delete a guide from the backend. This cannot be undone.',
      inputSchema: { id: z.string().min(1).describe('Guide id, as returned by list_workouts') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) =>
      guard(async () => {
        requireCapability(deps.backend, 'remove');
        await deps.backend.remove(id);
        return { deleted: id };
      }),
  );
}

// ---------------------------------------------------------------------------

/**
 * A compact human-readable rendering of the compiled guide, returned alongside
 * the raw JSON so a model can sanity-check the session without parsing a
 * hundred lines of field definitions.
 */
function summarise(guide: { steps: unknown[]; name: string; localDate?: string }): string {
  const lines: string[] = [guide.name];
  if (guide.localDate) lines.push(`scheduled ${guide.localDate}`);
  lines.push(`${guide.steps.length} top-level steps`);
  return lines.join(' — ');
}
