// 发现频道：路线模板库（灵感 + 固化大众路线）与目的地浏览。
// 生态位分工：规划 = 高定制（首页向导自己填）；发现 = 编辑精选模板，一键带入规划。
import { get, post } from './api.js';
import { h, toast, openSheet, closeSheet } from './ui.js';
import { narrationCard } from './narrator.js';

const REVIEW_NOTE = '内容库 v1 · 公开资料整理，未实地核验；票价/时间以官方公示为准';

function libBadge() {
  return h('div', { class: 'lib-badge' },
    h('span', { class: 'tag' }, '内容库 v1'),
    h('span', { class: 'lib-note' }, ' 公开资料整理，未实地核验；票价与开放时间以官方公示为准'));
}

function stars(rating) {
  return '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
}

function fmtDur(sec) {
  const h_ = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h_ ? (m ? `${h_}小时${m}分` : `${h_}小时`) : `${m}分钟`;
}
const SCENE_TXT = { venue: '景区路线', wander: '城市闲逛', itinerary: '多日行程' };

/* ==================== 发现页（路线模板库） ==================== */
export async function renderDiscover(view, ctx) {
  const root = h('div', {});
  view.append(root);
  const searchInput = h('input', { class: 'input', placeholder: '搜城市、景点、攻略…', id: 'disc-q' });
  root.append(h('div', { class: 'card disc-hero' },
    h('h2', { class: 'disc-title' }, '发现好路线'),
    h('div', { class: 'disc-sub' }, '挑一条现在就能走的；想先感受氛围，也可以从一段讲解开始。'),
    h('div', { class: 'disc-search' },
      searchInput,
      h('button', { class: 'btn btn-primary btn-sm', onclick: doSearch }, '搜索'))));

  function doSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    location.hash = '#/search?q=' + encodeURIComponent(q);
  }
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  const [tplData, hubData] = await Promise.all([get('/v1/hub/templates'), get('/v1/hub/highlights')]);
  const allTpl = tplData.templates || [];
  const counts = (hubData.meta && hubData.meta.counts) || {};
  const allTags = new Map();
  for (const t of allTpl) for (const g of t.themeTags || []) allTags.set(g, (allTags.get(g) || 0) + 1);
  let curDur = 'all';
  let curTag = '全部';

  /* 精选路线：时长 + 主题两个筛选维度（都带条数，避免点了才知道是空的） */
  const tplList = h('div', { class: 'tpl-grid' });
  const durRow = h('div', { class: 'chip-scroll' });
  const tagRow = h('div', { class: 'chip-scroll' });
  const listMeta = h('span', { class: 'sec-meta' });
  function renderDurRow() {
    durRow.innerHTML = '';
    for (const d of DUR_FILTERS) {
      const n = allTpl.filter((t) => d.test(t)).length;
      if (!n) continue;
      durRow.append(h('button', {
        class: 'dur-chip' + (curDur === d.key ? ' sel' : ''),
        onclick: () => { curDur = d.key; renderDurRow(); renderTplList(); },
      }, h('b', {}, d.label), h('span', {}, `${n} 条`)));
    }
  }
  function renderTagRow() {
    tagRow.innerHTML = '';
    const tags = ['全部', ...[...allTags.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x)];
    for (const g of tags) {
      tagRow.append(h('button', {
        class: 'chip' + (curTag === g ? ' sel' : ''),
        onclick: () => { curTag = g; renderTagRow(); renderTplList(); },
      }, g, h('small', {}, g === '全部' ? allTpl.length : allTags.get(g))));
    }
  }
  function renderTplList() {
    const df = DUR_FILTERS.find((d) => d.key === curDur) || DUR_FILTERS[0];
    const list = allTpl.filter((t) => df.test(t) && (curTag === '全部' || (t.themeTags || []).includes(curTag)));
    listMeta.textContent = `${list.length} 条 · 按热度排序`;
    tplList.innerHTML = '';
    if (!list.length) { tplList.append(h('div', { class: 'empty' }, '这个组合暂时没有路线，换个时长或主题看看')); return; }
    list.forEach((t, i) => tplList.append(tplCard(t, i === 0 && curDur === 'all' && curTag === '全部')));
  }
  renderDurRow(); renderTagRow(); renderTplList();

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'sec-head' }, h('span', { class: 'sec-title' }, '精选路线'), listMeta),
      durRow, tagRow, tplList),
    h('div', { class: 'card' },
      h('div', { class: 'sec-head' },
        h('span', { class: 'sec-title' }, '按城市逛'),
        h('span', { class: 'sec-meta' }, `共 ${hubData.allCityCount || hubData.cities.length} 座`)),
      h('div', { class: 'city-strip' }, ...hubData.cities.map(cityCard))),
    (hubData.narrations || []).length ? h('div', { class: 'card' },
      h('div', { class: 'sec-head' },
        h('span', { class: 'sec-title' }, '先听一段'),
        h('span', { class: 'sec-meta' }, '到了现场，讲解自动就位')),
      h('div', { class: 'narr-strip' }, ...hubData.narrations.map(narrCard))) : null,
    h('div', { class: 'card itin-entry' },
      h('div', { class: 'itin-emoji' }, '🗓'),
      h('div', { class: 'itin-body' },
        h('div', { class: 'itin-title' }, '要玩两三天？'),
        h('div', { class: 'tl-meta' }, '选城市、天数与兴趣，按地理就近排出多日行程')),
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => { location.hash = '#/itinerary'; } }, '排行程')),
    (hubData.articles || []).length ? h('div', { class: 'card' },
      h('div', { class: 'sec-head' },
        h('span', { class: 'sec-title' }, '读一篇'),
        h('span', { class: 'sec-meta' }, `${hubData.articles.length} 篇精选`)),
      ...hubData.articles.map(articleCard),
      h('button', { class: 'btn btn-ghost btn-block', onclick: () => { location.hash = '#/articles'; } }, `全部 ${counts.articles || ''} 篇攻略`)) : null,
    h('div', { class: 'card' },
      h('div', { class: 'sec-head' },
        h('span', { class: 'sec-title' }, '热门场所'),
        h('span', { class: 'sec-meta' }, `共 ${counts.venues || ''} 处`)),
      ...hubData.venues.slice(0, 5).map(venueRow),
      h('button', { class: 'btn btn-ghost btn-block', onclick: () => { location.hash = '#/venues'; } }, '查看全部场所')),
    h('div', { class: 'disc-foot' },
      h('div', {}, `内容库 v1 · ${counts.cities || 0} 座城市 · ${counts.venues || 0} 处场所 · ${counts.narrations || 0} 条讲解 · ${counts.templates || allTpl.length} 条路线`),
      h('div', {}, '公开资料整理，未实地核验；票价与开放时间以官方公示为准。')),
  );
}

