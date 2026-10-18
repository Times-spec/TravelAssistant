'use strict';
/**
 * 智能体编排内核（Agent Kernel）
 *
 * 在确定性求解器外层加一个"会思考、会自查"的闭环（只用于真实场所/真实片区）：
 *
 *   ① 提名 nominate   ：大模型凭知识列出"这里真正值得去的地方"（城市闲逛=沿途地标/街巷/老店；景区=殿馆园）
 *   ② 核实 verify     ：每个提名都必须被高德检索到、名称对得上、且在步行范围/场所范围内——模型不能凭空造点
 *   ③ 评审 appraise   ：大模型给候选池里每个点打"值得专门停留"分、建议停留时长、纠正分类、识别噪声点
 *   ④ 求解 solve      ：沿用约束台账 + 确定性求解器 + 独立验证器（RoutePlanningAgent）
 *   ⑤ 反思 critic     ：按质量指标找问题（末段空走 / 预算没用满 / 低价值站 / 漏掉代表性地点 / 商业化过重）
 *   ⑥ 修复 repair     ：生成"纳入/排除/替换"操作（规则 + 可选大模型提议），逐个重新求解，只接受质量分真正提升的
 *   ⑦ 解释 explain    ：只基于路线数据写推荐理由，必须如实交代末段步行与回头路
 *
 * 边界（与 §6.3/§11.2 一致）：
 * - 用户硬约束（必去/避开/截止时间/费用）不被智能体改动：修复操作只作用于求解用的克隆意图，结果仍经独立验证；
 * - 智能体选的点不会被标成"用户锁定"；
 * - 任何一步失败/超时都回退到原有规则路径，绝不因为智能体而出不了路线。
 */
const { solveOnce, solveAlternatives, buildRoutePlan, hydrateSolved } = require('./planner');
const { RoutePlanningAgent, verifyRoutePlan } = require('./route_planning_agent');
const { haversineM } = require('./geo');

const DEFAULTS = {
  enabled: true,        // 总开关（仅作用于真实场所/片区）
  llmNominate: true,    // ① 大模型提名
  llmAppraise: true,    // ③ 大模型评审
  llmCritic: true,      // ⑥ 大模型修复提议（规则反思始终开启）
  llmExplain: true,     // ⑦ 大模型写理由（失败回退诚实模板）
  maxRounds: 3,         // 反思-修复最多轮数
  maxNominate: 10,
  maxAppraise: 24,
  minGain: 0.01,        // 质量分至少提升这么多才接受修改
  timeBudgetMs: 60000,  // 智能体额外耗时上限：超出后跳过剩余大模型步骤
};
const TAGS = ['自然', '公园湿地', '街区', '人文', '建筑', '美食'];
const COMMERCIAL_RE = /(XR|VR|AR|飞览|飞行影院|体验馆|体验中心|探索馆|奥秘|网红|打卡馆|沉浸式|数字展|光影展|萌宠|猫咖|主题展|购物中心|百货|广场店|旗舰店|专卖店|超市|便利店|美食广场|美食城)/i;
const BAD_TYPECODE_RE = /^(07|09|10|12|13|15|16|17|18|20)/; // 生活服务/医疗/住宿/商务住宅/政府/交通/金融/公司/道路附属/公共设施
const EXCLUDE_NAME_RE = /(停车场|地铁站|公交站|售票处|游客中心|卫生间|厕所|出入口$|写字楼|大厦$|酒店|宾馆|学校|小学|中学|大学|医院|银行|派出所)/;

function agentConfig(cfg) { return { ...DEFAULTS, ...((cfg && cfg.agent) || {}) }; }
function llmReady(cfg) { return !!(cfg && cfg.providers && cfg.providers.llm === 'http'); }
function isLiveIntent(intent) {
  const v = String((intent && intent.venueId) || '');
  return v === 'area_amap' || v.startsWith('live:');
}
function isLivePack(pack) { return !!(pack && pack.venue && (pack.venue.live === true || pack.venue.id === 'area_amap')); }
/** 内核只接管真实场所/片区；自有已核验演示场所保持原有行为 */
function enabledFor(cfg, intent) {
  return agentConfig(cfg).enabled !== false && (cfg && cfg.routePlanningMode) !== 'algorithm' && isLiveIntent(intent);
}
const sceneOf = (intent) => (String(intent.venueId || '').startsWith('live:') ? 'venue' : 'wander');

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const clip = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? clamp(Math.round(Number(v)), lo, hi) : null);

function defaultDeps() {
  return {
    chatJSON: (...a) => require('./llm').chatJSON(...a),
    amapGet: (...a) => require('./amap').amapGet(...a),
    now: () => Date.now(),
  };
}
const depsOf = (d) => ({ ...defaultDeps(), ...(d || {}) });

/* ---------------- 记忆：同一片区/场所 30 分钟内复用提名与评审，省调用也让多次规划口径一致 ---------------- */
const MEMO_TTL_MS = 30 * 60 * 1000;
const memo = new Map();
function memoGet(k) {
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value;
  return null;
}
function memoSet(k, value) {
  memo.set(k, { at: Date.now(), value });
  while (memo.size > 200) memo.delete(memo.keys().next().value);
  return value;
}
function clearMemo() { memo.clear(); }

function interestTags(intent) { return (intent.interests || []).map((i) => i.tag).filter(Boolean); }
function endpointPoint(intent) {
  const ep = intent.endpoint;
  return ep && ep.mode === 'fixed' && ep.point && Number.isFinite(ep.point.lng) ? ep.point : null;
}
function venueCenter(intent) {
  const v = intent.venueRef || {};
  return v.coord || (Number.isFinite(v.lng) ? { lng: v.lng, lat: v.lat } : null) || v.center || (intent.origin && intent.origin.point) || null;
}
function nominateKey(intent) {
  const g = (v) => Math.round(v / 0.002); // 约 200m 网格
  const tags = interestTags(intent).sort().join(',');
  if (sceneOf(intent) === 'venue') return `nom:v:${intent.venueId}:${Math.round(intent.budgetSec / 3600)}:${tags}`;
  const o = intent.origin.point;
  const e = endpointPoint(intent);
  return `nom:w:${g(o.lng)},${g(o.lat)}:${e ? g(e.lng) + ',' + g(e.lat) : intent.endpoint.mode}:${Math.round(intent.budgetSec / 1800)}:${tags}`;
}

/** 名称归一：去括号注释、分隔符和"景区/景点"等后缀 */
function coreName(s) {
  return String(s || '').replace(/[（(][^）)]*[）)]/g, '').replace(/[\s·・\-—_|｜]/g, '').replace(/(景区|景点|旅游区|风景区|步行街)$/, '');
}
/** 提名名称与高德 POI 名称是否指同一地点（"故宫博物院-太和殿" ≈ "太和殿"；"成都" ≠ "成都大慈寺"） */
function nameMatches(asked, poiName, venueCore = '') {
  let q = coreName(asked), n = coreName(poiName);
  if (venueCore && venueCore.length >= 2) {
    const q2 = q.replace(venueCore, ''), n2 = n.replace(venueCore, '');
    if (q2.length >= 2) q = q2;
    if (n2.length >= 2) n = n2;
  }
  if (q.length < 2 || n.length < 2) return false;
  if (n === q || n.includes(q)) return true;
  return q.includes(n) && n.length >= Math.max(2, Math.ceil(q.length * 0.6));
}

