# Materialious Live 1.18.9-live.2 — feed-first verification

## User-visible changes

- Subscription feed first: All / Live now / Upcoming filters. Existing rows render without waiting for detail checks; only loaded video IDs are checked in the background.
- Details correct stale feed flags and LIVE/upcoming badges progressively. Filters use verified states; missing/malformed state or failed requests remain unverified, not offline.
- Four concurrent detail checks, 12-second per-request timeout, per-identity in-memory two-minute state cache. Filter toggles do not refetch completed checks.
- Refresh refetches feed page 1, resets pagination, then re-verifies details. Existing rows remain visible on refresh failure; retry is available.
- Additional pages are fetched only through **Load more** in every filter. Empty filtered results do not trigger a crawl of the feed history.
- Whole-channel discovery is retained as an optional **Full channel scan**. Opening that screen does not scan: the user must press **Start full scan**.
- Identity switches isolate feed and verification state; in-flight page operations are fenced, bounded and cancelled. Component teardown aborts its feed/detail requests.
- Existing API server, production web containers, accounts and streaming extractor were not changed.

## Executed checks

- `npm test`: **85 passed, 0 failed, 0 skipped**. Includes the pre-existing live-scanner regression suite and new feed-state/cache/filter/page tests.
- `npm run check`: **0 errors**, 59 existing Svelte warnings in 25 files.
- `npm run eslint`: **0 errors**, two existing unused-disable warnings outside this feature.
- Web build → `cap sync android` → JDK21 / SDK36 `./gradlew assembleDebug`: successful. Existing Gradle deprecation warnings remain.
- Real headless Chrome with isolated synthetic subscriptions/API fixtures, at 320/390/768/1440px: feed visible while detail responses are held; live false-negative and archive false-positive corrected; upcoming exclusion; failed details shown as unverified; filter toggles do not refetch details; refresh refetches feed and details; page2/page3 only on button press; empty filter does not auto-page; scanner idle until explicit Start. No page errors or horizontal overflow in the exercised states.
- Additional Chrome outage/race checks: initial failure recovers through retry; failed refresh preserves rows; refresh retry succeeds; refreshing during a pending page request restores a usable Load more button; navigation aborts a held feed request. All assertions passed, no browser page errors. The Python route harness logs cancellation of deliberately held routes during teardown; this is not an application page error.
- APK metadata: applicationId `us.materialio.app.livefork`, versionName `1.18.9-live.2`, versionCode **277**. arm64 and universal builds inspected with `aapt2`, signature verified with `apksigner`.
- Both APKs have the same signing certificate as live.1 (`dec9f0254ff5fc3b61b85aadc3b4bc7e4fa04ad381bf6b6e4c182717982f3aa7`), preserving the Android upgrade path. Final zipped bundles contain the feed filters, Load more/manual scan labels, isolated callback and proxy port; bundled native Node runtime present.

## Review follow-up

Independent specification and standards reviews found the original refresh only rechecked details, infinite scroll could crawl history when filters were empty, and recovery/identity races could strand loading state. These were corrected. Shared scope construction and favourite promotion now keep route and refresh paths aligned. A missing upcoming field stays unverified. Parent verification additionally caught and fixed an unused prop, missing feed-request teardown and the pagination→refresh loading race.

## Limits

- This revision's feed behavior was tested with **synthetic API data**, not a real user's account/feed. Previous live.1 public metadata integration is historical, not proof of this revision's authenticated native behavior.
- **No Android device/emulator connected**: installation, retained login/settings after update, authorization return and on-device playback remain unverified. This is a debug-signed personal trial, not an official production release.
- Default filters cover only the loaded feed. A broadcast missing from that feed cannot be discovered without the optional channel scan. Loaded-feed detail checking still scales with the number of loaded items, but does not block first rendering or crawl other channels.
- Client refresh cannot purge Invidious/companion caches; last-check time is response acquisition time, not proof of fresh YouTube extraction. No automatic continuous polling is claimed.
- Initial route loading has a bounded request and rejects late results for a changed identity; the component owns cancellation of its later feed/detail requests.
- Review suggestions to add a separate aggregate scan budget or globally re-sort appended pages were not adopted: explicit pagination bounds user-requested discovery and appended pages retain the existing feed-order behavior.

## Install / rollback

Install live.2 over the previous **Materialious Live** fork; its application ID and signing key are unchanged and versionCode increased. Do not uninstall first if you want to retain its local data. The official Materialious app remains separate. To stop using this feature, open the unchanged official app; no server migration/rollback is needed.

AI-assisted implementation/review via Hermes Agent and DeepSeek subagents. No upstream pull request submitted. `LIVE-NOW-VERIFICATION.md` documents the historical live.1 build; this file supersedes it for the feed-first revision.
