<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { getFeed } from '$lib/api/index';
	import { getVideo } from '$lib/api';
	import type { PlaylistPageVideo, Video, VideoBase } from '$lib/api/model';
	import { localDb } from '$lib/dexie';
	import {
		authTokenStore,
		backendInUseStore,
		feedCacheStore,
		feedLoadingStore,
		invidiousAuthStore,
		invidiousInstanceStore,
		materialiousBackendStore,
		rawMasterKeyStore
	} from '$lib/store';
	import ItemsList from '$lib/components/layout/ItemsList.svelte';
	import { resolve } from '$app/paths';
	import { _ } from '$lib/i18n';
	import PageLoading from '$lib/components/PageLoading.svelte';

	import {
		applyLiveStateToItem,
		buildFeedScopeKey,
		checkFeedVideos,
		createVideoStateCache,
		dedupeFeedItems,
		feedCacheSlot,
		filterFeedItems,
		resolveItemState,
		type FeedLiveFilter,
		type VerifiedVideoState,
		type VideoLiveState
	} from '$lib/subscriptions/feedLive';
	import { buildFeedScopeInput } from '$lib/subscriptions/feedScope';
	import {
		FEED_PAGE_SIZE,
		isFeedPageExhausted,
		mergeFeedPage,
		promoteFavouriteVideos
	} from '$lib/subscriptions/feedPage';
	import { errorMessage, runRequest } from '$lib/subscriptions/scanCore';

	// Feed-first: the subscription feed is shown immediately. In the background
	// only the already-loaded video ids are verified, with bounded concurrency and
	// timeouts; subscribed channel pages are never listed here (that is the
	// separate, manual Full channel scan). Verified state is cached per identity
	// for a short window, so toggling the filters never re-fetches a checked video.
	const STATE_TTL_MS = 2 * 60 * 1000;
	// Every feed request is bounded so a stuck backend can never leave the page
	// spinning forever; it fails visibly and offers a retry instead.
	const FEED_TIMEOUT_MS = 12000;
	const stateCache = createVideoStateCache(STATE_TTL_MS);

	let filter: FeedLiveFilter = $state('all');
	let states: Record<string, VerifiedVideoState> = $state({});
	let checking = $state(false);
	let progressChecked = $state(0);
	let progressTotal = $state(0);
	let lastCheckedAt = $state<number | null>(null);

	// Pagination is explicit: page 1 is loaded by the route, every further page
	// only by pressing Load more. Nothing pages automatically, so an empty
	// filtered result can never crawl the whole history.
	let currentPage = $state(1);
	let pageComplete = $state(false);
	let pageLoading = $state(false);
	let initialLoading = $state(false);
	let refreshing = $state(false);
	// Distinct errors so each one retries the operation that actually failed.
	let pageError = $state<string | null>(null);
	let refreshError = $state<string | null>(null);
	let initialError = $state<string | null>(null);

	let checkController: AbortController | null = null;
	let feedController: AbortController | null = null;
	onDestroy(() => {
		feedController?.abort();
		checkController?.abort();
	});
	let displayedScope = '';
	// Set by refresh before publishing a fresh first page so the very next check
	// re-verifies every id (bypassing the cache) even when the content is identical.
	let bypassNextCheck = false;

	// Bound to the identity so a switch during an async load cannot leak a feed or
	// reuse another identity's verified flags. Both the route load and this page
	// build the scope through the same helper, so the keys cannot drift apart.
	const scopeKey = $derived(
		buildFeedScopeKey(
			buildFeedScopeInput({
				engine: $backendInUseStore,
				instance: $invidiousInstanceStore,
				backend: $materialiousBackendStore,
				invidiousToken: $invidiousAuthStore?.token,
				authToken: $authTokenStore,
				masterKey: $rawMasterKeyStore
			})
		)
	);
	const slot = $derived(feedCacheSlot(scopeKey));

	const videos = $derived(
		($feedCacheStore[slot] ?? []) as (VideoBase | Video | PlaylistPageVideo)[]
	);
	const items = $derived(dedupeFeedItems(videos));
	const cacheHasSlot = $derived(slot in $feedCacheStore);

	const stateOf = (videoId: string): VideoLiveState | undefined => states[videoId]?.state;
	const resolvedItems = $derived(
		items.map((item) => applyLiveStateToItem(item, resolveItemState(item.videoId, stateOf)))
	);
	const visibleItems = $derived(filterFeedItems(resolvedItems, filter, stateOf));
	const liveCount = $derived(filterFeedItems(resolvedItems, 'live', stateOf).length);
	const upcomingCount = $derived(filterFeedItems(resolvedItems, 'upcoming', stateOf).length);
	const unverifiedCount = $derived(
		items.filter((item) => resolveItemState(item.videoId, stateOf) === 'unknown').length
	);

	const currentIds = () =>
		items
			.map((item) => item.videoId)
			.filter((videoId): videoId is string => typeof videoId === 'string');

	// --- background verification ---------------------------------------------

	async function runCheck(ids: string[], targetScope: string, bypassCache: boolean) {
		checkController?.abort();
		const local = new AbortController();
		checkController = local;

		if (ids.length === 0) {
			checking = false;
			progressChecked = 0;
			progressTotal = 0;
			return;
		}

		checking = true;
		progressChecked = 0;
		progressTotal = ids.length;

		try {
			await checkFeedVideos({ getVideo }, ids, {
				signal: local.signal,
				cache: stateCache,
				scope: targetScope,
				bypassCache,
				onResult: (state) => {
					if (local.signal.aborted) return;
					progressChecked++;
					states = { ...states, [state.videoId]: state };
				}
			});
		} finally {
			// An old run must never clear the flag of a newer run.
			if (!local.signal.aborted && checkController === local) {
				checking = false;
				lastCheckedAt = Date.now();
			}
		}
	}

	// Re-verify whenever the loaded feed or the identity changes; the cleanup
	// cancels an in-flight check on navigation or scope change. Newly paginated
	// items flow through here too (already-verified ids come from the cache).
	$effect(() => {
		const targetScope = scopeKey;
		const ids = items
			.map((item) => item.videoId)
			.filter((videoId): videoId is string => typeof videoId === 'string');

		untrack(() => {
			if (displayedScope !== targetScope) {
				resetForScope(targetScope);
			}
			const bypassCache = bypassNextCheck;
			bypassNextCheck = false;
			runCheck(ids, targetScope, bypassCache);
		});

		return () => checkController?.abort();
	});

	// --- feed loading ---------------------------------------------------------

	async function fetchFeedPage(pageNumber: number, bypassCache: boolean, signal: AbortSignal) {
		return runRequest(FEED_TIMEOUT_MS, signal, (requestSignal) =>
			getFeed(FEED_PAGE_SIZE, pageNumber, {
				signal: requestSignal,
				...(bypassCache ? { cache: 'no-store' as const } : {})
			})
		);
	}

	async function loadFavouriteChannelIds(): Promise<string[]> {
		if (typeof window === 'undefined' || !window.indexedDB) return [];
		try {
			return (await localDb.favouriteChannels.toArray()).map((channel) => channel.channelId);
		} catch {
			return [];
		}
	}

	function beginFeedRequest(): AbortController {
		feedController?.abort();
		// Superseding pagination with refresh must release the old operation's
		// UI flags; its guarded finally intentionally cannot change this run.
		pageLoading = false;
		initialLoading = false;
		refreshing = false;
		const local = new AbortController();
		feedController = local;
		return local;
	}

	// A late completion is stale once the scope or the slot changed, or a newer
	// feed request replaced this one: discard it instead of leaking it.
	function isStale(local: AbortController, targetSlot: string, targetScope: string): boolean {
		return (
			local.signal.aborted ||
			feedController !== local ||
			slot !== targetSlot ||
			scopeKey !== targetScope
		);
	}

	function resetForScope(targetScope: string) {
		feedController?.abort();
		checkController?.abort();
		states = {};
		currentPage = 1;
		pageComplete = false;
		pageLoading = false;
		initialLoading = false;
		refreshing = false;
		pageError = null;
		refreshError = null;
		initialError = null;
		lastCheckedAt = null;
		bypassNextCheck = false;
		displayedScope = targetScope;
	}

	// Load the first page for a scope the route load did not publish (e.g. the
	// identity settled after the load, or it switched on this page). A failure is
	// surfaced with a retry, never an endless spinner.
	async function loadFirstPage(targetSlot: string, targetScope: string) {
		const local = beginFeedRequest();
		initialLoading = true;
		initialError = null;

		try {
			const feed = await fetchFeedPage(1, false, local.signal);
			if (isStale(local, targetSlot, targetScope)) return;

			const favouriteIds = await loadFavouriteChannelIds();
			if (isStale(local, targetSlot, targetScope)) return;

			const ordered = promoteFavouriteVideos([...feed.notifications, ...feed.videos], favouriteIds);
			currentPage = 1;
			pageComplete = isFeedPageExhausted(feed);
			feedCacheStore.set({ ...$feedCacheStore, [targetSlot]: ordered });
		} catch (error) {
			if (local.signal.aborted || feedController !== local) return;
			initialError = errorMessage(error);
		} finally {
			if (feedController === local) initialLoading = false;
		}
	}

	// Manual refresh: refetch feed page 1 (resetting pagination), then re-verify
	// the loaded details. Rows stay visible while the request is in flight.
	async function refresh() {
		const targetSlot = slot;
		const targetScope = scopeKey;
		const local = beginFeedRequest();
		refreshing = true;
		refreshError = null;

		try {
			const feed = await fetchFeedPage(1, true, local.signal);
			if (isStale(local, targetSlot, targetScope)) return;

			const favouriteIds = await loadFavouriteChannelIds();
			if (isStale(local, targetSlot, targetScope)) return;

			const ordered = promoteFavouriteVideos([...feed.notifications, ...feed.videos], favouriteIds);

			// Reset pagination safely before publishing the fresh first page.
			currentPage = 1;
			pageComplete = isFeedPageExhausted(feed);
			bypassNextCheck = true;
			feedCacheStore.set({ ...$feedCacheStore, [targetSlot]: ordered });
		} catch (error) {
			if (local.signal.aborted || feedController !== local) return;
			// The feed could not be refreshed: keep the rows and report it, but
			// still retry the detail checks against what is already loaded.
			refreshError = errorMessage(error);
			runCheck(currentIds(), targetScope, true);
		} finally {
			if (feedController === local) refreshing = false;
		}
	}

	// Load more is explicit in every filter mode: it appends the next page and
	// never fires on its own, so an empty filtered result cannot page forever.
	async function loadMore() {
		if (pageLoading || pageComplete || refreshing || initialLoading) return;

		const targetSlot = slot;
		const targetScope = scopeKey;
		const nextPage = currentPage + 1;
		const local = beginFeedRequest();
		pageLoading = true;
		pageError = null;

		try {
			const feed = await fetchFeedPage(nextPage, false, local.signal);
			if (isStale(local, targetSlot, targetScope)) return;

			if (isFeedPageExhausted(feed)) {
				pageComplete = true;
				return;
			}

			const current = ($feedCacheStore[targetSlot] ?? []) as (
				| VideoBase
				| Video
				| PlaylistPageVideo
			)[];
			const merged = mergeFeedPage(current, feed);
			currentPage = nextPage;
			feedCacheStore.set({ ...$feedCacheStore, [targetSlot]: merged });
		} catch (error) {
			if (local.signal.aborted || feedController !== local) return;
			pageError = errorMessage(error);
		} finally {
			if (feedController === local) pageLoading = false;
		}
	}

	// Safety net for a scope the route load did not publish. Guarded so it runs
	// at most once per slot; a failure is shown with a retry instead of looping.
	const attemptedLoads: Record<string, true> = {};

	$effect(() => {
		const currentSlot = slot;
		const targetScope = scopeKey;
		if ($feedLoadingStore) return;
		if (currentSlot in $feedCacheStore) return;
		if (initialLoading || refreshing) return;
		if (attemptedLoads[currentSlot]) return;
		untrack(() => {
			attemptedLoads[currentSlot] = true;
			void loadFirstPage(currentSlot, targetScope);
		});
	});

	async function retryFeed() {
		await loadFirstPage(slot, scopeKey);
	}