/** 地理范围：城市闲逛=步行圈或起终点走廊椭圆；景区=离场所中心不远 */
function geoScope(intent) {
  if (sceneOf(intent) === 'venue') {
    const c = venueCenter(intent);
    const sec = Number(intent.budgetSec) > 0 ? Number(intent.budgetSec) : 7200;
    const radius = clamp(Math.round((sec / 7200) * 1500), 1500, 3000);
    return { kind: 'venue', center: c, radiusM: radius, accept: (p) => haversineM(c, p) <= radius };
  }
  const { areaRadiusM } = require('./amap');
  const o = intent.origin.point;
  const radius = areaRadiusM(intent.budgetSec);
  const e = endpointPoint(intent);
  if (e && haversineM(o, e) > 80) {
    const od = haversineM(o, e);
    const detourMax = Math.max(radius, od * 0.6);
    return {
      kind: 'corridor', center: { lng: (o.lng + e.lng) / 2, lat: (o.lat + e.lat) / 2 },
      radiusM: Math.min(5000, Math.round(od / 2 + radius)), odM: od,
      accept: (p) => haversineM(o, p) + haversineM(p, e) - od <= detourMax && haversineM(p, e) >= 60,
    };
  }
  return { kind: 'around', center: o, radiusM: Math.round(radius * 1.2), accept: (p) => haversineM(o, p) <= radius * 1.2 };
}

async function cityOf(cfg, point, deps) {
  try {
    const j = await deps.amapGet(cfg, '/v3/geocode/regeo', { location: `${point.lng},${point.lat}`, extensions: 'base' });
    const a = (j.regeocode && j.regeocode.addressComponent) || {};
    const s = (v) => (typeof v === 'string' ? v : '');
    return { name: s(a.city) || s(a.province), code: s(a.citycode) || s(a.adcode), district: s(a.district), township: s(a.township) };
  } catch (e) {
    return { name: '', code: '', district: '', township: '' };
  }
}

function nominatePrompt(intent, city, scope, max) {
  const tags = interestTags(intent);
  const minutes = Math.round(intent.budgetSec / 60);
  const raw = clip(intent.rawText || '', 160);
  const ep = intent.endpoint || {};
  const endText = ep.mode === 'fixed' ? `${ep.label || '指定终点'}（${ep.point ? `${ep.point.lng.toFixed(5)},${ep.point.lat.toFixed(5)}` : ''}）`
    : ep.mode === 'return_to_origin' ? '回到起点' : '顺路结束，不必回起点';
  // 紧凑数组输出：同样信息 token 数约减半，大模型返回更快
  const schema = `{"places":[["正式名称（高德地图能搜到的叫法）","为什么值得去，≤24字，具体到看什么/吃什么",建议停留分钟]]}`;
  if (scope.kind === 'venue') {
    const v = intent.venueRef || {};
    return {
      system: `你是熟悉中国景区的资深导游。任务：提名一个场所内部最值得游览的具体点位（殿、馆、门、园、桥、亭、展厅、观景台等）。只输出 JSON：${schema}
要求：
- 只列该场所围墙/范围内部的点位；不要场外街道、商铺、停车场、地铁站、厕所、售票处、游客中心；
- 按经典游览价值从高到低排序（先列必看的核心景点），最多 ${max} 个；
- 不确定是否真实存在就不要列，宁少勿错；
- 结合用户兴趣与时长取舍：时长短时只列最核心的。`,
      user: `场所：${v.name || ''}（${[v.city || city.name, v.district].filter(Boolean).join(' ')}）
场所中心：${scope.center.lng.toFixed(5)},${scope.center.lat.toFixed(5)}
游览时长：约 ${minutes} 分钟
入园/起点：${intent.origin.label || '入口'}
终点：${endText}
兴趣：${tags.join('、') || '未指定'}
用户原话：${raw || '（无）'}`,
    };
  }
  const o = intent.origin.point;
  return {
    system: `你是熟悉中国城市的本地向导。任务：为一次步行闲逛提名"真正值得去"的具体地点。只输出 JSON：${schema}
要求：
- 只提名你确信真实存在、且在给定范围内步行可达的地点；不确定就不要列，宁少勿错；
- 优先：有代表性的历史文化地标、特色街巷、寺庙祠堂、公园绿地、博物馆/美术馆、地方风味老店；
- 不要：购物中心/百货商场、连锁品牌门店、写字楼、酒店、学校、医院、地铁站、停车场、普通小区、XR/VR 体验馆、网红打卡馆；
- 兴趣含"美食"时可提名 1-3 家有名的地方小吃店或美食街；否则最多 1 个；
- 按值得程度从高到低排序，最多 ${max} 个。`,
    user: `城市：${city.name || '未知'}${city.district ? ' ' + city.district : ''}
起点：${intent.origin.label || '当前位置'}（${o.lng.toFixed(5)},${o.lat.toFixed(5)}）
终点：${endText}
步行范围：${scope.kind === 'corridor' ? `起点到终点约 ${Math.round(scope.odM)} 米，沿途两侧可绕行` : `起点周边约 ${scope.radiusM} 米内`}
时长：约 ${minutes} 分钟
兴趣：${tags.join('、') || '未指定'}
用户原话：${raw || '（无）'}`,
  };
}

