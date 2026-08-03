# Suunto Cloud API — Guides

Extracted from Suunto's `SuuntoplusGuideCloudAPI.pdf` (the PDF renders as binary in
most readers; the text was recovered by decompressing its content streams) and
cross-checked against the field reference at
<https://apizone.suunto.com/suuntoplus-guide-description>.

This is the *documented, sanctioned* path. It is what `CloudApiGuideBackend`
targets. It is unrelated to the Sports-Tracker API that `suuntool` uses.

## Auth

- OAuth2 **authorization_code**
  - authorize: `https://cloudapi-oauth.suunto.com/oauth/authorize`
  - token: `https://cloudapi-oauth.suunto.com/oauth/token`
  - scope: `workout`; access tokens expire in 86400s (24h)
- Every request additionally needs `Ocp-Apim-Subscription-Key`, obtained by
  subscribing to the API in the developer portal ("Your subscriptions").

Partner approval is a *separate* thing, and is only required to publish guides to
other people's watches or to the SuuntoPlus App Store. Pushing to your own
account should not need it.

## Operations

| Purpose | Method | Path |
|---|---|---|
| Create | `POST` | `https://cloudapi.suunto.com/v2/guides/files` |
| List | `GET` | `/v2/guides/items` |
| Update file | `PUT` | `/v2/guides/files/{id}` |
| Download | `GET` | `/v2/guides/files/{id}` |
| Delete | `DELETE` | `/v2/guides/files/{id}` |

Create and update send `Content-Type: application/zip` with the zip as the **raw
binary body** — not multipart.

`GET /v2/guides/items` takes `offset` (default 0), `limit` (default 50), and
`fileSince` (epoch ms; returns guides whose `fileModificationTime` is >= it).
Results are sorted by `fileModificationTime` descending, and **only include guides
created by your own application**.

`PUT` updates guide *content only*. It does not change `pinned`, `username` or
`id`.

## The zip

Three files, no directory nesting:

- `manifest.json` — `{name, type: "sequence", owner, description}`.
  **`owner` must match your application name in the OAuth settings**, or the
  upload is rejected.
- `guide.json` — the workout itself. See `src/domain/guide.ts` for the model and
  `src/domain/guide-schema.ts` for the validator.
- `icon.png` — 300×300. May be served from a public URL, so it must not contain
  anything private.

## Responses

`201 Created` on create, `200 OK` on update, both returning:

```json
{
  "error": null,
  "payload": {
    "id": "oxrgorwo",
    "username": "…",
    "modificationTime": 1634031291729,
    "fileModificationTime": 1634031291729,
    "name": "…", "description": "…", "shortDescription": "…",
    "owner": "…", "url": "…", "iconUrl": "https://suuntoplusplugins.blob.core.windows.net/…",
    "type": "sequence", "activities": [3], "localDate": "2021-05-28",
    "usage": "workout", "pinned": false, "externalId": "123456789"
  },
  "metadata": { "ts": "1634031291785" }
}
```

Errors:

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error":{"description":"Invalid step type: 'notfication'"}}` | Schema violation. One unstructured string, no path to the offending step — which is why we validate locally first. |
| 409 | `{"error":{"description":"Conflict"}}` | An existing guide already has this `externalId`. |
| 404 | — | Missing, owned by another user, or created by a different partner. |

## Why `externalId` matters

It is a server-side idempotency key. Pushing the same workout twice returns 409
rather than creating a duplicate, which makes a sync pipeline safe to re-run
without any local state beyond an `externalId → guide id` map for updates.

`src/compile/external-id.ts` derives it deterministically from date + title +
step structure, so the same session always produces the same id.

## Gotchas the schema does not spell out

- Pace and speed targets are **metres per second**. A pace range inverts when
  converted: 4:15–4:25 /km is `{min: 3.77, max: 3.92}`.
- `targetCadence` is **Hertz**. 180 spm is `3.0`.
- There is no percentage representation — `%HRmax` and `%FTP` must be resolved to
  absolutes before serialising.
- **Nested repeats are not allowed.**
- Step `title` is capped at **13 characters**.
- The documented character set excludes `@`, but Suunto's own sample guide uses
  it in a text field. We allow it; see the note in `src/domain/limits.ts`.
