import type { DriveItem, DriveItemCollection } from '../types/apiType';
import { fetchWithAuth } from './fetchUtils';
import { buildUriPath } from './pathUtils';
import { sha256 } from './utils';
import {
  JELLYFIN_CONFIG_FILENAME,
  JELLYFIN_MANIFEST_FILENAME,
  buildJellyfinStreamUrl,
  isJellyfinVideo,
  jellyfinPathDepth,
  joinJellyfinPath,
  normalizeJellyfinPath,
  parseJellyfinConfig,
  toJellyfinStreamPath,
  type ResolvedJellyfinConfig,
} from './jellyfinUtils';

const JOB_VERSION = 1;
const MANIFEST_VERSION = 1;
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const FINISHED_JOB_TTL_SECONDS = 24 * 60 * 60;
const LIST_PAGE_SIZE = 100;
const MUTATIONS_PER_STEP = 10;
const MAX_ERRORS = 50;
const MAX_RETRIES = 5;
const CHUNK_THRESHOLD_CODE_UNITS = 64 * 1024;
const CHUNK_SIZE_CODE_UNITS = 128 * 1024;

const CHUNKED_JOB_FIELDS = [
  'scanQueue',
  'desired',
  'desiredDirectories',
  'actualStreams',
  'actualDirectories',
  'oldManifest',
  'directoryQueue',
  'streamQueue',
  'staleStreamQueue',
  'staleDirectoryQueue',
] as const;

type ChunkedJobField = (typeof CHUNKED_JOB_FIELDS)[number];

interface JobChunkReference {
  hash: string;
  chunks: number;
}

type JellyfinJobPhase =
  | 'scan_sources'
  | 'scan_outputs'
  | 'create_directories'
  | 'write_streams'
  | 'delete_streams'
  | 'delete_directories'
  | 'write_manifest'
  | 'done'
  | 'done_with_errors'
  | 'failed'
  | 'cancelled';

interface JellyfinManifestEntry {
  sourcePath: string;
  outputPath: string;
  size: number;
  lastModifiedDateTime: string;
  streamUrl: string;
  contentHash: string;
}

interface JellyfinManifest {
  version: number;
  origin: string;
  configFingerprint: string;
  generatedAt: string;
  entries: JellyfinManifestEntry[];
  directories: string[];
}

interface SourceScanTask {
  kind: 'source';
  sourceRoot: string;
  outputRoot: string;
  path: string;
  nextLink?: string;
}

interface OutputScanTask {
  kind: 'output';
  path: string;
  nextLink?: string;
}

type ScanTask = SourceScanTask | OutputScanTask;

interface JellyfinJobCounters {
  scannedFolders: number;
  discoveredVideos: number;
  planned: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
}

interface JellyfinJobError {
  path?: string;
  message: string;
}

interface JellyfinJob {
  version: number;
  id: string;
  configPath: string;
  configFilePath: string;
  configEtag?: string;
  config: ResolvedJellyfinConfig;
  configFingerprint: string;
  origin: string;
  phase: JellyfinJobPhase;
  createdAt: string;
  updatedAt: string;
  retryAt?: number;
  retryCount: number;
  scanQueue: ScanTask[];
  desired: Record<string, JellyfinManifestEntry & { collision?: boolean }>;
  desiredDirectories: string[];
  actualStreams: Record<string, { size: number; lastModifiedDateTime: string }>;
  actualDirectories: string[];
  oldManifest: JellyfinManifest | null;
  directoryQueue: string[];
  streamQueue: string[];
  staleStreamQueue: string[];
  staleDirectoryQueue: string[];
  counters: JellyfinJobCounters;
  errors: JellyfinJobError[];
  storage?: Partial<Record<ChunkedJobField, JobChunkReference>>;
}

interface JellyfinJobStatus {
  id: string;
  configPath: string;
  phase: JellyfinJobPhase;
  terminal: boolean;
  createdAt: string;
  updatedAt: string;
  retryAt?: number;
  counters: JellyfinJobCounters;
  errors: JellyfinJobError[];
}

class GraphRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }

  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

function jobKey(jobId: string) {
  return `jellyfin:job:${jobId}`;
}

function jobChunkKey(jobId: string, field: ChunkedJobField, hash: string, index: number) {
  return `${jobKey(jobId)}:chunk:${field}:${hash}:${index}`;
}

async function activeJobKey(configPath: string) {
  return `jellyfin:active:${await sha256(configPath.toLowerCase())}`;
}

function terminalPhase(phase: JellyfinJobPhase) {
  return ['done', 'done_with_errors', 'failed', 'cancelled'].includes(phase);
}

function toStatus(job: JellyfinJob): JellyfinJobStatus {
  return {
    id: job.id,
    configPath: job.configPath,
    phase: job.phase,
    terminal: terminalPhase(job.phase),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    retryAt: job.retryAt,
    counters: { ...job.counters },
    errors: job.errors.slice(-10),
  };
}

function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function addUnique(target: string[], value: string) {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function addJobError(job: JellyfinJob, message: string, path?: string) {
  job.counters.failed++;
  if (job.errors.length < MAX_ERRORS) {
    job.errors.push({ message, path });
  }
}

function parseRetryAfter(response: Response): number | undefined {
  const value = response.headers.get('Retry-After');
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(1, seconds);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(1, Math.ceil((date - Date.now()) / 1000));
}

async function graphResponse(uri: string, init: RequestInit = {}) {
  const response = await fetchWithAuth(uri, init);
  if (response.status === 429 || response.status >= 500) {
    throw new GraphRequestError(
      `Microsoft Graph returned ${response.status} ${response.statusText}`,
      response.status,
      parseRetryAfter(response),
    );
  }
  return response;
}

async function responseError(response: Response, context: string) {
  const details = (await response.text()).slice(0, 500);
  return new GraphRequestError(
    `${context}: ${response.status} ${response.statusText}${details ? ` - ${details}` : ''}`,
    response.status,
  );
}

function itemUri(env: Env, path: string) {
  return buildUriPath(path, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl);
}

async function getDriveItem(env: Env, path: string): Promise<DriveItem | null> {
  const response = await graphResponse(
    `${itemUri(env, path)}?$select=id,name,size,lastModifiedDateTime,file,folder,eTag`,
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await responseError(response, `Unable to read ${path}`);
  }
  return response.json<DriveItem>();
}

async function readTextFile(env: Env, path: string): Promise<string | null> {
  const response = await graphResponse(`${itemUri(env, path)}/content`, { redirect: 'manual' });
  if (response.status === 404) {
    return null;
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location');
    if (!location) {
      throw new GraphRequestError(`OneDrive did not return a download URL for ${path}`, 502);
    }
    const downloadResponse = await fetch(location);
    if (!downloadResponse.ok) {
      throw await responseError(downloadResponse, `Unable to download ${path}`);
    }
    return downloadResponse.text();
  }
  if (!response.ok) {
    throw await responseError(response, `Unable to read ${path}`);
  }
  return response.text();
}

async function listDrivePage(
  env: Env,
  path: string,
  nextLink?: string,
  top = LIST_PAGE_SIZE,
): Promise<DriveItemCollection> {
  const uri =
    nextLink ??
    `${itemUri(env, path)}/children?$select=id,name,size,lastModifiedDateTime,file,folder&$top=${top}`;
  const response = await graphResponse(uri);
  if (response.status === 404) {
    return { value: [] };
  }
  if (!response.ok) {
    throw await responseError(response, `Unable to list ${path}`);
  }
  return response.json<DriveItemCollection>();
}

async function ensureDirectory(env: Env, path: string): Promise<'created' | 'existing'> {
  const existing = await getDriveItem(env, path);
  if (existing?.folder) {
    return 'existing';
  }
  if (existing) {
    throw new GraphRequestError(`Cannot create folder because a file exists at ${path}`, 409);
  }

  const segments = path.split('/');
  const name = segments.pop()!;
  const parent = segments.join('/') || '/';
  const response = await graphResponse(`${itemUri(env, parent)}/children`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    }),
  });
  if (response.status === 409) {
    const racedItem = await getDriveItem(env, path);
    if (racedItem?.folder) {
      return 'existing';
    }
  }
  if (!response.ok) {
    throw await responseError(response, `Unable to create directory ${path}`);
  }
  return 'created';
}

