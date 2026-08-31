// Thin fetch wrapper around the Soldi JSON API.

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data && data.error;
    err.details = data && data.details;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),

  // auth
  me: () => request('GET', '/api/auth/me'),
  login: (email, password) => request('POST', '/api/auth/login', { email, password }),
  register: (payload) => request('POST', '/api/auth/register', payload),
  logout: () => request('POST', '/api/auth/logout'),

  // data
  overview: (params = '') =>
    request('GET', `/api/summary/overview${params ? `?${params}` : ''}`),
  transactions: (qs = '') => request('GET', `/api/transactions${qs ? `?${qs}` : ''}`),
  categories: () => request('GET', '/api/categories'),
  accounts: () => request('GET', '/api/accounts'),
  backups: () => request('GET', '/api/backups'),
};
