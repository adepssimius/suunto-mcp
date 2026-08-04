# Private guides API — confirmed

**Status: fully mapped AND fully live-verified, reads and writes.** Full
lifecycle exercised for real against a live account (2026-08-04) via the
actual `suunto-mcp` binary, `SUUNTO_MCP_BACKEND=private`, using a session from
`suuntool login`:

1. `list_workouts` → 10 real guides, correctly decoded, including one named
   "Runna Repeats" — confirms the Runna-sourced guides mentioned below are
   genuinely on this account.
2. `create_workout` with `externalId: "suunto-mcp-livetest-2026-08-04"` →
   succeeded, real guide id `iwmrmx4t`.
3. A second `create_workout` with the **same** `externalId` → **`409
   Conflict`**, mapped correctly to `CONFLICT` by this server's own error
   taxonomy. Confirms the dedup guarantee documented for the Cloud API also
   holds here, despite `RemoteGuideInfo` never exposing `externalId` back to
   the caller.
4. Fetched the raw stored zip directly (`GET suuntoplus/guides/files/{id}`,
   bypassing this library — see "Confirmed: externalId round-trips" below) and
   found `externalId` present, byte-for-byte, in the server-stored
   `guide.json`. So server-side dedup on it is real, not a documentation
   artifact of the app the endpoint was designed for.
5. `update_workout` → succeeded, same id, `modificationTime` advanced.
6. `delete_workout` → succeeded.
7. `list_workouts` again → back to the original 10, zero residue on the
   account.

Every open question from the first pass at this document is now closed. What
follows is the mapping that made the live test possible in the first place.

Mapped by static analysis of `com.stt.android.suunto` v6.11.8
(pulled from a real device via `scripts/pull-apk.sh`, decompiled via
`scripts/analyze-apk.sh 2`). No traffic capture was needed — R8 left the
Retrofit interface and its DTOs with real names, and the annotation *values*
(paths, headers) survive obfuscation regardless, since they're string
constants Retrofit reads at runtime.

Source of every claim below: `capture/decompiled/sources/com/stt/android/device/remote/suuntoplusguide/*.java`
(git-ignored; re-derivable any time from the pulled APK). Retrofit's own
annotation types get R8-obfuscated to single-letter-ish names — the mapping
below was confirmed by usage pattern, not by the annotation's own definition:

| Obfuscated | Real annotation |
|---|---|
| `sef` | `@GET` |
| `yrp` | `@POST` |
| `bsp` | `@PUT` |
| `bpp` | `@PATCH` |
| `p99` | `@DELETE` |
| `sag` | `@Headers` |
| `q5q` | `@Path` |
| `nyr` | `@Query` |
| `xi3` | `@Body` |

## The headline finding

**This is not on `cloudapi.suunto.com`.** It's on the same Sports-Tracker ASKO
backend `suuntool` already talks to (`https://api.sports-tracker.com/apiserver/v1/`),
using the exact same auth (`STTAuthorization` header, session key from login)
and the exact same response envelope suuntool's Go code calls `AskoResponse`
(`{error, payload, metadata}` — `internal/api/envelope.go`'s `DecodeAsko[T]`
decodes this shape already). The relative paths below hang off that base.

This means: **once a `suuntool` session exists, this API needs no new
credential at all.** No OAuth, no subscription key, no partner application.

## Endpoints

From `SuuntoPlusGuideRestAPI.java` (interface `SuuntoPlusGuideRestAPI`, package
`com.stt.android.device.remote.suuntoplusguide`):

| Verb | Path | Method | Returns |
|---|---|---|---|
| Create | `POST suuntoplus/guides/files` | `uploadGuide(body)` | `AskoResponse<RemoteGuideInfo>` |
| Update content | `PUT suuntoplus/guides/files/{guideId}` | `updateGuide(id, body)` | `AskoResponse<RemoteGuideInfo>` |
| Delete | `DELETE suuntoplus/guides/files/{guideId}` | `deleteGuide(id)` | — |
| List all | `GET suuntoplus/guides/items` | `fetchAll()` | `AskoResponse<List<RemoteGuideInfo>>` |
| Priority order | `GET suuntoplus/guides/priority` | `fetchPriorityOrder()` | `AskoResponse<RemoteGuidePriorities>` |
| Set pinned | `PATCH suuntoplus/guides/items/{guideId}` | `updatePinnedStatus(id, body)` | `AskoResponse<RemoteGuideInfo>` |
| Download zip | `GET suuntoplus/guides/files/{guideId}` | `downloadSource(id)` | raw zip bytes |
| Download guide.json | `GET suuntoplus/guides/json/{guideId}?capabilities=` | `downloadJsonFile(id, capabilities)` | raw JSON — **404'd live with no `capabilities` value sent**; `downloadSource` (below) worked fine and needs no query param, so use that instead |
| Download plugin | `GET suuntoplus/guides/plugins/{guideId}?capabilities=` | `downloadZAPPFile(id, capabilities)` | raw binary |