</script>

<nav class="right-align subscriptions-actions">
	<a class="button primary" href={resolve('/subscriptions/live', {})}>
		<i>sensors</i>
		<span>{$_('subscriptionsLive.fullScan')}</span>
	</a>
	<a class="button surface-container-highest" href={resolve('/subscriptions/manage', {})}>
		{$_('subscriptions.manageSubscriptions')}
	</a>
</nav>
<div class="space"></div>

{#if !cacheHasSlot}
	{#if initialLoading || refreshing}
		<PageLoading />
	{:else}
		<div class="center-align padding" role="status">
			<p>{$_('subscriptionsLive.feedUnavailable')}</p>
			{#if initialError}<p class="small" role="alert">{initialError}</p>{/if}
			<button
				class="surface-container-highest"
				disabled={initialLoading || refreshing}
				onclick={retryFeed}
			>
				<i>refresh</i>
				<span>{$_('subscriptionsLive.retry')}</span>
			</button>
		</div>
	{/if}
{:else}
	<div class="feed-controls padding">
		<nav class="group feed-filters">
			<button
				class="no-round"
				class:active={filter === 'all'}
				aria-pressed={filter === 'all'}
				onclick={() => (filter = 'all')}
			>
				{$_('subscriptionsLive.filterAll')}
			</button>
			<button
				class="no-round"
				class:active={filter === 'live'}
				aria-pressed={filter === 'live'}
				onclick={() => (filter = 'live')}
			>
				{$_('subscriptionsLive.filterLive')}
				{#if liveCount > 0}<span class="filter-count">{liveCount}</span>{/if}
			</button>
			<button
				class="no-round"
				class:active={filter === 'upcoming'}
				aria-pressed={filter === 'upcoming'}
				onclick={() => (filter = 'upcoming')}
			>
				{$_('subscriptionsLive.filterUpcoming')}
				{#if upcomingCount > 0}<span class="filter-count">{upcomingCount}</span>{/if}
			</button>
		</nav>

		<div class="feed-status small">
			<p class="no-margin">{$_('subscriptionsLive.feedScope')}</p>
			{#if checking}
				<p class="no-margin" role="status">
					{$_('subscriptionsLive.feedChecking', { checked: progressChecked, total: progressTotal })}
				</p>
			{:else if lastCheckedAt}
				<p class="no-margin">
					{$_('subscriptionsLive.lastChecked', {
						time: new Date(lastCheckedAt).toLocaleTimeString()
					})}
				</p>
			{/if}
			{#if unverifiedCount > 0}
				<p class="no-margin" role="status">
					{$_('subscriptionsLive.feedUnverified', { n: unverifiedCount })}
				</p>
			{/if}
		</div>

		<nav class="right-align">
			<button class="surface-container-highest" disabled={checking || refreshing} onclick={refresh}>
				<i>{checking || refreshing ? 'sync' : 'refresh'}</i>
				<span
					>{checking || refreshing
						? $_('subscriptionsLive.refreshing')
						: $_('subscriptionsLive.refresh')}</span
				>
			</button>
		</nav>
	</div>

	{#if visibleItems.length === 0 && items.length > 0}
		<p class="padding center-align" role="status">{$_('subscriptionsLive.noFilterMatch')}</p>
	{/if}

	{#if refreshError}
		<div class="center-align padding" role="alert">
			<p class="small no-margin">{$_('subscriptionsLive.refreshFailed')}</p>
			<p class="small no-margin">{refreshError}</p>
			<button class="surface-container-highest" disabled={refreshing} onclick={refresh}>
				{$_('subscriptionsLive.retry')}
			</button>
		</div>
	{/if}

	{#if pageError}
		<div class="center-align padding" role="alert">
			<p class="small no-margin">{$_('subscriptionsLive.loadMoreFailed')}</p>
			<p class="small no-margin">{pageError}</p>
		</div>
	{/if}

	<ItemsList items={visibleItems} />

	<div class="feed-pagination center-align padding">
		{#if pageComplete}
			<p class="small no-margin" role="status">{$_('subscriptionsLive.noMore')}</p>
		{:else}
			<button
				class="surface-container-highest"
				disabled={pageLoading || refreshing}
				onclick={loadMore}
			>
				<i>{pageLoading ? 'sync' : 'expand_more'}</i>
				<span
					>{pageLoading
						? $_('subscriptionsLive.loadingMore')
						: $_('subscriptionsLive.loadMore')}</span
				>
			</button>
		{/if}
		{#if pageError}
			<button class="surface-container-highest" disabled={pageLoading} onclick={loadMore}>
				{$_('subscriptionsLive.retry')}
			</button>
		{/if}
	</div>
{/if}

<style>
	.feed-controls {
		display: flex;
		flex-direction: column;
		gap: 0.5em;
	}

	.feed-filters {
		margin: 0;
	}

	.filter-count {
		margin-left: 0.35em;
		opacity: 0.75;
	}

	.feed-status {
		opacity: 0.85;
	}
</style>
