import type { DriveItem, DriveItemCollection, DavDepth } from '../types/apiType';
import { fetchWithAuth, fetchBatchRes } from './fetchUtils';
import { getSaveDelta } from './utils';
import { createReturnXml, createPropfindXml, uploadChunk } from './davUtils';
import { parsePath, buildUriPath } from './pathUtils';

export const davClient = {
  handlePropfind,
  handleCopyMove,
  handleDelete,
  handleHead,
  handleMkcol,
  handlePut,
};

async function handlePropfind(env: Env, filePath: string, depth: DavDepth) {
  const { path, parent } = parsePath(filePath);
  let data: DriveItemCollection = { value: [] };
  let selfEntry: DriveItem = {
    name: '',
    size: 0,
    lastModifiedDateTime: new Date().toISOString(),
  };

  const itemPathWrapped = buildUriPath(path, env.PROTECTED.EXPOSE_PATH, '');
  const baseEndpoint = `/me/drive/root${itemPathWrapped}`;
  const select = '?select=id,name,size,lastModifiedDateTime,file,@odata.etag';

  const createBatchRequest = (endpoints: string[]) => ({
    requests: endpoints.map((endpoint, index) => ({
      id: (index + 1).toString(),
      method: 'GET',
      url: endpoint,
    })),
  });

  // Depth 0 returns the target itself only, no children lookup (any path)
  if (depth === '0') {
    const batchResult = await fetchBatchRes(createBatchRequest([baseEndpoint + select]), env);
    const resp = batchResult.responses[0];
    if (resp.status !== 200) {
      return {
        davXml: createReturnXml(filePath, resp.status, 'Failed to fetch files'),
        davStatus: resp.status,
      };
    }
    const entry = resp.body as DriveItem;
    return { davXml: createPropfindXml(entry.file ? parent : path, [entry]), davStatus: 207 };
  }

  const savedData = await getSaveDelta(env, path);
  const reqUrl = new URL(
    savedData?.['@odata.nextLink'] ??
      savedData?.['@odata.deltaLink'] ??
      `${env.OAUTH.apiUrl}${itemPathWrapped}/children${select}&top=1000`,
  );
  const reqEndpoint = (reqUrl.pathname + reqUrl.search).replace('v1.0', '');

  const batchRequest = createBatchRequest([baseEndpoint + select, reqEndpoint]);
  const batchResult = await fetchBatchRes(batchRequest, env);

  let childrenFailed = false;
  for (const resp of batchResult.responses) {
    if (resp.status !== 200) {
      if (resp.id === '2') {
        // children lookup fails on non-folders (getChildrenOnNonFolder);
        // PROPFIND on a file legitimately returns the resource itself
        childrenFailed = true;
        continue;
      }
      return {
        davXml: createReturnXml(filePath, resp.status, 'Failed to fetch files'),
        davStatus: resp.status,
      };
    }

    if (resp.id === '1') {
      selfEntry = resp.body as DriveItem;
      selfEntry.name = selfEntry.file ? selfEntry.name : '';
    } else {
      data = resp.body as DriveItemCollection;
    }
  }

  if (childrenFailed) {
    return { davXml: createPropfindXml(parent, [selfEntry]), davStatus: 207 };
  }

  // children endpoint results
  if (savedData?.['@odata.nextLink'] || data['@odata.nextLink']) {
    data.value = [...(savedData?.value || []), ...data.value];
    await getSaveDelta(env, path, data);
  }

  // nextlink fetch finished, init delta link
  if (savedData && !data['@odata.nextLink'] && !data['@odata.deltaLink']) {
    const deltaPrams = `${select},parentReference,deleted&token=latest`;
    const deltaUrl =
      buildUriPath(path, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl) + `/delta${deltaPrams}`;
    const newDeltaResp = await fetchWithAuth(deltaUrl, {}, env);
    if (!newDeltaResp.ok) {
      return {
        davXml: createReturnXml(filePath, newDeltaResp.status, 'Failed to fetch delta'),
        davStatus: newDeltaResp.status,
      };
    }
    const newDeltaJson: DriveItemCollection = await newDeltaResp.json();
    newDeltaJson.value = [...data.value];
    await getSaveDelta(env, path, newDeltaJson);
  }

  // fetch delta data
  if (savedData && data['@odata.deltaLink']) {
    data.value.shift();
    const mergedMap = new Map(savedData?.value.map((item) => [item.id, item]));
    for (const item of data.value) {
      const itemParentPath = item?.parentReference?.path?.replace(`/drive/root:`, '');
      // not direct child, skip
      if (itemParentPath && itemParentPath !== path) {
        continue;
      }

      item.parentReference = undefined;
      if (item.deleted) {
        mergedMap.delete(item.id);
      } else {
        mergedMap.set(item.id, item);
      }
    }
    data.value = Array.from(mergedMap.values());
    await getSaveDelta(env, path, data);
  }

  data.value.unshift(selfEntry);
  const propfindPath = data.value[0]?.file ? parent : path;
  const responseXML = createPropfindXml(propfindPath, data.value);
  return { davXml: responseXML, davStatus: 207 };
}

