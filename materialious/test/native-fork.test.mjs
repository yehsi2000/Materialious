import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('personal fork keeps a separate native identity and matching login callback', () => {
	assert.match(source('android/app/build.gradle'), /applicationId "us\.materialio\.app\.livefork"/);
	assert.match(source('capacitor.config.ts'), /appId: 'us\.materialio\.app\.livefork'/);
	assert.match(source('android/app/src/main/res/values/strings.xml'), /Materialious Live/);
	assert.match(
		source('android/app/src/main/AndroidManifest.xml'),
		/android:scheme="materialious-live-auth"/
	);
	assert.match(source('src/lib/auth.ts'), /materialious-live-auth:\/\//);
	assert.match(source('src/routes/+layout.svelte'), /'materialious-live-auth:'/);
	for (const callback of [
		'materialious-live-auth://?username=test&token=fixture',
		'materialious-live-auth:?username=test&token=fixture'
	]) {
		const parsed = new URL(callback);
		assert.equal(parsed.protocol, 'materialious-live-auth:');
		assert.equal(parsed.searchParams.get('username'), 'test');
	}
});

test('live view has a direct navigation entry independent of subscription feed loading', () => {
	assert.match(source('src/lib/navPages.ts'), /href: '\/subscriptions\/live'/);
});

test('fork proxy uses a distinct port consistently to avoid the official app server', () => {
	assert.match(source('static/nodejsAndroid/index.js'), /const PORT = 3001;/);
	assert.match(source('src/lib/fetchProxy.ts'), /http:\/\/localhost:3001\//);
});
