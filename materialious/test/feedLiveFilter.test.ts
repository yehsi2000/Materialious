import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	resolveLiveStateFromDetail,
	applyLiveStateToItem,
	filterFeedItems,
	dedupeFeedItems,
	resolveItemState,
	buildFeedScopeKey
} from '../src/lib/subscriptions/feedLive.ts';

// --- detail -> live state ---------------------------------------------------

test('a live detail is classified live, an upcoming detail upcoming, and the rest offline', () => {
	assert.equal(resolveLiveStateFromDetail({ liveNow: true, isUpcoming: false } as never), 'live');
	assert.equal(
		resolveLiveStateFromDetail({ liveNow: true, isUpcoming: true } as never),
		'upcoming'
	);
	assert.equal(
		resolveLiveStateFromDetail({ liveNow: false, isUpcoming: true } as never),
		'upcoming'
	);
	assert.equal(
		resolveLiveStateFromDetail({ liveNow: false, isUpcoming: false } as never),
		'offline'
	);
});

test('a detail without a boolean liveNow stays unknown, never offline', () => {
	assert.equal(resolveLiveStateFromDetail({} as never), 'unknown');
	assert.equal(resolveLiveStateFromDetail({ liveNow: 'true' } as never), 'unknown');
});

// --- applying state to a card ----------------------------------------------

test('missing or invalid upcoming state is unverified rather than a confirmed live or offline', () => {
	assert.equal(resolveLiveStateFromDetail({ liveNow: true }), 'unknown');
	assert.equal(resolveLiveStateFromDetail({ liveNow: false }), 'unknown');
	assert.equal(resolveLiveStateFromDetail({ liveNow: true, isUpcoming: 'false' }), 'unknown');
});

test('a confirmed live item becomes a live stream card while keeping every other field', () => {
	const item = {
		videoId: 'v1',
		type: 'video',
		title: 'Live soon',
		lengthSeconds: 0,
		liveNow: false,
		isUpcoming: false
	};

	const applied = applyLiveStateToItem(item as never, 'live') as Record<string, unknown>;

	assert.equal(applied.type, 'stream');
	assert.equal(applied.liveNow, true);
	assert.equal(applied.isUpcoming, false);
	assert.equal(
		applied.liveVideo,
		true,
		'the existing thumbnail needs liveVideo for its LIVE badge'
	);
	assert.equal(applied.title, 'Live soon');
	assert.equal(applied.lengthSeconds, 0);
	// The source item is untouched.
	assert.equal(item.type, 'video');
	assert.equal(item.liveNow, false);
});

test('an upcoming item never carries a LIVE badge', () => {
	const applied = applyLiveStateToItem(
		{ videoId: 'u1', type: 'video', liveNow: true, isUpcoming: false } as never,
		'upcoming'
	) as Record<string, unknown>;

	assert.equal(applied.isUpcoming, true);
	assert.equal(applied.liveNow, false);
	assert.equal(Boolean(applied.liveVideo), false);
});

test('an offline item clears stale live flags and the LIVE badge', () => {
	const applied = applyLiveStateToItem(
		{ videoId: 'o1', type: 'stream', liveNow: true, isUpcoming: false, liveVideo: true } as never,
		'offline'
	) as Record<string, unknown>;

	assert.equal(applied.liveNow, false);
	assert.equal(applied.isUpcoming, false);
	assert.equal(Boolean(applied.liveVideo), false);
});

test('an unverified item is left exactly as the feed listed it', () => {
	const item = { videoId: 'x1', type: 'stream', liveNow: true, isUpcoming: false, title: 'stale' };
	const applied = applyLiveStateToItem(item as never, 'unknown');

	assert.equal(applied, item, 'unverified must not be rewritten nor mislabelled offline');
});

// --- resolving + filtering --------------------------------------------------

test('resolveItemState falls back to unknown for ids with no verified state', () => {
	assert.equal(
		resolveItemState('v1', () => undefined),
		'unknown'
	);
	assert.equal(
		resolveItemState('v1', () => 'live'),
		'live'
	);
});

test('the live and upcoming filters only trust verified state, never the stale list flag', () => {
	const items = [
		{ videoId: 'live1', type: 'stream', liveNow: false },
		{ videoId: 'up1', type: 'stream', liveNow: true }, // stale list flag says live
		{ videoId: 'off1', type: 'stream', liveNow: true }, // stale list flag says live
		{ videoId: 'unknown1', type: 'stream' }
	];
	const verified: Record<string, string> = {
		live1: 'live',
		up1: 'upcoming',
		off1: 'offline'
	};
	const stateOf = (videoId: string) => verified[videoId];

	assert.deepEqual(
		filterFeedItems(items as never, 'live', stateOf).map((i) => (i as { videoId: string }).videoId),
		['live1']
	);
	assert.deepEqual(
		filterFeedItems(items as never, 'upcoming', stateOf).map(
			(i) => (i as { videoId: string }).videoId
		),
		['up1']
	);
});

test('the all filter keeps every item in feed order, including unverified ones', () => {
	const items = [{ videoId: 'a' }, { videoId: 'b' }, { videoId: 'c' }];

	assert.deepEqual(
		filterFeedItems(items as never, 'all', () => undefined).map(
			(i) => (i as { videoId: string }).videoId
		),
		['a', 'b', 'c']
	);
});

test('filters never mutate the loaded feed', () => {
	const items = [{ videoId: 'a' }, { videoId: 'b' }];
	filterFeedItems(items as never, 'live', () => 'live');
	assert.deepEqual(items, [{ videoId: 'a' }, { videoId: 'b' }]);
});

// --- dedupe -----------------------------------------------------------------

test('dedupeFeedItems drops repeated video ids while preserving the first-seen order', () => {
	const items = [
		{ videoId: 'a', title: 'first' },
		{ videoId: 'b' },
		{ videoId: 'a', title: 'later duplicate' },
		{ videoId: 'c' }
	];

	const deduped = dedupeFeedItems(items as never) as { videoId: string; title?: string }[];

	assert.deepEqual(
		deduped.map((i) => i.videoId),
		['a', 'b', 'c']
	);
	assert.equal(deduped[0].title, 'first');
});

// --- feed scope binding -----------------------------------------------------

test('the feed scope key isolates instance, backend and account identities', () => {
	const base = buildFeedScopeKey({ instance: 'https://a.example' });
	assert.equal(base, buildFeedScopeKey({ instance: 'https://a.example' }));
	assert.notEqual(base, buildFeedScopeKey({ instance: 'https://b.example' }));
	assert.notEqual(base, buildFeedScopeKey({ instance: 'https://a.example', engine: 'yt' }));
	assert.notEqual(base, buildFeedScopeKey({ instance: 'https://a.example', account: 'token-1' }));
	assert.notEqual(
		buildFeedScopeKey({ instance: 'https://a.example', account: 'token-1' }),
		buildFeedScopeKey({ instance: 'https://a.example', account: 'token-2' })
	);
	assert.notEqual(
		base,
		buildFeedScopeKey({ instance: 'https://a.example', backend: 'https://backend.example' })
	);
});
