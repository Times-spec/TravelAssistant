'use strict';
/**
 * 高德真实 Provider（Web 服务）：
 * - 周边候选检索、文本搜索、逆地理、坐标转换、步行路由。
 * - 设计约束（文档 §8.6）：直线距离仅粗筛；发布的路段必须有真实路由（步行 API 折线）；
 *   路由调用计入预算 maxRoutingCalls；请求失败的边标 unreachable，绝不用直线顶替。
 * - 与场所包同构输出（VenueGraph 接口 + pack 结构），求解/校验层零改动复用。
 */
const { haversineM } = require('./geo');
const { geometrySegmentKeys } = require('./route_constraints');

const AMAP = 'https://restapi.amap.com';

/**
 * 全局限速门：高德个人账号约 3 QPS，被限流时自动加大间隔、平稳时缓慢回落。
 * 所有高德请求都经过这里，避免并发任务把配额打爆（§17.3 成本与配额控制）。
 */
const rateGate = {
  minIntervalMs: 360,
  lastAt: 0,
  _waiting: Promise.resolve(),
  async pass() {
    const run = this._waiting.then(async () => {
      const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastAt));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
    });
    this._waiting = run.catch(() => {});
    return run;
  },
  penalize() { this.minIntervalMs = Math.min(1600, Math.round(this.minIntervalMs * 1.6)); },
  relax() { this.minIntervalMs = Math.max(360, Math.round(this.minIntervalMs * 0.97)); },
};

/**
 * 路由矩阵配额 → 最多能覆盖几个候选。
 * n 个候选 + 起点 = n+1 个节点，两两 C(n+1,2) 对，另留约 10% 重试余量。
 *
 * 2026-09-30 修：此前是 `maxCalls = maxRoutingCalls − 8`，配上 config.json 里的 60，
 * 12 个候选（13 节点）需要 78 对却只抓得到 52 对。抓取顺序是 for i / for j>i，
 * 于是质量分最低的 5 个候选互相之间一条路都没有：插入一个点需要 prev→点 与 点→next 同时存在，
 * 所以它们永远插不进多站路线，2-opt 里涉及它们的交换也只会静默失败。
 * 最终顺序被"配额恰好覆盖了哪些点对"决定，而不是被地理决定。
 */
function maxCandidatesForQuota(maxRoutingCalls, reserveRatio = 0.1) {
  const budget = Math.max(6, Math.floor((Number(maxRoutingCalls) || 60) * (1 - reserveRatio)));
  let c = 1;
  while (((c + 1) * c) / 2 <= budget) c++;
  return Math.max(1, c - 1);
}

/** 步行路由矩阵缓存：同一场所 10 分钟内反复规划不再重抓同一批 OD（只有首次慢） */
const matrixCache = new Map();
const MATRIX_TTL_MS = 10 * 60 * 1000;
const MATRIX_CACHE_MAX = 12;
function matrixCacheGet(key) {
  if (!key) return null;
  const hit = matrixCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MATRIX_TTL_MS) { matrixCache.delete(key); return null; }
  return hit.value;
}
function matrixCacheSet(key, value) {
  if (!key) return;
  matrixCache.set(key, { at: Date.now(), value });
  while (matrixCache.size > MATRIX_CACHE_MAX) matrixCache.delete(matrixCache.keys().next().value);
}
/** 起点按约 50m 网格取整后再进缓存键：GPS 轻微漂移不该让整张矩阵失效 */
function matrixCacheKeyOf(prefix, origin, ids) {
  const grid = 0.0005;
  return `${prefix}|${Math.round(origin.lng / grid)}|${Math.round(origin.lat / grid)}|${ids.join(',')}`;
}

async function amapGetOnce(cfg, path, params) {
  await rateGate.pass();
  const qs = new URLSearchParams({ key: cfg.amap.webServiceKey, ...params }).toString();
  const resp = await fetch(`${AMAP}${path}?${qs}`, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) { const e = new Error('amap http ' + resp.status); e.code = 'PROVIDER_RATE_LIMITED'; throw e; }
  const json = await resp.json();
  if (json.status !== '1') {
    const e = new Error('amap: ' + (json.info || 'error') + ' (' + json.infocode + ')');
    e.code = ['10021', '10003', '10044', '10019', '10020'].includes(String(json.infocode)) ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_ERROR';
    e.infocode = String(json.infocode);
    throw e;
  }
  rateGate.relax();
  return json;
}

