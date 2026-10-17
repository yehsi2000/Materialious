import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	scanLive,
	type LiveScanDeps,
	type LiveScanProgress
} from '../src/lib/subscriptions/live.ts';

interface Overrides {
	subs?: { author: string; authorId: string }[];
	getSubscriptions?: LiveScanDeps['getSubscriptions'];
	getChannelContent?: LiveScanDeps['getChannelContent'];
	getVideo?: LiveScanDeps['getVideo'];
}

function deps(overrides: Overrides = {}): LiveScanDeps {
	return {
		getSubscriptions:
			overrides.getSubscriptions ??
			(async () => overrides.subs ?? [{ author: 'A', authorId: 'c1' }]),
		getChannelContent: overrides.getChannelContent ?? (async () => ({ videos: [] })),
		getVideo:
			overrides.getVideo ??
			(async (videoId: string) => ({ videoId, type: 'video', liveNow: true, isUpcoming: false }))
	};
}

// --- malformed channel listings ---------------------------------------------

test('a channel whose videos is not an array is a failure, not an empty success', async () => {
	const result = await scanLive(
		deps({ getChannelContent: async () => ({ videos: 'nope' }) as never })
	);

	assert.equal(result.channelsChecked, 0);
	assert.deepEqual(
		result.channelFailures.map((f) => f.channelId),
		['c1']
	);
	assert.match(result.channelFailures[0].error, /videos/i);
	assert.equal(result.candidateCount, 0);
});

test('a channel response missing the videos array is a failure, never "offline"', async () => {
	const result = await scanLive(deps({ getChannelContent: async () => ({}) as never }));

	assert.equal(result.channelsChecked, 0);
	assert.deepEqual(
		result.channelFailures.map((f) => f.channelId),
		['c1']
	);
	assert.deepEqual(result.lives, []);
});

// --- truncation --------------------------------------------------------------

test('flags a channel as truncated when a continuation exists even under the candidate cap', async () => {
	const result = await scanLive(
		deps({
			getChannelContent: async () => ({
				videos: [{ videoId: 'v1' }, { videoId: 'v2' }],
				continuation: 'next-page-token'
			})
		})
	);

	assert.deepEqual(result.truncatedChannels, ['c1']);
	assert.equal(result.candidateCount, 2);
});

test('does not flag truncation with no continuation and the cap not reached', async () => {
	const result = await scanLive(
		deps({ getChannelContent: async () => ({ videos: [{ videoId: 'v1' }] }) })
	);

	assert.deepEqual(result.truncatedChannels, []);
});

// --- malformed / mismatched details -----------------------------------------

test('a detail missing a boolean liveNow is unresolved, never inferred offline', async () => {
	const result = await scanLive(
		deps({
			getChannelContent: async () => ({ videos: [{ videoId: 'v1' }] }),
			// no liveNow at all
			getVideo: async (videoId: string) => ({ videoId, type: 'video' }) as never
		})
	);

	assert.deepEqual(result.lives, []);
	assert.deepEqual(
		result.videoFailures.map((f) => f.videoId),
		['v1']
	);
});

test('a non-boolean liveNow is unresolved', async () => {
	const result = await scanLive(
		deps({
			getChannelContent: async () => ({ videos: [{ videoId: 'v1' }] }),
			getVideo: async (videoId: string) => ({ videoId, type: 'video', liveNow: 'true' }) as never
		})
	);

	assert.deepEqual(result.lives, []);
	assert.deepEqual(
		result.videoFailures.map((f) => f.videoId),
		['v1']
	);
});

test('a detail whose videoId does not match the candidate is unresolved', async () => {
	const result = await scanLive(
		deps({
			getChannelContent: async () => ({ videos: [{ videoId: 'v1' }] }),
			getVideo: async () => ({ videoId: 'other', type: 'video', liveNow: true })
		})
	);

	assert.deepEqual(result.lives, []);
	assert.deepEqual(
		result.videoFailures.map((f) => f.videoId),
		['v1']
	);
	assert.match(result.videoFailures[0].error, /videoId/i);
});

test('a non-object detail is unresolved', async () => {
	const result = await scanLive(
		deps({
			getChannelContent: async () => ({ videos: [{ videoId: 'v1' }] }),
			getVideo: async () => null as never
		})
	);

	assert.deepEqual(result.lives, []);
	assert.deepEqual(
		result.videoFailures.map((f) => f.videoId),
		['v1']
	);
});

// --- normalization -----------------------------------------------------------

test('confirmed lives are normalized to type stream while preserving every field', async () => {
	const detail = {
		videoId: 'v1',
		type: 'video' as const,
		liveNow: true,
		isUpcoming: false,
		title: 'Live right now',
		author: 'Alpha',
		authorId: 'c1',
		lengthSeconds: 1234
	};
	const result = await scanLive(
		deps({
			getChannelContent: async () => ({ videos: [{ videoId: 'v1' }] }),
			getVideo: async () => detail
		})
	);

	assert.equal(result.lives.length, 1);
	const live = result.lives[0];
	assert.equal(live.type, 'stream');
	assert.equal(live.liveVideo, true, 'existing thumbnail needs liveVideo for its LIVE badge');
	assert.equal(live.title, 'Live right now');
	assert.equal(live.author, 'Alpha');
	assert.equal(live.authorId, 'c1');
	assert.equal(live.lengthSeconds, 1234);
	// The source object is untouched.
	assert.equal(detail.type, 'video');
});

// --- progress ----------------------------------------------------------------

test('progress exposes candidateCount and advances as channels and videos complete', async () => {
	const events: LiveScanProgress[] = [];
	const result = await scanLive(
		deps({
			subs: [
				{ author: 'A', authorId: 'c1' },
				{ author: 'B', authorId: 'c2' }
			],
			getChannelContent: async (channelId: string) => ({
				videos: [{ videoId: `${channelId}-1` }, { videoId: `${channelId}-2` }]
			}),
			getVideo: async (videoId: string) => ({ videoId, type: 'video', liveNow: true })
		}),
		{ onProgress: (p) => events.push({ ...p }) }
	);

	assert.ok(events.length > 0);
	assert.ok(events.every((e) => typeof e.candidateCount === 'number'));
	assert.equal(events[0].candidateCount, 0);
	assert.ok(
		events.some((e) => e.candidateCount === 4),
		'candidateCount should grow with discovered candidates'
	);
	const last = events[events.length - 1];
	assert.equal(last.candidateCount, 4);
	assert.equal(last.phase, 'done');
	assert.equal(last.videosChecked, 4);
	assert.equal(last.videosChecked, result.candidateCount);
});

test('video progress is reported incrementally, not once after the whole phase', async () => {
	const events: LiveScanProgress[] = [];
	await scanLive(
		deps({
			getChannelContent: async () => ({
				videos: Array.from({ length: 4 }, (_, i) => ({ videoId: `v${i}` }))
			}),
			getVideo: async (videoId: string) => {
				await new Promise((r) => setTimeout(r, 5));
				return { videoId, type: 'video', liveNow: true };
			}
		}),
		{ concurrency: 1, onProgress: (p) => events.push({ ...p }) }
	);

	const positiveTicks = events
		.filter((e) => e.phase === 'videos' && e.videosChecked > 0)
		.map((e) => e.videosChecked);
	// With concurrency 1 the checked count must climb 1,2,3,4 rather than jumping to 4 at the end.
	assert.deepEqual(positiveTicks, [1, 2, 3, 4]);
});
