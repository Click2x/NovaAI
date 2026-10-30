// The backend's memory endpoints as seen by the memory window. Every call resolves: { ok:false, error } when the backend is unreachable or refuses.
export function createApi(base, fetchFn = (...a) => globalThis.fetch(...a)) {
  const root = String(base || '').replace(/\/+$/, '')

  async function call(method, path, body, timeoutMs = 15000) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await fetchFn(root + path, {
        method, signal: ctl.signal,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let data = null
      try { data = await r.json() } catch { /* not JSON */ }
      if (!r.ok) return { ok: false, status: r.status, error: (data && typeof data.detail === 'string' && data.detail) || `The backend answered ${r.status}.` }
      return data && typeof data === 'object' ? { ok: true, ...data } : { ok: true }
    } catch {
      return { ok: false, offline: true, error: 'I cannot reach my backend.' }
    } finally { clearTimeout(t) }
  }

  return {
    list: () => call('GET', '/api/memory'),
    add: (text, kind) => call('POST', '/api/memory', { text, kind: kind || null }),
    update: (id, text, kind) => call('PATCH', `/api/memory/${encodeURIComponent(id)}`, { text, kind: kind || null }),
    remove: (id) => call('DELETE', `/api/memory/${encodeURIComponent(id)}`),
    clear: () => call('DELETE', '/api/memory'),
    settings: () => call('GET', '/api/settings'),
    setAutoLearn: (on) => call('PATCH', '/api/settings', { memory: { auto_learn: !!on } }),
  }
}
