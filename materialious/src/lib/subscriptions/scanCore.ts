import type { Video } from '$lib/api/model';

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 12000;

/** The reason a request was aborted because its per-request timeout elapsed. */
export class RequestTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Request timed out after ${timeoutMs}ms`);
		this.name = 'RequestTimeoutError';
	}
}

export function errorMessage(error: unknown): string {
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
export async function runRequest<T>(
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
export async function mapLimit<T, R>(
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

/**
 * A detail response is the only source of truth for liveNow. Anything that does
 * not line up exactly is unresolved - it must never be silently downgraded to
 * "offline".
 */
export function validateDetail(value: unknown, expectedVideoId: string): Video {
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