/* ==================== 发现页小组件 ==================== */
const DUR_FILTERS = [
  { key: 'all', label: '不限', test: () => true },
  { key: 'short', label: '2 小时内', test: (t) => t.scene !== 'itinerary' && t.durationSec <= 7200 },
  { key: 'half', label: '半天', test: (t) => t.scene !== 'itinerary' && t.durationSec > 7200 && t.durationSec <= 18000 },
  { key: 'day', label: '一天', test: (t) => t.scene !== 'itinerary' && t.durationSec > 18000 },
  { key: 'multi', label: '多日', test: (t) => t.scene === 'itinerary' },
];

function tplCard(t, featured) {
  const names = t.stopNames || [];
  const route = names.join(' → ') + (t.stopCount > names.length ? ` → …共 ${t.stopCount} 站` : '');
  return h('button', { class: 'tpl-card', onclick: () => { location.hash = '#/template/' + t.id; } },
    featured ? h('span', { class: 'tpl-badge' }, '本周最热') : null,
    h('div', { class: 'tpl-top' },
      h('span', { class: 'tpl-name' }, t.name),
      h('span', { class: 'tpl-heat' }, `🔥 ${t.heat}`)),
    h('div', { class: 'tpl-city' }, [t.cityName, t.venueName || SCENE_TXT[t.scene] || t.scene, fmtDur(t.durationSec), `${t.stopCount} 站`].filter(Boolean).join(' · ')),
    route ? h('div', { class: 'tpl-route' }, route) : null,
    h('div', { class: 'tpl-sum' }, t.summary),
    h('div', { class: 'tpl-foot' },
      h('div', { class: 'tpl-meta' }, ...(t.themeTags || []).slice(0, 3).map((x) => h('span', { class: 'tag' }, x))),
      h('span', { class: 'tpl-cta' }, '带入规划 →')));
}