/** §17.1：限流/超时有上限重试 + 指数退避与抖动；不补造数据 */
async function amapGet(cfg, path, params) {
  let lastErr = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await amapGetOnce(cfg, path, params);
    } catch (e) {
      lastErr = e;
      if (e.code !== 'PROVIDER_RATE_LIMITED' || attempt === 2) throw e;
      rateGate.penalize(); // 被限流 → 后续请求整体放慢
      const backoff = 700 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/* ---------- 类型映射：高德 typecode → 本产品兴趣标签/停留 ----------
 * 按官方 POI 分类编码表（amap_poicode 2023-10）精确到二级子类：
 * 1401=博物馆 1402=展览馆 1404=美术馆 1405=图书馆 1406=科技馆 1407=天文馆 1408=文化宫；
 * 学校/科研/培训/驾校（1412xx/1413xx/1414xx/1415xx）不在此映射——它们根本不该进候选池。
 */
function mapType(typecode, name) {
  const tc = String(typecode || '');
  if (/^1101/.test(tc)) return { tags: ['自然'], dwellSec: 1500, scenic: 0.7 };          // 公园广场（公园/动物园/植物园/水族馆/城市广场）
  if (/^1102/.test(tc)) return { tags: ['自然', '人文'], dwellSec: 1500, scenic: 0.8 };  // 风景名胜（含寺庙/纪念馆/观景点/红色景区）
  if (/^1401/.test(tc)) return { tags: ['人文', '建筑'], dwellSec: 2400, scenic: 0.75 }; // 博物馆
  if (/^140[2467]/.test(tc)) return { tags: ['人文', '建筑'], dwellSec: 1800, scenic: 0.75 }; // 展览馆/美术馆/科技馆/天文馆
  if (/^140[58]/.test(tc)) return { tags: ['人文'], dwellSec: 1200, scenic: 0.6 };       // 图书馆/文化宫
  if (/^05/.test(tc)) return { tags: ['美食'], dwellSec: 1500, scenic: 0.5 };            // 餐饮
  if (/^06(01|10)/.test(tc)) return { tags: ['街区'], dwellSec: 900, scenic: 0.55 };     // 商场/特色商业街（步行街）
  if (/^0612/.test(tc)) return { tags: ['街区', '人文'], dwellSec: 600, scenic: 0.5 };   // 古玩/书店/礼品/土特产小店
  if (/^08(05|06)/.test(tc)) return { tags: ['街区'], dwellSec: 1200, scenic: 0.6 };     // 休闲场所/影剧院（游乐场/露营/音乐厅/剧场）
  void name;
  return { tags: ['街区'], dwellSec: 900, scenic: 0.4 };
}

/* ---------- 游览准入：名称黑名单（兜底，不依赖类目表准确性） ----------
 * 检索类目已收窄到白名单，但高德仍可能返回楼内混合业态；这些名称的场所在"逛街游览"语境下
 * 没有游览价值（学校/培训机构/医院/银行/批发市场/纯运动场馆/酒店书吧/设施节点等），
 * 一律不进候选池。注意"公园"不得被"幼儿园"误伤——黑名单用完整词，不用单字"园"。
 * 2026-10-01 春熙路实数据补强：080500 休闲场所在商圈=拼豆/DIY 工坊重灾区（名称词兜底）、
 * 亚朵酒店把大堂书吧标成"图书馆"（连锁品牌词）、商场内部设施节点（楼梯/扶梯）。 */
const EXCLUDE_NAME_RE = new RegExp([
  '学校', '学院', '大学', '培训', '补习', '考研', '驾校', '幼儿园', '托育', '托管',
  '医院', '诊所', '卫生服务', '药店', '药房', '体检',
  '银行', '储蓄', '信用社', '证券', '保险', '营业厅',
  '加油站', '充电站', '加气站', '停车场', '洗车', '汽修', '维修', '4S',
  '五金', '建材', '家居', '家装', '批发', '菜市场', '超市', '便利店', '粮油',
  '公司', '工厂', '产业园', '写字楼', '办公楼', '宿舍', '公寓',
  '宾馆', '酒店', '民宿', '旅馆', '旅舍', '网吧', '网咖', '棋牌', 'KTV', '夜总会', '迪厅', '彩票',
  '殡仪', '墓园', '陵园', '养老院', '敬老院', '福利院',
  '快递', '驿站', '公厕', '环卫', '变电站', '水厂',
  '楼梯', '扶梯', '电梯', '出入口', '通道', '收银', '柜台', '卫生间', '厕所',
  '拼豆', '手作', 'DIY', '自拍', '换装', '密室', '剧本杀', '影院', '影城', '电玩', 'PS5',
  '亚朵', '如家', '汉庭', '全季', '锦江之星', '7天', '速8', '格林', '维也纳', '丽枫', '桔子',
  '希尔顿', '万豪', '洲际', '凯悦', '香格里拉', '索菲特', '喜来登', '威斯汀', '华住', '首旅',
].join('|'), 'i');

/** 名称归一化：去掉括注（分店/楼层/打卡点后缀）与空白，再截到第一个分隔符前的"品牌段"
 * （"笑古里喜剧剧场(商业场店)"→"笑古里"；"IFS国际金融中心-圆形窗洞"→"IFS国际金融中心"），
 * 分隔符前不足 2 字时退回整体前 8 字（"运·本命年"→"运本命年旗舰店"）。
 * 用于同主体/同品牌去重。 */
function normalizeNameForDedupe(name) {
  const base = String(name || '').replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').replace(/\s+/g, '');
  const m = base.match(/^[^-·—|｜/]*/);
  const brand = m && m[0].length >= 2 ? m[0] : base;
  return brand.slice(0, 8);
}

/** 同主体去重：归一化品牌段相同视为同一地点/同一品牌连锁，
 * 组内只保留离起点最近的那个（亚朵书吧 ×3、礼信堂特产 ×2、春熙路牌打卡点 ×5、
 * 同楼"笑古里"×3 这类重复由此消除）。 */
function dedupeByPrefix(cands) {
  const groups = new Map();
  for (const c of cands) {
    const key = normalizeNameForDedupe(c.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const kept = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (a.distanceM ?? 9999) - (b.distanceM ?? 9999));
    kept.push(list[0]);
  }
  return kept;
}

/* ---------- 周边候选（§7.4：覆盖几个不同类别，去重后评分压缩） ----------
 * 检索类目白名单（官方 POI 分类编码表）：只搜"值得逛"的子类，每组用 | 合并为一次请求。
 * 此前整包检索 140000/060000/080000 三个大类，高等院校与培训机构混进候选（"考研学校"），
 * 便利店/超市/家电卖场/KTV 同理，而 061000 特色商业街这类最该有的点反而从未被搜过。 */
const SEARCH_TYPE_GROUPS = [
  '110100|110200',                                    // 公园广场/风景名胜（含打卡点/观景点/雕塑）
  '050000',                                           // 餐饮
  '140100|140200|140400|140500|140600|140700|140800', // 博物馆/展览馆/美术馆/图书馆/科技馆/天文馆/文化宫
  '060100|061000|061201|061205|061209|061214',        // 商场/特色商业街(步行街)/古玩/书店/礼品/土特产
  '080602|080603',                                    // 音乐厅/剧场（080601 电影院实数据被"私人影院/PS5电玩"包间店占满，剔除）
  // 注：080500 休闲场所不检索——实数据里该子类被手工 DIY/拼豆/自拍馆工坊占满（2026-10-01 春熙路验证）
];

async function searchAround(cfg, point, radiusM) {
  const seen = new Map();
  for (const types of SEARCH_TYPE_GROUPS) {
    const json = await amapGet(cfg, '/v3/place/around', {
      location: `${point.lng},${point.lat}`, types, radius: String(Math.min(radiusM, 4000)),
      offset: '15', page: '1', extensions: 'base',
    });
    for (const p of json.pois || []) {
      if (!seen.has(p.id)) seen.set(p.id, p);
    }
  }
  return dedupeByPrefix([...seen.values()]
    .filter((p) => !EXCLUDE_NAME_RE.test(p.name || '')))
    .map((p) => {
    const [lng, lat] = p.location.split(',').map(Number);
    const m = mapType(p.typecode, p.name);
    return {
      id: 'am_' + p.id, name: p.name, providerPoiId: p.id,
      address: typeof p.address === 'string' ? p.address : '',
      lng, lat, type: p.type, typecode: p.typecode,
      distanceM: Number(p.distance) || Math.round(haversineM(point, { lng, lat })),
      ...m,
    };
  });
}

/* ---------- 步行路由（真实路段折线，§8.6） ---------- */
async function walkingRoute(cfg, from, to) {
  const json = await amapGet(cfg, '/v3/direction/walking', {
    origin: `${from.lng},${from.lat}`, destination: `${to.lng},${to.lat}`,
  });
  const p = json.route.paths[0];
  const coords = [];
  // 逐步导引：保留高德每一步的文字指令/动作/道路名与它在折线里的起点下标，
  // 前端"怎么走"卡片直接用（此前只拼折线、把指令全扔了，游览页只能外跳高德导航）。
  const steps = [];
  for (const s of p.steps || []) {
    const startIdx = Math.max(0, coords.length - 1);
    for (const pair of String(s.polyline || '').split(';')) {
      const [lng, lat] = pair.split(',').map(Number);
      if (Number.isFinite(lng) && Number.isFinite(lat)) coords.push([lng, lat]);
    }
    const str = (v) => (typeof v === 'string' ? v : '');
    steps.push({
      instruction: str(s.instruction), action: str(s.action), assistantAction: str(s.assistant_action),
      road: str(s.road), distanceM: Number(s.distance) || 0, startIdx,
    });
  }
  return { distanceM: Number(p.distance), durationSec: Number(p.duration), geometry: coords, steps, provider: 'amap-walking' };
}

/* ---------- 文本搜索 / 逆地理 / 坐标转换 ---------- */
async function textSearch(cfg, q, city) {
  const json = await amapGet(cfg, '/v3/place/text', {
    keywords: q, city: city || '', citylimit: city ? 'true' : 'false', offset: '10', page: '1', extensions: 'base',
  });
  return (json.pois || []).map((p) => {
    const [lng, lat] = String(p.location || ',').split(',').map(Number);
    return {
      kind: 'poi', id: 'am_' + p.id, providerPoiId: p.id, name: p.name,
      city: (p.cityname || '') + '', address: typeof p.address === 'string' ? p.address : '',
      disambiguation: `${p.cityname || ''} ${p.adname || ''}`.trim(),
      coord: Number.isFinite(lng) ? { lng, lat, crs: 'GCJ02' } : null,
      status: 'unknown', tags: mapType(p.typecode).tags, provider: 'amap', demo: false,
    };
  }).filter((x) => x.coord);
}

async function regeo(cfg, point) {
  const json = await amapGet(cfg, '/v3/geocode/regeo', {
    location: `${point.lng},${point.lat}`, radius: '300', extensions: 'base',
  });
  const r = json.regeocode || {};
  const a = r.addressComponent || {};
  const label = r.formatted_address && typeof r.formatted_address === 'string'
    ? r.formatted_address
    : `${a.province || ''}${a.city || ''}${a.district || ''}${a.township || ''}`;
  return { ok: true, label: label || '所选位置', provider: 'amap', demo: false };
}

async function convertCoord(cfg, lng, lat) {
  const json = await amapGet(cfg, '/v3/assistant/coordinate/convert', {
    locations: `${lng},${lat}`, coordsys: 'gps',
  });
  const [glng, glat] = String(json.locations).split(',').map(Number);
  return { lng: glng, lat: glat };
}

/* ---------- 真实闲逛区域：与 VenueGraph/pack 同构的适配器 ---------- */
const END_NODE_MIN_M = 80; // 终点离起点不到 80m 视为同一端口（"回到附近"），不额外建节点

/** 绕行量：从 o 去 e 的路上顺道经过 c 要多走多少（直线近似） */
function detourM(o, c, e) {
  return haversineM(o, c) + haversineM(c, e) - haversineM(o, e);
}
/** 终点并入矩阵缓存键（约 50m 网格），换了终点必须重抓 OD */
function endKeyOf(e) {
  return `end@${Math.round(e.lng / 0.0005)},${Math.round(e.lat / 0.0005)}`;
}

class AmapAreaGraph {
  constructor(cfg, origin, budgetSec, endpoint) {
    this.cfg = cfg;
    this.origin = origin; // {lng,lat,crs:'GCJ02'}
    // 用户指定的终点（与起点相距 > END_NODE_MIN_M 时单独建节点 am_end）。
    // 此前图里只有 am_origin 一个端口，规划器把终点吸附到"最近的候选点"，
    // 于是末站→真实终点这一段既不参与排序也不在地图上，末站可能离终点很远（2026-10-18 修）。
    this.endpoint = endpoint && Number.isFinite(endpoint.lng) && haversineM(origin, endpoint) > END_NODE_MIN_M ? endpoint : null;
    this.budgetSec = budgetSec;
    this.nodes = new Map();
    this._routeCache = new Map();
    this._edgeSeq = 0;
    this._edges = new Map();
    this.routingCalls = 0;
  }
  get nodeById() { return this.nodes; }
  get edgeById() { return this._edges; }

  async init(cands, opts = {}) {
    this.nodes.set('am_origin', {
      id: 'am_origin', name: this.origin.label || '起点', type: 'entrance',
      lng: this.origin.lng, lat: this.origin.lat, status: 'open',
    });
    if (this.endpoint) {
      this.nodes.set('am_end', {
        id: 'am_end', name: this.endpoint.label || '终点', type: 'entrance',
        lng: this.endpoint.lng, lat: this.endpoint.lat, status: 'open',
      });
    }
    for (const c of cands) {
      this.nodes.set(c.id, { id: c.id, name: c.name, type: 'poi', lng: c.lng, lat: c.lat, status: 'open' });
    }
    const ports = this.endpoint ? ['am_origin', 'am_end'] : ['am_origin'];
    const ids = [...ports, ...cands.map((c) => c.id)];

    // 命中缓存：矩阵直接复原，一次网络请求都不发（同一场所反复规划只有首次慢）
    const cached = matrixCacheGet(opts.cacheKey);
    if (cached && cached.ids === ids.join('|')) {
      this._restoreMatrix(cached, ids);
      this._dropUnreachable(cands);
      this._buildAdj();
      return;
    }

    // 预取路由矩阵（起点 + 候选），受配额约束；全局限速门已保证 QPS。
    // 配额按"尝试次数"计：失败的请求同样占配额，否则被限流时会一直重试拖垮任务。
    const maxCalls = Math.max(6, this.cfg.limits.maxRoutingCalls || 60);
    let attempts = 0;
    const fetchPair = async (i, j) => {
      if (attempts >= maxCalls) return false;
      attempts++;
      const a = this.nodes.get(ids[i]), b = this.nodes.get(ids[j]);
      try {
        const r = await walkingRoute(this.cfg, a, b);
        this.routingCalls++;
        const eid = 'ame_' + (++this._edgeSeq);
        const physicalSegmentKeys = geometrySegmentKeys(r.geometry);
        this._edges.set(eid, { id: eid, from: ids[i], to: ids[j], lengthM: r.distanceM, walkAllowed: true, stepsKnown: false, steps: null, physicalSegmentKeys });
        this._storePair(ids[i], ids[j], eid, r.distanceM, r.geometry, physicalSegmentKeys, true, null, r.steps);
        return true;
      } catch (e) {
        this._storePair(ids[i], ids[j], null, null, [], [], false, e.message);
        return false;
      }
    };
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (attempts >= maxCalls) break;
        await fetchPair(i, j);
      }
      if (attempts >= maxCalls) break;
    }
    // 二次重试：起点↔候选的边必须拿到真实路由，否则候选会被误判不可达。
    // （此前这里是 `calls < maxCalls`，而 calls 早已等于上限，重试一次都没跑过。）
    for (let p = 0; p < ports.length; p++) {
      for (let j = p + 1; j < ids.length && attempts < maxCalls; j++) {
        const cur = this._routeCache.get(ids[p] + '>' + ids[j]);
        if (!cur || cur.status !== 'ok') await fetchPair(p, j);
      }
    }
    this._dropUnreachable(cands);
    matrixCacheSet(opts.cacheKey, this._snapshot(ids));
    this._buildAdj();
  }

  /** 与 VenueGraph 同构的邻接表：真实步行边按无向处理（正反共用同一条边）。
   *  拓扑预检（死胡同 / 唯一桥梁识别）等只认 graph.adj 的代码，在真实高德包上因此同样可用。 */
  _buildAdj() {
    this.adj = new Map();
    for (const e of this._edges.values()) {
      if (e.closed || e.walkAllowed === false) continue;
      if (!this.adj.has(e.from)) this.adj.set(e.from, []);
      if (!this.adj.has(e.to)) this.adj.set(e.to, []);
      this.adj.get(e.from).push({ to: e.to, edge: e });
      this.adj.get(e.to).push({ to: e.from, edge: e });
    }
  }

  /** 写入一对 OD 的正反两条缓存（无向：正反共用距离，折线反向） */
  _storePair(a, b, eid, distanceM, geometry, physicalSegmentKeys, ok, error, steps) {
    if (!ok) {
      const miss = { status: 'unreachable', distanceM: null, nodeIds: [], edgeIds: [], geometry: [], error: error || 'amap route failed' };
      this._routeCache.set(a + '>' + b, miss);
      this._routeCache.set(b + '>' + a, miss);
      return;
    }
    const base = { status: 'ok', distanceM, nodeIds: [a, b], edgeIds: [eid], geometry, physicalSegmentKeys, repeatDetection: 'geometry-grid-approx', provider: 'amap-walking', steps: Array.isArray(steps) && steps.length ? steps : null };
    this._routeCache.set(a + '>' + b, base);
    // 反向复用同一条折线：高德的文字指令只对正向成立，反向置空，由前端按折线几何合成导引
    this._routeCache.set(b + '>' + a, { ...base, nodeIds: [b, a], geometry: [...geometry].reverse(), steps: null });
  }

  /** 仍不可达的点位剔除（诚实：无真实路由就不参与规划） */
  _dropUnreachable(cands) {
    for (const c of cands) {
      const r = this._routeCache.get('am_origin>' + c.id);
      if (!r || r.status !== 'ok') this.nodes.delete(c.id);
    }
    // 终点自身走不到（起点→终点都没有真实路由）就退回旧行为，不伪造一段路
    if (this.nodes.has('am_end')) {
      const r = this._routeCache.get('am_origin>am_end');
      if (!r || r.status !== 'ok') { this.nodes.delete('am_end'); this.endpoint = null; }
    }
  }
  /** 规划器用：图里有没有独立的终点节点 */
  get endNodeId() { return this.nodes.has('am_end') ? 'am_end' : null; }

  _snapshot(ids) {
    const legs = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const r = this._routeCache.get(ids[i] + '>' + ids[j]);
        if (!r) continue;
        legs.push({
          i, j, ok: r.status === 'ok', eid: (r.edgeIds && r.edgeIds[0]) || null,
          distanceM: r.distanceM, geometry: r.geometry, physicalSegmentKeys: r.physicalSegmentKeys || null, steps: r.steps || null,
        });
      }
    }
    return { ids: ids.join('|'), edgeSeq: this._edgeSeq, legs };
  }

  _restoreMatrix(snap, ids) {
    this._edgeSeq = snap.edgeSeq || 0;
    for (const L of snap.legs) {
      if (!ids[L.i] || !ids[L.j]) continue;
      if (L.ok && L.eid) {
        this._edges.set(L.eid, { id: L.eid, from: ids[L.i], to: ids[L.j], lengthM: L.distanceM, walkAllowed: true, stepsKnown: false, steps: null, physicalSegmentKeys: L.physicalSegmentKeys });
        this._storePair(ids[L.i], ids[L.j], L.eid, L.distanceM, L.geometry, L.physicalSegmentKeys, true, null, L.steps);
      } else {
        this._storePair(ids[L.i], ids[L.j], null, null, [], [], false);
      }
    }
  }

  route(fromId, toId, opts = {}) {
    if (fromId === toId) {
      const n = this.nodes.get(fromId);
      return { status: 'ok', distanceM: 0, nodeIds: [fromId], edgeIds: [], geometry: n ? [[n.lng, n.lat]] : [] };
    }
    const hit = this._routeCache.get(fromId + '>' + toId);
    if (hit) {
      const forbidden = opts.forbiddenEdgeIds;
      if (forbidden && (hit.edgeIds || []).some((eid) => forbidden.has(eid))) {
        return { status: 'constraint_violation', code: 'REPEATED_EDGE', distanceM: null, nodeIds: [], edgeIds: hit.edgeIds, geometry: [] };
      }
      return hit;
    }
    return { status: 'unreachable', distanceM: null, nodeIds: [], edgeIds: [], geometry: [] }; // 无真实路由的边不伪造
  }
  nearestNode(point, types) {
    let best = null, bestD = Infinity;
    for (const n of this.nodes.values()) {
      if (types && !types.includes(n.type)) continue;
      const d = haversineM(point, n) * 1.3; // 直线粗筛系数，仅用于粗筛
      if (d < bestD) { bestD = d; best = n; }
    }
    return best ? { node: best, distanceM: Math.round(bestD) } : null;
  }
}