Create and update carry:
```
Content-Type: application/zip
Client-Id: 5c2fa984-4425-4e72-8f7c-deeaa454b9c6
```
(`@Headers` on the Retrofit method — a static, app-wide value, not
per-account. Whether the server actually requires it or just logs it is
unconfirmed; send it regardless, it costs nothing.)

**No `x-totp` header on any of these.** Grepped for it across the whole
`suuntoplusguide` package — present on `watchkey` endpoints elsewhere in the
app, absent here. Guide writes are simpler than comments/reactions in this
respect.

**`fetchAll()` takes no pagination parameters at all.** Unlike the documented
Cloud API's `offset`/`limit`/`fileSince`, the mobile client fetches everything
in one call and caches it in a local Room table (`suunto_plus_guides`, found in
stage 1's string scan) rather than paging.

## Confirmed live: `externalId` round-trips, and dedup is real

`downloadSource(id)` (`GET suuntoplus/guides/files/{id}`) returns a
**reconstituted** zip — `guide.json` + `icon.png` only, **no `manifest.json`**,
unlike the 3-file zip you upload. The server parses what you send and
re-serialises it (numeric fields came back as `60.0` where we'd sent `60`),
so it is not a byte-for-byte echo.

Inside that reconstituted `guide.json`, `externalId` was present exactly as
uploaded — `"suunto-mcp-livetest-2026-08-04"` — confirming the server stores
it even though `RemoteGuideInfo` never exposes it back to any caller. And a
second `create_workout` with the same `externalId` returned **`409
Conflict`**, matching the documented Cloud API's guarantee exactly. Treat
create as genuinely idempotent on `externalId` here — this is no longer an
inferred behavior, it's an observed one.

## Confirmed: the zip format is identical to the documented Cloud API

`SaveWorkoutPlanAsGuideUseCase.buildGuideZipPackage()` (`SaveWorkoutPlanAsGuideUseCase.java`)
takes an **already-built `guideJson` string** plus `name`/`description`, and:

1. Serialises a `GuideManifest` via Moshi — confirmed fields: `name`, `type`,
   `owner`, `description`. Identical to the documented `manifest.json`.
2. Packs `manifest.json` + the given `guide.json` + (presumably) `icon.png`
   into a zip (`byte[]`).
3. Hands the bytes to `SuuntoPlusGuideRemoteDataSource.i()` (create) or `.g()`
   (update), which call the Retrofit methods above with `@Body RequestBody`
   (Retrofit's real `RequestBody`, decompiled name `oet` — confirmed by its
   own file header: `/* JADX INFO: compiled from: RequestBody.kt */`,
   `package okhttp`).

**Where `guide.json`'s actual step content gets built is upstream of this
class** — it arrives as a pre-built string. Stage 1's string scan turned up
`com.soy.algorithms.planner.Guide` / `GuideWorkoutPlanType`, which is almost
certainly that builder, in a separate module. This was **not chased further**:
it doesn't matter how Suunto's own client builds `guide.json`, only that the
endpoint accepts a valid one — and we already have an independently-derived,
schema-validated compiler for that (`src/compile/compile.ts`), anchored on
Suunto's own published sample. Reversing their internal builder would be pure
cost with no payoff here.

## Response DTOs

`RemoteGuideInfo` (the payload of create/update/list), Moshi `@Json` names:

```
id, catalogueId, fileModificationTime→modifiedMillis, name, owner, ownerId,
description, shortDescription, richText→richDescription, localDate→date,
url, iconUrl, backgroundUrl, activities→activityIds, pinned
```

Two fields the documented Cloud API doesn't mention: `catalogueId` (presumably
non-null only for guides installed from the SuuntoPlus Store, not
user-created ones) and `ownerId`, `backgroundUrl`.

**One field conspicuously absent: `externalId`.** The documented Cloud API's
`RemoteGuideInfo`-equivalent includes it, and it's the whole idempotency story
there — a 409 on a duplicate `externalId`. This mobile DTO has no such field,
on create *or* list. **Confirmed live (2026-08-04) that the server enforces it
anyway**: a second `create_workout` with a previously-used `externalId`
returned `409 Conflict`, and the stored `guide.json` (fetched via
`downloadSource`, not `downloadJsonFile` — see below) contained the value
byte-for-byte. The DTO omission is cosmetic; the server-side behavior matches
the documented API exactly. `PrivateApiGuideBackend.toRef()` still reports
`externalId: undefined` in its own `GuideRef`, and that's correct — it's an
honest reflection of what the *response* contains, not a claim about what the
server does with it.

`UpdatePinnedStatusBody`: `{id: string, pinned: boolean}` — sent to the PATCH
endpoint. Confirms the documented API's note that content updates don't touch
`pinned` is true here too: it's a genuinely separate call.

`RemoteGuidePriorities`: `{guides: [{id: string}]}` — just an ordered id list.

## What this means for the adapter

A `PrivateApiGuideBackend` is now buildable with everything already in this
repo:

- **Auth**: read `suuntool`'s `session.json` (`src/auth/session.ts` already
  does this) and send it as `STTAuthorization`, exactly as `suuntool` does for
  every other Sports-Tracker call. No `x-totp` needed for these specific
  endpoints.
