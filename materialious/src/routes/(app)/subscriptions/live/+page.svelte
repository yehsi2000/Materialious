<script lang="ts">
	import { untrack } from 'svelte';
	import { getChannelContent, getSubscriptions, getVideo } from '$lib/api';
	import ItemsList from '$lib/components/layout/ItemsList.svelte';
	import PageLoading from '$lib/components/PageLoading.svelte';
	import NoResults from '$lib/components/NoResults.svelte';
	import { _ } from '$lib/i18n';
	import { resolve } from '$app/paths';
	import {
		invidiousAuthStore,
		invidiousInstanceStore,
		materialiousBackendStore,
		rawMasterKeyStore,
		backendInUseStore,
		authTokenStore
	} from '$lib/store';
	import { scanLive, type LiveScanProgress, type LiveScanResult } from '$lib/subscriptions/live';
	import { buildLiveCacheKey, createLiveCache } from '$lib/subscriptions/liveCache';

	// Short, instance-scoped cache. A manual refresh bypasses it.
	const CACHE_TTL_MS = 2 * 60 * 1000;
	const liveCache = createLiveCache(CACHE_TTL_MS);

	// The whole-channel scan is an explicit, optional tool. Merely opening it does
	// NOT start a scan: the user must press Start. The default Now live experience
	// is the feed-first filter on the subscriptions page.
	let started: boolean = $state(false);
	let status: 'loading' | 'done' | 'error' = $state('loading');
	let result: LiveScanResult | null = $state(null);
	let progress: LiveScanProgress | null = $state(null);
	let errorMessage: string | null = $state(null);
	let refreshing = $state(false);

	let hasResult = false;
	let controller: AbortController | null = null;

	const scope = $derived(
		buildLiveCacheKey({
			engine: $backendInUseStore,
			instance: $invidiousInstanceStore,
			backend: $materialiousBackendStore,
			account: JSON.stringify([$invidiousAuthStore?.token, $authTokenStore, $rawMasterKeyStore])
		})
	);
	let displayedScope = '';

	async function runScan(bypassCache: boolean = false) {
		controller?.abort();
		const local = new AbortController();
		controller = local;
		const signal = local.signal;
		const scopeKey = scope;

		if (!bypassCache) {
			const cached = liveCache.get(scopeKey);
			if (cached) {
				result = cached;
				hasResult = true;
				status = 'done';
				progress = null;
				refreshing = false;
				return;
			}
		}

		status = hasResult ? 'done' : 'loading';
		refreshing = true;
		errorMessage = null;
		progress = null;

		try {
			// Detail fetches are only authoritative within the backend's own cache
			// window; a manual refresh also asks the client not to serve a cached copy.
			const scanned = await scanLive(
				{ getSubscriptions, getChannelContent, getVideo },
				{
					signal,
					onProgress: (value) => {
						progress = value;
					},
					fetchOptions: bypassCache ? { cache: 'no-store' } : {}
				}
			);

			if (signal.aborted) return;

			liveCache.set(scopeKey, scanned);
			result = scanned;
			hasResult = true;
			status = 'done';
		} catch (error) {
			if (signal.aborted) return;
			status = 'error';
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			if (!signal.aborted) {
				refreshing = false;
				progress = null;
			}
		}
	}

	// Only a deliberate user action starts the scan. No mount-time effect calls
	// runScan, so opening the page issues no channel requests.
	function startScan() {
		started = true;
		runScan(false);
	}

	// Reset the view when the identity changes; the cleanup cancels an in-flight
	// scan on navigation. This effect never starts a scan.
	$effect(() => {
		const nextScope = scope;
		untrack(() => {
			if (displayedScope !== nextScope) {
				controller?.abort();
				liveCache.clear();
				result = null;
				hasResult = false;
				errorMessage = null;
				started = false;
				displayedScope = nextScope;
			}
		});
		return () => controller?.abort();
	});
</script>