async function handleCopyMove(
  env: Env,
  filePath: string,
  method: 'COPY' | 'MOVE',
  destination: string,
) {
  const { parent: newParent, tail: newTail } = parsePath(destination);
  const uri =
    buildUriPath(filePath, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl) +
    (method === 'COPY' ? '/copy' : '');

  // a trailing-slash destination parses to an empty tail; omit name so Graph keeps the source name
  const body: Record<string, unknown> = {
    parentReference: {
      path: `/drive/root:${env.PROTECTED.EXPOSE_PATH}${newParent}`,
    },
  };
  if (newTail) {
    body.name = newTail;
  }

  const resp = await fetchWithAuth(
    uri,
    {
      method: method === 'COPY' ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

  // Graph /copy is async: 202 + a monitor URL that turns 200/303 when done.
  // WebDAV clients (rclone, Windows) require 201/204, so poll briefly.
  if (method === 'COPY' && resp.status === 202) {
    const monitorUrl = resp.headers.get('Location');
    if (monitorUrl) {
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const monitorResp = await fetchWithAuth(monitorUrl, {}, env);
        if (monitorResp.status === 200 || monitorResp.status === 303) {
          return { davXml: null, davStatus: 201 };
        }
        if (monitorResp.status !== 202) {
          return {
            davXml: createReturnXml(filePath, monitorResp.status, monitorResp.statusText),
            davStatus: monitorResp.status,
          };
        }
      }
      // still copying after the deadline; report best effort
      return {
        davXml: createReturnXml(filePath, 202, 'Copy still in progress'),
        davStatus: 202,
      };
    }
  }

  const davStatus = resp.status === 200 ? 201 : resp.status;
  const responseXML =
    davStatus === 201 ? null : createReturnXml(filePath, davStatus, resp.statusText);

  return { davXml: responseXML, davStatus: davStatus };
}

async function handleDelete(env: Env, filePath: string) {
  const uri = buildUriPath(filePath, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl);
  const res = await fetchWithAuth(uri, { method: 'DELETE' }, env);
  const davStatus = res.status;
  const responseXML =
    davStatus === 204 ? null : createReturnXml(filePath, davStatus, res.statusText);

  return { davXml: responseXML, davStatus: davStatus };
}

async function handleHead(env: Env, filePath: string) {
  const uri = [
    buildUriPath(filePath, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl),
    '?select=size,file,folder,lastModifiedDateTime',
  ].join('');
  const resp = await fetchWithAuth(uri, {}, env);
  const data: DriveItem = await resp.json();

  // folders must return 200 with directory metadata, not 403
  if (data?.folder) {
    return {
      davXml: null,
      davStatus: 200,
      davHeaders: {
        'Content-Length': '0',
        'Content-Type': 'httpd/unix-directory',
        'Last-Modified': new Date(data.lastModifiedDateTime).toUTCString(),
      },
    };
  }

  return {
    davXml: null,
    davStatus: resp.status,
    davHeaders: data?.file
      ? {
          'Content-Length': data.size.toString(),
          'Content-Type': data.file.mimeType,
          'Last-Modified': new Date(data.lastModifiedDateTime).toUTCString(),
        }
      : {},
  };
}

async function handleMkcol(env: Env, filePath: string) {
  const { parent, tail } = parsePath(filePath);
  const uri =
    buildUriPath(parent, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl) + '/children';

  const res = await fetchWithAuth(
    uri,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: tail,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'replace',
      }),
    },
    env,
  );

  const davStatus = res.status === 200 ? 201 : res.status;
  const responseXML =
    davStatus === 201 ? null : createReturnXml(filePath, davStatus, res.statusText);

  return { davXml: responseXML, davStatus: davStatus };
}

