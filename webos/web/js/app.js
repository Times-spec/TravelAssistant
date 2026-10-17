// 应用入口：会话、全局状态、路由
import { ensureSession, get, setSessionRenewedHandler } from './api.js';
import { h, closeSheet, toast } from './ui.js';
import { renderHome } from './home.js';
import { renderPlan } from './plan.js';
import { renderTrip } from './trip.js';
import { renderFinish, renderMe, renderAdmin } from './me.js';
import { renderDiscover, renderCity, renderVenue, renderVenues, renderSearch, renderArticles, renderArticle, renderTemplate } from './hub.js';
import { renderItinerary } from './itinerary.js';

const DRAFT_KEY = 'st_draft_v1';

function hashQuery() {
  return new URLSearchParams((location.hash.split('?')[1] || ''));
}

export const state = {
  config: null,
  venues: [],
  venuePacks: new Map(), // venueId -> 完整包（地图渲染/站点详情用）
  draft: loadDraft(),
  nav: (hash) => { location.hash = hash; },
};

function defaultDraft() {
  return {
    step: 1,                          // 向导步骤：1 想怎么逛 → 2 哪个地方 → 3 怎么安排
    scene: null,                      // 由用户在第一步显式选择（venue / wander）
    venueId: null, venueRef: null, objective: 'highlights',
    origin: null,
    timeMode: 'duration', durationSec: 7200, latestEndClock: '17:00',
    startMode: 'now', startAtMs: null,
    endpointMode: 'return_to_origin', endpointTouched: false, endpointPoint: null, endpointLabel: null, endpointEntranceId: null, endpointPoiId: null,
    mobility: 'walk', pace: 'normal', interests: [], text: '',
    mustVisit: [], avoid: [],
    freePreferred: false, budgetHardZero: false, avoidRepeat: null, // null=未表态 true=明确不回头 false=允许通勤折返
    stepFreeRequired: false, stepFew: false, restPreferred: false, quietPreferred: false,
    guideStyle: 'normal',
  };
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return Object.assign(defaultDraft(), JSON.parse(raw));
  } catch (e) {}
  return defaultDraft();
}
export function saveDraft() { localStorage.setItem(DRAFT_KEY, JSON.stringify(state.draft)); }

export async function getVenuePack(venue) {
  const venueId = typeof venue === 'string' ? venue : venue.id;
  const ref = typeof venue === 'string' ? (state.draft.venueRef && state.draft.venueId === venueId ? state.draft.venueRef : null) : venue.ref;
  const key = venueId + (ref ? '@' + ref.lng.toFixed(4) + ',' + ref.lat.toFixed(4) : '');
  if (!state.venuePacks.has(key)) {
    let url = '/v1/venues/' + encodeURIComponent(venueId);
    if (String(venueId).startsWith('live:') && ref) {
      url += `?name=${encodeURIComponent(ref.name || '')}&lng=${ref.lng}&lat=${ref.lat}`
        + `&city=${encodeURIComponent(ref.city || '')}&district=${encodeURIComponent(ref.district || '')}`;
    }
    const pack = await get(url);
    state.venuePacks.set(key, pack);
  }
  return state.venuePacks.get(key);
}

/* ---------------- 路由 ---------------- */
const routes = [
  { match: /^#\/discover/, name: 'discover', render: (v) => renderDiscover(v, ctx) },
  { match: /^#\/city\/([\w-]+)/, name: 'city', render: (v, m) => renderCity(v, ctx, m[1]) },
  { match: /^#\/venue\/([\w-]+)/, name: 'venue', render: (v, m) => renderVenue(v, ctx, m[1]) },
  { match: /^#\/venues/, name: 'venues', render: (v) => renderVenues(v, ctx) },
  { match: /^#\/search/, name: 'search', render: (v) => renderSearch(v, ctx, hashQuery()) },
  { match: /^#\/articles/, name: 'articles', render: (v) => renderArticles(v, ctx) },
  { match: /^#\/article\/([\w-]+)/, name: 'article', render: (v, m) => renderArticle(v, ctx, m[1]) },
  { match: /^#\/template\/([\w-]+)/, name: 'template', render: (v, m) => renderTemplate(v, ctx, m[1]) },
  { match: /^#\/itinerary/, name: 'itinerary', render: (v) => renderItinerary(v, ctx, hashQuery()) },
  { match: /^#?\/?$/, name: 'home', render: (v) => renderHome(v, ctx) },
  { match: /^#\/plan\/([\w-]+)/, name: 'plan', render: (v, m) => renderPlan(v, ctx, m[1]) },
  { match: /^#\/trip\/([\w-]+)/, name: 'trip', render: (v, m) => renderTrip(v, ctx, m[1]) },
  { match: /^#\/finish\/([\w-]+)/, name: 'finish', render: (v, m) => renderFinish(v, ctx, m[1]) },
  { match: /^#\/me/, name: 'me', render: (v) => renderMe(v, ctx) },
  { match: /^#\/admin/, name: 'admin', render: (v) => renderAdmin(v, ctx) },
];

const ctx = { state, saveDraft, getVenuePack };
let currentCleanup = null;

function route() {
  closeSheet();
  const hash = location.hash || '#/';
  for (const r of routes) {
    const m = hash.match(r.match);
    if (m) {
      document.querySelectorAll('.nav-btn').forEach((b) => {
        const matches = (b.dataset.navmatch || '').split(' ').filter(Boolean);
        b.classList.toggle('active', matches.includes(r.name));
      });
      const view = document.getElementById('view');
      if (currentCleanup) { try { currentCleanup(); } catch (e) {} currentCleanup = null; }
      view.innerHTML = '';
      currentCleanup = r.render(view, m) || null;
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}

async function boot() {
  // 会话失效时自动重建，并如实告知用户（不再卡在"缺少或无效的会话凭证"）
  setSessionRenewedHandler(() => toast('会话已失效，正在重新连接…', 2500));
  await ensureSession();
  state.config = await get('/v1/config');
  if (state.config.setupRequired) {
    const banner = document.getElementById('demo-banner');
    banner.textContent = '⚠ ' + state.config.setupHint;
    banner.classList.remove('hidden');
  }
  try {
    const v = await get('/v1/venues');
    state.venues = v.venues;
  } catch (e) { toast('场所列表加载失败：' + e.message, 3000); }
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => { location.hash = el.dataset.nav; });
  });
  window.addEventListener('hashchange', route);
  route();
}

function showBootError(e) {
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.append(h('div', { class: 'card' },
    h('h3', {}, '暂时连不上服务端'),
    h('div', { class: 'tl-meta', style: 'margin-bottom:10px' }, e && e.message ? e.message : '请确认服务端已启动、网络可达'),
    h('button', {
      class: 'btn btn-primary btn-block',
      onclick: () => { view.innerHTML = ''; boot().catch(showBootError); },
    }, '重试')));
}

boot().catch(showBootError);
