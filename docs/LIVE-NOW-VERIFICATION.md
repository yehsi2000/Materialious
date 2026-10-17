# Materialious Live 1.18.9-live.1 — verification

## Implemented

- `/subscriptions/live`: subscribed channels → first Streams page (up to 15 candidates per channel) → individual video details → only `liveNow === true` and not `isUpcoming`.
- Direct navigation entry and subscriptions-page button. A merged subscription-feed outage does not log the account out unless the server explicitly rejects authentication (401/403).
- Four concurrent requests per phase, 12-second per-request timeout, cancellation on navigation/account/backend changes, video/channel deduplication, multiple broadcasts per channel.
- In-memory, account/engine/instance-scoped two-minute results cache; manual refresh re-fetches. Partial and malformed responses are not interpreted as offline/no subscriptions.
- Progress, last response-check time, coverage/caching caveat and partial-failure messages. English and Korean feature labels (other Korean UI strings fall back to English).
- Companion fork relative HLS URLs are resolved against the configured Invidious server, not the Android WebView origin.
- Separate Android identity `us.materialio.app.livefork`, display name `Materialious Live`, custom authorization callback `materialious-live-auth://`, local Node proxy port 3001.

## Executed checks

- Node 24 `npm test`: **43 passed, 0 failed**, including timeout/abort, malformed responses, list/detail disagreement, upcoming/archive exclusion, deduplication, multiple broadcasts, concurrency, cache isolation, HLS URL resolution and native configuration checks.
- `npm run check`: **0 errors**, 59 inherited Svelte warnings in 25 files. The upstream baseline had the same warning count.
- `npm run eslint`: **0 errors**, two inherited unused-disable warnings.
- `npm run build` → `npx cap sync android` → JDK 21 / Android SDK 36 `./gradlew assembleDebug`: successful.
- APK inspected with `aapt2` and `apksigner`: correct fork application ID/label/version, arm64 native runtime present, APK v2 signature valid. Bundled assets contain the new route/labels, callback and port. This is the final feature build, not the earlier baseline APK.
- Actual Chrome rendering at 320, 390, 768, 1024 and 1440 pixel widths: no horizontal overflow or page errors in the exercised cases. Fixtures explicitly exercise empty subscriptions, archive/upcoming exclusion, channel failure and manual refresh.
- Real public Invidious integration: a synthetic test subscription list (not a user's account) points to NBC News. Channel Streams and video-detail responses are fetched unchanged from the configured self-hosted Invidious instance through a test relay, to avoid the local browser development origin's CORS restriction. `KQT3uyD6jQQ` is detected and rendered with a LIVE badge; manual refresh makes another real scan. This is real public metadata, not a synthesized live response.
- The first historical test broadcast, `2aY6d7tMDOs`, ended during development. Its updated detail response reports not-live and is correctly excluded; this was not treated as a passing live-display test.
- The bundled native Node proxy was separately started on port 3001 and returned HTTP 200 both for its health endpoint and an actual Invidious API request.

## Review follow-up

Standards and specification reviewers identified early implementation gaps: subscriptions request lacked timeout/cancellation, progress contract lagged the page, native tests were not in `npm test`, live view needed an independent navigation entry, and backend/account cache scope was too coarse. These were corrected and covered by the final checks. Additional response-validation, cancellation listener cleanup and first-page coverage notes were added. Generated contributor metadata was excluded from the changes.

## Not verified / remaining limits

- **No Android device or emulator was connected.** Native installation, browser-to-app authorization return and actual on-device playback remain user acceptance checks. Browser UI/API checks are not presented as Android runtime tests.
- The Invidious/companion server can cache old state. Manual client refresh does not purge those server caches. “Last checked” is the response acquisition time, not proof of a fresh YouTube extraction.
- Discovery is a first-page sample, not an unlimited scan. Channels with additional pages/candidates are explicitly reported as potentially incomplete.
- Requests through a non-cooperative direct YouTube adapter can outlive their caller's cancellation; the scanner stops waiting and discards results. The tested primary path is Invidious's cancellable HTTP adapter.
- The APK is debug-signed for personal trial, not a production-signed upstream update. Keep the same local signing key for future fork updates. It installs separately and requires its own initial login/settings.
- Existing web containers, Invidious/companion configuration and account data were not changed by this feature implementation.

## Rollback

Close/uninstall **Materialious Live** and use the unchanged official application. No backend migration or database rollback is needed. Do not uninstall the official application to install this fork.

## AI assistance disclosure

Implementation and review were AI-assisted using Hermes Agent, OpenAI Codex and DeepSeek subagents with local Node/Gradle/Chrome tests. No human device acceptance verification is claimed. No upstream PR was submitted.