function cityCard(c) {
  return h('button', { class: 'city-strip-card', onclick: () => { location.hash = '#/city/' + c.id; } },
    h('div', { class: 'cs-top' },
      h('span', { class: 'cs-name' }, c.name),
      h('span', { class: 'cs-count' }, `${c.venueCount} 处`)),
    h('div', { class: 'cs-slogan' }, c.slogan || ''),
    h('div', { class: 'cs-tags' }, ...(c.tags || []).slice(0, 2).map((x) => h('span', { class: 'tag' }, x))),
    h('div', { class: 'cs-meta' }, c.bestMonths ? `最佳 ${c.bestMonths}` : ''));
}

function narrCard(n) {
  return h('button', { class: 'narr-card', onclick: () => openTeaserNarration(n) },
    h('div', { class: 'narr-quote' }, `「${n.teaser}」`),
    h('div', { class: 'narr-from' },
      h('span', {}, `${n.venueName}${n.cityName ? ' · ' + n.cityName : ''}`),
      h('span', { class: 'narr-cta' }, '试听 →')));
}

async function openTeaserNarration(n) {
  try {
    const r = await get('/v1/hub/narrations/' + n.id);
    openSheet(n.venueName + ' · 讲解', h('div', {},
      narrationCard(r.narration, { compact: true }),
      h('button', {
        class: 'btn btn-ghost btn-block',
        onclick: () => { closeSheet(); location.hash = '#/venue/' + n.venueId; },
      }, '去该景点看看')));
  } catch (e) { toast(e.message); }
}

function articleCard(a) {
  return h('div', { class: 'art-card', onclick: () => { location.hash = '#/article/' + a.id; } },
    h('div', { class: 'n' }, a.title),
    h('div', { class: 'art-meta' },
      ...(a.tags || []).slice(0, 3).map((x) => h('span', { class: 'tag' }, x)),
      h('span', { class: 'tl-meta' }, `${a.readMin} 分钟`)),
    h('div', { class: 'art-sum' }, a.summary));
}

/* ==================== 模板详情 ==================== */
export async function renderTemplate(view, ctx, templateId) {
  const { template: t } = await get('/v1/hub/templates/' + templateId);
  view.append(
    h('div', { class: 'card' },
      h('div', { class: 'venue-kicker' }, `${t.cityName} · ${SCENE_TXT[t.scene]} · ${fmtDur(t.durationSec)}`),
      h('h2', { style: 'margin:6px 0' }, t.name),
      h('div', { class: 'venue-score' }, `🔥 热度 ${t.heat} · ${t.stopCount} 站`),
      h('div', { class: 'tl-meta', style: 'margin-top:6px' }, t.summary),
      h('div', { class: 'chips', style: 'margin-top:8px' }, ...(t.themeTags || []).map((x) => h('span', { class: 'tag' }, x)))),
    h('div', { class: 'card' },
      h('p', { class: 'card-title' }, `途经（${t.stops.length}）`),
      ...t.stops.map((s, i) => h('div', { class: 'tpl-stop' },
        h('span', { class: 'tpl-idx' }, String(i + 1)),
        h('div', {}, h('div', { style: 'font-weight:600' }, s.name), h('div', { class: 'tpl-stop-b' }, s.brief || ''))))),
    t.blurb ? h('div', { class: 'card' }, h('p', { class: 'card-title' }, '为什么值得走'), h('p', { style: 'margin:0;line-height:1.7;font-size:14px' }, t.blurb)) : null,
    h('div', { class: 'card' },
      h('div', { class: 'warn-line' }, 'ℹ 模板是灵感骨架（内容库整理，未实地核验）；点"用这条去规划"后，路线由规划器按实时数据重新计算，站点以实时结果为准。'),
      h('button', { class: 'btn btn-primary btn-block', style: 'margin-top:10px', onclick: () => useTemplate(ctx, t) },
        t.scene === 'itinerary' ? '🗓 按这条排多日行程' : '🧭 用这条去规划'),
      h('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:8px', onclick: () => { location.hash = '#/'; } }, '想完全自定义？去规划')),
  );
}