/** 构建真实闲逛"场所包"（结构同演示包，数据来源标注为高德实时查询） */
async function buildAmapAreaPack(cfg, origin, budgetSec, endpoint) {
  // 检索半径=步行可达圈：闲逛者不会把 1.5 小时花在"赶路去 4km 外"上。
  // 此前 (budgetSec/3600)*2500 封顶 4000m——两小时的闲逛也在 4km 半径找点，
  // 候选间实际步行 1-3km，每站光交通就吃掉 15-30 分钟，半天只装得下两三站（2026-10-01 修）。
  const radiusM = Math.min(2500, Math.max(1000, Math.round((budgetSec / 3600) * 700)));
  const end = endpoint && Number.isFinite(endpoint.lng) && haversineM(origin, endpoint) > END_NODE_MIN_M ? endpoint : null;
  let rawCands = await searchAround(cfg, origin, radiusM);
  if (end) {
    // A→B 型路线：候选不能只围着起点找，否则最后一站必然离终点很远、只能"空走"过去。
    // 终点较远时再围绕终点检索一次，并按"顺路程度"（绕行椭圆）过滤：顺路经过它多走的距离不超过 detourMax。
    const odM = haversineM(origin, end);
    if (odM > radiusM * 0.5) {
      try {
        const near = await searchAround(cfg, end, radiusM);
        const seen = new Set(rawCands.map((c) => c.id));
        for (const c of near) if (!seen.has(c.id)) { seen.add(c.id); rawCands.push(c); }
      } catch (e) { /* 终点周边检索失败不影响主流程 */ }
    }
    const detourMax = Math.max(radiusM, odM * 0.6);
    for (const c of rawCands) {
      c.distanceM = Math.round(haversineM(origin, c));
      c.detourM = Math.round(detourM(origin, c, end));
    }
    rawCands = rawCands.filter((c) => c.detourM <= detourMax);
  }
  // 粗筛：按类型分桶保证多样性，每桶取最近 4 个，再按预算取前 8~12 进精算（§7.4 评分压缩）。
  // 候选数同时受路由矩阵配额约束：配额必须够抓满"起点 + 候选"的两两组合，
  // 否则末尾的候选拿不到任何 OD 边、永远排不进多站路线（2026-09-30 修）。
  const buckets = new Map();
  const nearKey = (c) => (end ? c.detourM : c.distanceM); // 有终点时"近"指顺路，而不是离起点近
  for (const c of rawCands.sort((a, b) => nearKey(a) - nearKey(b))) {
    const key = c.tags[0];
    if (!buckets.has(key)) buckets.set(key, []);
    if (buckets.get(key).length < 4) buckets.get(key).push(c);
  }
  const capByBudget = budgetSec >= 10800 ? 12 : 8; // 3 小时以上放宽池子，半天不该只有五六个可选点
  // 多一个终点节点就多一行 OD，候选上限相应少 1，保证矩阵仍能抓满
  const cap = Math.max(1, Math.min(capByBudget, maxCandidatesForQuota(cfg.limits.maxRoutingCalls) - (end ? 1 : 0)));
  const cands = [...buckets.values()].flat()
    .sort((a, b) => b.scenic - a.scenic || nearKey(a) - nearKey(b))
    .slice(0, cap);
  const graph = new AmapAreaGraph(cfg, origin, budgetSec, end);
  await graph.init(cands, { cacheKey: matrixCacheKeyOf('area', origin, [...(end ? [endKeyOf(end)] : []), ...cands.map((c) => c.id)]) });
  const usable = cands.filter((c) => graph.nodes.has(c.id));
  const pack = {
    venue: {
      id: 'area_amap', name: '周边片区（高德实时数据）', nameNote: '候选点与路段来自高德 Web 服务实时查询',
      city: '', timezone: 'Asia/Shanghai', packVersion: 'amap-live-' + new Date().toISOString().slice(0, 10),
      coverageScope: { kind: 'poi', scopeLabel: `周边 ${radiusM}m 内检索到的 ${usable.length} 个候选点` },
      center: { lng: origin.lng, lat: origin.lat, crs: 'GCJ02' },
      entrances: graph.endNodeId ? ['am_origin', 'am_end'] : ['am_origin'], openWindows: [['00:00', '24:00']],
    },
    nodes: [...graph.nodes.values()],
    edges: [...graph._edges.values()].map((e) => ({ ...e, bikeAllowed: false, closed: false, evidenceIds: ['ev_amap_live'] })),
    pois: usable.map((c) => ({
      id: c.id, name: c.name, entranceNode: c.id,
      tags: c.tags, indoor: c.tags.includes('美食') || c.tags.includes('人文'),
      scenic: c.scenic, dwellMinSec: 600, dwellSec: c.dwellSec,
      openWindows: null, // 开放时间未核验 → 校验层标 unknown，绝不假装已知（§7.1）
      ticketCny: null, ticketKnown: false, costNote: '门票/消费未核验',
      reservation: 'unknown', hoursEvidenceIds: ['ev_amap_live'],
      providerPoiId: c.providerPoiId, address: c.address,
      guide: null, // 真实内容需资料检索管线（未配置 LLM 时不虚构，§11.2）
    })),
    evidence: [{
      id: 'ev_amap_live', sourceTitle: '高德地图 Web 服务实时查询', sourceUrl: 'https://restapi.amap.com',
      retrievedAt: new Date().toISOString(), effectiveFrom: null, expiresAt: null,
      license: '高德平台数据（按许可展示，不持久化）', reviewStatus: 'provider',
    }],
    _poiById: new Map(),
    _nodeById: graph.nodes,
    _evById: new Map(),
  };
  pack._poiById = new Map(pack.pois.map((p) => [p.id, p]));
  pack._evById = new Map(pack.evidence.map((e) => [e.id, e]));
  return { pack, graph };
}

module.exports = { detourM, endKeyOf, END_NODE_MIN_M, searchAround, walkingRoute, textSearch, regeo, convertCoord, buildAmapAreaPack, AmapAreaGraph, amapGet, mapType, maxCandidatesForQuota, matrixCacheKeyOf, EXCLUDE_NAME_RE, SEARCH_TYPE_GROUPS };
