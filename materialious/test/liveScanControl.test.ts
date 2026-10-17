import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	scanLive,
	type LiveScanDeps,
	type LiveScanProgress
} from '../src/lib/subscriptions/live.ts';

interface Tracked {
	maxChannelInFlight: number;
	maxVideoInFlight: number;
	maxTotalInFlight: number;
}

function trackedDeps(plan: {
	channels: number;
	perChannel: number;
	liveEveryVideos?: boolean;
	tracker?: Tracked;
}): LiveScanDeps {
	const tracker: Tracked = plan.tracker ?? {
		maxChannelInFlight: 0,
		maxVideoInFlight: 0,
		maxTotalInFlight: 0
	};
	let channelInFlight = 0;
	let videoInFlight = 0;
	const bump = () => {
		const total = channelInFlight + videoInFlight;
		tracker.maxTotalInFlight = Math.max(tracker.maxTotalInFlight, total);
	};

	const subscriptions = Array.from({ length: plan.channels }, (_, i) => ({
		author: `Ch${i}`,
		authorId: `c${i}`
	}));

	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	return {
		getSubscriptions: async () => subscriptions,
		getChannelContent: async (channelId: string) => {
			channelInFlight++;
			bump();
			tracker.maxChannelInFlight = Math.max(tracker.maxChannelInFlight, channelInFlight);
			try {
				await sleep(5);
				const index = channelId.replace('c', '');
				return {
					videos: Array.from({ length: plan.perChannel }, (_, i) => ({
						videoId: `${index}-${i}`
					}))
				};
			} finally {
				channelInFlight--;
			}
		},
		getVideo: async (videoId: string) => {
			videoInFlight++;
			bump();
			tracker.maxVideoInFlight = Math.max(tracker.maxVideoInFlight, videoInFlight);
			try {
				await sleep(5);
				const isLive = plan.liveEveryVideos === false ? false : true;
				return { videoId, type: 'video', liveNow: isLive, isUpcoming: false };
			} finally {
				videoInFlight--;
			}
		}
	};
}

test('bounds concurrency for both phases', async () => {
	const tracker: Tracked = { maxChannelInFlight: 0, maxVideoInFlight: 0, maxTotalInFlight: 0 };
	const deps = trackedDeps({ channels: 8, perChannel: 3, tracker });

	await scanLive(deps, { concurrency: 2 });

	assert.equal(tracker.maxChannelInFlight, 2, `channels in flight ${tracker.maxChannelInFlight}`);
	assert.equal(tracker.maxVideoInFlight, 2, `videos in flight ${tracker.maxVideoInFlight}`);
	assert.ok(tracker.maxTotalInFlight <= 2, `total in flight ${tracker.maxTotalInFlight}`);
});

test('stops promptly and reports aborted when the signal fires during the run', async () => {
	const controller = new AbortController();
	let detailCalls = 0;

	const deps: LiveScanDeps = {
		getSubscriptions: async () => {
			// Abort after subscriptions resolve, before channel scanning.
			controller.abort();
			return [{ author: 'Alpha', authorId: 'c1' }];
		},
		getChannelContent: async () => {
			throw new Error('should not be reached after abort');
		},
		getVideo: async () => {
			detailCalls++;
			return { videoId: 'v1', type: 'video', liveNow: true };
		}
	};

	const result = await scanLive(deps, { signal: controller.signal });

	assert.equal(result.aborted, true);
	assert.equal(detailCalls, 0);
	assert.equal(result.channelsChecked, 0);
	assert.deepEqual(result.lives, []);
	// Cancellation must not be smeared into channel failures.
	assert.deepEqual(result.channelFailures, []);
});

test('abandons in-flight requests when the signal fires mid-scan without recording failures', async () => {
	const controller = new AbortController();
	let started = 0;

	const deps: LiveScanDeps = {
		getSubscriptions: async () =>
			Array.from({ length: 4 }, (_, i) => ({ author: `Ch${i}`, authorId: `c${i}` })),
		getChannelContent: async (_channelId, _options, fetchOptions) => {
			started++;
			if (started === 1) controller.abort();
			return new Promise((_resolve, reject) => {
				const signal = fetchOptions?.signal;
				if (signal?.aborted) return reject(new Error('aborted'));
				signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
			});
		},
		getVideo: async (videoId: string) => ({ videoId, type: 'video', liveNow: true })
	};

	const result = await scanLive(deps, { signal: controller.signal, concurrency: 2 });

	assert.equal(result.aborted, true);
	assert.deepEqual(result.channelFailures, []);
});

test('times out a slow request and records it as a failure without hanging the scan', async () => {
	const deps: LiveScanDeps = {
		getSubscriptions: async () => [
			{ author: 'Slow', authorId: 'slow' },
			{ author: 'Fast', authorId: 'fast' }
		],
		getChannelContent: async (channelId, _options, fetchOptions) => {
			if (channelId === 'fast') return { videos: [{ videoId: 'vf' }] };
			return new Promise((_resolve, reject) => {
				const signal = fetchOptions?.signal;
				if (signal?.aborted) return reject(new Error('aborted'));
				signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
			});
		},
		getVideo: async (videoId: string) => ({ videoId, type: 'video', liveNow: true })
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
});

test('emits progress with totals, checked counts and live totals', async () => {
	const deps = trackedDeps({ channels: 3, perChannel: 2, liveEveryVideos: false });
	const events: LiveScanProgress[] = [];

	const result = await scanLive(deps, { concurrency: 2, onProgress: (p) => events.push({ ...p }) });

	assert.ok(events.length > 0, 'progress should be reported');
	assert.equal(events[0].channelsTotal, 3);
	const last = events[events.length - 1];
	assert.equal(last.channelsChecked, 3);
	assert.equal(last.videosChecked, 6);
	assert.equal(last.liveFound, 0);
	assert.equal(last.liveFound, result.lives.length);
});
