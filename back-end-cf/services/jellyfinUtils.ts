export const JELLYFIN_CONFIG_FILENAME = '.jellyfinconfig';
export const JELLYFIN_MANIFEST_FILENAME = '.jellyfinmanifest.json';

const JELLYFIN_STREAM_ID_NAMESPACE = 'skybridge-jellyfin-stream-v1';

async function jellyfinStreamId(sourcePath: string): Promise<string> {
  const input = new TextEncoder().encode(`${JELLYFIN_STREAM_ID_NAMESPACE}\n${sourcePath}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const VIDEO_EXTENSIONS = new Set([
  'avi',
  'flv',
  'm2ts',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'mts',
  'ts',
  'webm',
  'wmv',
]);

export interface JellyfinConfig {
  moviePath: string;
  seriesPath: string;
}

export interface ResolvedJellyfinConfig extends JellyfinConfig {
  configPath: string;
  movieOutputPath: string;
  seriesOutputPath: string;
}

export function normalizeJellyfinPath(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Path must be a non-empty string');
  }

  const input = value.trim().replaceAll('\\', '/');
  if (!input.startsWith('/')) {
    throw new Error(`Path must be absolute: ${value}`);
  }
  if (input.includes('\0')) {
    throw new Error('Path cannot contain a null byte');
  }

  const segments: string[] = [];
  for (const segment of input.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (!segments.length) {
        throw new Error(`Path escapes the exposed root: ${value}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length ? `/${segments.join('/')}` : '/';
}

export function joinJellyfinPath(parent: string, child: string): string {
  const normalizedParent = normalizeJellyfinPath(parent);
  return normalizeJellyfinPath(`${normalizedParent === '/' ? '' : normalizedParent}/${child}`);
}

export function isSameOrDescendant(path: string, parent: string): boolean {
  const normalizedPath = normalizeJellyfinPath(path);
  const normalizedParent = normalizeJellyfinPath(parent);
  return (
    normalizedParent === '/' ||
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  );
}

function pathsOverlap(first: string, second: string): boolean {
  return isSameOrDescendant(first, second) || isSameOrDescendant(second, first);
}

export function parseJellyfinConfig(raw: string, configPath: string): ResolvedJellyfinConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${JELLYFIN_CONFIG_FILENAME} must contain valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${JELLYFIN_CONFIG_FILENAME} must contain a JSON object`);
  }

  const config = parsed as Record<string, unknown>;
  if (typeof config.moviePath !== 'string' || typeof config.seriesPath !== 'string') {
    throw new Error(`${JELLYFIN_CONFIG_FILENAME} requires moviePath and seriesPath strings`);
  }

  const normalizedConfigPath = normalizeJellyfinPath(configPath);
  const moviePath = normalizeJellyfinPath(config.moviePath);
  const seriesPath = normalizeJellyfinPath(config.seriesPath);
  const movieOutputPath = joinJellyfinPath(normalizedConfigPath, 'Movies');
  const seriesOutputPath = joinJellyfinPath(normalizedConfigPath, 'Series');

  for (const [label, source, output] of [
    ['movie', moviePath, movieOutputPath],
    ['series', seriesPath, seriesOutputPath],
  ] as const) {
    if (pathsOverlap(source, output)) {
      throw new Error(`${label} source and generated output paths cannot overlap`);
    }
  }

  return {
    configPath: normalizedConfigPath,
    moviePath,
    seriesPath,
    movieOutputPath,
    seriesOutputPath,
  };
}

export function isJellyfinVideo(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  const dotIndex = name.lastIndexOf('.');
  return dotIndex > 0 && VIDEO_EXTENSIONS.has(name.slice(dotIndex + 1).toLowerCase());
}

export function toJellyfinStreamPath(
  sourcePath: string,
  sourceRoot: string,
  outputRoot: string,
): string {
  const normalizedSource = normalizeJellyfinPath(sourcePath);
  const normalizedRoot = normalizeJellyfinPath(sourceRoot);
  if (
    !isSameOrDescendant(normalizedSource, normalizedRoot) ||
    normalizedSource === normalizedRoot
  ) {
    throw new Error(`${sourcePath} is not a child of ${sourceRoot}`);
  }
  if (!isJellyfinVideo(normalizedSource)) {
    throw new Error(`${sourcePath} is not a supported video file`);
  }

  const relativePath = normalizedSource.slice(normalizedRoot.length).replace(/^\//, '');
  const streamRelativePath = relativePath.replace(/\.[^/.]+$/, '.strm');
  return joinJellyfinPath(outputRoot, streamRelativePath);
}

export async function buildJellyfinStreamUrl(origin: string, sourcePath: string): Promise<string> {
  const normalizedSourcePath = normalizeJellyfinPath(sourcePath);
  const extension = normalizedSourcePath.split('.').pop()?.toLowerCase();
  if (!extension || !VIDEO_EXTENSIONS.has(extension)) {
    throw new Error(`${sourcePath} is not a supported video file`);
  }

  // Jellyfin's Android client expects a 32-hex media id between path separators
  // when it creates its HTTP cache key. The id only identifies this stable URL;
  // the file query parameter remains the authoritative OneDrive source path.
  const streamId = await jellyfinStreamId(normalizedSourcePath);
  const url = new URL(`/jellyfin/${streamId}/stream.${extension}`, origin);
  url.searchParams.set('file', normalizedSourcePath);
  return url.toString();
}

export function jellyfinPathDepth(path: string): number {
  return normalizeJellyfinPath(path).split('/').filter(Boolean).length;
}
