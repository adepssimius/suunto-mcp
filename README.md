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
all. It's a good *read* client for completed activity and wellness data, and it
ships its own MCP server, so it's best composed alongside this one rather than
wrapped by it.

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