function cleanPlaces(raw, max) {
  const arr = raw && Array.isArray(raw.places) ? raw.places : [];
  const out = [];
  const seen = new Set();
  for (const row of arr) {
    // 兼容两种形式：["名称","理由",分钟] 与 {name,why,dwellMin}
    const p = Array.isArray(row) ? { name: row[0], why: row[1], dwellMin: row[2], kind: row[3] } : row;
    const name = clip(p && p.name, 30).replace(/[「」"“”《》]/g, '');
    if (name.length < 2 || seen.has(coreName(name))) continue;
    seen.add(coreName(name));
    out.push({ name, why: clip(p.why || p.reason, 30), dwellMin: num(p.dwellMin, 5, 240), kind: clip(p.kind, 8) });
    if (out.length >= max) break;
  }
  return out;
}

/** ② 核实：周边关键词检索（按范围中心）优先，查不到再按城市文本检索；名称 + 范围双校验 */
async function geocodePlace(cfg, place, scope, city, deps, venue) {
  const venueCore = venue ? coreName(venue.name).replace(/(博物院|博物馆|公园)$/, '') : '';
  const pick = (pois) => {
    for (const p of pois || []) {
      if (!p || !p.id || (venue && p.id === venue.providerPoiId)) continue;
      const [lng, lat] = String(p.location || ',').split(',').map(Number);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (BAD_TYPECODE_RE.test(String(p.typecode || '')) || EXCLUDE_NAME_RE.test(p.name || '') || require('./amap').isJunkPoi(p.name, p.typecode, { nominated: true })) continue;
      if (!nameMatches(place.name, p.name, venueCore)) continue;
      if (!scope.accept({ lng, lat })) continue;
      return { p, lng, lat };
    }
    return null;
  };
  let hit = null;
  try {
    const j = await deps.amapGet(cfg, '/v3/place/around', {
      keywords: place.name, location: `${scope.center.lng},${scope.center.lat}`,
      radius: String(Math.min(5000, scope.radiusM)), offset: '8', page: '1', extensions: 'base', sortrule: 'weight',
    });
    hit = pick(j.pois);
  } catch (e) { /* 单个地点检索失败只算未核实 */ }
  if (!hit) {
    try {
      const kw = venue && venueCore && !place.name.includes(venueCore) ? `${venueCore}${place.name}` : place.name;
      const j = await deps.amapGet(cfg, '/v3/place/text', {
        keywords: kw, city: city.code || city.name || '', citylimit: city.code || city.name ? 'true' : 'false',
        offset: '8', page: '1', extensions: 'base',
      });
      hit = pick(j.pois);
    } catch (e) { /* 同上 */ }
  }
  if (!hit) return null;
  const { p, lng, lat } = hit;
  return {
    id: 'am_' + p.id, providerPoiId: p.id, name: p.name, lng, lat,
    typecode: String(p.typecode || ''), type: typeof p.type === 'string' ? p.type : '',
    address: typeof p.address === 'string' ? p.address : '',
    reason: place.why || null, dwellMin: place.dwellMin, kind: place.kind, asked: place.name,
  };
}

/**
 * ①② 提名 + 核实。结果写入 intent.agentKnowledge.nominated（同一意图的重排/编辑沿用同一候选口径）。
 * 返回 trace 行；未启用/无大模型时返回 null。
 */
async function ensureNominations(cfg, intent, opts = {}) {
  const ac = agentConfig(cfg);
  if (!enabledFor(cfg, intent) || !ac.llmNominate || !llmReady(cfg)) return null;
  const k = intent.agentKnowledge || {};
  if (Array.isArray(k.nominated)) return null; // 已做过（含"提名为空"）
  const deps = depsOf(opts.deps);
  const t0 = deps.now();
  const key = nominateKey(intent);
  let result = memoGet(key);
  let error = null;
  if (!result) {
    try {
      const scope = geoScope(intent);
      if (!scope.center) throw new Error('no center');
      const venue = scope.kind === 'venue' ? (intent.venueRef || {}) : null;
      const city = venue && venue.city ? { name: venue.city, code: '', district: venue.district || '' } : await cityOf(cfg, scope.center, deps);
      const prompt = nominatePrompt(intent, city, scope, ac.maxNominate);
      const raw = await deps.chatJSON(cfg, prompt.system, prompt.user, { maxTokens: 700, timeoutMs: 25000, temperature: 0.3 });
      const places = cleanPlaces(raw, ac.maxNominate);
      const nominated = [];
      const misses = [];
      for (const place of places) {
        const g = await geocodePlace(cfg, place, scope, city, deps, venue);
        if (g && !nominated.some((x) => x.id === g.id)) nominated.push(g);
        else if (!g) misses.push(place.name);
      }
      result = memoSet(key, { nominated, misses, asked: places.length, city: city.name || '' });
    } catch (e) {
      error = e.message || String(e);
      result = { nominated: [], misses: [], asked: 0, city: '' };
    }
  }
  const knowledge = { ...(intent.agentKnowledge || {}), nominated: result.nominated, nominateMisses: result.misses };
  persistKnowledge(intent, knowledge, opts.store);
  return {
    stage: 'agent.nominated', durMs: deps.now() - t0, asked: result.asked, count: result.nominated.length,
    names: result.nominated.map((n) => n.name).slice(0, 10), misses: result.misses.slice(0, 10), error,
  };
}

function persistKnowledge(intent, knowledge, store) {
  intent.agentKnowledge = knowledge;
  if (store && intent.id) store.update('intents', intent.id, { agentKnowledge: knowledge });
}

/* ---------------- ③ 评审 ---------------- */
function typeLabel(tc) {
  const t = String(tc || '');
  if (/^1101/.test(t)) return '公园广场';
  if (/^1102/.test(t)) return '风景名胜';
  if (/^1401/.test(t)) return '博物馆';
  if (/^140[2467]/.test(t)) return '展馆';
  if (/^14/.test(t)) return '文化场所';
  if (/^05/.test(t)) return '餐饮';
  if (/^0601/.test(t)) return '商场';
  if (/^0610/.test(t)) return '商业街';
  if (/^06/.test(t)) return '购物';
  if (/^08/.test(t)) return '休闲娱乐';
  if (/^19/.test(t)) return '地名';
  return '其他';
}

function appraisalCtxKey(intent) {
  return `${sceneOf(intent)}:${intent.venueId}:${interestTags(intent).sort().join(',')}`;
}

/**
 * 对一组候选做评审（结果写入 intent.agentKnowledge.appraisal 与记忆）。
 * list 只需 {id,name,typecode,tags,nominated,address}：建包前（拿到候选、抓路网矩阵的同时）就能开评，
 * 大模型与高德路线矩阵两段耗时并行。
 */
async function appraiseList(cfg, intent, list, opts = {}) {
  const ac = agentConfig(cfg);
  const deps = depsOf(opts.deps);
  const t0 = deps.now();
  const prev = { ...((intent.agentKnowledge && intent.agentKnowledge.appraisal) || {}) };
  const tags = interestTags(intent);
  const ctxKey = appraisalCtxKey(intent);
  // 记忆里已有的直接复用（同一片区重复规划不再问一遍）
  for (const p of list) {
    if (prev[p.id]) continue;
    const m = memoGet(`ap:${ctxKey}:${p.id}`);
    if (m) prev[p.id] = m;
  }
  const todo = list.filter((p) => !prev[p.id]).slice(0, ac.maxAppraise);
  let error = null;
  let fresh = 0;
  if (todo.length) {
    const place = sceneOf(intent) === 'venue'
      ? `景区游玩：${(intent.venueRef && intent.venueRef.name) || opts.venueName || ''}`
      : `城市步行闲逛：从「${intent.origin.label || '起点'}」出发${endpointPoint(intent) ? `到「${intent.endpoint.label || '终点'}」` : ''}`;
    const lines = todo.map((p, i) => `${i}. ${p.name}｜${typeLabel(p.typecode)}｜现标签:${(p.tags || []).join('/')}${p.nominated ? '｜智能体提名' : ''}${p.address ? '｜' + clip(p.address, 18) : ''}`);
    const system = `你是游览路线评审。逐个评估候选点"对这位游客是否值得专门停留"。只输出 JSON：
{"r":[[编号,值得度,停留分钟,"分类","理由",噪声]]}
每个候选一行：值得度为 0 到 1 的小数；分类从 ${TAGS.join('|')} 中选 1-2 个，用/连接；理由≤20字；噪声为 1 或 0。
评分口径：
- value≥0.8：该城市/场所的代表性景点，游客会专程去；0.5-0.7：值得顺路看看；≤0.3：普通商铺、连锁店、商场楼层、设施、无游览价值；
- 噪声=1：明显不是游览点（停车场、公司、学校、XR/VR 体验馆、普通超市/便利店、楼栋、指示牌等）；
- 兴趣含"美食"时，有名的地方风味店 value 可到 0.7；否则餐饮一般 ≤0.4；
- tags 用最贴切的分类：广场/商业街/步行街是"街区"不是"自然"；寺庙祠堂故居是"人文"；
- dwellMin：一般景点 15-40，大型博物馆/园林 60-120，小吃店 20-30，路过看看 5-10；
- 不认识的点按名称与类型保守评估（0.3-0.5），不要编造事实；why 只写看得到/吃得到的具体内容。`;
    const user = `${place}
时长：约 ${Math.round(intent.budgetSec / 60)} 分钟；兴趣：${tags.join('、') || '未指定'}
候选：
${lines.join('\n')}`;
    try {
      const raw = await deps.chatJSON(cfg, system, user, { maxTokens: 1100, timeoutMs: 25000 });
      const rows = raw && Array.isArray(raw.r) ? raw.r : raw && Array.isArray(raw.items) ? raw.items : [];
      for (const row of rows) {
        // 兼容紧凑数组 [i,value,dwellMin,"人文/自然","理由",0|1] 与对象形式
        const it = Array.isArray(row)
          ? { i: row[0], value: row[1], dwellMin: row[2], tags: String(row[3] || '').split(/[\/、,，|]/).map((t) => t.trim()).filter(Boolean), why: row[4], noise: row[5] === 1 || row[5] === true || row[5] === '1' }
          : row;
        const i = Number(it && it.i);
        if (!Number.isInteger(i) || i < 0 || i >= todo.length) continue;
        const value = Number(it.value);
        if (!Number.isFinite(value)) continue;
        const dwellMin = num(it.dwellMin, 5, 240);
        const a = {
          value: r2(clamp(value, 0, 1)),
          dwellSec: dwellMin ? clamp(dwellMin * 60, 300, 7200) : null,
          tags: Array.isArray(it.tags) ? [...new Set(it.tags.filter((t) => TAGS.includes(t)))].slice(0, 2) : [],
          noise: it.noise === true || it.noise === 1,
          reason: clip(it.why || it.reason, 26) || null,
        };
        const poi = todo[i];
        prev[poi.id] = a;
        memoSet(`ap:${ctxKey}:${poi.id}`, a);
        fresh++;
      }
    } catch (e) {
      error = e.message || String(e);
    }
  }
  persistKnowledge(intent, { ...(intent.agentKnowledge || {}), appraisal: prev }, opts.store);
  return { fresh, error, durMs: deps.now() - t0 };
}

/** 建包前提前开评：条件不满足时返回 null（调用方回退到建包后 ensureAppraisal 自行评审） */
function startAppraisal(cfg, intent, list, opts = {}) {
  const ac = agentConfig(cfg);
  if (!enabledFor(cfg, intent) || !ac.llmAppraise || !llmReady(cfg) || !Array.isArray(list) || !list.length) return null;
  return appraiseList(cfg, intent, list, opts).catch((e) => ({ fresh: 0, error: e.message || String(e), durMs: 0 }));
}

async function ensureAppraisal(cfg, intent, pack, opts = {}) {
  const ac = agentConfig(cfg);
  if (!enabledFor(cfg, intent) || !isLivePack(pack) || !ac.llmAppraise || !llmReady(cfg)) return null;
  const deps = depsOf(opts.deps);
  const t0 = opts.t0 || deps.now();
  // 与路网矩阵并行的那一轮先收尾；没有提前开评时在这里评
  // （提前那轮失败也不再重试：不让大模型超时叠加两次，直接沿用类型先验）
  const early = opts.pending ? await opts.pending : null;
  const late = early ? { fresh: 0, error: null } : await appraiseList(cfg, intent, pack.pois, { ...opts, venueName: pack.venue && pack.venue.name });
  const prev = (intent.agentKnowledge && intent.agentKnowledge.appraisal) || {};
  applyAgentKnowledge(pack, intent.agentKnowledge);
  const appraised = pack.pois.filter((p) => prev[p.id]);
  return {
    stage: 'agent.appraised', durMs: deps.now() - t0, count: appraised.length,
    fresh: ((early && early.fresh) || 0) + late.fresh,
    parallel: !!early,
    noise: appraised.filter((p) => prev[p.id].noise).map((p) => p.name).slice(0, 8),
    top: [...appraised].sort((a, b) => prev[b.id].value - prev[a.id].value).slice(0, 5).map((p) => ({ name: p.name, value: prev[p.id].value })),
    error: late.error || (early && early.error) || null,
  };
}

/**
 * 把智能体知识（提名标记、评审分、停留时长、分类纠正、理由）落到场所包上。
 * 每次 resolvePackGraph 都调用：规划、编辑、途中重排看到的是同一套口径。幂等。
 */
function applyAgentKnowledge(pack, knowledge) {
  if (!isLivePack(pack) || !knowledge) return pack;
  const nomById = new Map((knowledge.nominated || []).map((n) => [n.id, n]));
  const ap = knowledge.appraisal || {};
  for (const p of pack.pois) {
    // 每次都从原始先验重算：先只有提名、后补上评审时也能正确叠加（幂等）
    if (!p._agentOrig) p._agentOrig = { scenic: p.scenic, tags: [...(p.tags || [])], dwellSec: p.dwellSec, agentReason: p.agentReason || null, nominated: !!p.nominated };
    const o = p._agentOrig;
    p.scenic = o.scenic; p.tags = [...o.tags]; p.dwellSec = o.dwellSec; p.agentReason = o.agentReason; p.nominated = o.nominated;
    delete p.agentValue; delete p.agentNoise;
    const n = nomById.get(p.id);
    if (n) {
      p.nominated = true;
      if (!p.agentReason && n.reason) p.agentReason = n.reason;
    }
    const a = ap[p.id];
    p.scenicPrior = o.scenic;
    if (a) {
      p.agentValue = a.value;
      // 按类型猜的景观分只是先验，评审分占大头；噪声点压到收益门槛之下
      let sc = 0.35 * (p.scenic ?? 0.5) + 0.65 * a.value;
      if (a.noise) sc = Math.min(sc, 0.3);
      p.scenic = r2(sc);
      p.agentNoise = !!a.noise;
      if (a.dwellSec) p.dwellSec = a.dwellSec;
      if (a.tags && a.tags.length) p.tags = [...a.tags];
      if (a.reason && !(n && n.reason)) p.agentReason = a.reason;
    } else if (n) {
      // 只有提名、没有评审（评审失败/关闭）：提名本身就是"值得去"的证据
      p.agentValue = 0.8;
      p.scenic = Math.max(p.scenic ?? 0.5, 0.85);
      if (n.dwellMin) p.dwellSec = clamp(n.dwellMin * 60, 300, 7200);
    }
    if (p.dwellMinSec && p.dwellSec < p.dwellMinSec) p.dwellSec = p.dwellMinSec;
  }
  return pack;
}

/* ---------------- ⑤ 质量评估 ---------------- */
const valueOf = (poi) => (poi.agentValue != null ? poi.agentValue : (poi.scenicPrior != null ? poi.scenicPrior : (poi.scenic ?? 0.5)));

function isCommercial(poi, foodWanted) {
  const tc = String(poi.typecode || '');
  return !!(poi.agentNoise || /^06/.test(tc) || COMMERCIAL_RE.test(poi.name || '') || (!foodWanted && /^05/.test(tc)));
}

function isABSolved(intent, solved) {
  const sch = solved.schedule;
  return !!(intent.endpoint && intent.endpoint.mode === 'fixed' && sch.endLeg && solved.endNodeId !== solved.startNodeId);
}

/** 质量分 Q∈[0,1]：值得度、预算填充、兴趣命中、非商业、末段适配、少重复、提名覆盖 */
function evaluateSolved(pack, intent, solved) {
  const sch = solved.schedule;
  const stops = sch.stops || [];
  const n = stops.length;
  const tags = new Set(interestTags(intent));
  const foodWanted = tags.has('美食');
  const avgValue = mean(stops.map((s) => valueOf(s.poi)));
  const util = clamp((sch.totals.totalSec || 0) / Math.max(1, intent.budgetSec), 0, 1);
  const utilTarget = intent.objective === 'relax' ? 0.7 : 0.85;
  const interestHit = tags.size
    ? (n ? stops.filter((s) => (s.poi.tags || []).some((t) => tags.has(t) || (t === '自然' && tags.has('公园湿地')))).length / n : 0)
    : 1;
  const commercialShare = n ? stops.filter((s) => isCommercial(s.poi, foodWanted)).length / n : 0;
  const isAB = isABSolved(intent, solved);
  const endWalkM = isAB ? Math.round(sch.endLeg.distanceM || 0) : 0;
  const endFit = isAB ? clamp(1 - Math.max(0, endWalkM - 300) / 1500, 0, 1) : 1;
  const repeatRatio = clamp((sch.totals.repeatSightM || 0) / Math.max(1, sch.totals.distanceM || 0), 0, 1);
  const nomPool = pack.pois.filter((p) => p.nominated).length;
  const nomVisited = stops.filter((s) => s.poi.nominated).length;
  const nomCov = nomPool ? Math.min(1, nomVisited / Math.min(nomPool, Math.max(1, n))) : 1;
  // 值得度按"总量覆盖"计（Σ值得度 / 预算对应的目标站数），而不是平均值：
  // 旧版 0.35×平均值奖励"少而精"，反思修复把 3 小时路线从 4 站压成 1 站（2026-10-18 线上实测 W3/W4/W9/W11）。
  const targetStops = clamp(Math.round(intent.budgetSec / 60 / 35), 1, 8);
  const coverage = Math.min(1, stops.reduce((a, s) => a + valueOf(s.poi), 0) / (targetStops * 0.75));
  const Q = n ? (0.3 * coverage + 0.12 * avgValue + 0.15 * Math.min(1, util / utilTarget) + 0.12 * interestHit + 0.1 * (1 - commercialShare)
    + 0.12 * endFit + 0.05 * (1 - repeatRatio) + 0.04 * nomCov) : 0;
  return {
    Q: r3(Q),
    metrics: {
      stops: n, avgValue: r2(avgValue), coverage: r2(coverage), targetStops, util: r2(util), interestHit: r2(interestHit), commercialShare: r2(commercialShare),
      endWalkM, repeatSightM: Math.round(sch.totals.repeatSightM || 0), distanceM: Math.round(sch.totals.distanceM || 0),
      totalSec: Math.round(sch.totals.totalSec || 0), nomVisited, nomPool, isAB,
    },
  };
}

/* ---------------- ⑤⑥ 反思：发现问题 → 候选修复操作 ---------------- */
function opKey(op) { return `${op.kind}:${op.outId || ''}>${op.inId || ''}`; }
function opLabel(op, nameOf) {
  if (op.kind === 'include') return `纳入「${nameOf(op.inId)}」`;
  if (op.kind === 'exclude') return `去掉「${nameOf(op.outId)}」`;
  return `把「${nameOf(op.outId)}」换成「${nameOf(op.inId)}」`;
}

function diagnose(pack, intent, graph, solved, ev, state) {
  const issues = [];
  const ops = [];
  const sch = solved.schedule;
  const stops = sch.stops || [];
  const inRoute = new Set(stops.map((s) => s.poi.id));
  const must = new Set(intent.hard.mustVisitIds || []);
  const avoid = new Set([...(intent.hard.avoidPoiIds || []), ...state.excluded]);
  const nodeOf = (p) => graph.nodeById.get(p.entranceNode);
  const pool = pack.pois.filter((p) => {
    if (inRoute.has(p.id) || avoid.has(p.id) || p.agentNoise) return false;
    const node = nodeOf(p);
    return node && node.status === 'open';
  }).sort((a, b) => valueOf(b) - valueOf(a));
  const removable = stops.map((s) => s.poi).filter((p) => !must.has(p.id)).sort((a, b) => valueOf(a) - valueOf(b));
  const worst = removable[0] || null;
  const add = (op) => { if (op.inId && op.inId === op.outId) return; if (!ops.some((o) => opKey(o) === opKey(op))) ops.push({ source: 'rule', ...op }); };
  const m = ev.metrics;
  const tags = new Set(interestTags(intent));
  const foodWanted = tags.has('美食');

  // 末段空走：A→B 最后一站离终点太远 → 纳入/换入终点附近值得去的点
  if (m.isAB && m.endWalkM > 500) {
    issues.push({ code: 'END_EMPTY_WALK', label: `末站离终点还要步行约 ${Math.round(m.endWalkM / 100) * 100} 米` });
    const endNode = graph.nodeById.get(solved.endNodeId);
    const near = pool.filter((p) => endNode && haversineM(nodeOf(p), endNode) < m.endWalkM * 0.6 && valueOf(p) >= 0.4).slice(0, 2);
    for (const p of near) {
      add({ kind: 'include', inId: p.id, why: '靠近终点，顺路收尾' });
      if (worst) add({ kind: 'swap', outId: worst.id, inId: p.id, why: '用终点附近的点替换低价值站' });
    }
  }
  // 预算没用满 → 纳入价值最高的未选点
  const utilTarget = intent.objective === 'relax' ? 0.6 : 0.75;
  if (m.util < utilTarget && pool.length) {
    issues.push({ code: 'UNDER_FILLED', label: `时长只用了 ${Math.round(m.util * 100)}%` });
    for (const p of pool.filter((x) => valueOf(x) >= 0.45).slice(0, 2)) add({ kind: 'include', inId: p.id, why: '预算还有余量' });
  }
  // 低价值站 → 去掉或换成更值得的
  const lows = removable.filter((p) => valueOf(p) < 0.4 || p.agentNoise);
  if (lows.length) {
    issues.push({ code: 'LOW_VALUE_STOP', label: `「${lows.slice(0, 2).map((p) => p.name).join('」「')}」游览价值偏低` });
    for (const low of lows.slice(0, 2)) {
      add({ kind: 'exclude', outId: low.id, why: '游览价值偏低' });
      const better = pool.find((p) => valueOf(p) >= valueOf(low) + 0.2);
      if (better) add({ kind: 'swap', outId: low.id, inId: better.id, why: '换成更值得去的点' });
    }
  }
  // 无美食偏好时，餐饮/消费类站点最多留 1 个（2 小时精华路线不该有近半数停留是吃，2026-10-18 审计样本）
  const foodStops = stops.filter((s) => !must.has(s.poi.id) && !s.poi.nominated && /^05/.test(String(s.poi.typecode || '')));
  if (!foodWanted && foodStops.length > 1) {
    const dropList = [...foodStops].sort((a, b) => valueOf(a.poi) - valueOf(b.poi)).slice(0, foodStops.length - 1);
    issues.push({ code: 'TOO_MANY_FOOD', label: `未要求美食却有 ${foodStops.length} 个餐饮停靠` });
    for (const st of dropList) add({ kind: 'exclude', outId: st.poi.id, why: '控制餐饮停靠数量' });
  }
  // 漏掉代表性地点 → 纳入/替换
  const minIn = stops.length ? Math.min(...stops.map((s) => valueOf(s.poi))) : 0;
  const highs = pool.filter((p) => (valueOf(p) >= 0.75 || (p.nominated && valueOf(p) >= 0.6)) && valueOf(p) > minIn + 0.15).slice(0, 2);
  if (highs.length) {
    issues.push({ code: 'MISSED_HIGHLIGHT', label: `没有包含代表性地点「${highs[0].name}」` });
    for (const h of highs) {
      add({ kind: 'include', inId: h.id, why: '代表性地点' });
      if (worst && valueOf(worst) < valueOf(h)) add({ kind: 'swap', outId: worst.id, inId: h.id, why: '用代表性地点替换低价值站' });
    }
  }
  // 商业化过重 → 去掉最"商业"的低价值站
  if (m.commercialShare > 0.4 && stops.length >= 3) {
    issues.push({ code: 'TOO_COMMERCIAL', label: `商场/连锁/体验馆类站点占 ${Math.round(m.commercialShare * 100)}%` });
    const com = removable.filter((p) => isCommercial(p, foodWanted)).slice(0, 2);
    for (const p of com) {
      add({ kind: 'exclude', outId: p.id, why: '商业化站点' });
      const alt = pool.find((x) => !isCommercial(x, foodWanted) && valueOf(x) >= 0.5);
      if (alt) add({ kind: 'swap', outId: p.id, inId: alt.id, why: '换成非商业的游览点' });
    }
  }
  return { issues, ops: ops.slice(0, 8), pool };
}

/** 可选：大模型看了问题清单后提议修复操作（只能引用给定编号，服务端逐条校验） */
async function llmCriticOps(cfg, intent, solved, ev, diag, deps) {
  const stops = solved.schedule.stops || [];
  const must = new Set(intent.hard.mustVisitIds || []);
  const pool = diag.pool.slice(0, 8);
  const sLines = stops.map((s, i) => `s${i}. ${s.poi.name}｜值得度${valueOf(s.poi)}｜停留${Math.round(s.dwellSec / 60)}分${must.has(s.poi.id) ? '｜用户必去(不可去掉)' : ''}`);
  const cLines = pool.map((p, i) => `c${i}. ${p.name}｜值得度${valueOf(p)}${p.nominated ? '｜提名' : ''}${p.agentReason ? '｜' + p.agentReason : ''}`);
  const system = `你是路线复核员。根据当前路线、发现的问题和未入选候选，提出至多 3 个修复操作。只输出 JSON：
{"ops":[{"type":"include|exclude|swap","add":"c编号（include/swap 需要）","remove":"s编号（exclude/swap 需要）","why":"≤16字"}]}
规则：只能引用给出的编号；不能去掉"用户必去"的站；目标是让路线更值得走、末段少空走、时长用得更充分。`;
  const user = `当前路线（共 ${Math.round(ev.metrics.totalSec / 60)} 分钟/预算 ${Math.round(intent.budgetSec / 60)} 分钟，步行 ${ev.metrics.distanceM} 米${ev.metrics.isAB ? `，末站到终点 ${ev.metrics.endWalkM} 米` : ''}）：
${sLines.join('\n')}
问题：${diag.issues.map((x) => x.label).join('；') || '无明显问题'}
未入选候选：
${cLines.join('\n') || '（无）'}`;
  const raw = await deps.chatJSON(cfg, system, user, { maxTokens: 500, timeoutMs: 12000 });
  const out = [];
  for (const o of (raw && Array.isArray(raw.ops) ? raw.ops : []).slice(0, 3)) {
    const kind = ['include', 'exclude', 'swap'].includes(o && o.type) ? o.type : null;
    if (!kind) continue;
    const ci = /^c(\d+)$/.exec(String(o.add || '')), si = /^s(\d+)$/.exec(String(o.remove || ''));
    const inPoi = ci ? pool[Number(ci[1])] : null;
    const outStop = si ? stops[Number(si[1])] : null;
    if ((kind !== 'exclude' && !inPoi) || (kind !== 'include' && !outStop)) continue;
    if (outStop && must.has(outStop.poi.id)) continue; // 用户必去点不可去掉
    out.push({ kind, inId: inPoi ? inPoi.id : undefined, outId: outStop ? outStop.poi.id : undefined, why: clip(o.why, 20), source: 'llm' });
  }
  return out;
}

const BOOST = 0.8; // 1.5 过大：远点被优先插入、挤掉多个近点（2026-10-18 实测）
function workingIntent(intent, state) {
  return {
    ...intent,
    hard: { ...intent.hard, avoidPoiIds: [...new Set([...(intent.hard.avoidPoiIds || []), ...state.excluded])] },
    agentBoost: { ...(intent.agentBoost || {}), ...state.boost },
  };
}
function applyOp(state, op) {
  const next = { boost: { ...state.boost }, excluded: new Set(state.excluded) };
  if (op.outId) { next.excluded.add(op.outId); delete next.boost[op.outId]; }
  if (op.inId) { next.boost[op.inId] = BOOST; next.excluded.delete(op.inId); }
  return next;
}
function sameStops(a, b) {
  const x = a.schedule.stops.map((s) => s.nodeId).join('>');
  const y = b.schedule.stops.map((s) => s.nodeId).join('>');
  return x === y;
}
function jaccard(a, b) {
  const A = new Set(a.schedule.stops.map((s) => s.nodeId)), B = new Set(b.schedule.stops.map((s) => s.nodeId));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / Math.max(1, A.size + B.size - inter);
}

/** 在已求得的主方案上做反思-修复循环；返回最终方案、修改记录与各轮 trace */
async function criticLoop({ cfg, pack, intent, graph, policy, solved, deps, deadline, onProgress }) {
  const ac = agentConfig(cfg);
  const nameOf = (pid) => ((pack._poiById && pack._poiById.get(pid)) || pack.pois.find((p) => p.id === pid) || { name: pid }).name;
  let state = { boost: {}, excluded: new Set() };
  let cur = solved;
  let curEv = evaluateSolved(pack, intent, cur);
  const initial = curEv;
  const rounds = [];
  const accepted = [];
  for (let round = 1; round <= ac.maxRounds; round++) {
    const diag = diagnose(pack, intent, graph, cur, curEv, state);
    let ops = diag.ops;
    let llmUsed = false;
    if (diag.issues.length && ac.llmCritic && llmReady(cfg) && round === 1 && deps.now() < deadline) {
      try {
        const llmOps = await llmCriticOps(cfg, intent, cur, curEv, diag, deps);
        llmUsed = true;
        for (const op of llmOps) if (!ops.some((o) => opKey(o) === opKey(op))) ops = [op, ...ops];
      } catch (e) { /* 大模型提议失败不影响规则反思 */ }
    }
    if (!diag.issues.length || !ops.length) {
      rounds.push({ round, before: curEv.Q, after: curEv.Q, issues: diag.issues, tried: [], accepted: null, llmUsed });
      break;
    }
    if (onProgress) onProgress({ stage: 'critic', round, issues: diag.issues.map((x) => x.label) });
    const tried = [];
    let best = null;
    for (const op of ops) {
      const st = applyOp(state, op);
      const r = solveOnce(pack, workingIntent(intent, st), graph, policy);
      const label = opLabel(op, nameOf);
      if (r.status !== 'ok' || !(r.schedule.stops || []).length) { tried.push({ label, source: op.source, q: null, ok: false }); continue; }
      if (sameStops(r, cur)) { tried.push({ label, source: op.source, q: curEv.Q, ok: true, same: true }); continue; }
      const ev = evaluateSolved(pack, intent, r);
      // 护栏：修复不得把路线"压塌"——站数少 2 站以上、或预算利用率掉 15 个百分点以上的方案一律不采纳
      const collapsed = ev.metrics.stops < curEv.metrics.stops - 1 || ev.metrics.util < curEv.metrics.util - 0.15
        || (ev.metrics.stops < curEv.metrics.stops && ev.metrics.stops < Math.min(3, ev.metrics.targetStops));
      tried.push({ label, source: op.source, q: ev.Q, ok: true, rejected: collapsed ? 'collapse' : undefined });
      if (collapsed) continue;
      if (!best || ev.Q > best.ev.Q) best = { op, st, r, ev, label };
    }
    const gain = best ? best.ev.Q - curEv.Q : 0;
    const take = best && gain > ac.minGain;
    rounds.push({
      round, before: curEv.Q, after: take ? best.ev.Q : curEv.Q, llmUsed,
      issues: diag.issues, tried: tried.slice(0, 8),
      accepted: take ? { label: best.label, source: best.op.source, why: best.op.why || '', gain: r3(gain) } : null,
    });
    if (!take) break;
    state = best.st;
    cur = best.r;
    curEv = best.ev;
    accepted.push({ ...best.op, label: best.label, gain: r3(gain) });
  }
  return { solved: cur, ev: curEv, initial, rounds, accepted, state };
}

/* ---------------- ⑦ 解释 ---------------- */
function explainFacts(pack, intent, solved, ev, accepted) {
  const sch = solved.schedule;
  const ep = intent.endpoint || {};
  return {
    scene: sceneOf(intent),
    place: sceneOf(intent) === 'venue' ? ((intent.venueRef && intent.venueRef.name) || pack.venue.name) : (intent.origin.label || '起点'),
    endLabel: ep.mode === 'fixed' ? (ep.label || '终点') : ep.mode === 'return_to_origin' ? '回到起点' : '顺路结束',
    stops: sch.stops.map((s, i) => ({ order: i + 1, name: s.poi.name, dwellMin: Math.round(s.dwellSec / 60), reason: s.poi.agentReason || null })),
    totalMin: Math.round(sch.totals.totalSec / 60),
    distanceKm: Math.round((sch.totals.distanceM || 0) / 100) / 10,
    budgetMin: Math.round(intent.budgetSec / 60),
    endWalkM: ev.metrics.isAB ? Math.round(ev.metrics.endWalkM / 10) * 10 : null,
    endWalkMin: ev.metrics.isAB && sch.endLeg ? Math.max(1, Math.round((sch.endLeg.travelSec || 0) / 60)) : null,
    repeatM: Math.round(sch.totals.repeatSightM || 0),
    interests: interestTags(intent),
    changes: accepted.map((a) => a.label),
  };
}

function templateRationale(f) {
  const n = f.stops.length;
  const names = f.stops.map((s) => `「${s.name}」`);
  let t = n === 1 ? `安排了${names[0]}一站` : `共 ${n} 站：先到${names[0]}，${n > 2 ? `再到${names.slice(1, -1).join('、')}，` : ''}最后到${names[n - 1]}`;
  t += `，全程约 ${f.totalMin} 分钟、步行 ${f.distanceKm} 公里。`;
  const why = f.stops.filter((s) => s.reason).slice(0, 2).map((s) => `${s.name}${s.reason.startsWith('，') ? '' : '：'}${s.reason}`);
  if (why.length) t += why.join('；') + '。';
  if (f.endWalkM != null && f.endWalkM > 500) t += `最后一站离${f.endLabel}约 ${Math.round(f.endWalkM / 100) * 100} 米，还需步行约 ${f.endWalkMin} 分钟。`;
  if (f.repeatM > 200) t += `途中约有 ${f.repeatM} 米需要沿原路走回。`;
  if (f.changes.length) t += `智能体复核时已${f.changes[0]}。`;
  return t;
}

/** 大模型文案的事实校验：数字必须出自事实，地点必须是站点，不许绝对化承诺 */
function checkRationale(text, f) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 15 || t.length > 220) return false;
  if (/零回头|完全避免|绝不走回头|完美|最优路线|保证/.test(t)) return false;
  const allowed = new Set();
  const addN = (v) => { if (v != null && Number.isFinite(Number(v))) { allowed.add(String(v)); allowed.add(String(Number(v))); } };
  [f.stops.length, f.totalMin, f.distanceKm, f.budgetMin, f.endWalkM, f.endWalkMin, f.repeatM].forEach(addN);
  if (f.endWalkM != null) addN(Math.round(f.endWalkM / 100) * 100);
  addN(Math.round((f.totalMin / 60) * 10) / 10);
  f.stops.forEach((s) => { addN(s.dwellMin); addN(s.order); });
  for (const mm of t.match(/\d+(?:\.\d+)?/g) || []) {
    if (Number(mm) <= 3 || allowed.has(mm)) continue;
    if (f.stops.some((s) => s.name.includes(mm))) continue; // 地名里的数字（"九眼桥""1号院"）
    return false;
  }
  if (f.endWalkM != null && f.endWalkM > 500 && !/末|最后|终点/.test(t)) return false; // 必须交代末段
  if (f.repeatM > 200 && !/回头|原路|折返/.test(t)) return false;
  // 「」里出现的地名必须是站点
  for (const m of t.matchAll(/「([^」]+)」/g)) {
    if (!f.stops.some((s) => s.name === m[1] || s.name.includes(m[1]) || m[1].includes(s.name)) && m[1] !== f.endLabel && m[1] !== f.place) return false;
  }
  return true;
}

