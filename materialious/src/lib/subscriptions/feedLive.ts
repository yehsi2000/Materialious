import type { Video } from '$lib/api/model';
import type { LiveCacheScope } from './liveCache';
import { buildLiveCacheKey } from './liveCache.ts';
import {
	DEFAULT_CONCURRENCY,
	DEFAULT_TIMEOUT_MS,
	errorMessage,
	mapLimit,
	runRequest,
	validateDetail
} from './scanCore.ts';

/**
 * Feed-first subscriptions model.
 *
 * The default Now live experience no longer crawls subscribed channels. It shows
 * the already-loaded subscription feed immediately and, in the background,
 * verifies the live/upcoming state of only the videos that are loaded. The list
 * flags the API returns are unreliable (both false positives and false
 * negatives), so every loaded video id is checked - never a duration- or
 * flag-based candidate subset.
 */

export type FeedLiveFilter = 'all' | 'live' | 'upcoming';

export const FEED_LIVE_FILTERS: FeedLiveFilter[] = ['all', 'live', 'upcoming'];

export type VideoLiveState = 'live' | 'upcoming' | 'offline' | 'unknown';

export interface VerifiedVideoState {
	videoId: string;
	state: VideoLiveState;
	checkedAt: number;
	/** Present when a detail response was obtained. */
	detail?: Video;
	/** Present when the state is 'unknown' because the check failed. */
	error?: string;
}

export type VideoStateLookup = (videoId: string) => VideoLiveState | undefined;

export type FeedScopeInput = LiveCacheScope;

/**
 * Identity scope for the loaded feed and its verified state. Switching
 * Invidious instance, Materialious backend or account must never show another
 * identity's feed or reuse its verified flags.
 */
export function buildFeedScopeKey(scope: FeedScopeInput): string {
	return buildLiveCacheKey(scope);
}

/**
 * Slot key inside the shared feedCacheStore for a given scope. Keying the feed
 * by scope (not a single global `subscription` slot) means a late-resolving
 * route load writes to the identity it started under, so a switch can never
 * leak the previous identity's feed into the current view.
 */
export function feedCacheSlot(scopeKey: string): string {
	return `subscription:${scopeKey}`;
}

/**
 * The detail response is the only source of truth. A response without a boolean
 * `liveNow` is unresolved - never silently downgraded to "offline".
 */
export function resolveLiveStateFromDetail(
	detail: Pick<Video, 'liveNow' | 'isUpcoming'> | Record<string, unknown>
): VideoLiveState {
	const value = detail as { liveNow?: unknown; isUpcoming?: unknown };
	if (typeof value?.liveNow !== 'boolean' || typeof value.isUpcoming !== 'boolean')
		return 'unknown';
	if (value.isUpcoming === true) return 'upcoming';
	return value.liveNow === true ? 'live' : 'offline';
}

export function resolveItemState(videoId: string, lookup: VideoStateLookup): VideoLiveState {
	return lookup(videoId) ?? 'unknown';
}

/**
 * Return a corrected copy of a loaded feed item for a verified state. An
 * 'unknown' item is returned untouched: an unverifiable item must keep looking
 * exactly as the feed listed it, never be rewritten into a fake offline state.
 * A confirmed live item gets `liveVideo` so the existing Thumbnail LIVE badge
 * renders, and an upcoming item explicitly never carries that badge.
 */
export function applyLiveStateToItem<T>(item: T, state: VideoLiveState): T {
	if (state === 'unknown') return item;

	if (state === 'live') {
		return {
			...(item as Record<string, unknown>),
			type: 'stream',
			liveNow: true,
			isUpcoming: false,
			liveVideo: true
		} as unknown as T;
	}

	if (state === 'upcoming') {
		return {
			...(item as Record<string, unknown>),
			liveNow: false,
			isUpcoming: true,
			liveVideo: false
		} as unknown as T;
	}

	return {
		...(item as Record<string, unknown>),
		liveNow: false,
		isUpcoming: false,
		liveVideo: false
	} as unknown as T;
}

/** Drop repeated video ids while keeping the first-seen order (feed order). */
export function dedupeFeedItems<T>(items: T[]): T[] {
	const seen = new Set<string>();
	const deduped: T[] = [];

	for (const item of items) {
		const videoId = (item as { videoId?: unknown })?.videoId;
		if (typeof videoId !== 'string' || videoId.length === 0) {
			deduped.push(item);
			continue;
		}
		if (seen.has(videoId)) continue;
		seen.add(videoId);
		deduped.push(item);
	}

	return deduped;
}

/**
 * Filter the *loaded* feed. Only a verified state can match Live now / Upcoming:
 * a stale list flag, an unchecked item, or an unverifiable (unknown) item is
 * never presented as live or upcoming.
 */
export function filterFeedItems<T>(
	items: T[],
	filter: FeedLiveFilter,
	stateOf: VideoStateLookup
): T[] {
	if (filter === 'all') return items.slice();

	const wanted: VideoLiveState = filter === 'live' ? 'live' : 'upcoming';
	return items.filter((item) => {
		const videoId = (item as { videoId?: unknown })?.videoId;
		if (typeof videoId !== 'string') return false;
		return resolveItemState(videoId, stateOf) === wanted;
	});
}

// --- verified-state cache ---------------------------------------------------

