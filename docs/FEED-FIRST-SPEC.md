# Feed-first subscriptions — 1.18.9-live.2

User-approved scope: fast subscription-feed filters by default, manual whole-channel scan as an auxiliary action. Baseline commit: `7cc1113d57260ca0d9b9bcc7fbf6cae39ac9458f`.

## Acceptance criteria

1. Show existing subscription feed immediately; do not wait for detail-state checks or scan subscribed channel pages automatically.
2. Provide All / Live now / Upcoming filters on the subscriptions page. Filter scope is the loaded feed, not every subscribed channel's broadcasts.
3. Check only loaded feed video IDs in the background, bounded concurrency/timeouts, progressively correcting stale/missing live/upcoming flags and card badges. Do not restrict discovery to a list flag or zero duration; these may be wrong.
4. Load more feed pages in every filter, including empty filtered results; newly loaded IDs are checked and duplicates removed. Do not let filtered emptiness end pagination.
5. Cancellation and account/backend/instance isolation prevent stale asynchronous results or cached video state from crossing identities. Navigation cancels pending work. Filter changes should not refetch already-checked IDs unnecessarily.
6. Failed or malformed detail responses remain unverified, never evidence of offline. Indicate progress/partial failures and the feed-only coverage limit. Manual refresh retries with fresh local state; it cannot purge server caches.
7. Retain whole-channel scanning as an explicit, optional manual tool. Opening that tool must not start a scan on mount.
8. Preserve existing card navigation/playback, official-app coexistence, fork application ID/callback/proxy, and server/account data. No backend changes.
9. Produce a new installable debug APK with increased version code using the same signing key. Disclose the absence of actual Android device acceptance testing if none is connected.

## Verification

Use failing behavior tests before implementation, focused tests during work, and final full tests/typecheck/lint/build. Exercise the actual UI with an isolated synthetic account/fixture API in Chrome: initial rendering while details are held pending; correcting list/detail disagreement; upcoming/archive exclusion; failure; pagination when the filtered page is empty; no channel requests until manual scan; refresh and narrow/mobile layout. Fixture results must not be described as a real user's feed or actual live metadata. Inspect final synchronized APK assets/identity/version/signature.
