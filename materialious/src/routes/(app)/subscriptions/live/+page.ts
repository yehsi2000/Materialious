import { authProtected } from '$lib/auth';

// The live view deliberately does NOT touch the subscription feed: it may be
// slow or failing, and a now-live list must not depend on it. The scan loads
// subscriptions itself.
export async function load() {
	authProtected();

	return {};
}
