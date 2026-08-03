# Private guides API — confirmed

**Status: fully mapped**, by static analysis of `com.stt.android.suunto` v6.11.8
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
| Download guide.json | `GET suuntoplus/guides/json/{guideId}?capabilities=` | `downloadJsonFile(id, capabilities)` | raw JSON |
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

## Remaining unknowns (low-stakes, resolvable with one real call)

- [ ] Exact base URL prefix (`api.sports-tracker.com/apiserver/v1/` is
      inferred from suuntool's own base URL and the ASKO envelope match, not
      proven by finding the literal concatenation in code — the Retrofit
      client's `@BaseUrl`/builder wiring wasn't tracked down). First real
      request will confirm or correct this immediately.
- [ ] Whether `Client-Id` is enforced or just logged.
- [ ] Whether the account needs to be the *creator* of a guide to update/delete
      it (mirrors the documented API's "belongs to someone else" 404), and
      what happens to guides created by a *different* client (Client-Id).

## Ground rules (unchanged)

Scope strictly to this account and this account's own data — the same rule
`suuntool`'s own author states plainly for the backend it already talks to.
This is genuinely undocumented and unsanctioned; prefer the Cloud API the
moment a subscription key exists. Nothing under `apk/` or `capture/` is ever
committed — both are git-ignored.