async function writeTextFile(env: Env, path: string, content: string, contentType: string) {
  const response = await graphResponse(`${itemUri(env, path)}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: content,
  });
  if (!response.ok) {
    throw await responseError(response, `Unable to write ${path}`);
  }
}

async function deleteDriveItem(env: Env, path: string) {
  const response = await graphResponse(itemUri(env, path), { method: 'DELETE' });
  if (response.status !== 204 && response.status !== 404) {
    throw await responseError(response, `Unable to delete ${path}`);
  }
}

function splitJobField(value: string) {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; ) {
    let end = Math.min(value.length, offset + CHUNK_SIZE_CODE_UNITS);
    // Do not split a UTF-16 surrogate pair across separately encoded KV values.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) {
      end--;
    }
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

async function saveJob(env: Env, job: JellyfinJob) {
  if (!env.SB_CACHE) {
    throw new Error('KV is not available');
  }
  job.updatedAt = new Date().toISOString();
  const expirationTtl = terminalPhase(job.phase) ? FINISHED_JOB_TTL_SECONDS : JOB_TTL_SECONDS;
  const stored = { ...job } as JellyfinJob;
  const previousStorage = job.storage ?? {};
  const nextStorage: Partial<Record<ChunkedJobField, JobChunkReference>> = {};
  const staleReferences: Array<[ChunkedJobField, JobChunkReference]> = [];

  for (const field of CHUNKED_JOB_FIELDS) {
    const serialized = JSON.stringify(job[field]);
    const previous = previousStorage[field];
    if (serialized.length <= CHUNK_THRESHOLD_CODE_UNITS) {
      if (previous) {
        staleReferences.push([field, previous]);
      }
      continue;
    }

    const hash = await sha256(serialized);
    const chunks = splitJobField(serialized);
    nextStorage[field] = { hash, chunks: chunks.length };
    if (previous?.hash !== hash || previous.chunks !== chunks.length) {
      await Promise.all(
        chunks.map((chunk, index) =>
          env.SB_CACHE!.put(jobChunkKey(job.id, field, hash, index), chunk, {
            expirationTtl,
          }),
        ),
      );
      if (previous) {
        staleReferences.push([field, previous]);
      }
    }
    delete (stored as unknown as Record<string, unknown>)[field];
  }

  stored.storage = nextStorage;
  job.storage = nextStorage;
  await env.SB_CACHE.put(jobKey(job.id), JSON.stringify(stored), { expirationTtl });

  await Promise.all(
    staleReferences.flatMap(([field, reference]) =>
      Array.from({ length: reference.chunks }, (_, index) =>
        env.SB_CACHE!.delete(jobChunkKey(job.id, field, reference.hash, index)),
      ),
    ),
  );
}

async function loadJob(env: Env, jobId: string): Promise<JellyfinJob | null> {
  if (!env.SB_CACHE) {
    throw new Error('KV is not available');
  }
  const job = await env.SB_CACHE.get<JellyfinJob>(jobKey(jobId), 'json');
  if (!job) {
    return null;
  }
  for (const field of CHUNKED_JOB_FIELDS) {
    const reference = job.storage?.[field];
    if (!reference) {
      continue;
    }
    const chunks = await Promise.all(
      Array.from({ length: reference.chunks }, (_, index) =>
        env.SB_CACHE!.get(jobChunkKey(job.id, field, reference.hash, index)),
      ),
    );
    if (chunks.some((chunk) => chunk === null)) {
      throw new Error(`Refresh job state is incomplete (${field})`);
    }
    (job as unknown as Record<string, unknown>)[field] = JSON.parse(chunks.join(''));
  }
  return job;
}

async function verifyJobConfig(env: Env, job: JellyfinJob) {
  const configItem = await getDriveItem(env, job.configFilePath);
  if (!configItem?.file) {
    throw new GraphRequestError(`${JELLYFIN_CONFIG_FILENAME} no longer exists`, 404);
  }
  if (job.configEtag && configItem.eTag !== job.configEtag) {
    throw new GraphRequestError(`${JELLYFIN_CONFIG_FILENAME} changed; start a new refresh`, 409);
  }
}

async function readManifest(env: Env, path: string): Promise<JellyfinManifest | null> {
  const raw = await readTextFile(env, path);
  if (!raw) {
    return null;
  }
  try {
    const manifest = JSON.parse(raw) as JellyfinManifest;
    return manifest.version === MANIFEST_VERSION && Array.isArray(manifest.entries)
      ? manifest
      : null;
  } catch {
    return null;
  }
}

function unchangedEntry(job: JellyfinJob, desired: JellyfinManifestEntry): boolean {
  const actual = job.actualStreams[desired.outputPath];
  const previous = job.oldManifest?.entries.find(
    (entry) => entry.outputPath === desired.outputPath,
  );
  return Boolean(
    actual &&
    previous &&
    previous.sourcePath === desired.sourcePath &&
    previous.size === desired.size &&
    previous.lastModifiedDateTime === desired.lastModifiedDateTime &&
    previous.streamUrl === desired.streamUrl &&
    previous.contentHash === desired.contentHash,
  );
}

async function scanSourcePage(env: Env, job: JellyfinJob, task: SourceScanTask) {
  const page = await listDrivePage(env, task.path, task.nextLink);
  const childTasks: SourceScanTask[] = [];

  for (const item of page.value ?? []) {
    const sourcePath = joinJellyfinPath(task.path, item.name);
    if (item.folder) {
      const relative = sourcePath.slice(task.sourceRoot.length).replace(/^\//, '');
      const outputPath = joinJellyfinPath(task.outputRoot, relative);
      addUnique(job.desiredDirectories, outputPath);
      childTasks.push({
        kind: 'source',
        sourceRoot: task.sourceRoot,
        outputRoot: task.outputRoot,
        path: sourcePath,
      });
      continue;
    }
    if (!item.file || !isJellyfinVideo(sourcePath)) {
      continue;
    }

    job.counters.discoveredVideos++;
    const outputPath = toJellyfinStreamPath(sourcePath, task.sourceRoot, task.outputRoot);
    const streamUrl = await buildJellyfinStreamUrl(job.origin, sourcePath);
    const entry: JellyfinManifestEntry = {
      sourcePath,
      outputPath,
      size: item.size,
      lastModifiedDateTime: item.lastModifiedDateTime,
      streamUrl,
      contentHash: await sha256(`${streamUrl}\n`),
    };
    const existing = job.desired[outputPath];
    if (existing && existing.sourcePath !== sourcePath) {
      if (!existing.collision) {
        existing.collision = true;
        addJobError(
          job,
          `Multiple source files map to ${outputPath}; the destination was left unchanged`,
          outputPath,
        );
      }
      continue;
    }
    job.desired[outputPath] = entry;
  }

  const continuation = page['@odata.nextLink']
    ? [{ ...task, nextLink: page['@odata.nextLink'] }]
    : [];
  job.scanQueue.unshift(...continuation, ...childTasks);
  job.counters.scannedFolders++;
}

async function scanOutputPage(env: Env, job: JellyfinJob, task: OutputScanTask) {
  const rootItem = task.nextLink ? true : await getDriveItem(env, task.path);
  if (!rootItem) {
    return;
  }
  if (!task.nextLink) {
    addUnique(job.actualDirectories, task.path);
  }

  const page = await listDrivePage(env, task.path, task.nextLink);
  const childTasks: OutputScanTask[] = [];
  for (const item of page.value ?? []) {
    const path = joinJellyfinPath(task.path, item.name);
    if (item.folder) {
      addUnique(job.actualDirectories, path);
      childTasks.push({ kind: 'output', path });
    } else if (item.file && item.name.toLowerCase().endsWith('.strm')) {
      job.actualStreams[path] = {
        size: item.size,
        lastModifiedDateTime: item.lastModifiedDateTime,
      };
    }
  }

  const continuation = page['@odata.nextLink']
    ? [{ ...task, nextLink: page['@odata.nextLink'] }]
    : [];
  job.scanQueue.unshift(...continuation, ...childTasks);
  job.counters.scannedFolders++;
}

function prepareMutationQueues(job: JellyfinJob) {
  job.directoryQueue = [...job.desiredDirectories].sort(
    (a, b) => jellyfinPathDepth(a) - jellyfinPathDepth(b) || a.localeCompare(b),
  );
  job.streamQueue = Object.values(job.desired)
    .filter((entry) => !entry.collision)
    .map((entry) => entry.outputPath)
    .sort();
  job.staleStreamQueue = Object.keys(job.actualStreams)
    .filter((path) => !job.desired[path])
    .sort();
  job.staleDirectoryQueue = job.actualDirectories
    .filter((path) => !job.desiredDirectories.includes(path))
    .sort((a, b) => jellyfinPathDepth(b) - jellyfinPathDepth(a) || b.localeCompare(a));
  job.counters.planned =
    job.directoryQueue.length +
    job.streamQueue.length +
    job.staleStreamQueue.length +
    job.staleDirectoryQueue.length;
  job.phase = 'create_directories';
}

async function processMutationStep(env: Env, job: JellyfinJob) {
  let processed = 0;
  while (processed < MUTATIONS_PER_STEP) {
    if (job.phase === 'create_directories') {
      const path = job.directoryQueue[0];
      if (!path) {
        job.phase = 'write_streams';
        continue;
      }
      const result = await ensureDirectory(env, path);
      job.counters[result === 'created' ? 'created' : 'skipped']++;
      job.directoryQueue.shift();
    } else if (job.phase === 'write_streams') {
      const path = job.streamQueue[0];
      if (!path) {
        job.phase = 'delete_streams';
        continue;
      }
      const entry = job.desired[path];
      if (unchangedEntry(job, entry)) {
        job.counters.skipped++;
      } else {
        const existed = Boolean(job.actualStreams[path]);
        await writeTextFile(env, path, `${entry.streamUrl}\n`, 'text/plain; charset=utf-8');
        job.counters[existed ? 'updated' : 'created']++;
      }
      job.streamQueue.shift();
    } else if (job.phase === 'delete_streams') {
      const path = job.staleStreamQueue[0];
      if (!path) {
        job.phase = 'delete_directories';
        continue;
      }
      await deleteDriveItem(env, path);
      job.counters.deleted++;
      job.staleStreamQueue.shift();
    } else if (job.phase === 'delete_directories') {
      const path = job.staleDirectoryQueue[0];
      if (!path) {
        job.phase = 'write_manifest';
        continue;
      }
      const page = await listDrivePage(env, path, undefined, 1);
      if ((page.value ?? []).length === 0) {
        await deleteDriveItem(env, path);
        job.counters.deleted++;
      } else {
        job.counters.skipped++;
      }
      job.staleDirectoryQueue.shift();
      // Checking whether a directory is empty consumes a Graph listing page.
      // Keep that phase to one directory per request, as with source/output scans.
      processed++;
      break;
    } else {
      break;
    }
    processed++;
  }
}

async function writeManifest(env: Env, job: JellyfinJob) {
  // Collisions intentionally leave their destination untouched. Keep the previous
  // manifest as the last known-good snapshot instead of publishing a partial one.
  if (job.errors.length) {
    job.phase = 'done_with_errors';
    return;
  }

  const manifest: JellyfinManifest = {
    version: MANIFEST_VERSION,
    origin: job.origin,
    configFingerprint: job.configFingerprint,
    generatedAt: new Date().toISOString(),
    entries: Object.values(job.desired)
      .filter((entry) => !entry.collision)
      .map(({ collision: _collision, ...entry }) => entry)
      .sort((a, b) => a.outputPath.localeCompare(b.outputPath)),
    directories: [...job.desiredDirectories].sort(),
  };
  await writeTextFile(
    env,
    joinJellyfinPath(job.configPath, JELLYFIN_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'application/json; charset=utf-8',
  );
  job.phase = 'done';
}

async function advanceJob(env: Env, job: JellyfinJob) {
  if (job.phase === 'scan_sources') {
    const task = job.scanQueue.shift() as SourceScanTask | undefined;
    if (task) {
      await scanSourcePage(env, job, task);
    }
    if (!job.scanQueue.length) {
      job.phase = 'scan_outputs';
      job.scanQueue = [
        { kind: 'output', path: job.config.movieOutputPath },
        { kind: 'output', path: job.config.seriesOutputPath },
      ];
    }
    return;
  }

  if (job.phase === 'scan_outputs') {
    const task = job.scanQueue.shift() as OutputScanTask | undefined;
    if (task) {
      await scanOutputPage(env, job, task);
    }
    if (!job.scanQueue.length) {
      prepareMutationQueues(job);
    }
    return;
  }

  if (
    ['create_directories', 'write_streams', 'delete_streams', 'delete_directories'].includes(
      job.phase,
    )
  ) {
    await processMutationStep(env, job);
    return;
  }

  if (job.phase === 'write_manifest') {
    await writeManifest(env, job);
  }
}

async function createJob(env: Env, requestUrl: URL, configPathInput: string) {
  if (!env.SB_CACHE) {
    return jsonResponse({ error: 'KV is not available' }, 503);
  }

  const configPath = normalizeJellyfinPath(configPathInput);
  const activeKey = await activeJobKey(configPath);
  const activeId = await env.SB_CACHE.get(activeKey);
  if (activeId) {
    const activeJob = await loadJob(env, activeId);
    if (activeJob && !terminalPhase(activeJob.phase)) {
      return jsonResponse(toStatus(activeJob));
    }
  }

  const configFilePath = joinJellyfinPath(configPath, JELLYFIN_CONFIG_FILENAME);
  const [configItem, rawConfig] = await Promise.all([
    getDriveItem(env, configFilePath),
    readTextFile(env, configFilePath),
  ]);
  if (!configItem?.file || rawConfig === null) {
    return jsonResponse({ error: `${JELLYFIN_CONFIG_FILENAME} was not found` }, 404);
  }

  const config = parseJellyfinConfig(rawConfig, configPath);
  const [movieItem, seriesItem] = await Promise.all([
    getDriveItem(env, config.moviePath),
    getDriveItem(env, config.seriesPath),
  ]);
  if (!movieItem?.folder || !seriesItem?.folder) {
    return jsonResponse({ error: 'moviePath and seriesPath must both reference folders' }, 422);
  }

  const normalizedConfig = JSON.stringify({
    moviePath: config.moviePath,
    seriesPath: config.seriesPath,
  });
  const oldManifest = await readManifest(
    env,
    joinJellyfinPath(configPath, JELLYFIN_MANIFEST_FILENAME),
  );
  const now = new Date().toISOString();
  const job: JellyfinJob = {
    version: JOB_VERSION,
    id: crypto.randomUUID(),
    configPath,
    configFilePath,
    configEtag: configItem.eTag,
    config,
    configFingerprint: await sha256(normalizedConfig),
    origin: requestUrl.origin,
    phase: 'scan_sources',
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    scanQueue: [
      {
        kind: 'source',
        sourceRoot: config.moviePath,
        outputRoot: config.movieOutputPath,
        path: config.moviePath,
      },
      {
        kind: 'source',
        sourceRoot: config.seriesPath,
        outputRoot: config.seriesOutputPath,
        path: config.seriesPath,
      },
    ],
    desired: {},
    desiredDirectories: [config.movieOutputPath, config.seriesOutputPath],
    actualStreams: {},
    actualDirectories: [],
    oldManifest,
    directoryQueue: [],
    streamQueue: [],
    staleStreamQueue: [],
    staleDirectoryQueue: [],
    counters: {
      scannedFolders: 0,
      discoveredVideos: 0,
      planned: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
    },
    errors: [],
  };

  await saveJob(env, job);
  await env.SB_CACHE.put(activeKey, job.id, { expirationTtl: JOB_TTL_SECONDS });
  return jsonResponse(toStatus(job), 201);
}

export async function handleJellyfinJobPost(
  request: Request,
  env: Env,
  requestUrl: URL,
): Promise<Response | null> {
  if (requestUrl.pathname === '/api/jellyfin/jobs') {
    let body: { configPath?: string };
    try {
      body = (await request.json()) as { configPath?: string };
    } catch {
      return jsonResponse({ error: 'Request body must be JSON' }, 400);
    }
    if (!body.configPath) {
      return jsonResponse({ error: 'configPath is required' }, 400);
    }
    try {
      return await createJob(env, requestUrl, body.configPath);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 422);
    }
  }

  const match = requestUrl.pathname.match(/^\/api\/jellyfin\/jobs\/([0-9a-f-]+)\/(step|cancel)$/i);
  if (!match) {
    return null;
  }
  const [, jobId, action] = match;
  const job = await loadJob(env, jobId);
  if (!job) {
    return jsonResponse({ error: 'Refresh job was not found' }, 404);
  }

  if (action === 'cancel') {
    if (!terminalPhase(job.phase)) {
      job.phase = 'cancelled';
      await saveJob(env, job);
    }
    return jsonResponse(toStatus(job));
  }

  if (terminalPhase(job.phase)) {
    return jsonResponse(toStatus(job));
  }
  if (job.retryAt && Date.now() < job.retryAt) {
    return jsonResponse(toStatus(job), 202);
  }

  try {
    await verifyJobConfig(env, job);
    await advanceJob(env, job);
    job.retryAt = undefined;
    job.retryCount = 0;
  } catch (error) {
    const graphError = error instanceof GraphRequestError ? error : undefined;
    if (graphError?.retryable && job.retryCount < MAX_RETRIES) {
      job.retryCount++;
      const delaySeconds =
        graphError.retryAfterSeconds ?? Math.min(60, Math.pow(2, job.retryCount));
      job.retryAt = Date.now() + delaySeconds * 1000;
      if (job.errors.length < MAX_ERRORS) {
        job.errors.push({ message: `${graphError.message}; retrying` });
      }
    } else {
      addJobError(job, error instanceof Error ? error.message : String(error));
      job.phase = 'failed';
    }
  }

  await saveJob(env, job);
  return jsonResponse(toStatus(job), terminalPhase(job.phase) ? 200 : 202);
}

export async function handleJellyfinJobGet(env: Env, requestUrl: URL): Promise<Response | null> {
  if (requestUrl.pathname === '/api/jellyfin/config') {
    const configPathInput = requestUrl.searchParams.get('configPath');
    if (!configPathInput) {
      return jsonResponse({ error: 'configPath is required' }, 400);
    }
    try {
      const configPath = normalizeJellyfinPath(configPathInput);
      const configFilePath = joinJellyfinPath(configPath, JELLYFIN_CONFIG_FILENAME);
      const rawConfig = await readTextFile(env, configFilePath);
      if (rawConfig === null) {
        return jsonResponse({ error: `${JELLYFIN_CONFIG_FILENAME} was not found` }, 404);
      }
      const config = parseJellyfinConfig(rawConfig, configPath);
      const [movieItem, seriesItem] = await Promise.all([
        getDriveItem(env, config.moviePath),
        getDriveItem(env, config.seriesPath),
      ]);
      if (!movieItem?.folder || !seriesItem?.folder) {
        return jsonResponse({ error: 'moviePath and seriesPath must both reference folders' }, 422);
      }
      return jsonResponse({ valid: true });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 422);
    }
  }

  const match = requestUrl.pathname.match(/^\/api\/jellyfin\/jobs\/([0-9a-f-]+)$/i);
  if (!match) {
    return null;
  }
  const job = await loadJob(env, match[1]);
  return job
    ? jsonResponse(toStatus(job))
    : jsonResponse({ error: 'Refresh job was not found' }, 404);
}
