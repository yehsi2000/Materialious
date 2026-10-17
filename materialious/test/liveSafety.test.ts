import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import {
	scanLive,
	mergeSignals,
	mergeSignalsWithCleanup,
	type LiveScanDeps
} from '../src/lib/subscriptions/live.ts';

function live(videoId: string) {
	return { videoId, type: 'video', liveNow: true, isUpcoming: false };
}

// --- abort before the entry request -----------------------------------------

test('does not call getSubscriptions when the request is already aborted', async () => {
	const controller = new AbortController();
	controller.abort(new Error('pre-aborted'));

	let subsCalls = 0;
	const deps: LiveScanDeps = {
		getSubscriptions: async () => {
			subsCalls++;
			return [{ author: 'A', authorId: 'c1' }];
		},
		getChannelContent: async () => {
			throw new Error('must not be called');
		},
		getVideo: async () => {
			throw new Error('must not be called');
		}
	};

	const result = await scanLive(deps, { signal: controller.signal });

	assert.equal(subsCalls, 0);
	assert.equal(result.aborted, true);
	assert.deepEqual(result.lives, []);
	assert.equal(result.channelsTotal, 0);
});

// --- subscriptions abort vs timeout -----------------------------------------

test('a subscriptions timeout is a distinct global error, not an aborted result', async () => {
	const deps: LiveScanDeps = {
		// Non-cooperative: ignores every abort/timeout signal we hand it.
		getSubscriptions: () => new Promise(() => {}),
		getChannelContent: async () => ({ videos: [] }),
		getVideo: async (videoId: string) => live(videoId)
	};

	await assert.rejects(() => scanLive(deps, { timeoutMs: 25 }), /timed out/i);
});

test('aborting while subscriptions are in flight returns an aborted result without hanging', async () => {
	const controller = new AbortController();
	const deps: LiveScanDeps = {
		getSubscriptions: () => new Promise(() => {}),
		getChannelContent: async () => ({ videos: [] }),
		getVideo: async (videoId: string) => live(videoId)
	};

	const pending = scanLive(deps, { signal: controller.signal, timeoutMs: 5000 });
	setTimeout(() => controller.abort(), 15);

	const result = await pending;

	assert.equal(result.aborted, true);
	assert.deepEqual(result.lives, []);
	assert.deepEqual(result.channelFailures, []);
});

// --- race: non-cooperative fetches must not hang the scan -------------------

test('a channel fetch that ignores its signal still times out without hanging the scan', async () => {
	const deps: LiveScanDeps = {
		getSubscriptions: async () => [
			{ author: 'Slow', authorId: 'slow' },
			{ author: 'Fast', authorId: 'fast' }
		],
		getChannelContent: async (channelId: string) => {
			if (channelId === 'fast') return { videos: [{ videoId: 'vf' }] };
			return new Promise(() => {}); // never settles, ignores the signal
		},
		getVideo: async (videoId: string) => live(videoId)
	};

	const result = await scanLive(deps, { timeoutMs: 30 });

	assert.deepEqual(
		result.lives.map((v) => v.videoId),
		['vf']
	);
	assert.deepEqual(
		result.channelFailures.map((f) => f.channelId),
		['slow']
	);
	assert.match(result.channelFailures[0].error, /timed out/i);
	assert.equal(result.aborted, false);
});

test('a detail fetch that ignores its signal times out into a video failure without hanging', async () => {
	const deps: LiveScanDeps = {
		getSubscriptions: async () => [{ author: 'A', authorId: 'c1' }],
		getChannelContent: async () => ({ videos: [{ videoId: 'v1' }] }),
		getVideo: () => new Promise(() => {})
	};

	const result = await scanLive(deps, { timeoutMs: 30 });

	assert.deepEqual(
		result.videoFailures.map((f) => f.videoId),
		['v1']
	);
	assert.deepEqual(result.lives, []);
	assert.equal(result.aborted, false);
});

// --- no listener leaks -------------------------------------------------------

test('mergeSignals does not leave abort listeners on the source signals', () => {
	const a = new AbortController();
	const b = new AbortController();

	const merged = mergeSignals([a.signal, b.signal]);

	assert.equal(getEventListeners(a.signal, 'abort').length, 0);
	assert.equal(getEventListeners(b.signal, 'abort').length, 0);

	a.abort(new Error('boom'));
	assert.equal(merged.aborted, true);
});

test('mergeSignalsWithCleanup removes every source listener on cleanup', () => {
	const a = new AbortController();
	const b = new AbortController();

	const { signal, cleanup } = mergeSignalsWithCleanup([a.signal, b.signal]);
	assert.equal(getEventListeners(a.signal, 'abort').length, 1);
	assert.equal(getEventListeners(b.signal, 'abort').length, 1);

	// Still propagates while wired up.
	b.abort();
	assert.equal(signal.aborted, true);

	cleanup();
	assert.equal(getEventListeners(a.signal, 'abort').length, 0);
	assert.equal(getEventListeners(b.signal, 'abort').length, 0);

	// Idempotent.
	cleanup();
});

test('a completed scan leaves no abort listeners on the external signal', async () => {
	const controller = new AbortController();
	const deps: LiveScanDeps = {
		getSubscriptions: async () => [
			{ author: 'A', authorId: 'c1' },
			{ author: 'B', authorId: 'c2' }
		],
		getChannelContent: async (channelId: string) => ({ videos: [{ videoId: `${channelId}-1` }] }),
		getVideo: async (videoId: string) => live(videoId)
	};

	await scanLive(deps, { signal: controller.signal });

	assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
