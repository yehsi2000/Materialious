import type { LiveScanResult } from './live';

export interface LiveCacheScope {
	engine?: string | null;
	instance?: string | null;
	backend?: string | null;
	account?: string | null;
}

export interface LiveCache {
	get(key: string): LiveScanResult | undefined;
	set(key: string, result: LiveScanResult): void;
	has(key: string): boolean;
	clear(): void;
	size(): number;
}

interface CacheEntry {
	result: LiveScanResult;
	storedAt: number;
}

/**
 * Short-lived, instance-scoped cache for a live-scan result. Keyed by the
 * instance/backend/account scope so switching Invidious instance, Materialious
 * backend or account never shows another scope's lives. A manual refresh
 * bypasses this cache by simply not consulting it.
 */
export function createLiveCache(ttlMs: number, now: () => number = Date.now): LiveCache {
	const entries = new Map<string, CacheEntry>();

	return {
		get(key: string) {
			const entry = entries.get(key);
			if (!entry) return undefined;
			if (now() - entry.storedAt >= ttlMs) {
				entries.delete(key);
				return undefined;
			}
			return entry.result;
		},
		set(key: string, result: LiveScanResult) {
			entries.set(key, { result, storedAt: now() });
		},
		has(key: string) {
			return this.get(key) !== undefined;
		},
		clear() {
			entries.clear();
		},
		size() {
			return entries.size;
		}
	};
}

export function buildLiveCacheKey(scope: LiveCacheScope): string {
	return JSON.stringify([
		scope.engine ?? '',
		scope.instance ?? '',
		scope.backend ?? '',
		scope.account ?? ''
	]);
}
