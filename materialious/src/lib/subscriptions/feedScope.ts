import { get } from 'svelte/store';
import {
	authTokenStore,
	backendInUseStore,
	invidiousAuthStore,
	invidiousInstanceStore,
	materialiousBackendStore,
	rawMasterKeyStore
} from '$lib/store';
import type { FeedScopeInput } from './feedLive';

/**
 * Pure builder for the identity a subscription feed belongs to. The route load
 * and the page must derive the *same* key, so both call this with their own
 * (reactive vs. `get()`-read) values rather than re-implementing the account
 * encoding - a divergence there would strand the feed in a slot the page never
 * reads.
 */
export function buildFeedScopeInput(input: {
	engine?: FeedScopeInput['engine'];
	instance?: FeedScopeInput['instance'];
	backend?: FeedScopeInput['backend'];
	invidiousToken?: string | null;
	authToken?: string | null;
	masterKey?: string | null;
}): FeedScopeInput {
	return {
		engine: input.engine,
		instance: input.instance,
		backend: input.backend,
		account: JSON.stringify([input.invidiousToken, input.authToken, input.masterKey])
	};
}

/**
 * The identity a subscription feed belongs to: engine, Invidious instance,
 * Materialious backend and account. The loaded feed and its verified live state
 * are both keyed by this, so switching identity never shows another one's feed
 * or reuses its flags.
 */
export function readFeedScope(): FeedScopeInput {
	return buildFeedScopeInput({
		engine: get(backendInUseStore),
		instance: get(invidiousInstanceStore),
		backend: get(materialiousBackendStore),
		invidiousToken: get(invidiousAuthStore)?.token,
		authToken: get(authTokenStore),
		masterKey: get(rawMasterKeyStore)
	});
}
