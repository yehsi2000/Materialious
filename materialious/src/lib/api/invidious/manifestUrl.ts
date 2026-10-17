/** Keep native WebView playback on the configured Invidious server. */
export function resolveHlsManifestUrl(
	url: string | undefined,
	videoApiUrl: string
): string | undefined {
	return url ? new URL(url, videoApiUrl).toString() : undefined;
}
