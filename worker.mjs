import { createRemoteJWKSet, jwtVerify, errors } from 'jose';
import { applyPatch, validateInventory, validatePatch, InventoryError } from './lib/inventory-schema.mjs';

const maximumBodySize = 512 * 1024;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

function decodeContent(content) {
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), character => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encodeContent(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

async function readBody(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    throw new InventoryError(415, 'Content-Type must be application/json.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new InventoryError(400, 'Provide a JSON request body.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximumBodySize) {
        await reader.cancel();
        throw new InventoryError(413, 'Request is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new InventoryError(400, 'Invalid JSON request.');
    }
    throw error;
  }
}

export function createWorker({ fetchGitHub = fetch, signingKeys } = {}) {
  let remoteKeys;
  let keyIssuer;

  async function authenticate(request, env) {
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER || '') ||
        !/^[a-f0-9]{64}$/.test(env.ACCESS_AUD || '')) {
      throw new InventoryError(503, 'Access validation is not configured. Saving is disabled.');
    }
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!assertion) throw new InventoryError(401, 'Sign in through Cloudflare Access to load or save the inventory.');
    if (!remoteKeys || keyIssuer !== env.ACCESS_ISSUER) {
      remoteKeys = createRemoteJWKSet(new URL(`${env.ACCESS_ISSUER}/cdn-cgi/access/certs`));
      keyIssuer = env.ACCESS_ISSUER;
    }
    try {
      const { payload } = await jwtVerify(assertion, signingKeys || remoteKeys, {
        issuer: env.ACCESS_ISSUER,
        audience: env.ACCESS_AUD,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub'],
        clockTolerance: 5
      });
      if (typeof payload.email !== 'string' || payload.email.length === 0) {
        throw new InventoryError(403, 'An authenticated user login is required; service tokens cannot edit this inventory.');
      }
    } catch (error) {
      if (error instanceof InventoryError) throw error;
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
        console.error('Access signing keys could not be checked.');
        throw new InventoryError(503, 'Login validation is temporarily unavailable. Your edits have not been saved.');
      }
      console.warn('Access login rejected:', error.code);
      throw new InventoryError(401, 'Your Access login is invalid or expired. Sign in again; export unsaved edits before reloading.');
    }
  }

  function githubConfig(env) {
    if (!env.GITHUB_TOKEN || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '') ||
        typeof env.GITHUB_BRANCH !== 'string' || env.GITHUB_BRANCH.length === 0) {
      throw new InventoryError(503, 'GitHub storage is not configured. Add the GITHUB_TOKEN runtime secret; saving is disabled.');
    }
    return {
      endpoint: `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/contents/drawers.json`,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'niimbot-labels-worker',
        'Cache-Control': 'no-cache'
      }
    };
  }

  async function githubRequest(url, options) {
    try {
      return await fetchGitHub(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    } catch (error) {
      const failureType = error instanceof Error ? error.name : 'UnknownError';
      console.error('GitHub inventory request could not be completed:', failureType);
      const message = options.method === 'PUT'
        ? 'GitHub could not be reached during saving. A timed-out save may have completed; export your draft and reload before retrying.'
        : 'GitHub could not be reached while loading the inventory. No save was attempted; retry Reload or check the Worker logs.';
      throw new InventoryError(502, message);
    }
  }

  function githubError(response) {
    console.error('GitHub inventory request failed with status', response.status);
    if (response.status === 401 || response.status === 403) {
      return new InventoryError(502, 'GitHub denied access. Check the runtime token, expiration and repository Contents permissions.');
    }
    if (response.status === 404) {
      return new InventoryError(502, 'GitHub inventory was not found. Check repository, branch, drawers.json and token repository access.');
    }
    return new InventoryError(502, `GitHub could not complete the inventory request (HTTP ${response.status}). Your draft is retained.`);
  }

  async function readInventory(env, config) {
    const response = await githubRequest(`${config.endpoint}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`, {
      headers: config.headers
    });
    if (!response.ok) throw githubError(response);
    try {
      const data = await response.json();
      if (data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string' ||
          !/^[a-f0-9]{40}$/.test(data.sha || '')) {
        throw new Error('Unexpected GitHub content response.');
      }
      return { drawers: validateInventory(JSON.parse(decodeContent(data.content))), sha: data.sha };
    } catch {
      console.error('GitHub returned invalid inventory content.');
      throw new InventoryError(502, 'GitHub inventory is invalid. It has not been replaced or overwritten.');
    }
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      try {
        await authenticate(request, env);
        const config = githubConfig(env);
        if (request.method === 'GET' && url.pathname === '/api/drawers') {
          const result = await readInventory(env, config);
          return json({ drawers: result.drawers, readOnly: false, revision: result.sha });
        }
        const match = /^\/api\/drawers\/(\d{3})$/.exec(url.pathname);
        if (request.method === 'PATCH' && match) {
          if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
            throw new InventoryError(403, 'Only same-origin edits are allowed.');
          }
          const payload = await readBody(request);
          const fields = validatePatch(payload);
          for (let attempt = 0; attempt < 3; attempt++) {
            const latest = await readInventory(env, config);
            const drawer = applyPatch(latest.drawers, match[1], payload, fields);
            const response = await githubRequest(config.endpoint, {
              method: 'PUT',
              headers: { ...config.headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: `Update drawer ${match[1]}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
                branch: env.GITHUB_BRANCH,
                sha: latest.sha,
                content: encodeContent(`${JSON.stringify(latest.drawers, null, 2)}\n`)
              })
            });
            // Retry SHA races only after re-reading and rechecking the original field values.
            if (response.status === 409) continue;
            if (!response.ok) throw githubError(response);
            const saved = await response.json();
            if (!/^[a-f0-9]{40}$/.test(saved.content?.sha || '')) {
              console.error('GitHub save confirmation did not contain a valid content SHA.');
              throw new InventoryError(502, 'GitHub returned an invalid save confirmation. Export your draft and reload to check whether the save completed.');
            }
            return json({ drawer, revision: saved.content.sha });
          }
          throw new InventoryError(409, 'Inventory changed repeatedly during saving. Your draft is retained; retry Save now or export and reload.');
        }
        return json({ error: 'API route or method not found.' }, 404);
      } catch (error) {
        if (error instanceof InventoryError) return json({ error: error.message }, error.status);
        console.error('Unexpected hosted inventory error.');
        return json({ error: 'Inventory could not be loaded or saved. Your draft is retained; check the Worker logs.' }, 500);
      }
    }
  };
}

export default createWorker();
