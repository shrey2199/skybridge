import { sha256, parseJson } from '../services/utils';
import { authorizeActions } from '../services/authUtils';
import { handleWebdav } from './dav-handler';
import { handleGetRequest } from './get-handler';
import { handlePostRequest } from './post-handler';
import type { TokenScope } from '../types/apiType';

export async function cacheRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  // Job state and explicit file links are dynamic and must never share cache entries.
  if (requestUrl.pathname.startsWith('/api/jellyfin/') || requestUrl.searchParams.has('file')) {
    return handleRequest(request, env);
  }
  // Upload-link responses are single-use and must not be served from cache
  if (request.method === 'POST' && requestUrl.searchParams.has('upload')) {
    return handleRequest(request, env);
  }

  const CACHE_TTLMAP = env.CACHE_TTLMAP;
  const method = request.method as keyof typeof CACHE_TTLMAP;
  const cacheTTL = CACHE_TTLMAP[method];

  if (!cacheTTL || cacheTTL <= 0) {
    return handleRequest(request, env);
  }

  // WebDAV bypass
  const cacheUrl = requestUrl;
  const isDavGetCache =
    env.PROTECTED.PROXY_KEYWORD && cacheUrl.hostname.includes(`${env.PROTECTED.PROXY_KEYWORD}.`);
  if (request.headers.get('Authorization') && !isDavGetCache) {
    return handleRequest(request, env);
  }
  // Range requests must never share a cache entry with full downloads
  if (method === 'GET' && request.headers.has('Range')) {
    return handleRequest(request, env);
  }

  const reqBody = method === 'POST' ? await request.clone().text() : '{}';
  const parsedBody = parseJson<{ path?: string; globalPasswd?: string; passwd?: string }>(reqBody);
  const tokenScopeSet = await authorizeActions(['download', 'refresh', 'list'], {
    env,
    url: cacheUrl,
    passwd: parsedBody?.passwd ?? request.headers.get('Authorization') ?? undefined,
    globalPasswd: parsedBody?.globalPasswd,
    postPath: parsedBody?.path,
  });

  const requestKeyGenerators = {
    GET: () => (tokenScopeSet.has('download') ? 'download' : ''),
    POST: async () =>
      tokenScopeSet.has('list') ? `list/${await sha256(reqBody)}` : await sha256(reqBody),
  };
  const key = await requestKeyGenerators[method]();

  // format changes the response body (e.g. ?format=pdf), so it must be part of the key
  const format = requestUrl.searchParams.get('format');
  cacheUrl.search = ''; // avoid query parameters affecting cache entry
  cacheUrl.pathname = `/${method}/${key}` + (format ? `/format-${format}` : '') + cacheUrl.pathname;
  const cacheKey = new Request(cacheUrl.toString().toLowerCase());
  const cache = (caches as any).default;
  const cachedResponse: Response | null = await cache.match(cacheKey);

  const cacheCreatedTime =
    new Date(cachedResponse?.headers.get('Expires') || 0).getTime() - cacheTTL * 1000;
  const cachedAgeSec = (Date.now() - cacheCreatedTime) / 1000;
  // 302 OneDrive download links are valid for 1 hour
  const isLinkExpired = method === 'GET' && cachedResponse?.status === 302 && cachedAgeSec > 3600;
  // expired or forced refresh
  const isCacheExpired = cachedAgeSec > cacheTTL || isLinkExpired;
  const isForceRefresh = tokenScopeSet.has('refresh');

  if (!cachedResponse || isCacheExpired || isForceRefresh) {
    const upstreamResponse = await handleRequest(request, env, tokenScopeSet);
    const freshResponse = new Response(upstreamResponse.body, upstreamResponse);

    freshResponse.headers.set('Expires', new Date(Date.now() + cacheTTL * 1000).toUTCString());
    freshResponse.headers.set('Cache-Control', `max-age=${cacheTTL}`);

    ctx.waitUntil(cache.put(cacheKey, freshResponse.clone()));
    return freshResponse;
  }

  return cachedResponse;
}

async function handleRequest(request: Request, env: Env, preAuth?: Set<TokenScope>): Promise<Response> {
  const url = new URL(request.url);
  const allowMethods = [
    'COPY',
    'DELETE',
    'GET',
    'HEAD',
    'MKCOL',
    'MOVE',
    'OPTIONS',
    'POST',
    'PROPFIND',
    'PUT',
  ];

  if (!allowMethods.includes(request.method)) {
    return new Response(null, { status: 405 });
  }

  switch (request.method) {
    // Preflight
    case 'OPTIONS':
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '604800',
          DAV: '1, 3',
          ALLOW: allowMethods.join(', '),
          'ms-author-via': 'DAV',
        },
      });
    // Download a file or display web
    case 'GET':
      return handleGetRequest(request, env, url, preAuth);
    case 'HEAD':
      return url.searchParams.has('file')
        ? handleGetRequest(request, env, url, preAuth)
        : handleWebdav(request, env, url);
    // Upload or List files
    case 'POST':
      return handlePostRequest(request, env, url, preAuth);
    default:
      return handleWebdav(request, env, url);
  }
}
