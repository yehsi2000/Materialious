import type { ChannelContent, Subscription, Video } from '$lib/api/model';
import {
	DEFAULT_CONCURRENCY,
	DEFAULT_TIMEOUT_MS,
	errorMessage,
	mapLimit,
	mergeSignals,
	mergeSignalsWithCleanup,
	RequestTimeoutError,
	runRequest,
	validateDetail,
	type MergedSignal
} from './scanCore.ts';

// Shared request/abort primitives live in ./scanCore; re-exported here so the
// whole-channel scan's public surface (and its existing consumers) is stable.
export {
	DEFAULT_CONCURRENCY,
	DEFAULT_TIMEOUT_MS,
	RequestTimeoutError,
	mergeSignals,
	mergeSignalsWithCleanup
};
export type { MergedSignal };

export interface LiveScanDeps {
	getSubscriptions: (fetchOptions?: RequestInit) => Promise<Subscription[]>;
	getChannelContent: (
		channelId: string,
		options: { type: 'streams' },
		fetchOptions?: RequestInit
	) => Promise<ChannelContent>;
	getVideo: (videoId: string, local?: boolean, fetchOptions?: RequestInit) => Promise<Video>;
}

export interface LiveScanOptions {
	concurrency?: number;
	candidateLimit?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (progress: LiveScanProgress) => void;
	fetchOptions?: RequestInit;
}

export interface LiveScanProgress {
	channelsTotal: number;
	channelsChecked: number;
	videosChecked: number;
	liveFound: number;
	/** Unique candidates discovered so far (grows during the channel phase). */
	candidateCount: number;
	phase: 'channels' | 'videos' | 'done';
}

export interface LiveChannelFailure {
	channelId: string;
	author?: string;
	error: string;
}

export interface LiveVideoFailure {
	videoId: string;
	error: string;
}

export type LiveVideo = Video & { liveVideo: true };

export interface LiveScanResult {
	lives: LiveVideo[];
	channelsTotal: number;
	channelsChecked: number;
	channelFailures: LiveChannelFailure[];
	videoFailures: LiveVideoFailure[];
	candidateCount: number;
	truncatedChannels: string[];
	lastChecked: number;
	aborted: boolean;
}

/**
 * Default first-page candidate cap per channel. This is intentionally a
 * bounded sample: the "streams" tab of a channel is sorted with upcoming
 * premieres first, and a channel can list more candidates than we are willing
 * to detail-fetch. We therefore never claim the result is exhaustive for a
 * channel whose list was truncated - such channels are surfaced in
 * `truncatedChannels` and the UI shows a "showing a subset" note.
 */
export const DEFAULT_CANDIDATE_LIMIT = 15;

interface ChannelListing {
	videoIds: string[];
	truncated: boolean;
}

function emptyResult(channelsTotal = 0): LiveScanResult {
	return {
		lives: [],
		channelsTotal,
		channelsChecked: 0,
		channelFailures: [],
		videoFailures: [],
		candidateCount: 0,
		truncatedChannels: [],
		lastChecked: Date.now(),
		aborted: true
	};
}

