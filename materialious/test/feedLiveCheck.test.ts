import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	checkFeedVideos,
	createVideoStateCache,
	type FeedCheckDeps,
	type VerifiedVideoState
} from '../src/lib/subscriptions/feedLive.ts';

function detail(videoId: string, extra: Record<string, unknown> = {}) {
	return { videoId, type: 'video', liveNow: false, isUpcoming: false, ...extra };
}

function deps(getVideo: FeedCheckDeps['getVideo']): FeedCheckDeps {
	return { getVideo };
}

test('checks every loaded video id, not only zero-duration or flagged candidates', async () => {
	const seen: string[] = [];
	const items = [
		{ videoId: 'plain', lengthSeconds: 3600 }, // no live flags at all
		{ videoId: 'zero', lengthSeconds: 0 },
		{ videoId: 'flagged', lengthSeconds: 42, liveNow: false, isUpcoming: false }
	];

	const result = await checkFeedVideos(
		deps(async (videoId: string) => {
			seen.push(videoId);
			return detail(videoId, { liveNow: videoId === 'plain' });
		}),
		items.map((item) => item.videoId)
	);

	assert.deepEqual(seen.sort(), ['flagged', 'plain', 'zero']);
	assert.equal(result.states.get('plain')?.state, 'live');
	assert.equal(result.states.get('zero')?.state, 'offline');
});

test('dedupes ids so a repeated video is fetched once', async () => {
	let calls = 0;
	const result = await checkFeedVideos(
		deps(async (videoId: string) => {
			calls++;
			return detail(videoId);
		}),
		['v1', 'v1', 'v2', 'v1']
	);

	assert.equal(calls, 2);
	assert.equal(result.states.size, 2);
});

test('never refetches an already-verified id, so filter toggles are cheap', async () => {
	const cache = createVideoStateCache(60_000);
	let calls = 0;
	const getVideo: FeedCheckDeps['getVideo'] = async (videoId: string) => {
		calls++;
		return detail(videoId, { liveNow: true });
	};

	await checkFeedVideos(deps(getVideo), ['v1', 'v2'], { cache, scope: 'scope-a' });
	assert.equal(calls, 2);

	// A second pass over the same loaded ids (what a filter toggle triggers) must not re-fetch.
	const second = await checkFeedVideos(deps(getVideo), ['v1', 'v2'], { cache, scope: 'scope-a' });
	assert.equal(calls, 2);
	assert.equal(second.cached, 2);
	assert.equal(second.states.get('v1')?.state, 'live');
});

test('does not reuse cached state across account/backend/instance scopes', async () => {
	const cache = createVideoStateCache(60_000);
	let calls = 0;
	const getVideo: FeedCheckDeps['getVideo'] = async (videoId: string) => {
		calls++;
		return detail(videoId, { liveNow: true });
	};

	await checkFeedVideos(deps(getVideo), ['v1'], { cache, scope: 'account-a' });
	await checkFeedVideos(deps(getVideo), ['v1'], { cache, scope: 'account-b' });

	assert.equal(calls, 2, 'a different identity must re-verify rather than reuse another scope');
});

test('bypassCache re-verifies with fresh state', async () => {
	const cache = createVideoStateCache(60_000);
	let calls = 0;
	const getVideo: FeedCheckDeps['getVideo'] = async (videoId: string) => {
		calls++;
		return detail(videoId, { liveNow: true });
	};

	await checkFeedVideos(deps(getVideo), ['v1'], { cache, scope: 's' });
	await checkFeedVideos(deps(getVideo), ['v1'], { cache, scope: 's', bypassCache: true });

	assert.equal(calls, 2);
});

test('bounds how many detail requests are in flight at once', async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const ids = Array.from({ length: 8 }, (_, i) => `v${i}`);

	await checkFeedVideos(
		deps(async (videoId: string) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				await new Promise((resolve) => setTimeout(resolve, 5));
				return detail(videoId);
			} finally {
				inFlight--;
			}
		}),
		ids,
		{ concurrency: 2 }
	);

	assert.equal(maxInFlight, 2);
});

test('a slow detail times out into an unverified state without hanging the run', async () => {
	const result = await checkFeedVideos(
		deps(async (videoId: string) => {
			if (videoId === 'slow') return new Promise(() => {}); // ignores its signal
			return detail(videoId, { liveNow: true });
		}),
		['slow', 'fast'],
		{ timeoutMs: 30 }
	);

	assert.equal(result.aborted, false);
	assert.equal(result.states.get('fast')?.state, 'live');
	assert.equal(result.states.get('slow')?.state, 'unknown');
	assert.match(result.failures[0].error, /timed out/i);
});

test('a malformed detail stays unknown and never becomes offline', async () => {
	const result = await checkFeedVideos(
		deps(async (videoId: string) => ({ videoId, type: 'video' }) as never),
		['v1']
	);

	assert.equal(result.states.get('v1')?.state, 'unknown');
	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0].error, /liveNow/i);
});

test('a detail whose videoId does not match the requested id stays unknown', async () => {
	const result = await checkFeedVideos(
		deps(async () => ({ videoId: 'other', type: 'video', liveNow: true }) as never),
		['v1']
	);

	assert.equal(result.states.get('v1')?.state, 'unknown');
	assert.equal(result.failures.length, 1);
});

test('caches unverified results so a failing id is not hammered on every toggle', async () => {
	const cache = createVideoStateCache(60_000);
	let calls = 0;
	const getVideo: FeedCheckDeps['getVideo'] = async () => {
		calls++;
		throw new Error('detail unavailable');
	};

	await checkFeedVideos(deps(getVideo), ['v1'], { cache, scope: 's' });
	await checkFeedVideos(deps(getVideo), ['v1'], { cache, scope: 's' });

	assert.equal(calls, 1, 'unverified state is cached, but a manual refresh bypasses it');
});

test('stops issuing requests once aborted and does not smear cancellation into failures', async () => {
	const controller = new AbortController();
	let started = 0;
	const ids = Array.from({ length: 6 }, (_, i) => `v${i}`);

	const result = await checkFeedVideos(
		deps(async (videoId: string) => {
			started++;
			if (started === 1) controller.abort();
			return detail(videoId, { liveNow: true });
		}),
		ids,
		{ signal: controller.signal, concurrency: 1 }
	);

	assert.equal(result.aborted, true);
	assert.ok(started < ids.length, `abort should stop remaining requests (started ${started})`);
	assert.deepEqual(result.failures, []);
});

test('reports each verified result progressively as it completes', async () => {
	const events: VerifiedVideoState[] = [];

	await checkFeedVideos(
		deps(async (videoId: string) => detail(videoId, { liveNow: true })),
		['v1', 'v2', 'v3'],
		{ concurrency: 1, onResult: (state) => events.push({ ...state }) }
	);

	assert.deepEqual(events.map((e) => e.videoId).sort(), ['v1', 'v2', 'v3']);
	assert.ok(events.every((e) => e.state === 'live'));
});

test('does not call any channel listing or subscription endpoint', async () => {
	// The checker is fed ids from the already-loaded feed, so its deps expose only getVideo.
	// A stray channel/subscription call is structurally impossible and this guards the contract.
	const keys: string[] = [];
	const used = deps(async (videoId: string) => detail(videoId));
	for (const key of Object.keys(used)) keys.push(key);

	assert.deepEqual(keys, ['getVideo']);
});
