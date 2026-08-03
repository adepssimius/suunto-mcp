# suunto-mcp

An MCP server for authoring and managing structured workouts (SuuntoPlus™ Guides)
on Suunto, designed so the transport can be swapped without touching the workout
model.

Not affiliated with or endorsed by Suunto Oy.

## Why it's built this way

There are three possible ways to get a structured workout onto a Suunto watch,
and they differ enough that the transport has to be a replaceable part:

| Path | Status | Notes |
|---|---|---|
| Cloud API (`cloudapi.suunto.com/v2/guides`) | Documented, needs a subscription key | The sanctioned path. Contract fully captured in [docs/cloud-api.md](docs/cloud-api.md). |
| Private mobile API | Unmapped | The Suunto app's Workout Builder uses it. See [docs/private-guides-api.md](docs/private-guides-api.md). |
| Local zip | Works today | Emit a validated `guide.zip`; no auth involved. |

`suuntool` deliberately isn't one of them: it has no guide-creation capability at
all. It's a good *read* client for completed activity and wellness data, so with
`SUUNTO_TRAINING_CONTEXT=suuntool` this server shells out to it (argv array,
never a shell string) for one extra tool, `get_recent_training` — recent
workouts and recovery, unit-converted (recovery HR arrives in **Hz**, not BPM;
quality as a **0..1 fraction**, not a percentage — both silent enough to pass an
inattentive review unconverted). It otherwise ships its own MCP server, so for
anything beyond that, run the two side by side rather than wrapping one in the
other.

Its exit codes double as this server's own error taxonomy: codes 2–7
(`USAGE`/`NETWORK`/`AUTH_EXPIRED`/`SERVER`/`NOT_FOUND`/`FORBIDDEN`) are
numerically identical on both, so a session that has expired in suuntool's own
`session.json` surfaces through the same code as an expired Cloud API token.

## The interesting part

The guide format is a **display** format, not a training format. It has no step
roles, no percentages, no nesting, and a 13-character title budget. So the domain
model is what a coach would write, and `src/compile` lowers it:

- roles (`warmup`/`work`/`rest`/…) → titles, notifications and lap marks
- durations → a per-step `trigger` plus a matching countdown *field*
- **pace ranges → m/s, with the bounds inverted** (4:15–4:25 /km is 3.77–3.92 m/s)
- cadence → **Hertz** (180 spm is 3.0)
- `%HRmax` / `%FTP` → absolutes, resolved from the athlete profile
- nested repeats → flattened, keeping the outer block so the step budget survives
- every string truncated and charset-sanitised for the watch display

Correctness is anchored on Suunto's own published sample guide, which is stored
verbatim in `test/fixtures/` and used two ways: to prove the format model accepts
real Suunto output, and as the compiler's target.

## Layout

```
src/domain/     workout model, guide wire format, validator, limits, activity IDs
src/compile/    the lowering compiler, unit conversions, externalId hashing
src/package/    zip packing (manifest.json + guide.json + icon.png)
src/backends/   the GuideBackend port and its implementations
src/mcp/        MCP server
scripts/        APK acquisition and static analysis for the RE track
docs/           captured API contracts and RE findings
```

## Running it

Tool tiers follow suuntool's: read-only by default, `--allow-write` to create and
update, `--allow-destructive` on top of that to delete. Gating happens at
*registration*, so a tool you have not permitted is absent from the listing
entirely rather than present and always refusing.

```bash
claude mcp add suunto -- node /path/to/suunto-mcp/dist/mcp/main.js --allow-write
```

| Tier | Tools |
|---|---|
| read | `preview_workout`, `list_workouts`, `describe_backend` |
| `--allow-write` | `create_workout`, `update_workout` |
| `--allow-destructive` | `delete_workout` |

`preview_workout` compiles and validates without uploading, and returns the
warnings — start there.

### Configuration

| Variable | Purpose |
|---|---|
| `SUUNTO_MCP_BACKEND` | `file` (default) or `cloud` |
| `SUUNTO_MCP_OUTPUT_DIR` | Where the file backend writes; defaults under `~/.local/share` |
| `SUUNTO_OWNER` | Creator name. Must match the OAuth app name for the Cloud API |
| `SUUNTO_SUBSCRIPTION_KEY` | `Ocp-Apim-Subscription-Key`, required for `cloud` |
| `SUUNTO_ACCESS_TOKEN` | Static bearer token, for trying the API by hand |
| `SUUNTO_CLIENT_ID` / `SUUNTO_CLIENT_SECRET` | Enables refresh of the 24h token |
| `SUUNTO_MAX_HR`, `SUUNTO_THRESHOLD_HR`, `SUUNTO_FTP`, `SUUNTO_REST_HR` | Athlete profile, needed only for `%HRmax` / `%FTP` targets |
| `SUUNTO_TRAINING_CONTEXT` | `suuntool` to enable `get_recent_training`, `off` (default) |
| `SUUNTOOL_BINARY` | Path to `suuntool`, if not on `PATH` |

Configuration is validated at startup and a bad config is a hard exit — an MCP
server that starts and then fails every call is much harder to diagnose.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
```

## Reverse-engineering track

```bash
scripts/pull-apk.sh        # pull the APK off a connected Android device
scripts/analyze-apk.sh     # stage 1: fast dex string scan
scripts/analyze-apk.sh 2   # stage 2: full jadx decompile, only if needed
```

`apk/` and `capture/` are git-ignored and must stay that way — captures contain
session keys and account identifiers.
