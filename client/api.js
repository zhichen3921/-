const DEFAULT_HEADERS = Object.freeze({
  accept: 'application/json'
});

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'API_ERROR', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function responseState(payload) {
  if (payload && typeof payload === 'object' && payload.state) {
    return payload.state;
  }
  return payload;
}

export function createApiClient({
  baseUrl = '',
  token = '',
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createApiClient requires a fetch implementation');
  }

  const root = trimTrailingSlash(baseUrl);
  let resolvedToken = String(token || '').trim();
  let bootstrapPromise;

  function endpoint(path) {
    return `${root}${path}`;
  }

  async function readBootstrapToken() {
    if (resolvedToken) return resolvedToken;

    const injected = globalThis.__APPLICATION_DESK_BOOTSTRAP__?.token;
    if (injected) {
      resolvedToken = String(injected);
      return resolvedToken;
    }

    if (globalThis.document) {
      const metaToken = document
        .querySelector('meta[name="application-desk-token"]')
        ?.getAttribute('content');
      if (metaToken) {
        resolvedToken = metaToken;
        return resolvedToken;
      }
    }

    bootstrapPromise ||= fetchImpl(endpoint('/api/bootstrap'), {
      headers: DEFAULT_HEADERS
    }).then(async (response) => {
      if (!response.ok) {
        throw new ApiError('无法读取本地投递台授权信息', {
          status: response.status,
          code: 'BOOTSTRAP_FAILED'
        });
      }
      const payload = await response.json();
      if (!payload?.token) {
        throw new ApiError('本地投递台未返回写入令牌', {
          status: response.status,
          code: 'TOKEN_MISSING'
        });
      }
      resolvedToken = String(payload.token);
      return resolvedToken;
    });

    return bootstrapPromise;
  }

  async function request(path, {
    method = 'GET',
    body,
    write = false
  } = {}) {
    const headers = { ...DEFAULT_HEADERS };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (write) headers['x-desk-token'] = await readBootstrapToken();

    let response;
    try {
      response = await fetchImpl(endpoint(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new ApiError('无法连接本地投递台服务', {
        code: 'NETWORK_ERROR',
        details: error
      });
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError('本地投递台返回了无法解析的数据', {
          status: response.status,
          code: 'INVALID_JSON'
        });
      }
    }

    if (!response.ok) {
      throw new ApiError(
        payload?.error?.message || `本地投递台请求失败（${response.status}）`,
        {
          status: response.status,
          code: payload?.error?.code || 'REQUEST_FAILED',
          details: payload?.error || payload
        }
      );
    }

    return payload;
  }

  const client = {
    health() {
      return request('/api/health');
    },

    async getState() {
      return responseState(await request('/api/state'));
    },

    createJob(job) {
      return request('/api/jobs', {
        method: 'POST',
        body: job,
        write: true
      });
    },

    patchJob(id, patch) {
      if (!String(id || '').trim()) throw new TypeError('Job id is required');
      return request(`/api/jobs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
        write: true
      });
    },

    deleteJob(id) {
      if (!String(id || '').trim()) throw new TypeError('Job id is required');
      return request(`/api/jobs/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        write: true
      });
    },

    updatePreferences(preferences) {
      return request('/api/preferences', {
        method: 'PUT',
        body: preferences,
        write: true
      });
    },

    runPublicUpdate() {
      return request('/api/updates/run', {
        method: 'POST',
        body: { trigger: 'manual' },
        write: true
      });
    },

    pairExtension() {
      return request('/api/extension/pair', {
        method: 'POST',
        body: { requestedBy: 'user' },
        write: true
      });
    },

    importLegacyState(payload) {
      if (!payload || !Array.isArray(payload.jobs)) {
        throw new TypeError('Legacy migration payload must contain jobs');
      }
      return request('/api/migrations/legacy', {
        method: 'POST',
        body: payload,
        write: true
      });
    },

    // Migration bootstrap only. Routine UI actions must use granular methods above.
    putClientState(clientState) {
      if (!clientState || !Array.isArray(clientState.jobs)) {
        throw new TypeError('Client state must contain jobs');
      }
      return request('/api/client-state', {
        method: 'PUT',
        body: clientState,
        write: true
      });
    }
  };

  return client;
}
