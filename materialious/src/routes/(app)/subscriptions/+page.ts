import { getFeed } from '$lib/api/index';
import type { PlaylistPageVideo, Video, VideoBase } from '$lib/api/model';
import { localDb } from '$lib/dexie';
import { authProtected } from '$lib/auth';
import { feedCacheStore, feedLoadingStore } from '$lib/store';
import { get } from 'svelte/store';
import { buildFeedScopeKey, feedCacheSlot } from '$lib/subscriptions/feedLive';
import { readFeedScope } from '$lib/subscriptions/feedScope';
import { runRequest } from '$lib/subscriptions/scanCore';
import { FEED_PAGE_SIZE, promoteFavouriteVideos } from '$lib/subscriptions/feedPage';

type supportedVideos = (VideoBase | Video | PlaylistPageVideo)[];

/**
 * Promote videos from favourited channels to the top of the loaded feed. The
 * same helper is used by the page's refresh/recovery so a refresh keeps the
 * ordering the initial load produced.
 */
async function sortVideosByFavourites(videos: supportedVideos): Promise<supportedVideos> {
	if (!window.indexedDB) return videos;

	const favouritedChannels = (await localDb.favouriteChannels.toArray()).map(
		(channel) => channel.channelId
	);

	return promoteFavouriteVideos(videos, favouritedChannels);
}

export async function load() {
	authProtected();

	feedLoadingStore.set(true);

	// Publish the feed under the identity it was loaded for, so a switch during
	// the (possibly slow) request can never expose this feed to another scope.
	const scopeKey = buildFeedScopeKey(readFeedScope());
	const slot = feedCacheSlot(scopeKey);

	try {
		const feed = await runRequest(12000, undefined, (signal) =>
			getFeed(FEED_PAGE_SIZE, 1, { signal })
		);
		const videos = await sortVideosByFavourites([...feed.notifications, ...feed.videos]);

		// If the identity changed while loading, discard instead of leaking it.
		if (buildFeedScopeKey(readFeedScope()) !== scopeKey) {
			return { feedUnavailable: false };
		}

		feedCacheStore.set({ ...get(feedCacheStore), [slot]: videos });
	} catch {
		// Keep the independent live scanner reachable during a merged-feed outage.
		return { feedUnavailable: true };
	} finally {
		feedLoadingStore.set(false);
	}
	return { feedUnavailable: false };
}
