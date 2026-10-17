// API 客户端：会话、REST、SSE（断线 afterSeq 补偿 + 轮询回退）
const LS_KEY = 'st_session';

export function getToken() { return localStorage.getItem(LS_KEY); }
export function setToken(t) { localStorage.setItem(LS_KEY, t); }

/**
 * 确保有可用会话。
 *
 * 会话是服务端下发的访客凭证，存在服务端 JSON 库里：一旦服务端清库/迁移/换机，
 * 或凭证被吊销，客户端旧 token 立即失效。因此这里必须支持强制重建（force），
 * 并由 api() 在遇到 401 时自动调用——否则用户会卡在"缺少或无效的会话凭证"上出不来。
 * 并发调用用同一个 in-flight Promise 去重，避免同时建出多个会话。
 */
let sessionInFlight = null;
export async function ensureSession(force = false) {
  if (force) localStorage.removeItem(LS_KEY);
  if (getToken()) return getToken();
  if (!sessionInFlight) {
    sessionInFlight = (async () => {
      const r = await fetch('/v1/sessions/guest', { method: 'POST' });
      if (!r.ok) {
        const e = new Error('无法连接服务端建立会话');
        e.code = 'SESSION_BOOTSTRAP_FAILED';
        throw e;
      }
      const j = await r.json();
      setToken(j.sessionToken);
      return j.sessionToken;
    })().finally(() => { sessionInFlight = null; });
  }
  return sessionInFlight;
}

export class ApiError extends Error {
  constructor(payload, status) {
    super(payload.message || '请求失败');
    this.code = payload.code; this.status = status;
    this.retryable = payload.retryable; this.details = payload.details || {};
  }
}

/** 401（会话失效）时的自愈通知，供 UI 提示"正在重新连接" */
let onSessionRenewed = null;
export function setSessionRenewedHandler(fn) { onSessionRenewed = fn; }

export async function api(method, path, body, retried = false) {
  await ensureSession();
  const opts = { method, headers: {} };
  if (getToken()) opts.headers.authorization = 'Bearer ' + getToken();
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 会话失效 → 重建后重试一次（只重试一次，避免死循环）
    // 注：401 表示请求未被服务端处理，重试不会产生重复副作用
    if (r.status === 401 && !retried) {
      if (onSessionRenewed) { try { onSessionRenewed(); } catch (e) {} }
      await ensureSession(true);
      return api(method, path, body, true);
    }
    throw new ApiError(j, r.status);
  }
  return j;
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b ?? {});
export const put = (p, b) => api('PUT', p, b ?? {});
export const del = (p) => api('DELETE', p);

/**
 * 订阅任务事件：优先 SSE；失败/不支持回退轮询。
 * onEvent(evt), 返回 unsubscribe。
 */
export function subscribeJob(jobId, onEvent, { afterSeq = 0, onError } = {}) {
  let stopped = false;
  let lastSeq = afterSeq;
  let es = null;
  let pollTimer = null;

  const handle = (evt) => {
    if (stopped) return;
    if (evt.seq && evt.seq <= lastSeq) return;
    if (evt.seq) lastSeq = evt.seq;
    onEvent(evt);
  };

  const startPolling = () => {
    if (pollTimer || stopped) return;
    const tick = async () => {
      pollTimer = null;
      if (stopped) return;
      try {
        const j = await get(`/v1/jobs/${jobId}/events?poll=1&afterSeq=${lastSeq}`);
        for (const e of j.events) handle(e);
        handle({ type: 'job.progress', jobId, payload: { queuePosition: j.queuePosition, phase: j.phase, phaseLabel: j.phaseLabel, activePhaseLabel: j.activePhaseLabel, jobStatus: j.jobStatus } });
        if (j.jobStatus === 'completed' || j.jobStatus === 'failed' || j.jobStatus === 'cancelled') {
          return; // 本次返回的尾部事件已全部交付
        }
      } catch (e) { onError && onError(e); }
      if (!stopped) pollTimer = setTimeout(tick, 2500);
    };
    tick();
  };

  if (window.EventSource) {
    try {
      es = new EventSource(`/v1/jobs/${jobId}/events?afterSeq=${lastSeq}&token=${encodeURIComponent(getToken() || '')}`);
      // 注意：EventSource 无法附带鉴权头；服务端对 events 端点接受 query token
      es.onerror = () => { es.close(); es = null; startPolling(); };
      const types = ['intent.normalized', 'clarification.required', 'candidates.ready', 'route.ready',
        'route.alternative_ready', 'guide.text_ready', 'guide.audio_ready', 'route.risk_detected',
        'job.failed', 'job.completed', 'job.progress'];
      for (const t of types) {
        es.addEventListener(t, (m) => { try { handle(JSON.parse(m.data)); } catch (e) {} });
      }
    } catch (e) { startPolling(); }
  } else {
    startPolling();
  }

  return () => {
    stopped = true;
    if (es) es.close();
    if (pollTimer) clearTimeout(pollTimer);
  };
}
