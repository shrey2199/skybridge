import type { BatchReqPayload, BatchRespData, TokenResponse } from '../types/apiType';

export async function fetchToken(
  envOauth: Env['OAUTH'],
  params: Record<string, string>,
): Promise<TokenResponse> {
  const tokenEndpoint = `${envOauth.oauthUrl}token`;
  const body = new URLSearchParams({
    client_id: envOauth.clientId,
    client_secret: envOauth.clientSecret,
    redirect_uri: envOauth.redirectUri,
    ...params,
  });

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Token request failed: ${errText}`);
  }

  return (await resp.json()) as TokenResponse;
}

// Isolate-memory token cache: avoids a KV read per Graph call and coalesces
// concurrent requests into a single refresh. Cross-isolate refresh races are
// still possible (last KV write wins) but are bounded by the cron warm-up.
let memoizedToken: { token: string; expiresAt: number } | null = null;
let inflightRefresh: Promise<string> | null = null;

const EARLY_REFRESH_SEC = 600;

export async function fetchAccessToken(
  envOauth: Env['OAUTH'],
  envCache?: Env['SB_CACHE'],
): Promise<string> {
  if (memoizedToken && Date.now() < memoizedToken.expiresAt) {
    return memoizedToken.token;
  }

  if (!inflightRefresh) {
    inflightRefresh = loadAccessToken(envOauth, envCache)
      .then((token) => {
        inflightRefresh = null;
        return token;
      })
      .catch((e) => {
        inflightRefresh = null;
        throw e;
      });
  }
  return inflightRefresh;
}

async function loadAccessToken(
  envOauth: Env['OAUTH'],
  envCache?: Env['SB_CACHE'],
): Promise<string> {
  if (!envCache) {
    throw new Error('KV is not available');
  }

  let refreshToken = '';
  const tokenData = await envCache.get('token_data');
  const cache = tokenData ? JSON.parse(tokenData) : null;
  if (cache?.refresh_token) {
    const passedMilis = Date.now() - cache.save_time;
    if (passedMilis / 1000 < cache.expires_in - EARLY_REFRESH_SEC) {
      const expiresAt = cache.save_time + (cache.expires_in - EARLY_REFRESH_SEC) * 1000;
      memoizedToken = { token: cache.access_token, expiresAt };
      return cache.access_token;
    }

    if (passedMilis < 6912000000) {
      refreshToken = cache.refresh_token;
    }
  }

  const result = await fetchToken(envOauth, {
    grant_type: 'refresh_token',
    requested_token_use: 'on_behalf_of',
    refresh_token: refreshToken,
  });
  if (result?.refresh_token) {
    (result as TokenResponse).save_time = Date.now();
    await envCache.put('token_data', JSON.stringify(result));
  }
  if (result.expires_in) {
    memoizedToken = {
      token: result.access_token,
      expiresAt: Date.now() + (result.expires_in - EARLY_REFRESH_SEC) * 1000,
    };
  }

  return result.access_token;
}

export async function fetchWithAuth(uri: string, options: RequestInit = {}, env: Env) {
  const accessToken = await fetchAccessToken(env.OAUTH, env.SB_CACHE);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);

  return fetch(uri, {
    ...options,
    headers,
  });
}

export async function fetchBatchRes(
  batch: BatchReqPayload,
  env: Env,
): Promise<BatchRespData> {
  const batchResponse = await fetchWithAuth(
    `${env.OAUTH.apiHost}/v1.0/$batch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    },
    env,
  );
  return batchResponse.json();
}
