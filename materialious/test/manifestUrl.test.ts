import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHlsManifestUrl } from '../src/lib/api/invidious/manifestUrl.ts';

test('resolves fork companion HLS paths against the Invidious server, not the Android WebView', () => {
	assert.equal(
		resolveHlsManifestUrl(
			'/companion/api/manifest/hls/id/video',
			'https://invidious.example/api/v1/videos/video'
		),
		'https://invidious.example/companion/api/manifest/hls/id/video'
	);
});
test('preserves absolute HLS URLs and missing manifests', () => {
	assert.equal(
		resolveHlsManifestUrl(
			'https://manifest.googlevideo.com/live.m3u8',
			'https://invidious.example/api/v1/videos/video'
		),
		'https://manifest.googlevideo.com/live.m3u8'
	);
	assert.equal(
		resolveHlsManifestUrl(undefined, 'https://invidious.example/api/v1/videos/video'),
		undefined
	);
});