interface VideoStateCacheEntry {
	state: VerifiedVideoState;
	storedAt: number;
}

export interface VideoStateCache {
	get(scope: string, videoId: string): VerifiedVideoState | undefined;
	set(scope: string, videoId: string, state: VerifiedVideoState): void;
	has(scope: string, videoId: string): boolean;
	clear(): void;
	size(): number;
}

/**
 * Short-lived, scope-keyed cache of verified video state. It keeps the feed-first
 * filter cheap: toggling All / Live now / Upcoming, or re-rendering the same
 * loaded ids, must not re-fetch already-verified videos. A manual refresh
 * bypasses it. Unverified ('unknown') results are cached too, so one failing id
 * is not hammered on every toggle.
 */
export function createVideoStateCache(
	ttlMs: number,
	now: () => number = Date.now
): VideoStateCache {
	const entries = new Map<string, VideoStateCacheEntry>();
	const key = (scope: string, videoId: string) => `${scope}\u0000${videoId}`;

	return {
		get(scope, videoId) {
			const cacheKey = key(scope, videoId);
			const entry = entries.get(cacheKey);
			if (!entry) return undefined;
			if (now() - entry.storedAt >= ttlMs) {
				entries.delete(cacheKey);
				return undefined;
			}
			return entry.state;
		},
		set(scope, videoId, state) {
			entries.set(key(scope, videoId), { state, storedAt: now() });
		},
		has(scope, videoId) {
			return this.get(scope, videoId) !== undefined;
		},
		clear() {
			entries.clear();
		},
		size() {
			return entries.size;
		}
	};
}

// --- background checker -----------------------------------------------------

export interface FeedCheckDeps {
	/**
	 * Exactly one dependency: the feed already supplied the ids, so the checker
	 * never lists a channel or a subscription. That keeps it impossible for the
	 * default feed filters to trigger a whole-channel scan.
	 */
	getVideo: (videoId: string, local?: boolean, fetchOptions?: RequestInit) => Promise<Video>;
}

export interface FeedCheckFailure {
	videoId: string;
	error: string;
}

export interface FeedCheckOptions {
	concurrency?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchOptions?: RequestInit;
	onResult?: (state: VerifiedVideoState) => void;
	cache?: VideoStateCache | null;
	scope?: string;
	/** Ignore cached state and re-verify (manual refresh). */
	bypassCache?: boolean;
}

export interface FeedCheckResult {
	states: Map<string, VerifiedVideoState>;
	failures: FeedCheckFailure[];
	/** Detail requests issued this run (cached hits excluded). */
	checked: number;
	/** Ids answered from the cache instead of the network. */
	cached: number;
	aborted: boolean;
}

/**
 * Verify the live/upcoming state of the given loaded video ids with bounded
 * concurrency and a per-request timeout. Failures become an 'unknown' state and
 * a recorded failure, never 'offline'. Cancellation stops issuing requests and
 * is not recorded as failure.
 */
export async function checkFeedVideos(
	deps: FeedCheckDeps,
	videoIds: string[],
	options: FeedCheckOptions = {}
): Promise<FeedCheckResult> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const signal = options.signal;
	const baseFetchOptions = options.fetchOptions;
	const onResult = options.onResult;
	const cache = options.cache ?? null;
	const scope = options.scope ?? '';
	const bypassCache = options.bypassCache === true;

	const aborted = () => signal?.aborted === true;

	const states = new Map<string, VerifiedVideoState>();
	const failures: FeedCheckFailure[] = [];
	let checked = 0;
	let cached = 0;

	const unique: string[] = [];
	const seen = new Set<string>();
	for (const videoId of videoIds) {
		if (typeof videoId !== 'string' || videoId.length === 0 || seen.has(videoId)) continue;
		seen.add(videoId);
		unique.push(videoId);
	}

	const pending: string[] = [];
	for (const videoId of unique) {
		const hit = cache && !bypassCache ? cache.get(scope, videoId) : undefined;
		if (hit) {
			states.set(videoId, hit);
			cached++;
			onResult?.(hit);
			continue;
		}
		pending.push(videoId);
	}

	if (aborted()) {
		return { states, failures, checked, cached, aborted: true };
	}

	const publish = (state: VerifiedVideoState) => {
		states.set(state.videoId, state);
		cache?.set(scope, state.videoId, state);
		onResult?.(state);
	};

	const results = await mapLimit(pending, concurrency, async (videoId) => {
		if (aborted()) throw new Error('Aborted');

		const value = await runRequest(timeoutMs, signal, (requestSignal) =>
			deps.getVideo(videoId, undefined, { ...baseFetchOptions, signal: requestSignal })
		);
		const detail = validateDetail(value, videoId);

		checked++;
		publish({
			videoId,
			state: resolveLiveStateFromDetail(detail),
			checkedAt: Date.now(),
			detail
		});
		return detail;
	});

	results.forEach((result, index) => {
		if (result.status === 'rejected' && !aborted()) {
			// A malformed or failed detail is unresolved, never offline.
			const videoId = pending[index];
			const error = errorMessage(result.reason);
			checked++;
			failures.push({ videoId, error });
			publish({ videoId, state: 'unknown', checkedAt: Date.now(), error });
		}
	});

	return { states, failures, checked, cached, aborted: aborted() };
}