async function explain(cfg, f, deps, deadline) {
  const ac = agentConfig(cfg);
  if (ac.llmExplain && llmReady(cfg) && deps.now() < deadline) {
    try {
      const system = `你是路线讲解员。只根据给定事实，用 2-3 句中文写这条路线的推荐理由（总共不超过 120 字）。
规则：只能使用事实里的地点名和数字，不得新增地点或数字；地点名用「」括起来；
说清先看什么、再看什么、为什么值得（用事实里的 reason）；
endWalkM 大于 500 时必须说明最后一段到终点还要步行多远；repeatM 大于 200 时必须如实说明有回头路；
不要用"零回头路""完美""保证"等绝对化用语。只输出 JSON：{"text":"..."}`;
      const raw = await deps.chatJSON(cfg, system, JSON.stringify(f), { maxTokens: 400, timeoutMs: 12000, temperature: 0.4 });
      const text = raw && typeof raw.text === 'string' ? raw.text.trim() : '';
      if (checkRationale(text, f)) return { text, source: 'llm' };
      return { text: templateRationale(f), source: 'template', rejected: clip(text, 120) || null };
    } catch (e) {
      return { text: templateRationale(f), source: 'template', error: e.message || String(e) };
    }
  }
  return { text: templateRationale(f), source: 'template' };
}