- **Packing**: `src/package/zip.ts` already produces the right zip shape —
  nothing to change there.
- **Envelope**: `{error, payload, metadata}` decoding is new work, but small —
  suuntool's Go `DecodeAsko[T]` is the reference implementation to mirror.
- **Capabilities**: `create`/`update`/`remove`/`list` all map directly.
  `schedule` (via `localDate` in `guide.json`) works the same way the file and
  Cloud backends already do it. Pinning is a distinct, optional capability this
  backend has that the others don't model yet (`suuntoplus/guides/items/{id}`
  PATCH) — worth a `pin` capability flag if it's ever exposed as a tool.

## Remaining unknowns

- [x] ~~Exact base URL prefix~~ — **confirmed**: `suuntool doctor` reports
      `https://api.sports-tracker.com/apiserver/v1/` as its own `baseURL`, and
      `PrivateApiGuideBackend` using that exact value against
      `suuntoplus/guides/items` returned a correctly-decoded real guide list.
- [x] ~~Whether `STTAuthorization` from a `suuntool` session is accepted here~~
      — **confirmed live**, no separate login or credential needed.
- [x] ~~Whether `externalId` survives a real create/update round-trip~~ —
      **confirmed live**: stored server-side, and a duplicate genuinely 409s.
      See "Confirmed live: `externalId` round-trips" above.
- [x] ~~Create/update/delete/list all work~~ — **confirmed live**, full
      lifecycle, see the top of this document.
- [ ] Whether `Client-Id` is enforced or just logged (every call so far sent
      it and succeeded; haven't tried omitting it).
- [ ] Whether the account needs to be the *creator* of a guide to update/delete
      it (mirrors the documented API's "belongs to someone else" 404), and
      what happens to guides created by a *different* client (Client-Id) — e.g.
      the "Runna Repeats" guide seen in the live list, created by Runna's
      Client-Id, not ours. Untested: only this account's own
      `suunto-mcp`-created guide was ever mutated.
- [ ] `downloadJsonFile` (the endpoint with a `capabilities` query param) 404'd
      live with no value sent for `capabilities`. `downloadSource` (no query
      param, returns a full zip) works fine and was used instead — not worth
      chasing further unless a capability-adjusted JSON view specifically
      matters later.

## Ground rules (unchanged)

Scope strictly to this account and this account's own data — the same rule
`suuntool`'s own author states plainly for the backend it already talks to.
This is genuinely undocumented and unsanctioned; prefer the Cloud API the
moment a subscription key exists. Nothing under `apk/` or `capture/` is ever
committed — both are git-ignored.