async function handlePut(env: Env, filePath: string, request: Request) {
  const simpleUploadLimit = 4 * 1024 * 1024; // 4MB
  const chunkSize = 60 * 1024 * 1024;
  const contentLength = request.headers.get('Content-Length') || '0';
  const fileSize = parseInt(contentLength);

  if (fileSize <= simpleUploadLimit) {
    const body = await request.arrayBuffer();
    const uri =
      buildUriPath(filePath, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl) + '/content';
    const res = await fetchWithAuth(uri, { method: 'PUT', body }, env);

    const davXml = res.ok ? null : createReturnXml(filePath, res.status, res.statusText);
    const davStatus = res.status === 200 ? 204 : res.status;
    return { davXml, davStatus };
  }

  const uri =
    buildUriPath(filePath, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl) + '/createUploadSession';
  const uploadSessionRes = await fetchWithAuth(
    uri,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item: { '@microsoft.graph.conflictBehavior': 'replace' },
      }),
    },
    env,
  );

  const { uploadUrl } = (await uploadSessionRes.json()) as { uploadUrl: string };
  const reader = request.body!.getReader();
  let uploadedBytes = 0;
  let buffer = new Uint8Array(chunkSize);
  let bufferOffset = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        // If remaining buffer is full, upload current chunk before writing more data
        let vOffset = 0;
        while (vOffset < value.length) {
          const space = chunkSize - bufferOffset;
          const copySize = Math.min(space, value.length - vOffset);

          buffer.set(value.subarray(vOffset, vOffset + copySize), bufferOffset);
          bufferOffset += copySize;
          vOffset += copySize;

          if (bufferOffset === chunkSize) {
            // Full chunk -> Upload
            const chunk = buffer.subarray(0, bufferOffset);
            const contentRange = `bytes ${uploadedBytes}-${uploadedBytes + bufferOffset - 1}/${fileSize}`;
            const res = await uploadChunk(uploadUrl, chunk, contentRange);
            if (!res.ok) {
              return {
                davXml: createReturnXml(filePath, res.status, 'Upload failed'),
                davStatus: res.status,
              };
            }
            uploadedBytes += bufferOffset;
            bufferOffset = 0; // Clear buffer
          }
        }
      }

      if (done) {
        if (bufferOffset > 0) {
          // Upload final chunk (less than full blockSize)
          const chunk = buffer.subarray(0, bufferOffset);
          const contentRange = `bytes ${uploadedBytes}-${uploadedBytes + bufferOffset - 1}/${fileSize}`;
          const res = await uploadChunk(uploadUrl, chunk, contentRange);
          if (!res.ok) {
            return {
              davXml: createReturnXml(filePath, res.status, 'Upload failed'),
              davStatus: res.status,
            };
          }
        }
        break;
      }
    }

    return { davXml: null, davStatus: 201 };
  } catch (error) {
    return {
      davXml: createReturnXml(filePath, 500, `Upload error: ${error}`),
      davStatus: 500,
    };
  } finally {
    reader.releaseLock();
  }
}
