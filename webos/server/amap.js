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

/**
 * 路网矩阵模式（2026-10-18）：
 * - 'distance'（默认）：高德距离测量 /v3/distance type=3（步行），每个目的地一次请求带上全部起点，
 *   n 个节点只需 n−1 次请求（旧两两路径规划要 n(n−1)/2 次：14 节点 91 次、约 33 秒，候选被卡在 12 个）。
 *   求解阶段用真实步行距离 + 直线示意几何，选中的路段再用 /v3/direction/walking 回填真实折线（hydrate）。
 * - 'pairwise'：旧模式，逐对路径规划（距离接口不可用时自动回退）。
 */
function matrixModeOf(cfg) {
  const m = cfg && cfg.limits && cfg.limits.matrixMode;
  return m === 'pairwise' ? 'pairwise' : 'distance';
}
/** 距离接口可用性探测（一次请求，结果缓存：可用 1 小时、不可用 10 分钟）：
 *  先探测再定候选池大小——否则按 22 个候选选完点、建图时才发现接口不可用，只能粗暴截断。 */
let distanceProbe = { at: 0, ok: null };
async function resolveMatrixMode(cfg, point) {
  if (matrixModeOf(cfg) !== 'distance') return 'pairwise';
  const ttl = distanceProbe.ok ? 3600000 : 600000;
  if (distanceProbe.ok != null && Date.now() - distanceProbe.at < ttl) return distanceProbe.ok ? 'distance' : 'pairwise';
  let ok = false;
  try {
    const json = await amapGet(cfg, '/v3/distance', {
      origins: `${point.lng},${point.lat}`, destination: `${(point.lng + 0.003).toFixed(6)},${point.lat}`, type: '3',
    });
    const r = (json.results || [])[0];
    ok = !!(r && Number(r.distance) > 0 && (r.code == null || String(r.code) === '0' || String(r.code) === ''));
  } catch (e) { ok = false; }
  distanceProbe = { at: Date.now(), ok };
  return ok ? 'distance' : 'pairwise';
}

