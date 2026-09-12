import type { FetchFilesRes, UploadPayload, DriveItemCollection } from '../types/apiType';
import { fetchWithAuth, fetchBatchRes } from './fetchUtils';
import { buildUriPath } from './pathUtils';

export async function fetchFiles(
  env: Env,
  path: string,
  skipToken?: string,
  orderby?: string,
): Promise<FetchFilesRes> {
  const parent = path || '/';
  const uri = [
    buildUriPath(path, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl),
    '/children?select=name,size,lastModifiedDateTime,@microsoft.graph.downloadUrl',
    // maximum 1000, may change https://github.com/OneDrive/onedrive-api-docs/issues/319
    '&top=1000',
    orderby ? `&orderby=${encodeURIComponent(orderby)}` : '',
    skipToken ? `&skiptoken=${skipToken}` : '',
  ].join('');

  const pageRes: DriveItemCollection = await (await fetchWithAuth(uri, {}, env)).json();
  if (pageRes.error) {
    throw new Error(JSON.stringify(pageRes.error));
  }

  skipToken = pageRes['@odata.nextLink']
    ? (new URL(pageRes['@odata.nextLink']).searchParams.get('$skiptoken') ?? undefined)
    : undefined;
  const children = pageRes.value ?? [];

  return {
    parent,
    skipToken,
    orderby,
    files: children
      .map((file) => ({
        name: file.name,
        size: file.size,
        lastModifiedDateTime: file.lastModifiedDateTime,
        url: file['@microsoft.graph.downloadUrl'],
      }))
      .filter((file) => file.name !== env.PROTECTED.PASSWD_FILENAME),
  };
}

export async function fetchUploadLinks(env: Env, fileList: UploadPayload[]) {
  // Empty files cannot use createUploadSession, and a batch PUT would send a
  // literal "{}" body that corrupts them — create them directly instead.
  await Promise.all(
    fileList
      .filter((file) => !file['fileSize'])
      .map(async (file) => {
        const uri =
          env.OAUTH.apiUrl +
          buildUriPath(file['remotePath'], env.PROTECTED.EXPOSE_PATH, '') +
          '/content';
        const res = await fetchWithAuth(uri, { method: 'PUT', body: '' }, env);
        if (!res.ok) {
          throw new Error(`Failed to create empty file ${file['remotePath']}: ${res.status}`);
        }
      }),
  );

  const sessionFiles = fileList.filter((file) => Boolean(file['fileSize']));
  const batchRequest = {
    requests: sessionFiles.map((file, index) => ({
      id: `${index + 1}`,
      method: 'POST',
      url: `/me/drive/root${buildUriPath(file['remotePath'], env.PROTECTED.EXPOSE_PATH, '')}/createUploadSession`,
      headers: { 'Content-Type': 'application/json' },
      body: {},
    })),
  };
  const batchResult = await fetchBatchRes(batchRequest, env);
  batchResult.responses.forEach((response) => {
    if (response.status === 200 || response.status === 201) {
      const file = sessionFiles[parseInt(response.id) - 1];
      if (file) {
        file.uploadUrl = (response.body as { uploadUrl: string }).uploadUrl;
      }
    }
  });
  return { files: fileList };
}

export async function downloadFile(
  env: Env,
  filePath: string,
  stream?: boolean,
  format?: string | null,
  reqHeaders?: Headers,
) {
  const supportedFormats = ['glb', 'html', 'jpg', 'pdf'];
  if (format && !supportedFormats.includes(format.toLowerCase())) {
    return new Response('Unsupported target format', { status: 400 });
  }

  const uri = [
    buildUriPath(filePath, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl) + '/content',
    format ? `?format=${format}` : '',
    format === 'jpg' ? '&width=30000&height=30000' : '',
  ].join('');

  const downloadResp = await fetchWithAuth(
    uri,
    {
      headers: reqHeaders,
      redirect: 'manual',
    },
    env,
  );
  const downloadUrl = downloadResp.headers.get('Location');

  if (!downloadUrl) {
    return new Response(null, { status: downloadResp.status });
  }

  // proxy download
  if (stream) {
    const headers = new Headers(reqHeaders);
    headers.delete('Authorization');
    if (headers.get('Range')?.toLowerCase() === 'bytes=0-') {
      headers.delete('Range');
    }
    const resp = await fetch(downloadUrl, { headers });

    const returnHeaders = new Headers();
    const keepHeaders = [
      'Content-Length',
      'Content-Type',
      'Accept-Ranges',
      'ETag',
      'Content-Range',
    ];
    keepHeaders.forEach((key) => {
      if (resp.headers.has(key)) {
        returnHeaders.set(key, resp.headers.get(key)!);
      }
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: returnHeaders,
    });
  }

  // direct download
  return Response.redirect(downloadUrl);
}
