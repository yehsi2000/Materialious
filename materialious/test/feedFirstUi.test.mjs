import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const FEED_FIRST_KEYS = [
	'filterAll',
	'filterLive',
	'filterUpcoming',
	'feedScope',
	'feedChecking',
	'feedUnverified',
	'noFilterMatch',
	'startScan',
	'scanScope'
];

test('the subscriptions page is feed-first: it filters the loaded feed before any scan', () => {
	const page = source('src/routes/(app)/subscriptions/+page.svelte');

	assert.match(page, /checkFeedVideos/, 'loaded feed ids must be checked in the background');
	assert.match(
		page,
		/filterFeedItems/,
		'the All / Live now / Upcoming filter must run on loaded items'
	);
	for (const key of ['filterAll', 'filterLive', 'filterUpcoming']) {
		assert.match(page, new RegExp(`subscriptionsLive\\.${key}`), `${key} control is missing`);
	}
	// The feed itself is never replaced by the whole-channel scan.
	assert.doesNotMatch(page, /scanLive\(/);
});

test('the feed is keyed by identity so a late route load cannot leak across scopes', () => {
	const pageTs = source('src/routes/(app)/subscriptions/+page.ts');
	const page = source('src/routes/(app)/subscriptions/+page.svelte');

	assert.match(pageTs, /buildFeedScopeKey/);
	assert.match(pageTs, /feedCacheSlot/);
	assert.match(page, /feedCacheSlot/);
	assert.doesNotMatch(
		pageTs,
		/feedCacheStore\.set\(\{[\s\S]*subscription:/,
		'must use the scoped slot helper'
	);
});

test('the full-channel scan is manual: it never runs on mount', () => {
	const live = source('src/routes/(app)/subscriptions/live/+page.svelte');

	assert.match(live, /subscriptionsLive\.startScan/, 'an explicit start control is required');
	assert.match(
		live,
		/let started(?::\s*\w+)?\s*=\s*\$state\(false\)/,
		'the scan must be gated behind a user action'
	);
	assert.doesNotMatch(live, /onMount\(/, 'no scan may start on mount');
	assert.doesNotMatch(
		live,
		/\$effect\(\s*\(\)\s*=>\s*\{[^}]*runScan/,
		'a mount-time effect must not trigger a scan'
	);
});

test('feed-first labels exist in English and Korean', () => {
	for (const locale of ['en', 'ko']) {
		const json = JSON.parse(source(`src/lib/i18n/locales/${locale}.json`));
		for (const key of FEED_FIRST_KEYS) {
			assert.ok(
				typeof json.subscriptionsLive?.[key] === 'string' && json.subscriptionsLive[key].length > 0,
				`${locale}.subscriptionsLive.${key} is missing`
			);
		}
	}
});

test('the thumbnail can show an upcoming badge without faking a live badge', () => {
	const thumbnail = source('src/lib/components/thumbnail/VideoThumbnail.svelte');
	assert.match(thumbnail, /thumbnail\.upcoming/);
	assert.match(thumbnail, /thumbnail\.live/);
	const json = JSON.parse(source('src/lib/i18n/locales/en.json'));
	const ko = JSON.parse(source('src/lib/i18n/locales/ko.json'));
	assert.ok(json.thumbnail?.upcoming, 'en.thumbnail.upcoming is missing');
	assert.ok(ko.thumbnail?.upcoming, 'ko.thumbnail.upcoming is missing');
});
