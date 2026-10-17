# Materialious Live — Android-first fork

This fork adds a **Live now** view for subscribed channels. It is not an official Materialious release.

## Scope

- Find candidates in subscribed channels' Streams pages, not only the merged subscription feed.
- Confirm video detail state before showing an item as live; upcoming and archived broadcasts do not belong in Live now.
- Preserve multiple simultaneous broadcasts from the same channel and deduplicate videos.
- Limit concurrent requests, support manual refresh and cancellation, and distinguish failed checks from confirmed offline channels.
- Show loading/progress, empty/no-subscription, partial failure, and last-check information.
- Open **Now live** directly from the main navigation or from the subscriptions screen. A failing merged feed does not prevent opening the live screen.
- Reuse existing video cards and playback. This does not replace or patch the streaming extractor.

## Android versus web

The Capacitor Android application packages the compiled Svelte web UI into the APK. The instance URL is an API/backend address, **not an address from which the application downloads its entire UI**.

For this client-side feature, installing the fork APK is sufficient. The existing Invidious server can remain in place. The same source also supports web builds, but the existing deployed Materialious web container is not automatically updated and does not need to be replaced for Android use.

## Installation and accounts

- Fork display name: **Materialious Live**.
- Application ID: `us.materialio.app.livefork` (official application can remain installed).
- Bundled Android Node proxy uses loopback port `3001`, separate from upstream's `3000`.
- Invidious Android login callback: `materialious-live-auth://` (avoids the official application's login callback).
- Choose the existing Invidious instance in the application setup and authorize the existing Invidious account. This enables access to its subscriptions.
- Existing Materialious backend account connections remain supported through upstream settings. Materialious and Invidious account subscriptions are not assumed to be identical.
- The distributable is a debug-signed personal trial APK, not an official or production-signed update. Keep the same signing key for subsequent updates. No credentials are embedded in the APK.

## Freshness limits

A check timestamp records when the client obtained a response. It is not proof that YouTube was re-extracted at that instant. Manual refresh bypasses this feature's local cache; it cannot purge Invidious/companion's server caches.

The live server has demonstrated inconsistent list and detail `liveNow` values. Detail verification handles the observed list false-negative, but stale detail responses can still delay newly started/ended broadcasts. Request failure must be shown as incomplete verification, never as evidence that all channels are offline.

Channel candidate discovery is bounded rather than an unlimited crawl. See the feature's on-screen coverage note for the exact limit. A channel with sufficiently many scheduled items may require a later pagination enhancement.

## Local build

From `materialious/`, using Node 24 or newer:

```sh
npm ci
npm ci --prefix static/nodejsAndroid
npm run check
npm run test:live
npm run build
npx cap sync android
```

Configure `materialious/android/local.properties` with the local Android SDK path (not committed). With JDK 21 and Android SDK 36 installed:

```sh
cd android
./gradlew assembleDebug
```

APK outputs are under `materialious/android/app/build/outputs/apk/debug/`. Release artifacts and verification evidence will be listed with the fork release.

## Upstream and licensing

Upstream: https://github.com/Materialious/Materialious (historical URL: WardPearce/Materialious). Keep the existing license and attribution. Changes are isolated on `feat/subscriptions-live-now`; no pull request to upstream is created automatically.
