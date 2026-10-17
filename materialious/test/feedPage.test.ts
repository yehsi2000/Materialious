import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	FEED_PAGE_SIZE,
	isFeedPageExhausted,
	mergeFeedPage,
	promoteFavouriteVideos
} from '../src/lib/subscriptions/feedPage.ts';

test('a page with no videos and no notifications is exhausted', () => {
	assert.equal(isFeedPageExhausted({ videos: [], notifications: [] }), true);
	assert.equal(isFeedPageExhausted({}), true);
	assert.equal(isFeedPageExhausted(null), true);
	assert.equal(isFeedPageExhausted({ videos: [{ videoId: 'a' }], notifications: [] }), false);
	assert.equal(isFeedPageExhausted({ videos: [], notifications: [{ id: 1 }] }), false);
});

test('mergeFeedPage appends a page deduped while keeping feed order', () => {
	const loaded = [{ videoId: 'a' }, { videoId: 'b' }];
	const merged = mergeFeedPage(loaded, {
		notifications: [{ videoId: 'n1' }],
		videos: [{ videoId: 'b' }, { videoId: 'c' }]
	});

	assert.deepEqual(
		merged.map((v) => v.videoId),
		['a', 'b', 'n1', 'c']
	);
	// The source rows are never mutated.
	assert.deepEqual(
		loaded.map((v) => v.videoId),
		['a', 'b']
	);
});

test('promoteFavouriteVideos moves favourited channels first without mutating input', () => {
	const videos = [
		{ videoId: 'a', authorId: 'X' },
		{ videoId: 'b', authorId: 'FAV' },
		{ videoId: 'c', authorId: 'X' }
	];

	const out = promoteFavouriteVideos(videos, ['FAV']) as { videoId: string; promotedBy?: string }[];

	assert.deepEqual(
		out.map((v) => v.videoId),
		['b', 'a', 'c']
	);
	assert.equal(out[0].promotedBy, 'favourited');
	assert.equal((videos[0] as { promotedBy?: string }).promotedBy, undefined);
	assert.deepEqual(
		promoteFavouriteVideos(videos, []).map((v) => v.videoId),
		['a', 'b', 'c']
	);
});

test('FEED_PAGE_SIZE is the 100-video page the feed uses', () => {
	assert.equal(FEED_PAGE_SIZE, 100);
});
