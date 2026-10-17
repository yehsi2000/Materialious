import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveCache, buildLiveCacheKey } from '../src/lib/subscriptions/liveCache.ts';
import type { LiveScanResult } from '../src/lib/subscriptions/live.ts';

function result(videoIds: string[]): LiveScanResult {
	return {
		lives: videoIds.map((videoId) => ({ videoId, type: 'video', liveNow: true })) as never,
		channelsChecked: 1,
		channelFailures: [],
		videoFailures: [],
		candidateCount: videoIds.length,
		truncatedChannels: [],
		lastChecked: 1,
		aborted: false
	};
}

test('stores and returns a result for a key', () => {
	const cache = createLiveCache(1000);
	assert.equal(cache.get('a'), undefined);

	const stored = result(['v1']);
	cache.set('a', stored);
	assert.equal(cache.get('a'), stored);
});

test('keeps entries isolated per key', () => {
	const cache = createLiveCache(1000);
	cache.set('instance-a::', result(['v1']));
	cache.set('instance-b::', result(['v2']));

	assert.deepEqual(
		cache.get('instance-a::')?.lives.map((v) => v.videoId),
		['v1']
	);
	assert.deepEqual(
		cache.get('instance-b::')?.lives.map((v) => v.videoId),
		['v2']
	);
	assert.equal(cache.get('instance-c::'), undefined);
});

test('expires entries after the ttl', () => {
	let now = 1000;
	const cache = createLiveCache(500, () => now);
	cache.set('a', result(['v1']));

	assert.ok(cache.get('a'));

	now = 1499;
	assert.ok(cache.get('a'), 'still fresh just before ttl');

	now = 1500;
	assert.equal(cache.get('a'), undefined, 'expired at ttl');
});

test('clear empties every key', () => {
	const cache = createLiveCache(1000);
	cache.set('a', result(['v1']));
	cache.set('b', result(['v2']));
	cache.clear();

	assert.equal(cache.get('a'), undefined);
	assert.equal(cache.get('b'), undefined);
});

test('scope keys isolate engines and do not collide on separator characters', () => {
	assert.notEqual(
		buildLiveCacheKey({ instance: 'same', engine: 'ivg' }),
		buildLiveCacheKey({ instance: 'same', engine: 'yt' })
	);
	assert.notEqual(
		buildLiveCacheKey({ instance: 'a::b', backend: 'c' }),
		buildLiveCacheKey({ instance: 'a', backend: 'b::c' })
	);
});

test('builds distinct cache keys per instance, backend and account', () => {
	const base = buildLiveCacheKey({ instance: 'https://invidious.example' });
	const otherInstance = buildLiveCacheKey({ instance: 'https://other.example' });
	const withAccount = buildLiveCacheKey({
		instance: 'https://invidious.example',
		account: 'token-1'
	});
	const withAccount2 = buildLiveCacheKey({
		instance: 'https://invidious.example',
		account: 'token-2'
	});
	const withBackend = buildLiveCacheKey({ backend: 'https://backend.example' });

	assert.equal(base, buildLiveCacheKey({ instance: 'https://invidious.example' }));
	assert.notEqual(base, otherInstance);
	assert.notEqual(base, withAccount);
	assert.notEqual(withAccount, withAccount2);
	assert.notEqual(base, withBackend);
});
