import { sha256, secureEqual, hmacSha256 } from './utils';
import { fetchWithAuth } from './fetchUtils';
import { buildUriPath } from './pathUtils';
import type { TokenScope } from '../types/apiType';

const UPLOAD_MARKER_FILENAME = '.upload';

/**
 * Read a small text file from OneDrive by path.
 * Returns the raw content, or null when the file does not exist.
 */
async function readTextFileFromDrive(env: Env, filePath: string): Promise<string | null> {
  try {
    const uri = buildUriPath(filePath, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl) + '/content';
    const response = await fetchWithAuth(uri, { redirect: 'manual' });

    if (response.status === 404) {
      return null;
    }

    // OneDrive answers with a redirect to a pre-authenticated download URL
    if (response.status === 301 || response.status === 302) {
      const downloadUrl = response.headers.get('Location');
      if (!downloadUrl) {
        return null;
      }

      const downloadResponse = await fetch(downloadUrl);
      if (!downloadResponse.ok) {
        return null;
      }

      return await downloadResponse.text();
    }

    if (response.status === 200) {
      return await response.text();
    }

    // Any other status code means failure
    return null;
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
    return null;
  }
}

/**
 * Build the ancestor chain of a folder path, starting with the folder itself
 * and ending at the drive root ('').
 * '/a/b' -> ['/a/b', '/a', '']
 */
function ancestorChain(folderPath: string): string[] {
  const chain: string[] = [];
  let current = folderPath === '/' ? '' : folderPath;
  while (true) {
    chain.push(current);
    if (current === '') {
      break;
    }
    const lastSlash = current.lastIndexOf('/');
    current = lastSlash <= 0 ? '' : current.slice(0, lastSlash);
  }
  return chain;
}

interface FolderLock {
  /** Path of the folder that owns the lock; '' means the drive root */
  folder: string;
  /** Trimmed, lowercased sha256 hex digest stored in the .password file */
  hash: string;
}

/**
 * Find the nearest folder lock for a path: the path itself and every ancestor
 * are checked for a `.password` file (all in parallel, no caching by design)
 * and the deepest folder with a non-empty password file wins. Subfolders
 * therefore inherit their parent's password, and a deeper folder can override
 * an inherited lock with its own `.password` file.
 */
async function findNearestFolderLock(env: Env, folderPath: string): Promise<FolderLock | null> {
  if (!env.PROTECTED.FOLDER_LOCK_ENABLE) {
    return null;
  }

  const chain = ancestorChain(folderPath);
  const contents = await Promise.all(
    chain.map((folder) =>
      readTextFileFromDrive(env, `${folder === '' ? '' : folder}/${env.PROTECTED.PASSWD_FILENAME}`),
    ),
  );

  for (let i = 0; i < chain.length; i++) {
    const content = contents[i];
    if (content && content.trim().length > 0) {
      return { folder: chain[i], hash: content.trim().toLowerCase() };
    }
  }
  return null;
}

/**
 * The global gate is active only when both REQUIRE_AUTH and GLOBAL_PASSWORD
 * are configured; an empty password would otherwise lock the whole site out.
 */
export function isGlobalGateActive(env: Env): boolean {
  return Boolean(env.PROTECTED.REQUIRE_AUTH && env.PROTECTED.GLOBAL_PASSWORD);
}

/**
 * Verify the site-wide password (plain text comparison, timing safe).
 */
export function verifyGlobalPassword(env: Env, inputPassword: string | undefined): boolean {
  if (!isGlobalGateActive(env) || !inputPassword) {
    return false;
  }
  return secureEqual(inputPassword, env.PROTECTED.GLOBAL_PASSWORD);
}

/**
 * Authorization for listing a folder.
 * - When the global gate is active, the site password (globalPasswd) must be
 *   supplied for every path, not only the root.
 * - When a folder lock applies (nearest ancestor `.password`), the folder
 *   password (passwd) must match it.
 * Both checks stack: a locked folder requires both passwords.
 */
async function authorizeList(
  env: Env,
  path: string,
  globalPasswd: string | undefined,
  passwd: string | undefined,
): Promise<boolean> {
  if (isGlobalGateActive(env) && !verifyGlobalPassword(env, globalPasswd)) {
    return false;
  }

  const lock = await findNearestFolderLock(env, path);
  if (lock) {
    if (!passwd) {
      return false;
    }
    const inputHash = await sha256(passwd);
    if (!secureEqual(inputHash, lock.hash)) {
      return false;
    }
  }

  return true;
}

/**
 * Check whether the `.upload` marker file exists in a folder.
 * Uploads are only allowed into folders explicitly marked this way.
 */
