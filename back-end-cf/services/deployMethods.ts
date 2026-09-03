import type { TokenResponse } from '../types/apiType';
import { fetchToken } from './fetchUtils';

export async function renderDeployHtml(env: Env, requestUrl: URL) {
  if (!env.SB_CACHE) {
    throw new Error('KV is not available');
  }

  const tokenData = await env.SB_CACHE.get('token_data');
  if (tokenData) {
    return Response.redirect(`${requestUrl.origin}/sb`);
  }

  const authUrl = [
    env.OAUTH.oauthUrl,
    'authorize',
    `?client_id=${env.OAUTH.clientId}`,
    `&scope=${encodeURIComponent(env.OAUTH.scope)}`,
    '&response_type=code',
    `&redirect_uri=${env.OAUTH.redirectUri}`,
  ].join('');
  const returnHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Authorization</title>
</head>
<body style="font-family: sans-serif; padding: 20px;">
  <h2>OneDrive Authorization</h2>
  <p>
    <a href="${authUrl}" target="_blank">
      <button style="padding:8px 16px;">Click to Authorize</button>
    </a>
  </p>
  <p>After successful authorization, the browser will redirect to a new URL. Please copy the full URL and paste it into the form below.</p>
  <form action="/deployreturn" method="post">
    <label for="codeUrl">Redirected URL:</label><br>
    <input type="text" id="codeUrl" name="codeUrl" style="width:100%;padding:8px;margin:8px 0;" required />
    <br>
    <button type="submit" style="padding:8px 16px;">Submit</button>
  </form>
</body>
</html>
`;

  return new Response(returnHtml, { headers: { 'Content-Type': 'text/html' } });
}

export async function saveDeployData(env: Env, requestUrl: URL, codeUrl: string) {
  if (!env.SB_CACHE) {
    throw new Error('KV is not available');
  }

  const tokenData = await env.SB_CACHE.get('token_data');
  if (tokenData) {
    return Response.redirect(`${requestUrl.origin}/sb`);
  }

  const urlObj = new URL(codeUrl);
  const code = urlObj.searchParams.get('code');
  if (!code) {
    return new Response('Missing Code Parameter', { status: 400 });
  }

  const result = await fetchToken(env.OAUTH, {
    grant_type: 'authorization_code',
    code,
  });
  (result as TokenResponse).save_time = Date.now();
  await env.SB_CACHE.put('token_data', JSON.stringify(result));

  return Response.redirect(`${requestUrl.origin}/sb`);
}