/** 模板站点 → 真实 POI：逐个按站名搜索，命中的写入必去。
 *  只收 kind=poi（场所/入口没有对应的候选点位，写进必去反而会对不上包）；单个站名失败不影响其它站。 */
async function resolveTemplateStops(cityName, stops) {
  const out = [];
  const seen = new Set();
  for (const s of stops || []) {
    const name = ((s && s.name) || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    try {
      const qs = new URLSearchParams({ q: name });
      if (cityName) qs.set('city', cityName);
      const r = await get('/v1/places/search?' + qs.toString());
      const hit = (r.results || []).find((x) => x.kind === 'poi' && x.coord);
      if (hit) out.push({ id: hit.id, name: hit.name });
    } catch (e) { /* 单站失败不阻断整条模板 */ }
  }
  return out;
}

/** 模板 → 规划向导：预填草稿（热度+1 计入真实使用），起点仍由用户确认 */
async function useTemplate(ctx, t) {
  try { await post(`/v1/hub/templates/${t.id}/use`); } catch (e) { /* 热度计数失败不阻断 */ }
  const d = ctx.state.draft;
  if (t.scene === 'itinerary') { location.hash = '#/itinerary?city=' + t.cityId; return; }
  d.scene = t.scene === 'venue' ? 'venue' : 'wander';
  d.timeMode = 'duration';
  d.durationSec = t.durationSec || 7200;
  d.objective = (t.draft && t.draft.objective) || 'highlights';
  d.interests = [...((t.draft && t.draft.interests) || [])];
  d.endpointMode = (t.draft && t.draft.endpointMode) || 'return_to_origin';
  d.venueId = null; d.venueRef = null; d.origin = null;
  d.mustVisit = []; d.avoid = [];
  // 模板途经站点带入"必去"，规划器会强制把它们放进候选池（即使不在检索半径内）
  d.mustVisit = await resolveTemplateStops(t.cityName, t.stops);
  if (t.scene === 'venue' && t.venueId) {
    // 场所模板：按内容库名称搜真实场所，命中即带入；不中就停在第二步让用户自己选
    try {
      const hub = await get('/v1/hub/venues/' + t.venueId);
      const r = await get('/v1/places/search?kind=venue&q=' + encodeURIComponent(hub.venue.name));
      const hit = (r.results || []).find((x) => x.kind === 'venue');
      if (hit) {
        d.venueId = hit.id;
        d.venueRef = { id: hit.id, name: hit.name, lng: hit.coord.lng, lat: hit.coord.lat, city: hit.city || t.cityName, district: hit.district || '' };
        d.step = 3;
        ctx.saveDraft();
        location.hash = '#/';
        toast('已带入「' + hit.name + '」，确认起点后即可生成', 3200);
        return;
      }
      d.step = 2;
      ctx.saveDraft();
      location.hash = '#/';
      toast('已带入模板条件，请搜索「' + hub.venue.name + '」选定地方', 3200);
      return;
    } catch (e) { /* 落到 wander/通用入口 */ }
  }
  // 闲逛没有预选场所，必须先由用户在第二步确定出发地
  d.step = 2;
  ctx.saveDraft();
  location.hash = '#/';
  toast('已带入模板条件，请先确定从哪儿出发', 3200);
}

/* ==================== 全部场所（可筛选） ==================== */
export async function renderVenues(view, ctx) {
  const state = { cityId: '', tag: '' };
  const listBox = h('div', {});
  const cities = await get('/v1/hub/cities');
  const tags = ['人文', '自然', '建筑', '街区', '美食', '公园湿地', '都市观光'];

  async function refresh() {
    listBox.innerHTML = '';
    listBox.append(h('div', { class: 'tl-meta', style: 'text-align:center;padding:20px' }, '加载中…'));
    const qs = new URLSearchParams();
    if (state.cityId) qs.set('cityId', state.cityId);
    if (state.tag) qs.set('tag', state.tag);
    const data = await get('/v1/hub/venues?' + qs.toString());
    listBox.innerHTML = '';
    if (!data.venues.length) { listBox.append(h('div', { class: 'empty' }, '没有符合条件的场所')); return; }
    listBox.append(...data.venues.map((v) => venueRow(v)));
  }

  view.append(
    h('div', { class: 'card' },
      h('p', { class: 'card-title' }, '按城市'),
      h('div', { class: 'chips' },
        h('button', { class: 'chip' + (!state.cityId ? ' sel' : ''), onclick: (e) => { state.cityId = ''; mark(e); refresh(); } }, '全部'),
        ...cities.cities.map((c) => h('button', { class: 'chip', dataset: { city: c.id }, onclick: (e) => { state.cityId = c.id; mark(e); refresh(); } }, c.name))),
      h('p', { class: 'card-title', style: 'margin-top:10px' }, '按主题'),
      h('div', { class: 'chips' },
        h('button', { class: 'chip sel', onclick: (e) => { state.tag = ''; mark(e); refresh(); } }, '不限'),
        ...tags.map((t) => h('button', { class: 'chip', onclick: (e) => { state.tag = t; mark(e); refresh(); } }, t)))),
    listBox,
  );
  function mark(e) {
    e.target.parentElement.querySelectorAll('.chip').forEach((x) => x.classList.remove('sel'));
    e.target.classList.add('sel');
  }
  await refresh();
}

/* ==================== 搜索结果 ==================== */
export async function renderSearch(view, ctx, query) {
  const q = query.get('q') || '';
  view.append(h('div', { class: 'card' }, h('h3', {}, `搜索「${q}」`)));
  const box = h('div', {});
  view.append(box);
  const data = await get('/v1/hub/search?q=' + encodeURIComponent(q));
  const groups = [
    ['城市', data.cities, (c) => ({ hash: '#/city/' + c.id, n: c.name + ' — ' + c.slogan, a: (c.tags || []).join('、') })],
    ['场所', data.venues, (v) => ({ hash: '#/venue/' + v.id, n: `${v.name}（${v.level}）`, a: v.kind + ' · ' + v.rating.toFixed(1) + ' 分' })],
    ['攻略', data.articles, (a) => ({ hash: '#/article/' + a.id, n: a.title, a: a.readMin + ' 分钟阅读' })],
  ];
  let any = false;
  for (const [name, list, fmt] of groups) {
    if (!list || !list.length) continue;
    any = true;
    box.append(h('div', { class: 'card' },
      h('p', { class: 'card-title' }, name),
      ...list.map((x) => { const f = fmt(x); return h('div', { class: 'poi-result', onclick: () => { location.hash = f.hash; } }, h('div', { class: 'n' }, f.n), h('div', { class: 'a' }, f.a)); })));
  }
  if (!any) box.append(h('div', { class: 'empty' }, '没有找到相关内容，换个关键词试试'));
}

/* ==================== 城市详情 ==================== */
export async function renderCity(view, ctx, cityId) {
  const data = await get('/v1/hub/cities/' + cityId);
  const c = data.city;
  view.append(
    h('div', { class: 'card city-hero' },
      h('h2', { style: 'margin:0' }, c.name, ' ', h('span', { class: 'city-slogan' }, c.slogan)),
      h('div', { class: 'tl-meta' }, c.summary),
      h('div', { class: 'city-facts' },
        h('div', {}, '最佳季节：', h('b', {}, c.bestMonths)),
        h('div', {}, '人均预算参考：', h('b', {}, `¥${c.avgBudgetCnyPerDay}/天`)),
        h('div', {}, '交通：', c.transport)),
      h('div', { class: 'chips', style: 'margin-top:8px' }, ...(c.food || []).map((f) => h('span', { class: 'tag' }, '🍽 ' + f)))),
    h('div', { class: 'card itin-entry' },
      h('h3', {}, `一键生成 ${c.name} 多日行程`),
      h('div', { class: 'tl-meta' }, '按兴趣与节奏排 1-7 天，含每日场所组合、看点与预算估算'),
      h('button', { class: 'btn btn-primary btn-block', onclick: () => { location.hash = `#/itinerary?city=${c.id}`; } }, '生成行程')),
    h('div', { class: 'card' },
      h('p', { class: 'card-title' }, `场所（${c.venues.length}）`),
      ...c.venues.map((v) => venueRow(v))),
    c.articles.length ? h('div', { class: 'card' },
      h('p', { class: 'card-title' }, '攻略'),
      ...c.articles.map((a) => h('div', { class: 'poi-result', onclick: () => { location.hash = '#/article/' + a.id; } },
        h('div', { class: 'n' }, a.title), h('div', { class: 'a' }, `${a.readMin} 分钟 · ${a.summary.slice(0, 36)}…`)))) : null,
  );
}

/* ==================== 场所详情 ==================== */
export async function renderVenue(view, ctx, venueId) {
  const data = await get('/v1/hub/venues/' + venueId);
  const v = data.venue;
  const intro = await get('/v1/hub/narrations/n_intro_' + venueId.replace('v_', ''));

  view.append(
    h('div', { class: 'card venue-hero' },
      h('div', { class: 'venue-kicker' }, `${v.city ? v.city.name : ''} · ${v.kind}${v.level ? ' · ' + v.level : ''}${v.worldHeritage ? ' · 世界遗产' : ''}`),
      h('h2', { style: 'margin:4px 0 8px' }, v.name),
      h('div', { class: 'venue-score' }, h('span', { class: 'stars-txt' }, stars(v.rating)), ` ${v.rating.toFixed(1)} · 热度 ${v.heat}`),
      h('div', { class: 'tl-meta', style: 'margin-top:6px' }, v.summary),
      h('div', { class: 'venue-facts' },
        h('div', {}, '建议游玩：', h('b', {}, `${v.suggestedHours} 小时`)),
        h('div', {}, '参考票价：', h('b', {}, v.ticket.referencePriceCny === 0 ? '免费开放' : v.ticket.referencePriceCny ? `约 ¥${v.ticket.referencePriceCny}` : '未知'), v.ticket.known ? '' : '（未核验）'),
        h('div', {}, '开放时间：', v.openHours.text, v.openHours.known ? '' : '（未核验）'),
        h('div', {}, '最佳季节：', v.bestSeason || '四季皆宜')),
      v.ticket.note ? h('div', { class: 'warn-line' }, 'ℹ ' + v.ticket.note) : null),
    narrationCard(intro.narration),
    h('div', { class: 'card' },
      h('p', { class: 'card-title' }, `看点（${v.pois.length}）· 点击试听讲解`),
      ...v.pois.map((p, i) => h('div', { class: 'poi-result' },
        h('div', { class: 'n', style: 'display:flex;align-items:center;gap:6px' },
          p.mustSee ? h('span', { class: 'tag', style: 'background:var(--warn-bg);color:var(--warn)' }, '必看') : null,
          p.name,
          p.narrationId ? h('button', { class: 'btn btn-ghost btn-sm', style: 'margin-left:auto', onclick: () => openNarration(v, i, p) }, '🔊 试听') : null),
        h('div', { class: 'a' }, p.brief)))),
    h('div', { class: 'card' },
      h('p', { class: 'card-title' }, '去这里怎么玩')),
  );

  function goPlanner() {
    // 带着场所名跳到规划器第一步：由既有向导/AI 完成现场路线规划（需要高德 Key）
    ctx.state.draft.text = `我想去${v.name}逛一逛，帮我规划两小时路线`;
    ctx.state.draft.step = 1;
    ctx.saveDraft();
    location.hash = '#/';
    toast('已带入规划页：确认条件后即可生成现场路线', 3000);
  }
  function goItinerary() {
    location.hash = `#/itinerary?city=${v.cityId}&focus=${v.id}`;
  }
  view.querySelectorAll('.card')[view.querySelectorAll('.card').length - 1].append(
    h('button', { class: 'btn btn-primary btn-block', onclick: goPlanner }, '🧭 生成现场游览路线'),
    h('button', { class: 'btn btn-ghost btn-block', onclick: goItinerary }, '🗓 排进多日行程'),
    h('div', { class: 'tl-meta', style: 'margin-top:8px' },
      '现场路线规划使用高德实时数据（需配置 Key）；讲解与行程不依赖 Key。'),
  );
}

/** 点位讲解弹层 */
async function openNarration(venue, idx, poi) {
  const box = h('div', {});
  openSheet(poi.name, box);
  box.append(h('div', { class: 'empty' }, '加载讲解…'));
  try {
    const r = await get(`/v1/hub/narrations/${poi.narrationId}`);
    box.innerHTML = '';
    box.append(narrationCard(r.narration, { compact: true }));
  } catch (e) {
    box.innerHTML = '';
    box.append(h('div', { class: 'empty' }, e.message));
  }
}

/* ==================== 攻略 ==================== */
export async function renderArticles(view, ctx) {
  const data = await get('/v1/hub/articles');
  view.append(
    h('div', { class: 'card' },
      h('h3', {}, '出行攻略'),
      h('div', { class: 'tl-meta' }, '编辑整理的路线、实用与避坑指南'),
      libBadge()),
    ...data.articles.map((a) => h('div', { class: 'card poi-result', onclick: () => { location.hash = '#/article/' + a.id; } },
      h('div', { class: 'n', style: 'font-size:16px;font-weight:600' }, a.title),
      h('div', { class: 'chips', style: 'margin:6px 0' }, ...(a.tags || []).map((t) => h('span', { class: 'tag' }, t))),
      h('div', { class: 'a' }, `${a.readMin} 分钟 · ${a.summary}`))),
  );
}

export async function renderArticle(view, ctx, articleId) {
  const data = await get('/v1/hub/articles/' + articleId);
  const a = data.article;
  view.append(
    h('div', { class: 'card' },
      h('h2', { style: 'margin:0 0 8px' }, a.title),
      h('div', { class: 'chips', style: 'margin-bottom:10px' }, ...(a.tags || []).map((t) => h('span', { class: 'tag' }, t))),
      ...a.body.split('\n\n').map((para) => h('p', { class: 'article-para' }, para)),
      h('div', { class: 'lib-badge', style: 'margin-top:12px' },
        h('span', { class: 'tag' }, '内容库 v1'),
        h('span', { class: 'lib-note' }, ' 编辑整理，未含实时信息；出行前请核对官方公告'))),
    h('button', { class: 'btn btn-ghost btn-block', onclick: () => history.back() }, '返回'),
  );
}

/* ==================== 通用行卡 ==================== */
function venueRow(v) {
  return h('div', { class: 'venue-row', onclick: () => { location.hash = '#/venue/' + v.id; } },
    h('div', { class: 'vr-main' },
      h('div', { class: 'vr-name' },
        v.name,
        v.worldHeritage ? h('span', { class: 'tag', style: 'background:var(--blue-bg);color:var(--blue)' }, '世界遗产') : null,
        v.level ? h('span', { class: 'tag' }, v.level) : null),
      h('div', { class: 'vr-sub' }, `${v.kind} · ${stars(v.rating)} ${v.rating.toFixed(1)} · 建议 ${v.suggestedHours} 小时`),
      h('div', { class: 'vr-sum' }, v.summary.slice(0, 52) + '…')),
    h('div', { class: 'vr-side' }, v.ticket.referencePriceCny === 0 ? '免费' : v.ticket.referencePriceCny ? `¥${v.ticket.referencePriceCny}` : '—'),
  );
}
