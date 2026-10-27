// All browser traffic stays on the application's origin. No Firebase client SDK.
export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AttendanceDashboard', ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      window.dispatchEvent(new Event('session-expired'));
    }
    const error = new Error(typeof body.detail === 'string' ? body.detail : 'Request failed');
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

// Schedule only after completion; cancellation prevents stale class responses.
export function poll(load, onData, onError, interval = 15000) {
  const controller = new AbortController();
  let timer;
  async function tick() {
    try {
      const data = await load(controller.signal);
      if (!controller.signal.aborted) onData(data);
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    }
    if (!controller.signal.aborted) timer = setTimeout(tick, interval);
  }
  tick();
  return () => { controller.abort(); clearTimeout(timer); };
}

export async function loadLogs(classId, signal) {
  const logs = [];
  let cursor = null;
  do {
    const page = await api(`/classes/${encodeURIComponent(classId)}/logs${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, { signal });
    logs.push(...page.items);
    cursor = page.next_cursor;
    if (logs.length > 100000) throw new Error('Session history is too large; contact your administrator.');
  } while (cursor);
  return logs.map(log => ({ ...log, date: log.timestamp ? new Date(log.timestamp) : null }))
    .sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
}
