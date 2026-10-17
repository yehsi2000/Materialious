import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanLive, type LiveScanDeps } from '../src/lib/subscriptions/live.ts';

interface FakeConfig {
	subscriptions?: { author: string; authorId: string }[];
	// channelId -> list items returned by getChannelContent(type: streams)
	streams?: Record<string, Record<string, unknown>[]>;
	// channelId -> error message (list fetch rejects)
	streamsError?: Record<string, string>;
	// videoId -> detail returned by getVideo
	details?: Record<string, Record<string, unknown>>;
	// videoId -> error message (detail fetch rejects)
	detailsError?: Record<string, string>;
	getSubscriptions?: () => Promise<{ author: string; authorId: string }[]>;
}

function fakeDeps(config: FakeConfig): LiveScanDeps {
	return {
		getSubscriptions: config.getSubscriptions ?? (async () => config.subscriptions ?? []),
		getChannelContent: async (channelId: string) => {
			const err = config.streamsError?.[channelId];
			if (err) throw new Error(err);
			return { videos: config.streams?.[channelId] ?? [] };
		},
		getVideo: async (videoId: string) => {
			const err = config.detailsError?.[videoId];
			if (err) throw new Error(err);
			return { videoId, type: 'video', ...(config.details?.[videoId] ?? {}) };
		}
	};
}

test('a malformed subscriptions response is an error, not a claim of no subscriptions', async () => {
	await assert.rejects(
		scanLive({
			getSubscriptions: async () => ({ error: 'bad' }) as never,
			getChannelContent: async () => ({ videos: [] }) as never,
			getVideo: async () => ({}) as never
		}),
		/Malformed subscriptions/
	);
});

test('keeps only videos whose detail reports liveNow and not upcoming', async () => {
	const deps = fakeDeps({
		subscriptions: [{ author: 'Alpha', authorId: 'c1' }],
		streams: {
			// List flags are unreliable: v1 looks offline here but the detail says live,
			// v2 looks live here but the detail says it is not.
			c1: [
				{ videoId: 'v1', liveNow: false, isUpcoming: false },
				{ videoId: 'v2', liveNow: true, isUpcoming: false }
			]
		},
		details: {
			v1: { liveNow: true, isUpcoming: false },
			v2: { liveNow: false, isUpcoming: false }
		}
	});

	const result = await scanLive(deps);

	assert.deepEqual(
		result.lives.map((v) => v.videoId),
		['v1']
	);
	assert.equal(result.channelsChecked, 1);
	assert.equal(result.candidateCount, 2);
});

test('excludes upcoming streams even when liveNow is true', async () => {
	const deps = fakeDeps({
		subscriptions: [{ author: 'Alpha', authorId: 'c1' }],
		streams: { c1: [{ videoId: 'up1' }] },
		details: { up1: { liveNow: true, isUpcoming: true } }
	});

	const result = await scanLive(deps);

	assert.deepEqual(result.lives, []);
});

test('reports the unique channel total, folding duplicate subscriptions', async () => {
	const deps = fakeDeps({
		subscriptions: [
			{ author: 'Alpha', authorId: 'c1' },
			{ author: 'Alpha duplicate', authorId: 'c1' },
			{ author: 'Beta', authorId: 'c2' }
		],
		streams: { c1: [], c2: [] }
	});

	const result = await scanLive(deps);

	assert.equal(result.channelsTotal, 2);
	assert.equal(result.channelsChecked, 2);
});

test('reports a channel-list failure distinctly without treating it as offline', async () => {
	const deps = fakeDeps({
		subscriptions: [
			{ author: 'Alpha', authorId: 'c1' },
			{ author: 'Beta', authorId: 'c2' }
		],
		streams: { c1: [] },
		streamsError: { c2: 'list unavailable' }
	});

	const result = await scanLive(deps);

	assert.equal(result.channelsChecked, 1);
	assert.deepEqual(
		result.channelFailures.map((f) => f.channelId),
		['c2']
	);
	assert.match(result.channelFailures[0].error, /list unavailable/);
	assert.equal(result.channelFailures[0].author, 'Beta');
	// A failed channel is not silently folded into "no lives".
	assert.deepEqual(result.lives, []);
});

test('a failed detail fetch is unresolved, never inferred as offline', async () => {
	const deps = fakeDeps({
		subscriptions: [{ author: 'Alpha', authorId: 'c1' }],
		streams: { c1: [{ videoId: 'v1' }, { videoId: 'v2' }] },
		details: { v1: { liveNow: true } },
		detailsError: { v2: 'detail unavailable' }
	});

	const result = await scanLive(deps);

	assert.deepEqual(
		result.lives.map((v) => v.videoId),
		['v1']
	);
	assert.deepEqual(
		result.videoFailures.map((f) => f.videoId),
		['v2']
	);
});

test('caps the first-page candidates per channel and flags truncated channels', async () => {
	const deps = fakeDeps({
		subscriptions: [{ author: 'Alpha', authorId: 'c1' }],
		streams: {
			c1: [
				{ videoId: 'v1' },
				{ videoId: 'v2' },
				{ videoId: 'v3' },
				{ videoId: 'v4' },
				{ videoId: 'v5' }
			]
		},
		details: {
			v1: { liveNow: true },
			v2: { liveNow: true },
			v3: { liveNow: true },
			v4: { liveNow: true },
			v5: { liveNow: true }
		}
	});

	const result = await scanLive(deps, { candidateLimit: 2 });

	assert.equal(result.candidateCount, 2);
	assert.deepEqual(result.truncatedChannels, ['c1']);
	assert.deepEqual(
		result.lives.map((v) => v.videoId),
		['v1', 'v2']
	);
});

test('dedupes by videoId and reports every live on a channel', async () => {
	const deps = fakeDeps({
		subscriptions: [
			{ author: 'Alpha', authorId: 'c1' },
			{ author: 'Beta', authorId: 'c2' }
		],
		streams: {
			c1: [{ videoId: 'v1' }, { videoId: 'v2' }],
			// v1 shows up again via a second channel's listing
			c2: [{ videoId: 'v1' }, { videoId: 'v3' }]
		},
		details: {
			v1: { liveNow: true },
			v2: { liveNow: true },
			v3: { liveNow: true }
		}
	});

	const result = await scanLive(deps);

	assert.deepEqual(result.lives.map((v) => v.videoId).sort(), ['v1', 'v2', 'v3']);
	assert.deepEqual(
		result.lives,
		result.lives.filter((v, i, arr) => arr.findIndex((x) => x.videoId === v.videoId) === i)
	);
});