/* ---------------- 编排入口 ---------------- */
/**
 * 运行内核：基础智能体（台账/求解/独立验证/冲突修复提议）→ 反思-修复循环 → 备选筛选 → 解释。
 * 返回值与 RoutePlanningAgent.plan 同形（solutions/trace/constraintLedger/proposals/agentRationale/agentStrategy），
 * 另加 quality 与 critic 记录。
 */
async function runAgentKernel({ cfg, pack, intent, graph, planId = 'agent_plan', preTrace = [], deps: d, onProgress, startedAt }) {
  const deps = depsOf(d);
  const ac = agentConfig(cfg);
  const t0 = startedAt || deps.now();
  const deadline = t0 + ac.timeBudgetMs;
  const base = new RoutePlanningAgent().plan({ pack, intent, graph, planId });
  const trace = [...preTrace.filter(Boolean), ...base.trace];
  if (base.status !== 'ready' || !base.solutions.length || !isLivePack(pack)) return { ...base, trace };

  const tc = deps.now();
  const main = base.solutions[0];
  const loop = await criticLoop({ cfg, pack, intent, graph, policy: main.policy, solved: main.solved, deps, deadline, onProgress });
  for (const r of loop.rounds) trace.push({ stage: 'critic.round', ms: deps.now() - t0, ...r });

  // 备选：主推荐被改过 → 带着同样的修改重新生成差异化备选；再按质量过滤劣势备选
  const mainSolved = loop.solved;
  const mainEv = loop.ev;
  const pool = loop.accepted.length
    ? solveAlternatives(pack, workingIntent(intent, loop.state), graph)
    : base.solutions.slice(1);
  const solutions = [{ policy: main.policy, solved: mainSolved, sig: new Set(mainSolved.schedule.stops.map((s) => s.nodeId)) }];
  const dropped = [];
  for (const alt of pool) {
    if (!alt || !alt.solved || alt.solved.status !== 'ok') continue;
    if (solutions.some((s) => jaccard(s.solved, alt.solved) > 0.75)) continue; // 近似重复（含与新主推荐重复）
    const ev = evaluateSolved(pack, intent, alt.solved);
    const worseEnd = mainEv.metrics.isAB && ev.metrics.endWalkM > Math.max(800, mainEv.metrics.endWalkM + 600);
    if (ev.Q < mainEv.Q - 0.12 || worseEnd) {
      dropped.push({ policy: alt.policy.name, q: ev.Q, endWalkM: ev.metrics.endWalkM, reason: worseEnd ? '末段空走明显更长' : '质量分明显更低' });
      continue;
    }
    solutions.push(alt);
    if (solutions.length >= 3) break;
  }
  // 距离矩阵模式：先回填真实步行折线并按真实距离重排时间，再验证、再写解释（解释里的数字与发布路线一致）
  for (const s of solutions) s.solved = await hydrateSolved(pack, intent, graph, s.solved);
  // 发布前独立验证（用用户原始意图：智能体选的点不算用户锁定，硬约束按用户口径复核）
  const verified = solutions.filter((s, i) => {
    const plan = buildRoutePlan(pack, intent, graph, s.solved, { version: i + 1, planId });
    return verifyRoutePlan(plan).ok;
  });
  const finalSolutions = verified.length && verified[0] === solutions[0] ? verified : base.solutions;
  if (finalSolutions === base.solutions) for (const s of finalSolutions) s.solved = await hydrateSolved(pack, intent, graph, s.solved);
  trace.push({
    stage: 'agent.quality', ms: deps.now() - t0, durMs: deps.now() - tc,
    before: loop.initial.Q, after: finalSolutions === base.solutions ? loop.initial.Q : mainEv.Q,
    metricsBefore: loop.initial.metrics, metrics: (finalSolutions === base.solutions ? loop.initial : mainEv).metrics,
    alternatives: finalSolutions.length - 1, dropped,
  });

  // 解释
  const usedSolved = finalSolutions[0].solved;
  // 回填折线后距离/末段以真实路线为准：重新评估一次，解释与质量分都用发布口径
  const usedEv = evaluateSolved(pack, intent, usedSolved);
  const facts = explainFacts(pack, intent, usedSolved, usedEv, finalSolutions === base.solutions ? [] : loop.accepted);
  if (onProgress) onProgress({ stage: 'explain' });
  const te = deps.now();
  const ex = await explain(cfg, facts, deps, deadline);
  trace.push({ stage: 'agent.explained', ms: deps.now() - t0, durMs: deps.now() - te, source: ex.source, rejected: ex.rejected || null, error: ex.error || null });

  const isLoop = usedSolved.endNodeId === usedSolved.startNodeId;
  const n = usedSolved.schedule.stops.length;
  const strategy = {
    flowType: n >= 2 ? (isLoop ? '环形闭环' : '单向游览') : '',
    summary: ex.text,
    pace: intent.pace || 'normal',
    highlights: usedSolved.schedule.stops.map((s) => ({ poiId: s.poi.id, name: s.poi.name, reason: s.poi.agentReason || null, nominated: !!s.poi.nominated })),
    quality: { before: loop.initial.Q, after: usedEv.Q, metrics: usedEv.metrics },
    changes: facts.changes,
    explainedBy: ex.source,
  };
  return {
    ...base,
    solutions: finalSolutions,
    agentRationale: ex.text,
    agentStrategy: strategy,
    quality: strategy.quality,
    critic: { rounds: loop.rounds, accepted: loop.accepted.map((a) => ({ label: a.label, source: a.source, gain: a.gain })) },
    trace,
  };
}

module.exports = {
  startAppraisal, appraiseList,
  agentConfig, enabledFor, llmReady, isLiveIntent, isLivePack,
  ensureNominations, ensureAppraisal, applyAgentKnowledge,
  evaluateSolved, diagnose, criticLoop, runAgentKernel,
  explainFacts, templateRationale, checkRationale,
  nameMatches, coreName, geoScope, cleanPlaces, clearMemo,
};