<div class="padding live-header">
	<nav>
		<h1 class="no-margin live-title">{$_('subscriptionsLive.title')}</h1>
		<div class="max"></div>
		{#if started}
			<button class="surface-container-highest" disabled={refreshing} onclick={() => runScan(true)}>
				<i>{refreshing ? 'sync' : 'refresh'}</i>
				<span
					>{refreshing ? $_('subscriptionsLive.refreshing') : $_('subscriptionsLive.refresh')}</span
				>
			</button>
		{/if}
	</nav>

	<div class="live-meta">
		{#if result}
			<span class="small"
				>{$_('subscriptionsLive.lastChecked', {
					time: new Date(result.lastChecked).toLocaleTimeString()
				})}</span
			>
		{:else}
			<span class="small">{$_('subscriptionsLive.neverChecked')}</span>
		{/if}
	</div>

	<div class="live-meta small">{$_('subscriptionsLive.coverage')}</div>

	{#if refreshing}
		<div class="live-progress small">
			{#if progress && progress.phase === 'channels'}
				{$_('subscriptionsLive.checkingChannels', {
					checked: progress.channelsChecked,
					total: progress.channelsTotal
				})}
			{:else if progress}
				{$_('subscriptionsLive.checkingVideos', {
					checked: progress.videosChecked,
					total: progress.candidateCount
				})}
			{:else}
				{$_('subscriptionsLive.preparing')}
			{/if}
		</div>
	{/if}
</div>

{#if !started}
	<div class="center-align padding">
		<p>{$_('subscriptionsLive.scanScope')}</p>
		<button class="primary" onclick={startScan}>
			<i>sensors</i>
			<span>{$_('subscriptionsLive.startScan')}</span>
		</button>
	</div>
{:else if status === 'error'}
	<div class="center-align padding">
		<h6>{$_('subscriptionsLive.error')}</h6>
		{#if errorMessage}<p class="small">{errorMessage}</p>{/if}
		<button class="surface-container-highest" onclick={() => runScan(true)}>
			{$_('subscriptionsLive.retry')}
		</button>
	</div>
{:else if !result}
	<PageLoading />
{:else if result.channelsTotal === 0}
	<NoResults />
	<div class="center-align padding">
		<p>{$_('subscriptionsLive.noSubscriptions')}</p>
		<a class="button surface-container-highest" href={resolve('/subscriptions/manage', {})}>
			{$_('subscriptions.manageSubscriptions')}
		</a>
	</div>
{:else}
	{#if result.lives.length > 0}
		<ItemsList items={result.lives} />
	{:else}
		<NoResults />
		<div class="center-align padding">
			<p>
				{$_(
					result.channelFailures.length ||
						result.videoFailures.length ||
						result.truncatedChannels.length
						? 'subscriptionsLive.noConfirmedLive'
						: 'subscriptionsLive.noLive'
				)}
			</p>
		</div>
	{/if}

	{#if result.channelFailures.length > 0}
		<div class="center-align padding">
			<p class="small">
				{$_('subscriptionsLive.partialChannels', { n: result.channelFailures.length })}
			</p>
		</div>
	{/if}
	{#if result.videoFailures.length > 0}
		<div class="center-align padding">
			<p class="small">
				{$_('subscriptionsLive.partialVideos', { n: result.videoFailures.length })}
			</p>
		</div>
	{/if}
	{#if result.truncatedChannels.length > 0}
		<div class="center-align padding">
			<p class="small">
				{$_('subscriptionsLive.truncated', { n: result.truncatedChannels.length })}
			</p>
		</div>
	{/if}
{/if}

<style>
	.live-header {
		padding-top: 0.5em;
	}

	.live-title {
		font-size: 1.5rem;
	}

	.live-meta {
		margin-top: 0.25em;
	}

	.live-progress {
		margin-top: 0.5em;
	}

	@media screen and (max-width: 590px) {
		.live-header nav {
			flex-wrap: wrap;
		}
	}
</style>
