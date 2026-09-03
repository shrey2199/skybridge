import { downloadFile } from '../services/fileMethods';
import { parsePath } from '../services/pathUtils';
import { renderDeployHtml } from '../services/deployMethods';
import { authorizeActions } from '../services/authUtils';
import { handleJellyfinJobGet } from '../services/jellyfinMethods';

export async function handleGetRequest(
  request: Request,
  env: Env,
  requestUrl: URL,
): Promise<Response> {
  const jellyfinResponse = await handleJellyfinJobGet(env, requestUrl);
  if (jellyfinResponse) {
    return jellyfinResponse;
  }

  // display deployment
  if (requestUrl.pathname === '/deploysb' || requestUrl.pathname === '/deployfodi') {
    return renderDeployHtml(env, requestUrl);
  }

  // legacy /fodi routes redirect to the rebranded /sb frontend
  if (requestUrl.pathname === '/fodi' || requestUrl.pathname.startsWith('/fodi/')) {
    const target = new URL(requestUrl.pathname.replace(/^\/fodi/, '/sb') + requestUrl.search, requestUrl.origin);
    return Response.redirect(target.toString(), 302);
  }

  // download files
  const isProxyRequest = Boolean(
    env.PROTECTED.PROXY_KEYWORD &&
    requestUrl.pathname.startsWith(`/${env.PROTECTED.PROXY_KEYWORD}`),
  );
  const { path: filePath, tail: fileName } = parsePath(
    requestUrl.searchParams.get('file') || decodeURIComponent(requestUrl.pathname),
    isProxyRequest ? `/${env.PROTECTED.PROXY_KEYWORD}` : undefined,
  );

  if (!fileName) {
    return new Response('Bad Request', { status: 400 });
  } else if (fileName.toLowerCase() === env.PROTECTED.PASSWD_FILENAME.toLowerCase()) {
    return new Response('Access Denied', { status: 403 });
  } else if (
    !(
      await authorizeActions(['download'], {
        env,
        url: requestUrl,
        passwd: request.headers.get('Authorization') ?? '',
      })
    ).has('download')
  ) {
    return new Response('Access Denied', { status: 403 });
  }

  return downloadFile(
    filePath,
    isProxyRequest,
    requestUrl.searchParams.get('format'),
    request.headers,
  );
}