export async function scanLive(
	deps: LiveScanDeps,
	options: LiveScanOptions = {}
): Promise<LiveScanResult> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const external = options.signal;
	const baseFetchOptions = options.fetchOptions;
	const onProgress = options.onProgress;

	const channelAuthor = new Map<string, string>();
	const channelFailures: LiveChannelFailure[] = [];
	const truncatedChannels: string[] = [];
	const candidates: { videoId: string }[] = [];
	const seenVideos = new Set<string>();
	const livesByIndex: LiveVideo[] = [];
	const videoFailuresByIndex: LiveVideoFailure[] = [];

	const channelIds: string[] = [];
	let channelsChecked = 0;
	let videosChecked = 0;
	let liveFound = 0;
	let phase: LiveScanProgress['phase'] = 'channels';

	const aborted = () => external?.aborted === true;

	const emit = () =>
		onProgress?.({
			channelsTotal: channelIds.length,
			channelsChecked,
			videosChecked,
			liveFound,
			candidateCount: candidates.length,
			phase
		});

	// If the caller already cancelled, make no request at all.
	if (aborted()) return emptyResult();

	// Phase 0: the subscription list. Timeout is a distinct global error; an
	// external abort is reported as an aborted result.
	let subscriptions: Subscription[];
	try {
		subscriptions = await runRequest(timeoutMs, external, (signal) =>
			deps.getSubscriptions({ ...baseFetchOptions, signal })
		);
	} catch (error) {
		if (aborted()) return emptyResult();
		throw error;
	}

	if (!Array.isArray(subscriptions)) throw new Error('Malformed subscriptions: expected an array');

	// De-duplicate channels: a subscription list can repeat a channel.
	for (const sub of subscriptions) {
		if (!sub || typeof sub.authorId !== 'string' || channelAuthor.has(sub.authorId)) continue;
		channelAuthor.set(sub.authorId, sub.author);
		channelIds.push(sub.authorId);
	}

	emit();

	if (aborted()) return emptyResult(channelIds.length);

	// Phase 1: list the "streams" tab for each subscribed channel.
	phase = 'channels';
	const channelResults = await mapLimit(channelIds, concurrency, async (channelId) => {
		if (aborted()) throw new Error('Aborted');

		const content = await runRequest(timeoutMs, external, (signal) =>
			deps.getChannelContent(channelId, { type: 'streams' }, { ...baseFetchOptions, signal })
		);

		const maybeVideos = (content as { videos?: unknown } | null | undefined)?.videos;
		// A response without a videos array is malformed, never an empty success.
		if (!Array.isArray(maybeVideos)) {
			throw new Error('Malformed channel content: videos is not an array');
		}

		const listing: ChannelListing = { videoIds: [], truncated: false };
		const seenHere = new Set<string>();
		for (const video of maybeVideos as Record<string, unknown>[]) {
			const videoId = typeof video?.videoId === 'string' ? video.videoId : undefined;
			if (!videoId || seenHere.has(videoId)) continue;
			if (listing.videoIds.length >= candidateLimit) {
				listing.truncated = true;
				break;
			}
			seenHere.add(videoId);
			listing.videoIds.push(videoId);
		}

		// A continuation means the first page is a subset even if it fit under
		// the candidate cap.
		const continuation = (content as { continuation?: unknown }).continuation;
		const truncated =
			listing.truncated || (typeof continuation === 'string' && continuation.length > 0);

		// Record synchronously so progress advances as each channel completes.
		channelsChecked++;
		if (truncated) truncatedChannels.push(channelId);
		for (const videoId of listing.videoIds) {
			if (seenVideos.has(videoId)) continue;
			seenVideos.add(videoId);
			candidates.push({ videoId });
		}
		emit();
		return listing;
	});

	channelResults.forEach((result, index) => {
		if (result.status === 'rejected' && !aborted()) {
			const channelId = channelIds[index];
			channelFailures.push({
				channelId,
				author: channelAuthor.get(channelId),
				error: errorMessage(result.reason)
			});
			emit();
		}
	});

	// Phase 2: detail-fetch every candidate. The list flags are unreliable, so
	// the detail response is the only source of truth for liveNow.
	if (!aborted() && candidates.length > 0) {
		phase = 'videos';
		emit();

		const detailResults = await mapLimit(candidates, concurrency, async (candidate, index) => {
			if (aborted()) throw new Error('Aborted');

			const value = await runRequest(timeoutMs, external, (signal) =>
				deps.getVideo(candidate.videoId, undefined, { ...baseFetchOptions, signal })
			);
			const detail = validateDetail(value, candidate.videoId);

			videosChecked++;
			if (detail.liveNow === true && detail.isUpcoming !== true) {
				// Normalize the type so the existing Thumbnail live badge renders,
				// preserving every other field from the detail response.
				livesByIndex[index] = { ...detail, type: 'stream', liveVideo: true };
				liveFound++;
			}
			emit();
			return detail;
		});

		detailResults.forEach((result, index) => {
			if (result.status === 'rejected' && !aborted()) {
				videosChecked++;
				videoFailuresByIndex[index] = {
					videoId: candidates[index].videoId,
					error: errorMessage(result.reason)
				};
				emit();
			}
		});
	}

	phase = 'done';
	emit();

	return {
		lives: livesByIndex.filter((video): video is LiveVideo => Boolean(video)),
		channelsTotal: channelIds.length,
		channelsChecked,
		channelFailures,
		videoFailures: videoFailuresByIndex.filter((f): f is LiveVideoFailure => Boolean(f)),
		candidateCount: candidates.length,
		truncatedChannels,
		lastChecked: Date.now(),
		aborted: aborted()
	};
}
