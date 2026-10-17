import type { ChannelContent, Subscription, Video } from '$lib/api/model';

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
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 12000;

/** The reason a request was aborted because its per-request timeout elapsed. */
export class RequestTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Request timed out after ${timeoutMs}ms`);
		this.name = 'RequestTimeoutError';
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface MergedSignal {
	signal: AbortSignal;
	/** Removes every listener this merge registered on the source signals. */
	cleanup: () => void;
}

const noop = () => {};

/**
 * Merge signals so the returned signal aborts when any source aborts, while
 * exposing a `cleanup` that detaches every listener we added. This always wires
 * explicit listeners (never `AbortSignal.any`) so `cleanup` deterministically
 * releases them - the request runner depends on that for per-request teardown.
 */
export function mergeSignalsWithCleanup(signals: (AbortSignal | undefined)[]): MergedSignal {
	const list = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	if (list.length === 0) return { signal: new AbortController().signal, cleanup: noop };
	if (list.length === 1) return { signal: list[0], cleanup: noop };

	const controller = new AbortController();
	const removers: (() => void)[] = [];
	for (const signal of list) {
		if (controller.signal.aborted) break;
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		const onAbort = () => controller.abort(signal.reason);
		signal.addEventListener('abort', onAbort, { once: true });
		removers.push(() => signal.removeEventListener('abort', onAbort));
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const remove of removers) remove();
			removers.length = 0;
		}
	};
}

/**
 * Public back-compat helper: merge signals into one. It never leaves JS-level
 * listeners on the sources (uses `AbortSignal.any` where available). Callers
 * that need to release non-listener resources (timers) or that must detach the
 * wiring explicitly should use `mergeSignalsWithCleanup` instead.
 */
export function mergeSignals(signals: (AbortSignal | undefined)[]): AbortSignal {
	const list = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	if (list.length === 0) return new AbortController().signal;
	if (list.length === 1) return list[0];
	if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
	return mergeSignalsWithCleanup(list).signal;
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return new Error(typeof reason === 'undefined' ? 'Aborted' : String(reason));
}

/**
 * Run `start(signal)` with a fresh timeout signal merged with `external`, and
 * race it against the abort signal so a request that *ignores* its signal
 * still settles instead of hanging the whole scan. Every timer and listener is
 * released before resolving or rejecting.
 */
async function runRequest<T>(
	timeoutMs: number,
	external: AbortSignal | undefined,
	start: (signal: AbortSignal) => Promise<T>
): Promise<T> {
	const timeoutController = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs > 0) {
		timer = setTimeout(
			() => timeoutController.abort(new RequestTimeoutError(timeoutMs)),
			timeoutMs
		);
	}

	const { signal, cleanup: cleanupMerge } = mergeSignalsWithCleanup([
		external,
		timeoutMs > 0 ? timeoutController.signal : undefined
	]);

	const finish = () => {
		if (timer) clearTimeout(timer);
		cleanupMerge();
	};

	if (signal.aborted) {
		finish();
		throw abortError(signal);
	}

	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(abortError(signal));
		signal.addEventListener('abort', onAbort, { once: true });
	});

	try {
		let started: Promise<T>;
		try {
			started = Promise.resolve(start(signal));
		} catch (error) {
			started = Promise.reject(error);
		}
		return await Promise.race([started, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort);
		finish();
	}
}

/**
 * Run `worker` over `items` with at most `limit` in flight at once. Returns a
 * settled result per item (in order) so partial failures never reject the batch.
 */
async function mapLimit<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = [];
	const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
	let next = 0;

	async function run(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			try {
				results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
			} catch (error) {
				results[index] = { status: 'rejected', reason: error };
			}
		}
	}

	await Promise.all(Array.from({ length: size }, () => run()));
	return results;
}

interface ChannelListing {
	videoIds: string[];
	truncated: boolean;
}

/**
 * A detail response is the only source of truth for liveNow. Anything that does
 * not line up exactly is unresolved - it must never be silently downgraded to
 * "offline".
 */
function validateDetail(value: unknown, expectedVideoId: string): Video {
	if (typeof value !== 'object' || value === null) {
		throw new Error('Malformed video detail: not an object');
	}
	const detail = value as Record<string, unknown>;
	if (typeof detail.videoId !== 'string') {
		throw new Error('Malformed video detail: missing videoId');
	}
	if (detail.videoId !== expectedVideoId) {
		throw new Error(
			`Malformed video detail: videoId mismatch (${detail.videoId} !== ${expectedVideoId})`
		);
	}
	if (typeof detail.liveNow !== 'boolean') {
		throw new Error('Malformed video detail: liveNow is not a boolean');
	}
	return value as Video;
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