async function uploadMarkerExists(env: Env, folderPath: string): Promise<boolean> {
  const markerPath = `${folderPath === '/' ? '' : folderPath}/${UPLOAD_MARKER_FILENAME}`;
  try {
    const uri = buildUriPath(markerPath, env.PROTECTED.EXPOSE_PATH, env.OAUTH.apiUrl) + '/content';
    const response = await fetchWithAuth(uri, { redirect: 'manual' });
    return response.status === 200 || response.status === 301 || response.status === 302;
  } catch (error) {
    console.error('Error checking upload marker:', error);
    return false;
  }
}

/**
 * Authorization for uploads into a folder:
 * - the global gate password (when active),
 * - the folder password (when a lock applies; the admin PASSWORD secret is
 *   also accepted), and
 * - the `.upload` marker file in the target folder.
 * A public folder with no lock only needs the marker (plus the global
 * password when the gate is active).
 */
async function authorizeUpload(
  env: Env,
  path: string,
  globalPasswd: string | undefined,
  passwd: string | undefined,
): Promise<boolean> {
  if (isGlobalGateActive(env) && !verifyGlobalPassword(env, globalPasswd)) {
    return false;
  }

  const lock = await findNearestFolderLock(env, path);
  if (lock) {
    if (!passwd) {
      return false;
    }
    const isAdminSecret = Boolean(env.PASSWORD && secureEqual(passwd, env.PASSWORD));
    if (!isAdminSecret) {
      const inputHash = await sha256(passwd);
      if (!secureEqual(inputHash, lock.hash)) {
        return false;
      }
    }
  }

  return uploadMarkerExists(env, path);
}

/**
 * WebDAV authentication
 */
export function authenticateWebdav(
  davAuthHeader: string | null,
  USERNAME: string | undefined,
  PASSWORD: string | undefined,
): boolean {
  if (!davAuthHeader || !USERNAME || !PASSWORD) {
    return false;
  }

  return secureEqual(davAuthHeader, `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`);
}

/**
 * Token-based authorization
 */
async function getTokenScopes(
  secret: string | undefined,
  reqPath: string,
  searchParams: URLSearchParams,
): Promise<TokenScope[]> {
  const token = searchParams.get('token')?.toLowerCase();
  if (!token || !secret) {
    return [];
  }

  const tokenScope = searchParams.get('ts') || 'download';
  const expires = searchParams.get('te');
  const authPath = searchParams.get('tb') ?? '/';
  const tokenArgString = [tokenScope, expires].filter(Boolean).join(',');

  const candidatePaths = new Set<string>();
  candidatePaths.add(reqPath);

  if (expires) {
    const now = Math.floor(Date.now() / 1000);
    const exp = parseInt(expires);
    if (isNaN(exp) || now > exp) {
      return [];
    }
  }

  if (tokenScope.includes('children') || tokenScope === 'download') {
    const beginPath = reqPath.split('/').slice(0, -1).join('/') || '/';
    candidatePaths.add(beginPath);
  }

  if (tokenScope.includes('recursive')) {
    if (reqPath.startsWith(authPath)) {
      candidatePaths.add(authPath);
    }
  }

  for (const p of candidatePaths) {
    const expectedSign = await hmacSha256(secret, `${p},${tokenArgString}`);
    if (token === expectedSign) {
      return tokenScope.split(',').sort() as TokenScope[];
    }
  }

  return [];
}

interface AuthContext {
  env: Env;
  url: URL;
  /** Folder password (POST body `passwd`) */
  passwd?: string;
  /** Site-wide password (POST body `globalPasswd`) */
  globalPasswd?: string;
  postPath?: string;
}

/**
 * Main authorization entry point
 */
export async function authorizeActions(
  actions: readonly TokenScope[],
  ctx: AuthContext,
): Promise<Set<TokenScope>> {
  const allowed = new Set<TokenScope>();
  const { env, url, passwd, globalPasswd, postPath } = ctx;

  // Normalize path
  let path = postPath || url.searchParams.get('file') || decodeURIComponent(url.pathname);
  if (path && !path.startsWith('/')) {
    path = '/' + path;
  }
  path = path || '/';

  // Check token-based access
  const tokenScopes = await getTokenScopes(env.PASSWORD, path, url.searchParams);

  for (const action of actions) {
    // Token access
    if (tokenScopes.includes(action)) {
      allowed.add(action);
      continue;
    }

    // Action-specific authorization
    let authorized = false;

    switch (action) {
      case 'list':
        authorized = await authorizeList(env, path, globalPasswd, passwd);
        break;

      case 'download':
        // Direct file downloads intentionally stay public so raw URLs keep
        // working in video players and download managers.
        authorized = true;
        break;

      case 'upload':
        authorized = await authorizeUpload(env, path, globalPasswd, passwd);
        break;

      default:
        authorized = false;
    }

    if (authorized) {
      allowed.add(action);
    }
  }

  return allowed;
}
