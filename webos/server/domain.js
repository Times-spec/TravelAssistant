'use strict';
/**
 * 领域层：需求提取与结构化契约（文档 §4、§6）。
 * 三层处理：
 *   1. 确定性预处理：时间、单位、枚举、已选 POI ID 由程序解析验证（本文件）。
 *   2. LLM 理解：自然语言提取（演示模式 = 规则引擎 ruleNLU；真实模式 = HTTP LLM 适配器，
 *      两者输出同一 Schema，且都必须经过第 3 层校验——模型不能创造 POI ID）。
 *   3. 规则合并与校验：冲突处理、可见默认值、追问判定，产出 NormalizedIntent。
 */
const tk = require('./timekit');
const { id, nowIso, E, clamp } = require('./util');

const INTEREST_TAGS = ['自然', '公园湿地', '街区', '人文', '建筑', '美食'];

/* ---------------- 中文数字 ---------------- */
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToNum(s) {
  if (s == null) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    total = (a ? CN_NUM[a] : 1) * 10 + (b ? CN_NUM[b] || 0 : 0);
  } else {
    for (const ch of s) total = total * 10 + (CN_NUM[ch] ?? 0);
  }
  return total || null;
}

/* ---------------- 规则 NLU（演示模式的 LLM 替代，输出同一 Schema） ---------------- */
function ruleNLU(text) {
  const out = {
    objective: null, interests: [], mobility: null, pace: null,
    durationSec: null, latestEndClock: null, endpointRef: null,
    mustVisitNames: [], avoidNames: [],
    hard: {}, soft: {}, notes: [],
  };
  if (!text || !text.trim()) return out;
  const t = text.trim();

  // 时长：半小时/两小时/2小时/90分钟/半天
  let m = t.match(/(半|一|两|二|三|四|五|六|七|八|九|\d+)\s*(?:个)?\s*半?\s*(?:小时|钟头)/);
  if (m) {
    let h = cnToNum(m[1]) || 0;
    if (/半\s*(?:小时|钟头)/.test(t) && m[0].includes('半') && m[1] !== '半') h += 0.5;
    if (m[1] === '半') h = 0.5;
    out.durationSec = Math.round(h * 3600);
  }
  if (!out.durationSec) {
    m = t.match(/(\d+)\s*分钟/);
    if (m) out.durationSec = Number(m[1]) * 60;
  }
  if (!out.durationSec && /半天/.test(t)) out.durationSec = 4 * 3600;

  // 截止：五点前/17:00前/下午5点前/6点半前
  m = t.match(/(上午|中午|下午|晚上|傍晚|今晚)?\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*[点:：]\s*(半|\d{1,2})?\s*(?:前|之前)/);
  if (m) {
    let hh = cnToNum(m[2]);
    let mm = m[3] === '半' ? 30 : cnToNum(m[3]) || 0;
    if (hh != null) {
      if (['下午', '晚上', '傍晚', '今晚'].includes(m[1]) && hh < 12) hh += 12;
      if (m[1] === '中午' && hh < 12) hh += 12;
      if (hh <= 24 && mm < 60) out.latestEndClock = `${String(hh % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  }

  // 目标
  if (/全都|全部|都逛|逛全|走遍|不重复逛完/.test(t)) out.objective = 'poi_coverage';
  else if (/精华|最值得|经典/.test(t)) out.objective = 'highlights';
  else if (/放空|随便|随意|散心|发呆/.test(t)) out.objective = 'relax';

  // 兴趣
  const kw = [
    [/湿地/, '公园湿地'], [/自然|风景|山水|湖|河|树|花|鸟|绿道|公园/, '自然'],
    [/老街|街区|巷子|市井|菜场|市集/, '街区'], [/历史|人文|文化|古迹|遗址|博物馆|美术|书/, '人文'],
    [/建筑|古建|楼|桥|塔|舫/, '建筑'], [/美食|吃|小吃|茶|咖啡|餐/, '美食'],
  ];
  for (const [re, tag] of kw) if (re.test(t) && !out.interests.includes(tag)) out.interests.push(tag);

  // 交通（可能与表单冲突 → 由合并层处理）
  if (/骑行|骑车|自行车|单车/.test(t)) out.mobility = 'bike';
  else if (/步行|走路|散步/.test(t)) out.mobility = 'walk';

  // 强度
  if (/轻松|慢|歇|不累/.test(t)) out.pace = 'easy';
  else if (/多走|暴走|快走/.test(t)) out.pace = 'active';

  // 必去 / 避开（实体名先取原文，由实体解析层映射到 ID；模型不创造 ID）
  let mm;
  const mustRe = /(?:必去|必须去|一定要去|想去|锁定)([^，。,;；!！?？]+)/g;
  while ((mm = mustRe.exec(t))) out.mustVisitNames.push(mm[1].trim());
  const avoidRe = /(?:不去|别去|避开|跳过)([^，。,;；!！?？]+)/g;
  while ((mm = avoidRe.exec(t))) out.avoidNames.push(mm[1].trim());

  // 终点
  if (/回到?起点|原路返回|回南门|回到?南门/.test(t)) out.endpointRef = { mode: 'return_to_origin' };
  else if (/回东门|东门出|东门离开/.test(t)) out.endpointRef = { mode: 'named', name: '东门' };
  else if (/顺路|走到哪算哪|不回头/.test(t)) out.endpointRef = { mode: 'flexible' };

  // 硬条件 / 软偏好（文档 §6.1：'不收费'可为硬条件，'免费优先'是偏好；少台阶≠轮椅可达）
  if (/不收费|零门票|不能花钱|一分钱不花|免费(?![的]?优先)/.test(t)) out.hard.maxCostCny = 0;
  else if (/免费优先|少花钱|省钱/.test(t)) out.soft.freePreferred = true;
  if (/轮椅|无障碍/.test(t)) out.hard.stepFreeRequired = true;
  else if (/少台阶|台阶少/.test(t)) out.soft.stepFewPreferred = true;
  if (/安静|人少/.test(t)) out.soft.quietPreferred = true;
  if (/多休息|歇脚|休息多/.test(t)) out.soft.restPreferred = true;
  if (/少走回头路|不重复|别绕/.test(t)) out.soft.repeatRoadPenalty = 1;

  return out;
}

/* ---------------- 时间模式解析（文档 §4.3 两种互斥主模式 + 双约束取紧） ---------------- */
function resolveTimes(form, textParsed, tz, evidence) {
  const nowMs = Date.now();
  const now = tk.msToZoned(nowMs, tz);
  const mark = (field, source, rawSpan) => { evidence[field] = { source, rawSpan }; };

  // 开始时间
  let startMs;
  if (form.startMode === 'later' && form.startAtMs) {
    startMs = Number(form.startAtMs);
    if (startMs < nowMs - 60000) throw E.badRequest('开始时间早于当前时间，请修正日期或时间', { field: 'startAt' });
    mark('startAt', 'form');
  } else {
    startMs = nowMs;
    mark('startAt', 'default', '现在');
  }

  // 时长：表单优先；文本补充
  let durationSec = form.durationSec || textParsed.durationSec || 2 * 3600;
  durationSec = clamp(durationSec, 30 * 60, 8 * 3600); // 文档 §2.2：30 分钟～8 小时
  mark('durationSec', form.durationSec ? 'form' : textParsed.durationSec ? 'text' : 'default', textParsed.durationSec ? undefined : '2 小时');

  // 截止：表单 arrive-by 模式 or 文本"几点前"
  let latestEndMs = startMs + durationSec * 1000;
  let deadlineSource = null;
  const parseClock = (clock, source) => {
    const z = tk.msToZoned(startMs, tz);
    let end = tk.zonedTimeToMs(z.dateStr, clock, tz);
    if (end <= startMs) end += 24 * 3600 * 1000; // 用户说"明天五点前"类语义按次日顺延一次
    deadlineSource = source;
    return end;
  };
  if (form.timeMode === 'arriveBy' && form.latestEndClock) {
    latestEndMs = parseClock(form.latestEndClock, 'form');
    mark('latestEndAt', 'form');
  } else if (textParsed.latestEndClock) {
    latestEndMs = parseClock(textParsed.latestEndClock, 'text');
    mark('latestEndAt', 'text', textParsed.latestEndClock);
  }
  // 双约束并存（"逛两小时，五点前回"）→ 取较紧（上面已是 min 语义：默认推导 vs 截止取更早）
  const byDuration = startMs + durationSec * 1000;
  if (latestEndMs > byDuration && !form.timeMode?.startsWith('arriveBy')) latestEndMs = byDuration;
  if (latestEndMs < byDuration && (form.timeMode === 'arriveBy' || textParsed.latestEndClock)) {
    // 截止更紧 → 实际预算被截止压缩，确认条需展示
  }
  if (latestEndMs <= startMs) {
    throw E.badRequest('开始时间已晚于截止时间，请修正日期或时间', { field: 'latestEndAt' });
  }
  return { startMs, latestEndMs, durationSec: Math.floor((latestEndMs - startMs) / 1000), dualConstraint: deadlineSource != null && latestEndMs < byDuration };
}

/* ---------------- 实体解析：文本地名 → 已知 POI/节点 ID（模型不创造 ID） ---------------- */
function resolvePlaceNames(names, pack) {
  const resolved = [];
  const unknown = [];
  for (const name of names) {
    const hit = pack.pois.find((p) => name.includes(p.name) || p.name.includes(name));
    if (hit) resolved.push(hit.id);
    else unknown.push(name);
  }
  return { resolved, unknown };
}

/* ---------------- 主入口：合并表单 + 文本 → NormalizedIntent ----------------
 * preParsed：可选的外部文本解析结果（真实模式 = LLM 输出，已按 §6.3 白名单校验），
 * 与规则 NLU 走完全相同的合并/校验路径——LLM 不创造 ID、不静默覆盖表单（§6.1）。 */
function normalizeIntent(input, packs, preParsed = null) {
  const { form = {}, text = '', timezone = 'Asia/Shanghai', profile = null } = input;
  const evidence = {};
  const unresolved = [];
  const scene = form.scene === 'venue' ? 'venue' : 'wander';
  evidence.scene = { source: 'form' };

  const isLiveVenue = String(form.venueId || '').startsWith('live:');
  const pack = scene === 'venue'
    ? packs.find((p) => p.venue.id === form.venueId) || (input.venuePack || null)
    : packs.find((p) => p.venue.id === 'block_binhe');
  if (scene === 'venue' && !pack && !isLiveVenue) throw E.badRequest('请先选择游览场所', { field: 'venueId' });
  if (scene === 'venue' && isLiveVenue && !form.venueRef) throw E.badRequest('缺少场所信息', { field: 'venueRef' });

  // 文本理解（真实模式优先 LLM 结果；规则引擎兜底；两者同 Schema、同校验路径）
  const parsed = preParsed || ruleNLU(text);
  // LLM 的终点 schema 只有"回到起点/顺路结束"，没有"从东门出"这类具名门；
  // 用规则解析补齐缺失的 endpointRef（LLM 已给出终点时仍以 LLM 为准）。
  if (preParsed && !parsed.endpointRef) {
    const rules = ruleNLU(text);
    if (rules.endpointRef) parsed.endpointRef = rules.endpointRef;
  }
  const textEngine = preParsed ? 'llm' : 'rules';

  // 目标
  // 目标。两种场景默认都是 highlights：用户说"陪我逛半天"，期待的是排满值得去点的路线；
  // relax 曾是城市闲逛的默认，但它压低街区点收益并曾跳过预算填充，半天实测只排两三站（2026-10-01 修）。
  // relax 仍可由用户文字（散心/放空）或景区模式选择触发。
  let objective = form.objective || parsed.objective || 'highlights';
  evidence.objective = { source: form.objective ? 'form' : parsed.objective ? 'text' : 'default' };

  // 起点（规划起点与设备位置分离，§1 表）
  if (!form.origin || typeof form.origin.lng !== 'number') throw E.badRequest('缺少规划起点', { field: 'origin' });
  const origin = {
    point: { lng: form.origin.lng, lat: form.origin.lat, crs: form.origin.crs || 'GCJ02' },
    poiId: form.origin.poiId || null,
    entranceId: form.origin.entranceId || null,
    label: form.origin.label || '自选起点',
  };
  evidence.origin = { source: form.origin.source === 'device' ? 'user_confirmed' : 'form' };

  // 时间
  const tz = (pack && pack.venue.timezone) || timezone;
  const times = resolveTimes(form, parsed, tz, evidence);

  // 终点：用户显式选过 → 表单优先；没选过 → 一句话里的终点描述优先（此前默认值总把文字条件盖掉）
  let endpoint;
  const ep = (form.endpointTouched ? form.endpointMode : null)
    || (parsed.endpointRef && parsed.endpointRef.mode)
    || form.endpointMode
    || 'return_to_origin';
  if (ep === 'fixed' && form.endpointPoint) {
    // entranceId/poiId：用户在地图上吸附到具体门/点位时由前端写入，planner 优先用它定位（比裸坐标更稳）
    endpoint = { mode: 'fixed', point: form.endpointPoint, poiId: form.endpointPoiId || null, entranceId: form.endpointEntranceId || null, label: form.endpointLabel || '指定终点' };
  } else if (ep === 'named' && parsed.endpointRef && parsed.endpointRef.name && pack) {
    const g = (pack.nodes || []).find((n) => n.type === 'entrance' && parsed.endpointRef.name.includes(n.name));
    endpoint = g
      ? { mode: 'fixed', point: { lng: g.lng, lat: g.lat, crs: 'GCJ02' }, poiId: null, entranceId: g.id, label: g.name }
      : { mode: 'return_to_origin' };
  } else if (ep === 'flexible') {
    endpoint = { mode: 'flexible' };
  } else {
    endpoint = { mode: 'return_to_origin' };
  }
  evidence.endpoint = { source: form.endpointTouched ? 'form' : parsed.endpointRef ? 'text' : 'default', rawSpan: undefined };

  // 交通：表单与文本冲突 → 追问（§4.4：步行与自然语言骑行冲突属于决定性冲突）
  let mobility = form.mobility && form.mobility !== 'skip' ? form.mobility : 'walk';
  if (parsed.mobility && form.mobility && form.mobility !== 'skip' && parsed.mobility !== form.mobility) {
    unresolved.push({
      field: 'mobility',
      question: `表单选的是${form.mobility === 'walk' ? '步行' : '骑行'}，但你说想${parsed.mobility === 'bike' ? '骑车' : '步行'}，按哪种方式规划？`,
      reason: '交通方式冲突会实质改变路线',
      options: ['walk', 'bike'],
    });
  }
  if (mobility === 'bike') {
    // §4.2：骑行是受控功能开关；演示路网全部 bikeAllowed:false → 追问改步行
    unresolved.push({
      field: 'mobility',
      question: '骑行功能尚未在当前区域开放（步道骑行权限未核验），先按步行规划可以吗？',
      reason: '首版骑行仅在路网与规则验证后开放',
      options: ['walk'],
    });
    mobility = 'walk';
  }
  evidence.mobility = { source: form.mobility && form.mobility !== 'skip' ? 'form' : 'default', rawSpan: form.mobility === 'skip' ? '暂不选择，按步行规划' : undefined };

  // 强度（§4.2：可跳过，默认适中；历史偏好只能补足软偏好）
  const pace = form.pace || parsed.pace || (profile && profile.pace) || 'normal';
  evidence.pace = { source: form.pace ? 'form' : parsed.pace ? 'text' : profile && profile.pace ? 'profile' : 'default' };

  // 兴趣：表单 ∪ 文本 ∪（未明确时）画像软偏好
  let interestSet = new Set([...(form.interests || []), ...parsed.interests]);
  if (!interestSet.size && profile && Array.isArray(profile.interests)) {
    for (const it of profile.interests) interestSet.add(it);
    evidence.interests = { source: 'profile' };
  } else {
    evidence.interests = { source: (form.interests || []).length ? 'form' : parsed.interests.length ? 'text' : 'default' };
  }
  const interests = [...interestSet].filter((t) => INTEREST_TAGS.includes(t)).map((tag) => ({ tag, weight: 1 }));

  // 必去/避开（表单 ID 优先；文本名做实体解析）
  let mustVisitIds = [...(form.mustVisitIds || [])];
  let avoidPoiIds = [...(form.avoidPoiIds || [])];
  if (pack && parsed.mustVisitNames.length) {
    const r = resolvePlaceNames(parsed.mustVisitNames, pack);
    mustVisitIds.push(...r.resolved.filter((x) => !mustVisitIds.includes(x)));
    for (const u of r.unknown) unresolved.push({ field: 'mustVisit', question: `没有找到叫"${u}"的点位，是说别的名字吗？`, reason: '必去点无法解析到已知地点' });
  }
  if (pack && parsed.avoidNames.length) {
    const r = resolvePlaceNames(parsed.avoidNames, pack);
    avoidPoiIds.push(...r.resolved.filter((x) => !avoidPoiIds.includes(x)));
  }
  // 必去∩避开必须为空（§6.3 校验）
  const both = mustVisitIds.filter((x) => avoidPoiIds.includes(x));
  if (both.length) throw E.badRequest('必去与避开包含相同地点，请调整', { field: 'mustVisit', ids: both });
  // 必去点已关闭 → 决定性追问（§4.4）
  if (pack) {
    for (const pid of mustVisitIds) {
      const poi = pack.pois.find((p) => p.id === pid);
      // 真实场所的轻量包只带 pois、不带 nodes（未建图）：不能因此崩掉需求解析
      const node = (pack.nodes || []).find((n) => n.id === pid);
      if (poi && (poi.closedToday || (node && node.status !== 'open'))) {
        unresolved.push({
          field: 'mustVisit',
          question: `必去点「${poi.name}」当前${poi.closedReason || '未开放'}，仍要保留吗？`,
          reason: '必去点关闭会实质改变路线',
          options: ['remove', 'keep_anyway'],
        });
      }
    }
  }
  evidence.mustVisit = { source: form.mustVisitIds?.length ? 'form' : parsed.mustVisitNames.length ? 'text' : 'default' };

  // 预算/无障碍/软偏好
  // "明确不回头"：只有用户显式表态（表单开关或自然语言"少走回头路/不重复/别绕"）才把返程也纳入零重复；
  // 默认只把"少重复"作为排序偏好，返程的必要通勤折返仍按通勤豁免处理。
  const explicitNoRepeat = form.avoidRepeat === true || parsed.soft.repeatRoadPenalty === 1;
  const allowBacktrack = form.avoidRepeat === false;
  const hard = {
    mustVisitIds,
    avoidPoiIds,
    // 产品固定约束：路线不得重复使用同一物理路段；正反向按同一 edgeId 计算。
    noRepeatedEdges: form.noRepeatedEdges !== false,
    strictNoRepeat: explicitNoRepeat && !allowBacktrack,
    maxDistanceM: form.maxDistanceM || null,
    maxCostCny: form.budgetHardZero ? 0 : parsed.hard.maxCostCny ?? null,
    stepFreeRequired: !!(form.stepFreeRequired || parsed.hard.stepFreeRequired),
  };
  const soft = {
    freePreferred: !!(form.freePreferred || parsed.soft.freePreferred),
    // 排序偏好默认开启（少走回头路）；只有用户明确"可以走回头路"才关掉。
    repeatRoadPenalty: allowBacktrack ? 0 : (parsed.soft.repeatRoadPenalty ?? 1),
    restPreferred: !!(form.restPreferred || parsed.soft.restPreferred || pace === 'easy'),
    quietPreferred: !!(form.quietPreferred || parsed.soft.quietPreferred),
    stepFewPreferred: !!parsed.soft.stepFewPreferred,
  };
  if (hard.stepFreeRequired && form.needsText && /少台阶/.test(form.needsText)) {
    // 少台阶 ≠ 必须轮椅可达（§6.1）
    hard.stepFreeRequired = false;
    soft.stepFewPreferred = true;
  }

  const intent = {
    schemaVersion: '1.0',
    intentId: id('int'),
    revision: 1,
    scene,
    objective,
    venueId: pack ? pack.venue.id : (isLiveVenue ? form.venueId : null),
    venueRef: isLiveVenue ? form.venueRef : null,
    origin,
    endpoint,
    startAt: tk.msToZoned(times.startMs, tz).iso,
    latestEndAt: tk.msToZoned(times.latestEndMs, tz).iso,
    startAtMs: times.startMs,
    latestEndAtMs: times.latestEndMs,
    budgetSec: times.durationSec,
    dualConstraint: times.dualConstraint,
    timezone: tz,
    mobility,
    pace,
    interests,
    hard,
    soft,
    guideStyle: form.guideStyle || 'normal',
    rawText: text,
    textEngine,
    unresolved,
    fieldEvidence: evidence,
    createdAt: nowIso(),
  };
  return intent;
}

/** 确认条文案（§4.4：一行可编辑条件，非第二份问卷） */
function confirmChips(intent) {
  const chips = [];
  const start = intent.startAt.slice(11, 16);
  const now = tk.nowInZone(intent.timezone);
  const isToday = intent.startAt.slice(0, 10) === now.dateStr;
  chips.push({ field: 'startAt', label: isToday && Math.abs(Date.parse(intent.startAt) - Date.now()) < 120000 ? '现在出发' : `${intent.startAt.slice(5, 10).replace('-', '/')} ${start} 出发` });
  chips.push({ field: 'duration', label: tk.fmtDuration(intent.budgetSec) + (intent.dualConstraint ? '（受截止压缩）' : '') });
  chips.push({ field: 'mobility', label: intent.mobility === 'walk' ? '步行' : '骑行' });
  const ep = intent.endpoint;
  chips.push({ field: 'endpoint', label: ep.mode === 'return_to_origin' ? `回到${intent.origin.entranceId ? '入口' : '起点'}` : ep.mode === 'fixed' ? `终点：${ep.label || '指定地点'}` : '顺路结束' });
  if (intent.interests.length) chips.push({ field: 'interests', label: intent.interests.map((i) => i.tag).join('、') + '优先' });
  if (intent.hard.maxCostCny === 0) chips.push({ field: 'cost', label: '零门票硬条件' });
  else if (intent.soft.freePreferred) chips.push({ field: 'cost', label: '免费优先' });
  if (intent.hard.stepFreeRequired) chips.push({ field: 'access', label: '轮椅可达（硬条件）' });
  else if (intent.soft.stepFewPreferred) chips.push({ field: 'access', label: '少台阶' });
  if (intent.hard.mustVisitIds.length) chips.push({ field: 'must', label: `必去 ${intent.hard.mustVisitIds.length} 处` });
  if (intent.hard.noRepeatedEdges) chips.push({ field: 'route', label: '不走重复路段' });
  return chips;
}

module.exports = { normalizeIntent, confirmChips, ruleNLU, INTEREST_TAGS, cnToNum };
