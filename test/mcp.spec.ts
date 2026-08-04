import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileGuideBackend } from '../src/backends/file.js';
import type { GuideBackend } from '../src/backends/port.js';
import { buildServer, type ServerOptions } from '../src/mcp/server.js';

/**
 * End-to-end through a real MCP client over an in-memory transport, rather than
 * calling the handlers directly — that is what exercises schema generation,
 * argument validation and result serialisation, which is where an MCP server
 * actually tends to break.
 */

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'suunto-mcp-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function connect(overrides: Partial<ServerOptions> = {}) {
  const server = buildServer({
    backend: new FileGuideBackend(tmp),
    owner: 'suunto-mcp',
    url: 'https://example.com/plan',
    ...overrides,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ payload: any; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return {
    payload: JSON.parse(result.content[0]!.text),
    isError: result.isError === true,
  };
}

/** Call a tool that is expected to succeed, surfacing the server's error if not. */
async function callOk(client: Client, name: string, args: Record<string, unknown>) {
  const { payload, isError } = await callJson(client, name, args);
  if (isError) throw new Error(`${name} failed: ${JSON.stringify(payload)}`);
  return payload;
}

const simpleWorkout = {
  title: 'Threshold 4x5',
  description: 'Four by five minutes at threshold with two minute floats',
  activities: ['RUNNING'],
  steps: [
    { type: 'step', role: 'warmup', duration: { kind: 'time', seconds: 900 } },
    {
      type: 'repeat',
      times: 4,
      note: 'Main set',
      steps: [
        {
          type: 'step',
          role: 'work',
          duration: { kind: 'time', seconds: 300 },
          intensity: { kind: 'pace', fastSecPerKm: 240, slowSecPerKm: 250 },
        },
        { type: 'step', role: 'recovery', duration: { kind: 'time', seconds: 120 } },
      ],
    },
    { type: 'step', role: 'cooldown', duration: { kind: 'time', seconds: 600 } },
  ],
};

describe('tool tiers', () => {
  /**
   * Gating happens at registration, so a disallowed tool is absent from the
   * listing entirely. That is a clearer contract than a tool that exists and
   * always refuses, and it stops the model proposing actions it cannot take.
   */
  it('exposes only read tools by default', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['describe_backend', 'list_workouts', 'preview_workout']);
  });

  it('adds write tools with allowWrite', async () => {
    const { client } = await connect({ allowWrite: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('create_workout');
    expect(names).toContain('update_workout');
    expect(names).not.toContain('delete_workout');
  });

  it('requires allowWrite as well as allowDestructive for delete', async () => {
    const withoutWrite = await connect({ allowDestructive: true });
    expect((await withoutWrite.client.listTools()).tools.map((t) => t.name)).not.toContain(
      'delete_workout',
    );

    const withBoth = await connect({ allowWrite: true, allowDestructive: true });
    expect((await withBoth.client.listTools()).tools.map((t) => t.name)).toContain(
      'delete_workout',
    );
  });

  it('marks destructive tools in their annotations', async () => {
    const { client } = await connect({ allowWrite: true, allowDestructive: true });
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === 'delete_workout')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'preview_workout')?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('preview_workout', () => {
  it('compiles without writing anything', async () => {
    const { client } = await connect();
    const payload = await callOk(client, 'preview_workout', simpleWorkout);

    expect(payload.guide.name).toBe('Threshold 4x5');
    expect(payload.guide.type).toBe('sequence');
    expect(payload.externalId).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.zipBytes).toBeGreaterThan(0);

    // Nothing reached the backend.
    const listed = await callJson(client, 'list_workouts', {});
    expect(listed.payload.count).toBe(0);
  });

  it('reports the pace target in m/s with the bounds inverted', async () => {
    const { client } = await connect();
    const payload = await callOk(client, 'preview_workout', simpleWorkout);
    const repeat = payload.guide.steps.find((s: any) => s.type === 'repeat');
    const target = repeat.steps[0].fields.find((f: any) => f.type === 'targetPace');
    // 4:00–4:10 /km → 4.00–4.17 m/s
    expect(target).toEqual({ type: 'targetPace', value: 4.09, min: 4, max: 4.17 });
  });

  it('returns a structured error rather than throwing on an invalid workout', async () => {
    const { client } = await connect();
    const { payload, isError } = await callJson(client, 'preview_workout', {
      ...simpleWorkout,
      steps: [
        {
          type: 'step',
          role: 'work',
          duration: { kind: 'time', seconds: 300 },
          intensity: { kind: 'hr', basis: 'pctMax', min: 85, max: 92 },
        },
      ],
    });

    expect(isError).toBe(true);
    expect(payload.error.code).toBe('SERVER');
    expect(payload.error.message).toMatch(/no maxHr/);
  });

  it('resolves percentage targets from a per-call profile', async () => {
    const { client } = await connect();
    const { payload, isError } = await callJson(client, 'preview_workout', {
      ...simpleWorkout,
      steps: [
        {
          type: 'step',
          role: 'work',
          duration: { kind: 'time', seconds: 300 },
          intensity: { kind: 'hr', basis: 'pctMax', min: 85, max: 92 },
        },
      ],
      profile: { maxHr: 190 },
    });

    expect(isError).toBe(false);
    // 85% and 92% of 190 bpm, rounded: 162 and 175. Midpoint 168.5 rounds to 169.
    const target = payload.guide.steps[0].fields.find((f: any) => f.type === 'targetHeartRate');
    expect(target).toEqual({ type: 'targetHeartRate', value: 169, min: 162, max: 175 });
  });
});

describe('create / list / delete round trip', () => {
  it('creates a guide, lists it, then deletes it', async () => {
    const { client } = await connect({ allowWrite: true, allowDestructive: true });

    const created = await callJson(client, 'create_workout', {
      ...simpleWorkout,
      date: '2026-08-11',
    });
    expect(created.isError).toBe(false);
    expect(created.payload.created.localDate).toBe('2026-08-11');

    const listed = await callJson(client, 'list_workouts', {});
    expect(listed.payload.count).toBe(1);
    expect(listed.payload.guides[0].name).toBe('Threshold 4x5');

    const id = listed.payload.guides[0].id;
    const deleted = await callJson(client, 'delete_workout', { id });
    expect(deleted.payload).toEqual({ deleted: id });

    expect((await callJson(client, 'list_workouts', {})).payload.count).toBe(0);
  });

  it('reports NOT_FOUND when deleting something that is not there', async () => {
    const { client } = await connect({ allowWrite: true, allowDestructive: true });
    const { payload, isError } = await callJson(client, 'delete_workout', { id: 'nope' });
    expect(isError).toBe(true);
    expect(payload.error.code).toBe('NOT_FOUND');
  });

  /**
   * Re-creating the same session overwrites rather than accumulating, because
   * the filename is the deterministic externalId — the local mirror of the
   * server-side dedup the Cloud API gives us via 409.
   */
  it('is idempotent for an unchanged session', async () => {
    const { client } = await connect({ allowWrite: true });
    await callJson(client, 'create_workout', simpleWorkout);
    await callJson(client, 'create_workout', simpleWorkout);
    expect((await callJson(client, 'list_workouts', {})).payload.count).toBe(1);
  });
});

describe('capability reporting', () => {
  it('describes the active backend', async () => {
    const { client } = await connect();
    const { payload } = await callJson(client, 'describe_backend', {});
    expect(payload.backend).toBe('file');
    expect(payload.capabilities).toEqual({
      create: true,
      update: true,
      remove: true,
      list: true,
      schedule: true,
    });
    expect(payload.activityTypes).toContain('TRAIL_RUNNING');
  });

  /**
   * A backend that cannot do something must say so in the taxonomy, not fail
   * somewhere confusing downstream.
   */
  it('reports UNSUPPORTED rather than failing obscurely', async () => {
    const readOnly: GuideBackend = {
      name: 'stub',
      capabilities: { create: true, update: false, remove: false, list: false, schedule: false },
      create: async () => ({ id: 'x', name: 'x' }),
      update: async () => ({ id: 'x', name: 'x' }),
      remove: async () => {},
      list: async () => [],
    };
    const { client } = await connect({ backend: readOnly, allowWrite: true });

    const listed = await callJson(client, 'list_workouts', {});
    expect(listed.isError).toBe(true);
    expect(listed.payload.error.code).toBe('UNSUPPORTED');
    expect(listed.payload.error.message).toMatch(/stub backend cannot list/);

    // Scheduling is refused before anything is uploaded.
    const scheduled = await callJson(client, 'create_workout', {
      ...simpleWorkout,
      date: '2026-08-11',
    });
    expect(scheduled.isError).toBe(true);
    expect(scheduled.payload.error.code).toBe('UNSUPPORTED');
  });
});

