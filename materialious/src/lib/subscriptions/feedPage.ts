import { dedupeFeedItems } from './feedLive.ts';

/**
 * Pure pagination helpers for the feed-first subscriptions page.
 *
 * They contain no Svelte/store/window access so the page, the route load and
 * the unit tests all share one definition of page size, exhausted pages, merge
 * order and favourite promotion.
 */

/** Page size requested from the subscription feed. */
export const FEED_PAGE_SIZE = 100;

export interface FeedPageLike {
	videos?: unknown[] | null;
	notifications?: unknown[] | null;
}

/**
 * A page with neither videos nor notifications is exhausted: the feed has no
 * more history to page through. Missing/typed-wrong fields count as empty so a
 * malformed tail never keeps a "Load more" control alive forever.
 */
export function isFeedPageExhausted(page: FeedPageLike | null | undefined): boolean {
	const videos = page?.videos;
	const notifications = page?.notifications;
	const videoCount = Array.isArray(videos) ? videos.length : 0;
	const notificationCount = Array.isArray(notifications) ? notifications.length : 0;
	return videoCount === 0 && notificationCount === 0;
}

/**
 * Append a freshly loaded page to the already-loaded rows: notifications first
 * (matching the route load), repeated video ids dropped, feed order preserved.
 * The input array is never mutated.
 */
export function mergeFeedPage<T>(loaded: T[], page: FeedPageLike | null | undefined): T[] {
	const notifications = (Array.isArray(page?.notifications) ? page?.notifications : []) as T[];
	const videos = (Array.isArray(page?.videos) ? page?.videos : []) as T[];
	return dedupeFeedItems([...loaded, ...notifications, ...videos]);
}

/**
 * Stable promotion of videos from favourited channels to the top of the first
 * page, preserving the relative order within each group. Copies the input so
 * the caller's rows are never mutated. Used by both the route load and refresh
 * so a refresh keeps the same favourite ordering as the initial load.
 */
export function promoteFavouriteVideos<T>(videos: T[], favouriteChannelIds: string[]): T[] {
	if (favouriteChannelIds.length === 0) return videos.slice();

	const favouriteSet = new Set(favouriteChannelIds);
	const favourites: T[] = [];
	const regular: T[] = [];

	for (const video of videos) {
		const authorId = (video as { authorId?: unknown })?.authorId;
		if (typeof authorId === 'string' && favouriteSet.has(authorId)) {
			favourites.push({
				...(video as Record<string, unknown>),
				promotedBy: 'favourited'
			} as unknown as T);
		} else {
			regular.push(video);
		}
	}

	return [...favourites, ...regular];
}
