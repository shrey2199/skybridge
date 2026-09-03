import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildJellyfinStreamUrl,
  isJellyfinVideo,
  normalizeJellyfinPath,
  parseJellyfinConfig,
  toJellyfinStreamPath,
} from './jellyfinUtils.ts';

test('normalizes absolute paths without allowing root escape', () => {
  assert.equal(normalizeJellyfinPath('/Movies//Drama/../Film.mkv'), '/Movies/Film.mkv');
  assert.throws(() => normalizeJellyfinPath('../../Movies'), /absolute/);
  assert.throws(() => normalizeJellyfinPath('/../Movies'), /escapes/);
});

test('parses config and derives output paths from its folder', () => {
  assert.deepEqual(
    parseJellyfinConfig('{"moviePath":"/Movies","seriesPath":"/Series"}', '/Jellyfin'),
    {
      configPath: '/Jellyfin',
      moviePath: '/Movies',
      seriesPath: '/Series',
      movieOutputPath: '/Jellyfin/Movies',
      seriesOutputPath: '/Jellyfin/Series',
    },
  );
});

test('rejects source and output overlap', () => {
  assert.throws(
    () => parseJellyfinConfig('{"moviePath":"/Jellyfin","seriesPath":"/Series"}', '/Jellyfin'),
    /cannot overlap/,
  );
});

test('filters video extensions case-insensitively', () => {
  assert.equal(isJellyfinVideo('/Movies/Film.MKV'), true);
  assert.equal(isJellyfinVideo('/Movies/poster.jpg'), false);
  assert.equal(isJellyfinVideo('/Movies/no-extension'), false);
});

test('mirrors nested paths and replaces only the final extension', () => {
  assert.equal(
    toJellyfinStreamPath(
      '/Movies/Film.Name (2025)/Film.Name (2025).mkv',
      '/Movies',
      '/Jellyfin/Movies',
    ),
    '/Jellyfin/Movies/Film.Name (2025)/Film.Name (2025).strm',
  );
});

test('builds a stable Android-compatible encoded worker URL', async () => {
  const first = await buildJellyfinStreamUrl(
    'https://worker.example.com/sb/',
    '/Movies/A & B/Film.MKV',
  );
  const second = await buildJellyfinStreamUrl(
    'https://worker.example.com/sb/',
    '/Movies/A & B/Film.MKV',
  );

  assert.equal(first, second);
  assert.match(
    first,
    /^https:\/\/worker\.example\.com\/jellyfin\/[0-9a-f]{32}\/stream\.mkv\?file=/,
  );
  assert.equal(new URL(first).searchParams.get('file'), '/Movies/A & B/Film.MKV');
});

test('uses different compatibility ids for different source paths', async () => {
  const first = await buildJellyfinStreamUrl('https://worker.example.com', '/Movies/One.mkv');
  const second = await buildJellyfinStreamUrl('https://worker.example.com', '/Movies/Two.mkv');

  assert.notEqual(new URL(first).pathname, new URL(second).pathname);
});

test('rejects unsupported files when building stream URLs', async () => {
  await assert.rejects(
    buildJellyfinStreamUrl('https://worker.example.com', '/Movies/poster.jpg'),
    /not a supported video file/,
  );
});
