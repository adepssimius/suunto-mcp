# Private guides API — findings

**Status: not yet mapped.** This document is the target of the reverse-engineering
track; everything below is either established context or an open question.

## Why this track exists

The Suunto mobile app has a Workout Builder that creates structured workouts and
syncs them to the watch as SuuntoPlus Guides. So an API for creating guides
exists on whatever backend the app talks to. But:

- **`suuntool` does not expose it.** Its endpoint table (`cmd/endpoints.go`) is
  entirely `/v1/workouts*` and `/v1/user*` on `api.sports-tracker.com`, plus
  wellness streams on `247.sports-tracker.com`. Every write it supports mutates
  an activity that *already happened* — comment, react, attributes, share,
  upload a recorded SML, delete. Nothing plans anything.
- **Nobody has published it.** A GitHub code search for `sports-tracker.com guide`
  returns zero results across all public code.

So the shape of the request is unknown, and the app is the only client that
knows it.

## What is already known

**The backend.** `suuntool` documents its target as "the Suunto / Sports-Tracker
API — the same backend the Suunto mobile app uses", base URL
`https://api.sports-tracker.com/apiserver/v1/`. Wellness lives on a second host,
`https://247.sports-tracker.com/`.

**The auth, if the guides endpoint lives on that backend.** Reverse-engineered
from APK `com.stt.android.suunto` v6.8.13, per `suuntool/internal/auth`:

- Session key travels in an `STTAuthorization` header.
- Login is signed: `SHA-256("POST&" + path + params + "&secret=" + derivedSecret)`,
  base64url no padding, no URL-encoding of values.
- The secret comes from a `KeyObfuscator` XOR whose correctness depends on
  matching Java's *lossy* `new String(bytes, UTF-8)` behaviour.
- **Every write additionally requires an `x-totp` header** (PBKDF2-HmacSHA1 +
  RFC 6238, with the Java `PBEKeySpec` quirk that only the low byte of each
  password character is used). The server validates it against its own clock;
  more than ~30s of drift returns 403.

Note that `suuntool`'s key material is pinned to app **v6.8.13** while the
current app is **6.11.8**, so it may already need rotation.

## The hypothesis to test first

The guide icons in Cloud API responses are served from
`suuntoplusplugins.blob.core.windows.net`, and `cloudapi.suunto.com` is Azure API
Management. It is entirely plausible that the mobile app simply calls the
**documented** `cloudapi.suunto.com/v2/guides/*` with a subscription key embedded
in the APK.

If that holds, this whole track collapses: the wire format is already known (see
`cloud-api.md`), and the only unknown is how the app authenticates.

`scripts/analyze-apk.sh` tests exactly this in its first stage, in seconds,
without decompiling anything.

## Method

1. `scripts/pull-apk.sh` — pull the APK off the device. Preferred over a mirror:
   no anti-bot to work around, and it captures the exact build in use.
2. `scripts/analyze-apk.sh` — stage 1 string-scans the dex for
   `cloudapi.suunto.com`, `Ocp-Apim-Subscription-Key`, guide paths and guide DTO
   field names.
3. `scripts/analyze-apk.sh 2` — full `jadx` decompile, only if stage 1 leaves
   gaps. Retrofit `@POST("…")` annotations give exact paths; Kotlin
   `@SerialName` annotations give the DTO field names, types and nullability.
   This is *more* complete than traffic capture, because it covers fields no
   hand-driven flow happens to exercise.
4. Live capture, only to confirm payloads — see below.

## Live capture (only if static analysis leaves gaps)

Try **unrooted first**: `apk-mitm` repackages the APK to trust user CAs and strip
OkHttp pinning; sideload it and proxy through `mitmproxy`. Rooting the Pixel 9 Pro
XL needs a bootloader unlock, which **wipes the device** — don't pay that cost
until the cheap path has actually failed. Fallback is Magisk + a cert-fixer module
+ `frida-server`.

Risk: a re-signed APK can fail login if the app checks its own signature or
requires Play Integrity.

Flows worth driving: create a structured workout, edit it, pin it to a date,
delete it, sync to watch.

**Also capture the guide list and download traffic.** Runna is a Suunto Cloud API
partner and already syncs structured runs with pace targets into this account, so
those responses are known-good, professionally-generated guides in exactly the
shape we want to emit — a far better oracle than anything we could infer.

## Open questions

- [ ] Does the app use `cloudapi.suunto.com/v2/guides/*`, or a private path?
- [ ] If private: what host, what paths, what verbs?
- [ ] Which auth — `STTAuthorization`, an OAuth bearer, or a baked-in
      subscription key?
- [ ] Is `x-totp` required on guide writes, as it is on every other
      Sports-Tracker write?
- [ ] Is the payload the same `guide.json` schema, a zip, or a different DTO?
- [ ] How is calendar pinning expressed — `localDate`, or a separate call?

## Ground rules

Scope strictly to this account and this account's own data. The Cloud API path
has no terms-of-service question attached, which is the reason to prefer it the
moment a subscription key is available.

Nothing from `apk/` or `capture/` is ever committed — both are git-ignored, and
captures contain session keys and account identifiers.
