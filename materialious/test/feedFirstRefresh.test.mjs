import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const page = () => source('src/routes/(app)/subscriptions/+page.svelte');
const locales = () => ['en', 'ko'];

test('pagination is explicit: no auto-loading infinite scroll in any filter mode', () => {
	const src = page();

	assert.doesNotMatch(
		src,
		/svelte-infinite-loading/,
		'the scroll-triggered infinite loader must be removed'
	);
	assert.doesNotMatch(
		src,
		/identifier=\{filter\}/,
		'the per-filter infinite loader could crawl the whole history'
	);
	assert.match(src, /subscriptionsLive\.loadMore/, 'an explicit Load more control is required');
});

test('refresh refetches feed page 1 (not only detail checks) and resets pagination', () => {
	const src = page();

	// A refresh must issue a page-1 feed request through the bounded runner.
	assert.match(src, /fetchFeedPage\(\s*1\b/, 'refresh must refetch feed page 1');
	assert.match(src, /FEED_PAGE_SIZE/, 'the shared feed page size must be used');
	// Pagination state is reset so a refresh does not continue from page N.
	assert.match(src, /currentPage\s*=\s*1/, 'refresh must reset the page counter');
	// Requests must share the bounded-timeout runner.
	assert.match(src, /runRequest/, 'feed requests must go through the bounded timeout runner');
	// Abort wiring for navigation/identity changes.
	assert.match(src, /\.abort\(\)/, 'in-flight requests must be abortable');
});

test('feed requests pass an abort signal so navigation can cancel them', () => {
	const src = page();
	assert.match(src, /getFeed\([^)]*signal/, 'getFeed must receive a RequestInit signal');
	assert.match(src, /signal:\s*\w+/, 'the request signal must be threaded into RequestInit');
});

test('navigation aborts both feed loading and detail checks', () => {
	assert.match(page(), /onDestroy\(\s*\(\)\s*=>\s*\{[\s\S]*?feedController\?\.abort\(\)/);
	assert.match(source('src/routes/(app)/subscriptions/+page.ts'), /runRequest\(/);
});

test('load-more and refresh expose complete / error / retry states', () => {
	const src = page();
	for (const key of ['loadMore', 'loadingMore', 'noMore', 'retry']) {
		assert.match(src, new RegExp(`subscriptionsLive\\.${key}`), `${key} state is missing`);
	}
});

test('pagination labels exist in English and Korean, with a Korean Load more', () => {
	for (const locale of locales()) {
		const json = JSON.parse(source(`src/lib/i18n/locales/${locale}.json`));
		for (const key of ['loadMore', 'loadingMore', 'noMore', 'retry']) {
			assert.ok(
				typeof json.subscriptionsLive?.[key] === 'string' && json.subscriptionsLive[key].length > 0,
				`${locale}.subscriptionsLive.${key} is missing`
			);
		}
	}
	const ko = JSON.parse(source('src/lib/i18n/locales/ko.json'));
	assert.match(
		ko.subscriptionsLive.loadMore,
		/더 불러오기/,
		'the Korean Load more label is required'
	);
});

test('the empty-filter hint points at Load more, not scrolling', () => {
	for (const locale of locales()) {
		const json = JSON.parse(source(`src/lib/i18n/locales/${locale}.json`));
		assert.doesNotMatch(
			json.subscriptionsLive.noFilterMatch,
			/scroll|스크롤/i,
			`${locale}.subscriptionsLive.noFilterMatch still tells the user to scroll`
		);
	}
});