/** 候选池上限：距离矩阵模式下按预算放宽（半天不该只有十来个可选点），两两模式按配额反推 */
function candidateCapFor(cfg, budgetSec, ports = 1, mode = null) {
  const legacy = Math.max(1, maxCandidatesForQuota(cfg.limits.maxRoutingCalls) - (ports - 1));
  if ((mode || matrixModeOf(cfg)) !== 'distance') return { cap: legacy, legacy };
  const byBudget = budgetSec >= 10800 ? 22 : budgetSec >= 7200 ? 18 : 14;
  const maxPoi = Math.max(6, Number(cfg.limits.maxPoiCandidates) || 24) - (ports - 1);
  return { cap: Math.max(1, Math.min(byBudget, maxPoi)), legacy };
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
  '学校', '学院', '大学', '小学', '中学', '附小', '附中', '一中', '二中', '实验学', '少年宫', '培训', '补习', '考研', '驾校', '幼儿园', '托育', '托管',
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

/* ---------- 无游览价值判定（2026-10-18 线上实测补强） ----------
 * 犀浦周边候选全是库迪咖啡/瑜伽馆/礼品店，提名里混进"通祠路与武侯祠大街交叉口"，广州美食路线排进"海底捞外送"。
 * 三层：① 设施/路口/外送这类"不是目的地"的名称一律剔除；② 机构/服务业/培训/连锁快餐名称剔除，
 *   但"旧址/故居/博物馆/纪念馆/教育基地"等文保语义豁免（"四川大学博物馆""国民政府旧址"应保留）；
 * ③ 类目黑名单（生活服务/医疗/住宿/商务住宅/政府团体/交通/金融/公司/道路附属/公共设施、学校科研培训驾校等）。 */
const FACILITY_NAME_RE = /(楼梯|扶梯|电梯|出入口$|通道$|收银|柜台|卫生间|厕所|公厕|停车场|停车楼|充电桩|交叉口|路口$|十字路口|丁字路口|外送|外卖|自提点|取餐|售票处|检票口|地铁站|公交站|公交车站|[A-Z]\d*口$|号口$)/i;
const HERITAGE_NAME_RE = /(旧址|遗址|故居|纪念馆|纪念碑|纪念堂|博物馆|博物院|美术馆|展览馆|艺术馆|文化馆|教育基地|文保|文物|古建|古迹|书院|祠堂|寺|庙|宫$|观$|塔$|牌坊|城墙|城门)/;
const JUNK_NAME_RE = new RegExp([
  '机构', '协会', '学会', '商会', '联合会', '委员会', '管委会', '政府', '街道办', '办事处', '居委会', '村委会', '社区服务', '社区中心', '服务中心', '服务站', '管理处', '管理局', '管理所',
  '派出所', '公安', '法院', '检察', '税务', '社保', '政务', '人社', '人才市场', '招聘', '劳务',
  '研究院', '研究所', '研究中心', '设计院', '事务所', '律师', '中介', '房产', '地产', '置业', '售楼', '物业', '党群', '党校',
  '教育', '早教', '辅导', '托班', '琴行', '画室', '美术班', '舞蹈', '跆拳道', '武道', '武术馆', '拳馆', '健身', '瑜伽', '普拉提', '游泳', '台球', '桌球', '电竞', '球馆', '羽毛球', '篮球馆', '网球',
  '按摩', '足疗', '足浴', '推拿', '采耳', '养生', '理疗', '美容', '美发', '美甲', '美睫', '纹绣', '理发', '发型', '造型', '婚纱', '影楼', '摄影工作室', '写真',
  '口腔', '牙科', '眼科', '眼镜', '母婴', '月子', '宠物', '物流', '货运', '仓储', '打印', '复印', '图文', '广告', '装饰', '装修', '开锁', '家政', '搬家', '回收', '典当', '租车', '加盟', '代办',
  '营业部', '分理处', '门诊', '康复', '护理', '殡葬', '寿衣',
].join('|'));
/** 连锁快餐/茶饮/便利店：不是"出门逛逛"的目的地（用户点名的必去点不受此限） */
const CHAIN_NAME_RE = /(库迪|COTTI|瑞幸|luckin|幸运咖|挪瓦|NOWWA|Tims|蜜雪冰城|古茗|茶百道|书亦烧仙草|益禾堂|甜啦啦|一点点|CoCo|都可|沪上阿姨|7分甜|肯德基|KFC|麦当劳|McDonald|德克士|华莱士|塔斯汀|汉堡王|必胜客|达美乐|赛百味|正新鸡排|绝味|周黑鸭|煌上煌|紫燕百味鸡|沙县小吃|兰州拉面|兰州牛肉面|杨国福|张亮麻辣烫|老乡鸡|真功夫|永和大王|乡村基|米村拌饭|袁记云饺|便利蜂|罗森|全家|7-?11|美宜佳|红旗连锁|舞东风|WOWO|名创优品)/i;
/** 有名气但非地方特色的连锁：保留，但压低景观分 */
const CHAIN_SOFT_RE = /(星巴克|Starbucks|喜茶|奈雪|霸王茶姬|海底捞|西贝|太二|呷哺|外婆家|绿茶餐厅|费大厨|木屋烧烤|九毛九|Manner|M Stand|Seesaw|%Arabica)/i;
const JUNK_TYPECODE_RE = /^(07|09|10|12|13|15|16|17|18|20|22|97|99|0602|0603|0604|0606|0607|0609|0611|0613|0614|0801|0802|0803|0804|1403|1409|141[0-5])/;

/**
 * 是否为无游览价值的 POI。opts.nominated：大模型提名并经地理编码核实的点只做名称判断
 * （地理编码结果的 typecode 常是 19 地名地址，"宽窄巷子"这类街区也落在其中，不能按类目一刀切）。
 */
function isJunkPoi(name, typecode, opts = {}) {
  const n = String(name || '');
  const tc = String(typecode || '');
  if (!n) return true;
  if (FACILITY_NAME_RE.test(n)) return true;
  // 高德 19 地名地址：190302 路口/190303 环岛/高速与快速路出入口/隧道/铁路、1904 门牌——不是地点；道路名/桥/街区放行
  if (/^(19030[234589]|19031[01]|1904)/.test(tc) || /^\S+?(路|街|道|巷)[一二三四五六七八九十\d]*段?\d+号$/.test(n)) return true;
  if (CHAIN_NAME_RE.test(n)) return true;
  const heritage = HERITAGE_NAME_RE.test(n);
  if (!heritage && (EXCLUDE_NAME_RE.test(n) || JUNK_NAME_RE.test(n))) return true;
  if (!opts.nominated && !heritage && JUNK_TYPECODE_RE.test(tc)) return true;
  return false;
}

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

/** 周边检索缓存（10 分钟，约 50m 网格）：同一片区反复规划/途中加点不再重复打 5 次高德检索 */
const aroundCache = new Map();
const AROUND_TTL_MS = 10 * 60 * 1000;
/** 商业"体验馆"类降权：城市候选里 XR/飞行影院/主题展馆挤占了真正的街区与人文点（2026-10-18 线上实测春熙路） */
const COMMERCIAL_EXPERIENCE_RE = /(XR|VR|AR|飞览|飞行影院|体验馆|体验中心|探索馆|奥秘|恋爱|爱情|网红|打卡馆|沉浸式|数字展|光影展|萌宠|猫咖|主题展)/i;

async function searchAround(cfg, point, radiusM) {
  const key = `${Math.round(point.lng / 0.0005)},${Math.round(point.lat / 0.0005)},${radiusM}`;
  const hit = aroundCache.get(key);
  if (hit && Date.now() - hit.at < AROUND_TTL_MS) return hit.value.map((c) => ({ ...c, tags: [...c.tags] }));
  const value = await searchAroundRaw(cfg, point, radiusM);
  aroundCache.set(key, { at: Date.now(), value });
  while (aroundCache.size > 40) aroundCache.delete(aroundCache.keys().next().value);
  return value.map((c) => ({ ...c, tags: [...c.tags] }));
}

async function searchAroundRaw(cfg, point, radiusM) {
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
    .filter((p) => !isJunkPoi(p.name, p.typecode)))
    .map((p) => {
    const [lng, lat] = p.location.split(',').map(Number);
    const m = mapType(p.typecode, p.name);
    if (COMMERCIAL_EXPERIENCE_RE.test(p.name || '')) m.scenic = Math.max(0.3, m.scenic - 0.25);
    if (CHAIN_SOFT_RE.test(p.name || '')) m.scenic = Math.min(m.scenic, 0.35);
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
/** 折线回填用的路由缓存（30 分钟，约 10m 网格）：编辑/途中重排/备选方案复用同一段路不再重抓 */
const walkCache = new Map();
const WALK_TTL_MS = 30 * 60 * 1000;
async function walkingRouteCached(cfg, from, to) {
  const g = (v) => Math.round(v / 0.0001);
  const key = `${g(from.lng)},${g(from.lat)}>${g(to.lng)},${g(to.lat)}`;
  const hit = walkCache.get(key);
  if (hit && Date.now() - hit.at < WALK_TTL_MS) return hit.value;
  const value = await walkingRoute(cfg, from, to);
  walkCache.set(key, { at: Date.now(), value });
  while (walkCache.size > 600) walkCache.delete(walkCache.keys().next().value);
  return value;
}

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

const END_DUP_M = 60; // 候选离终点不足 60m 视为"就是终点"

/** 候选在 o→e 走廊上的投影位置 t∈[0,1]（平面近似，城市尺度足够） */
function corridorT(o, e, c) {
  const kx = 111320 * Math.cos((o.lat * Math.PI) / 180), ky = 110540;
  const ex = (e.lng - o.lng) * kx, ey = (e.lat - o.lat) * ky;
  const cx = (c.lng - o.lng) * kx, cy = (c.lat - o.lat) * ky;
  const L2 = ex * ex + ey * ey || 1;
  return Math.max(0, Math.min(1, (cx * ex + cy * ey) / L2));
}
const segOf = (t) => (t < 1 / 3 ? 0 : t < 2 / 3 ? 1 : 2);

/** 普通（回起点/顺路结束）：类型分桶保证多样性，每桶最近 4 个，再按景观分取前 cap */
function pickByBuckets(list, cap, nearKey) {
  const buckets = new Map();
  for (const c of [...list].sort((a, b) => nearKey(a) - nearKey(b))) {
    const key = c.tags[0];
    if (!buckets.has(key)) buckets.set(key, []);
    if (buckets.get(key).length < 4) buckets.get(key).push(c);
  }
  return [...buckets.values()].flat()
    .sort((a, b) => rankOf(b) - rankOf(a) || nearKey(a) - nearKey(b))
    .slice(0, cap);
}
/** 进精算池的排序分：景观分 + 用户兴趣命中加成（"想吃点东西"时餐饮 scenic 0.5 不该被 0.75 的展馆全部挤出池子） */
const rankOf = (c) => (c._rank != null ? c._rank : c.scenic);

/**
 * A→B 走廊选点：按投影位置分前/中/后三段，每段保底配额（35%/30%/35%），段内再分桶取景观分高且顺路的。
 * 此前所有候选一起按"绕行量"排序再截断：起点周边 POI 密集、绕行同样≈0，终点段的点被整体挤掉，
 * 春熙路→宽窄巷子 12 个候选全在春熙路，末站离终点 2.4km（2026-10-18 线上实测）。
 */
function pickCorridor(list, cap, segmented) {
  if (!segmented) return pickByBuckets(list, cap, (c) => c.detourM);
  const quota = [0.35, 0.3, 0.35].map((r) => Math.max(1, Math.round(r * cap)));
  while (quota.reduce((a, b) => a + b, 0) > cap) quota[1]--;
  const picked = [];
  const left = [];
  for (let k = 0; k < 3; k++) {
    const seg = list.filter((c) => segOf(c.corridorT) === k);
    const ranked = pickByBuckets(seg, seg.length, (c) => c.detourM);
    picked.push(...ranked.slice(0, quota[k]));
    left.push(...ranked.slice(quota[k]));
  }
  // 某段不够配额时，用其余段的剩余点补满（优先景观分高、绕行小的）
  left.sort((a, b) => rankOf(b) - rankOf(a) || a.detourM - b.detourM);
  for (const c of left) { if (picked.length >= cap) break; picked.push(c); }
  const out = picked.slice(0, cap);
  // 终点附近（≤900m）至少留 3 个候选：否则末站只能落在中段，最后空走一两公里（西安钟楼→大雁塔末段 4.3km）
  const nearEnd = (c) => c.endM != null && c.endM <= 900;
  const have = out.filter(nearEnd).length;
  if (have < 3) {
    const extra = list.filter((c) => nearEnd(c) && !out.includes(c)).sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 3 - have);
    for (const c of extra) {
      // 换掉非终点段里排序最低的一个
      let wi = -1;
      for (let i = out.length - 1; i >= 0; i--) if (!nearEnd(out[i]) && !out[i].nominated) { wi = i; break; }
      if (wi < 0) break;
      out.splice(wi, 1);
      out.push(c);
    }
  }
  return out;
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

  async init(candsIn, opts = {}) {
    let cands = candsIn;
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

    if ((opts.matrixMode || matrixModeOf(this.cfg)) === 'distance' && ids.length > 2) {
      const ok = await this._initDistanceMatrix(ids);
      if (ok) {
        this.matrixMode = 'distance';
        this._dropUnreachable(cands);
        matrixCacheSet(opts.cacheKey, this._snapshot(ids));
        this._buildAdj();
        return;
      }
      // 距离接口不可用（Key 未开通/配额用尽）→ 回退两两路径规划，候选截回旧配额能抓满的数量
      this._routeCache.clear(); this._edges.clear();
      const legacy = Math.max(1, maxCandidatesForQuota(this.cfg.limits.maxRoutingCalls) - (ports.length - 1));
      for (const c of cands.slice(legacy)) this.nodes.delete(c.id);
      cands = cands.slice(0, legacy);
      ids.length = 0; ids.push(...ports, ...cands.map((c) => c.id));
      this.matrixFallback = true;
    }
    this.matrixMode = 'pairwise';

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

  /** 距离矩阵：每个目的地 j 一次请求，起点为 0..j-1（无向：一对只测一次）。成功返回 true。 */
  async _initDistanceMatrix(ids) {
    const n = ids.length;
    let anyValid = false;
    for (let j = 1; j < n; j++) {
      const dest = this.nodes.get(ids[j]);
      const origins = ids.slice(0, j).map((id) => this.nodes.get(id));
      const byOrigin = new Map();
      for (let off = 0; off < origins.length; off += 90) {
        const chunk = origins.slice(off, off + 90);
        let json = null;
        try {
          json = await amapGet(this.cfg, '/v3/distance', {
            origins: chunk.map((o) => `${o.lng},${o.lat}`).join('|'),
            destination: `${dest.lng},${dest.lat}`, type: '3',
          });
          this.routingCalls++;
        } catch (e) {
          if (!anyValid && j === 1) return false; // 第一次就失败：接口不可用，回退
          this.matrixErrors = (this.matrixErrors || 0) + 1;
        }
        for (const r of (json && json.results) || []) byOrigin.set(off + Number(r.origin_id) - 1, r);
      }
      for (let i = 0; i < j; i++) {
        const a = this.nodes.get(ids[i]);
        const straight = haversineM(a, dest);
        const r = byOrigin.get(i);
        let d = r && (r.code == null || String(r.code) === '0' || String(r.code) === '') ? Number(r.distance) : NaN;
        if (Number.isFinite(d) && d <= 0 && straight > 40) d = NaN; // 0 米但两点并不重合：视为无结果
        if (Number.isFinite(d) && d > 0) anyValid = true;
        // 超出步行测距范围（约 5km）或无结果：按直线 ×1.3 估算，标 estimated（回填折线时以真实路线为准）
        const estimated = !Number.isFinite(d);
        this._storePending(ids[i], ids[j], estimated ? Math.round(straight * 1.3) : Math.round(d), estimated);
      }
      if (j === 1 && !anyValid && haversineM(this.nodes.get(ids[0]), dest) > 40) return false; // 有响应但全是空结果
    }
    return true;
  }

  /** 距离已知、折线待回填的一对 OD：用直线作示意几何（求解期的重复路段检测用它粗估"折返"） */
  _storePending(a, b, distanceM, estimated) {
    const na = this.nodes.get(a), nb = this.nodes.get(b);
    const geometry = [[na.lng, na.lat], [nb.lng, nb.lat]];
    const physicalSegmentKeys = geometrySegmentKeys(geometry);
    const eid = 'ame_' + (++this._edgeSeq);
    this._edges.set(eid, { id: eid, from: a, to: b, lengthM: distanceM, walkAllowed: true, stepsKnown: false, steps: null, physicalSegmentKeys });
    this._storePair(a, b, eid, distanceM, geometry, physicalSegmentKeys, true, null, null, { geometryPending: true, estimated: !!estimated, provider: estimated ? 'amap-estimate' : 'amap-distance' });
  }

  /** 这段路是否还是"只有距离、没有真实折线" */
  isPending(a, b) {
    const r = this._routeCache.get(a + '>' + b);
    return !!(r && r.status === 'ok' && r.geometryPending);
  }

  /**
   * 回填真实步行折线：pairs=[[from,to],…]（按行进方向，正向保留逐步导引）。
   * 失败的段保留直线示意（距离仍是高德测距结果），不阻塞发布。返回成功回填的段数。
   */
  async hydrate(pairs) {
    let done = 0;
    const seen = new Set();
    for (const [a, b] of pairs || []) {
      const key = a + '>' + b;
      if (seen.has(key) || !this.isPending(a, b)) continue;
      seen.add(key);
      const na = this.nodes.get(a), nb = this.nodes.get(b);
      if (!na || !nb) continue;
      const cur = this._routeCache.get(key);
      const eid = (cur.edgeIds && cur.edgeIds[0]) || ('ame_' + (++this._edgeSeq));
      try {
        const r = await walkingRouteCached(this.cfg, na, nb);
        if (!(r.distanceM >= 0) || !r.geometry || r.geometry.length < 2) throw new Error('empty walking route');
        const physicalSegmentKeys = geometrySegmentKeys(r.geometry);
        this._edges.set(eid, { id: eid, from: a, to: b, lengthM: r.distanceM, walkAllowed: true, stepsKnown: false, steps: null, physicalSegmentKeys });
        this._storePair(a, b, eid, r.distanceM, r.geometry, physicalSegmentKeys, true, null, r.steps);
        this.hydratedCalls = (this.hydratedCalls || 0) + 1;
        done++;
      } catch (e) {
        // 回填失败：保留测距结果与直线示意，去掉 pending 标记避免反复重试
        this._storePair(a, b, eid, cur.distanceM, [...cur.geometry], cur.physicalSegmentKeys, true, null, null, { estimated: !!cur.estimated, provider: cur.provider, hydrateFailed: true });
      }
    }
    return done;
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
  _storePair(a, b, eid, distanceM, geometry, physicalSegmentKeys, ok, error, steps, extra = null) {
    if (!ok) {
      const miss = { status: 'unreachable', distanceM: null, nodeIds: [], edgeIds: [], geometry: [], error: error || 'amap route failed' };
      this._routeCache.set(a + '>' + b, miss);
      this._routeCache.set(b + '>' + a, miss);
      return;
    }
    const base = { status: 'ok', distanceM, nodeIds: [a, b], edgeIds: [eid], geometry, physicalSegmentKeys, repeatDetection: 'geometry-grid-approx', provider: 'amap-walking', steps: Array.isArray(steps) && steps.length ? steps : null, ...(extra || {}) };
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
          extra: r.geometryPending || r.estimated || r.venueEstimate || r.hydrateFailed
            ? { geometryPending: !!r.geometryPending, estimated: !!r.estimated, venueEstimate: !!r.venueEstimate, hydrateFailed: !!r.hydrateFailed, provider: r.provider }
            : null,
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
        this._storePair(ids[L.i], ids[L.j], L.eid, L.distanceM, L.geometry, L.physicalSegmentKeys, true, null, L.steps, L.extra || null);
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

/** 片区检索半径=步行可达圈（智能体提名的地理过滤与此同一口径） */
function areaRadiusM(budgetSec) {
  return Math.min(2500, Math.max(1000, Math.round((budgetSec / 3600) * 700)));
}

/** 智能体提名点并入候选：同一高德 id 已在池里就只打标记，否则作为新候选加入（坐标来自高德地理编码，不是模型） */
function mergeNominated(rawCands, nominated) {
  const byId = new Map(rawCands.map((c) => [c.id, c]));
  for (const n of nominated || []) {
    if (!n || !n.id || !Number.isFinite(n.lng) || !Number.isFinite(n.lat)) continue;
    if (!n.mustForce && isJunkPoi(n.name, n.typecode, { nominated: true })) continue; // 路口/机构/外送这类提名不进池
    const hit = byId.get(n.id);
    if (hit) { hit.nominated = true; hit.agentReason = hit.agentReason || n.reason || null; continue; }
    const m = mapType(n.typecode, n.name);
    const c = {
      id: n.id, name: n.name, providerPoiId: n.providerPoiId || String(n.id).replace(/^am_/, ''),
      address: n.address || '', lng: n.lng, lat: n.lat, type: n.type || '', typecode: n.typecode || '',
      ...m, nominated: true, agentReason: n.reason || null,
    };
    rawCands.push(c);
    byId.set(c.id, c);
  }
}

/** 先保留智能体提名点（至多约 60% 名额），剩余名额再按原有分桶/走廊规则补齐，保证多样性 */
function reserveNominated(list, cap, pickRest) {
  const nom = list.filter((c) => c.nominated).sort((a, b) => rankOf(b) - rankOf(a));
  const keep = nom.slice(0, Math.max(0, Math.min(nom.length, Math.ceil(cap * 0.6))));
  const keepIds = new Set(keep.map((c) => c.id));
  const rest = pickRest(list.filter((c) => !keepIds.has(c.id)), cap - keep.length);
  return [...keep, ...rest].slice(0, cap);
}

/** 预热片区周边检索缓存：智能体等大模型提名时，高德检索并行先跑（结果进 10 分钟缓存，建包时直接命中） */
async function prewarmAreaSearch(cfg, origin, budgetSec, endpoint) {
  const radiusM = areaRadiusM(budgetSec);
  const end = endpoint && Number.isFinite(endpoint.lng) && haversineM(origin, endpoint) > END_NODE_MIN_M ? endpoint : null;
  const jobs = [searchAround(cfg, origin, radiusM)];
  if (end) {
    const odM = haversineM(origin, end);
    if (odM > radiusM * 0.5) jobs.push(searchAround(cfg, end, radiusM));
    if (odM > radiusM * 1.2) {
      const mid = { lng: (origin.lng + end.lng) / 2, lat: (origin.lat + end.lat) / 2 };
      jobs.push(searchAround(cfg, mid, Math.min(radiusM, Math.max(800, Math.round(odM / 2)))));
    }
  }
  await Promise.allSettled(jobs);
}

/** 构建真实闲逛"场所包"（结构同演示包，数据来源标注为高德实时查询） */
async function buildAmapAreaPack(cfg, origin, budgetSec, endpoint, opts = {}) {
  // 检索半径=步行可达圈：闲逛者不会把 1.5 小时花在"赶路去 4km 外"上。
  // 此前 (budgetSec/3600)*2500 封顶 4000m——两小时的闲逛也在 4km 半径找点，
  // 候选间实际步行 1-3km，每站光交通就吃掉 15-30 分钟，半天只装得下两三站（2026-10-01 修）。
  const radiusM = areaRadiusM(budgetSec);
  const end = endpoint && Number.isFinite(endpoint.lng) && haversineM(origin, endpoint) > END_NODE_MIN_M ? endpoint : null;
  let rawCands = await searchAround(cfg, origin, radiusM);
  const nominated = Array.isArray(opts.nominated) ? opts.nominated : [];
  mergeNominated(rawCands, nominated);
  const prefTags = new Set(opts.interests || []);
  const markRank = () => {
    for (const c of rawCands) {
      const hit = c.tags.some((t) => prefTags.has(t) || (t === '自然' && prefTags.has('公园湿地')));
      const indoorish = c.tags.includes('美食') || c.tags.includes('人文');
      // 智能体提名（大模型知识 + 高德地理编码核实）是"值得去"的直接证据，按类型猜的景观分只是先验
      c._rank = c.scenic + (hit ? 0.3 : 0) + (opts.indoorPreferred ? (indoorish ? 0.15 : -0.15) : 0) + (c.nominated ? 0.5 : 0);
    }
  };
  markRank();
  // 候选池上限：距离矩阵模式 3h+ 22 / 2h+ 18 / 其余 14（旧两两路径规划被配额卡在 12 个，半天只排得进三四站）；
  // 两两模式仍按配额反推（多一个终点节点就多一行 OD，候选上限相应少 1）
  const matrixMode = await resolveMatrixMode(cfg, origin);
  const { cap: modeCap } = candidateCapFor(cfg, budgetSec, end ? 2 : 1, matrixMode);
  const capByBudget = matrixMode === 'distance' ? modeCap : (budgetSec >= 10800 ? 12 : 8);
  const cap = Math.max(1, Math.min(capByBudget, modeCap));
  // 用户指定的必去点是硬约束：必须进候选池（此前城市闲逛的必去点不在检索/走廊结果里时，
  // 校验层 must_visit_present 直接 fail，整条计划被判 infeasible —— 2026-10-18 审阅发现）
  const mustPids = new Set((opts.mustVisitIds || []).map((x) => String(x || '').replace(/^am_/, '')).filter(Boolean));
  const mustCands = [];
  const seenMust = new Set();
  const markMust = () => {
    for (const c of rawCands) {
      if (!mustPids.has(c.providerPoiId) || seenMust.has(c.providerPoiId)) continue;
      seenMust.add(c.providerPoiId);
      c.mustForce = true;
      mustCands.push(c);
    }
  };
  // 必去点占用名额：普通候选按剩余额度选，保证矩阵配额仍能覆盖"端口 + 全部候选"两两组合
  const pickCap = Math.max(0, Math.max(cap, mustPids.size) - mustPids.size);
  let cands;
  let corridor = null;
  let corridorSearchErrors = [];
  if (end) {
    // A→B 型路线：候选不能只围着起点找，否则最后一站必然离终点很远、只能"空走"过去。
    // 终点较远时再围绕终点（以及走廊中点）检索，并按"顺路程度"（绕行椭圆）过滤。
    const odM = haversineM(origin, end);
    const searchErrors = corridorSearchErrors;
    const merge = (list) => {
      const seen = new Set(rawCands.map((c) => c.id));
      for (const c of list) if (!seen.has(c.id)) { seen.add(c.id); rawCands.push(c); }
    };
    if (odM > radiusM * 0.5) {
      try { merge(await searchAround(cfg, end, radiusM)); }
      catch (e) { searchErrors.push('end:' + (e.code || e.message)); console.warn('[amap-area] 终点周边检索失败', e.code || e.message); }
    }
    if (odM > radiusM * 1.2) {
      const mid = { lng: (origin.lng + end.lng) / 2, lat: (origin.lat + end.lat) / 2 };
      try { merge(await searchAround(cfg, mid, Math.min(radiusM, Math.max(800, Math.round(odM / 2))))); }
      catch (e) { searchErrors.push('mid:' + (e.code || e.message)); console.warn('[amap-area] 走廊中点检索失败', e.code || e.message); }
    }
    mergeNominated(rawCands, nominated); // 终点/中点检索可能带回同一 id：补打提名标记
    markRank();
    markMust();
    const detourMax = Math.max(radiusM, odM * 0.6);
    for (const c of rawCands) {
      c.distanceM = Math.round(haversineM(origin, c));
      c.detourM = Math.round(detourM(origin, c, end));
      c.corridorT = corridorT(origin, end, c);
      c.endM = Math.round(haversineM(c, end));
    }
    // 离终点 < END_DUP_M 的点就是终点本身（"天府广场"作为末站又作为终点），不作为候选；
    // 但用户明确必去的点不参与这两条过滤（硬约束优先于选点偏好）
    rawCands = rawCands.filter((c) => c.mustForce || (c.detourM <= detourMax && haversineM(c, end) >= END_DUP_M));
    cands = reserveNominated(rawCands.filter((c) => !c.mustForce), pickCap, (list, n) => pickCorridor(list, n, odM > radiusM * 0.5));
  } else {
    markMust();
    for (const c of rawCands) if (!Number.isFinite(c.distanceM)) c.distanceM = Math.round(haversineM(origin, c));
    // 提名点离起点超出步行圈就不要（地理过滤在内核里已做，这里再兜一次底）
    const normal = rawCands.filter((c) => !c.mustForce && (!c.nominated || c.distanceM <= radiusM * 1.25));
    cands = reserveNominated(normal, pickCap, (list, n) => pickByBuckets(list, n, (c) => c.distanceM));
  }
  // 必去点不在检索结果里时按 id 直接取详情补进候选池（取不到就保持缺失，由校验层如实判 infeasible）
  for (const pid of mustPids) {
    if (seenMust.has(pid)) continue;
    try {
      const dj = await amapGet(cfg, '/v3/place/detail', { id: pid, extensions: 'base' });
      const p = (dj.pois || [])[0];
      const [lng, lat] = String((p && p.location) || ',').split(',').map(Number);
      if (!p || !p.id || !Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      const m = mapType(p.typecode, p.name);
      const c = {
        id: 'am_' + p.id, name: p.name, providerPoiId: p.id,
        address: typeof p.address === 'string' ? p.address : '',
        lng, lat, type: p.type, typecode: p.typecode,
        distanceM: Math.round(haversineM(origin, { lng, lat })), ...m, mustForce: true,
      };
      if (end) c.corridorT = corridorT(origin, end, c);
      c._rank = 1; // 必去点不参与普通候选排序，固定在最前
      mustCands.push(c);
      seenMust.add(pid);
    } catch (e) { /* 取不到详情 → 保持缺失，由校验层如实判 infeasible */ }
  }
  cands = [...mustCands, ...cands];
  if (end) corridor = { odM: Math.round(haversineM(origin, end)), searchErrors: corridorSearchErrors, segments: [0, 1, 2].map((k) => cands.filter((c) => segOf(c.corridorT) === k).length) };
  const graph = new AmapAreaGraph(cfg, origin, budgetSec, end);
  // 候选已定、路网矩阵还没抓：把候选交给调用方（智能体评审与矩阵抓取并行）
  if (typeof opts.onCandidates === 'function') {
    try { opts.onCandidates(cands.map((c) => ({ id: c.id, name: c.name, typecode: c.typecode || '', tags: c.tags || [], nominated: !!c.nominated, address: c.address || '' }))); } catch (e) { /* 回调失败不影响建包 */ }
  }
  await graph.init(cands, { matrixMode, cacheKey: matrixCacheKeyOf('area', origin, [...(end ? [endKeyOf(end)] : []), ...cands.map((c) => c.id)]) });
  const usable = cands.filter((c) => graph.nodes.has(c.id));
  const pack = {
    venue: {
      id: 'area_amap', name: '周边片区（高德实时数据）', nameNote: '候选点与路段来自高德 Web 服务实时查询',
      city: '', timezone: 'Asia/Shanghai', packVersion: 'amap-live-' + new Date().toISOString().slice(0, 10),
      coverageScope: {
        kind: 'poi',
        scopeLabel: corridor
          ? `起点→终点沿途 ${usable.length} 个候选点（前/中/后段 ${corridor.segments.join('/')}）`
          : `周边 ${radiusM}m 内检索到的 ${usable.length} 个候选点`,
        corridor,
      },
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
      providerPoiId: c.providerPoiId, address: c.address, typecode: c.typecode || '',
      nominated: !!c.nominated, agentReason: c.agentReason || null,
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

module.exports = { _rateGate: rateGate, prewarmAreaSearch, areaRadiusM, mergeNominated, reserveNominated, corridorT, pickCorridor, END_DUP_M, COMMERCIAL_EXPERIENCE_RE, detourM, endKeyOf, END_NODE_MIN_M, searchAround, walkingRoute, textSearch, regeo, convertCoord, buildAmapAreaPack, AmapAreaGraph, amapGet, mapType, maxCandidatesForQuota, matrixCacheKeyOf, EXCLUDE_NAME_RE, SEARCH_TYPE_GROUPS, isJunkPoi, CHAIN_SOFT_RE, matrixModeOf, candidateCapFor, walkingRouteCached, resolveMatrixMode, _resetDistanceProbe: () => { distanceProbe = { at: 0, ok: null }; } };
