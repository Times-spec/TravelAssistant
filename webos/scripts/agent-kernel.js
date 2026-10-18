'use strict';
/**
 * 智能体编排内核回归（模拟高德 + 假大模型，不调外网）。
 *
 * 不变式：
 *   1. 提名必须被高德核实：编造的地点、范围外的同名地点一律丢弃（模型不能造 POI）；
 *   2. 核实过的提名点进入片区/景区候选池，并带上 nominated / agentReason；景区围栏不误伤提名点；
 *   3. 评审分、停留时长、分类纠正落到候选上；噪声点被压到收益门槛之下；
 *   4. 反思-修复循环只接受质量分真正提升的修改；用户必去点不会被智能体去掉，智能体选的点不标"用户锁定"；
 *   5. 推荐理由：大模型文案过事实校验（数字/地名/末段/回头路/绝对化用语），不过就回退诚实模板；
 *   6. 大模型全部失败时，内核仍出路线（回退规则路径）；
 *   7. 端到端：JobRunner 跑一次 plan.generate，计划里有 agentKernel/critic trace，主推荐带理由。
 *
 * 运行：node scripts/agent-kernel.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { haversineM } = require('../server/geo');

/* ---------------- 模拟高德 ---------------- */
const O = { lng: 104.0, lat: 30.0, crs: 'GCJ02', label: '起点广场' };
const E = { lng: 104.03, lat: 30.0, crs: 'GCJ02', label: '终点地铁站' };
// 关键词检索能命中的"真实地点"（模拟高德库）
const KNOWN = [
  { id: 'K_WSY', name: '文殊院', typecode: '110205', lng: 104.0265, lat: 30.0012 },   // 靠近终点
  { id: 'K_DCS', name: '大慈寺', typecode: '110205', lng: 104.0135, lat: 30.0018 },   // 走廊中段
  { id: 'K_RMGY', name: '人民公园', typecode: '110101', lng: 104.0045, lat: 29.9990 }, // 起点附近
  { id: 'K_FAR', name: '远方古镇', typecode: '110202', lng: 104.30, lat: 30.30 },      // 同名但远在范围外
  { id: 'K_TH', name: '测试博物院-太和殿', typecode: '110200', lng: 116.3970, lat: 39.9180, addr: '测试博物院内' },
  { id: 'K_YHY', name: '测试博物院-御花园', typecode: '110200', lng: 116.3968, lat: 39.9220, addr: '测试博物院内' },
];
let amapCalls = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (!u.hostname.includes('restapi.amap.com')) return realFetch(url, opts);
  amapCalls++;
  const q = u.searchParams;
  const J = (o) => new Response(JSON.stringify({ status: '1', info: 'OK', infocode: '10000', ...o }), { status: 200 });
  const toPoi = (k, from) => ({
    id: k.id, name: k.name, typecode: k.typecode, type: '风景名胜', address: k.addr || '某路',
    location: `${k.lng},${k.lat}`, distance: String(Math.round(haversineM(from, k))), cityname: '成都市', adname: '锦江区',
  });
  if (u.pathname.includes('/geocode/regeo')) {
    return J({ regeocode: { formatted_address: '成都市锦江区某街道', addressComponent: { city: '成都市', citycode: '028', adcode: '510104', district: '锦江区', township: '春熙路街道' } } });
  }
  if (u.pathname.includes('/place/around') && q.get('keywords')) {
    const kw = q.get('keywords');
    const [lng, lat] = q.get('location').split(',').map(Number);
    const r = Number(q.get('radius') || 3000);
    const pois = KNOWN.filter((k) => (k.name.includes(kw) || kw.includes(k.name)) && haversineM({ lng, lat }, k) <= r).map((k) => toPoi(k, { lng, lat }));
    return J({ count: String(pois.length), pois });
  }
  if (u.pathname.includes('/place/text')) {
    const kw = q.get('keywords') || '';
    const pois = KNOWN.filter((k) => k.name.includes(kw.replace(/\s*景点$/, '')) || kw.includes(k.name.split('-').pop())).map((k) => toPoi(k, k));
    return J({ count: String(pois.length), pois });
  }
  if (u.pathname.includes('/place/around')) {
    // 类型周边检索：每类 4 个点，名字带上类型码，便于识别商业/餐饮
    const [lng, lat] = q.get('location').split(',').map(Number);
    const tc = (q.get('types') || '110000').split('|')[0];
    const k = [...tc].reduce((a, c) => a + c.charCodeAt(0), 0) % 7;
    const pois = Array.from({ length: 4 }, (_, i) => {
      const plng = lng + (i - 1.5) * 0.002 + k * 0.0004, plat = lat + ((i % 2) ? 0.0015 : -0.0015) + (k - 3) * 0.0003;
      const code = tc.length === 6 ? tc : '110200';
      const label = /^05/.test(code) ? '美食广场' : /^06/.test(code) ? '购物中心' : /^08/.test(code) ? 'XR体验馆' : '点';
      return {
        id: `P${Math.round(plng * 1e4)}_${Math.round(plat * 1e4)}_${tc}`, name: `${label}${code.slice(0, 3)}_${Math.round(plng * 1e4) % 1000}`,
        typecode: code, type: '测试', address: '某路', location: `${plng.toFixed(6)},${plat.toFixed(6)}`,
        distance: String(Math.round(haversineM({ lng, lat }, { lng: plng, lat: plat }))), cityname: '成都市', adname: '锦江区',
      };
    });
    return J({ count: String(pois.length), pois });
  }
  if (u.pathname.includes('/direction/walking')) {
    const a = q.get('origin'), b = q.get('destination');
    const [x1, y1] = a.split(',').map(Number), [x2, y2] = b.split(',').map(Number);
    const d = Math.round(haversineM({ lng: x1, lat: y1 }, { lng: x2, lat: y2 }) * 1.25);
    const mid = `${x2},${y1}`;
    return J({ route: { paths: [{ distance: String(d), duration: String(Math.round(d / 1.2)), steps: [
      { instruction: '沿测试路步行', action: '右转', road: '测试路', distance: String(Math.round(d / 2)), polyline: `${a};${mid}` },
      { instruction: '沿示例街步行到达目的地', action: '', road: '示例街', distance: String(Math.round(d / 2)), polyline: `${mid};${b}` },
    ] }] } });
  }
  if (u.pathname.includes('/v3/distance')) {
    // 距离矩阵（步行测距）：与路径规划同一口径（直线 ×1.25）；KERNEL_MATRIX=pairwise 时模拟"接口不可用"走旧模式
    if (process.env.KERNEL_MATRIX === 'pairwise') return J({ results: [] });
    const [dx, dy] = q.get('destination').split(',').map(Number);
    const results = q.get('origins').split('|').map((o, i) => {
      const [ox, oy] = o.split(',').map(Number);
      const d = Math.round(haversineM({ lng: ox, lat: oy }, { lng: dx, lat: dy }) * 1.25);
      return d > 6000 ? { origin_id: String(i + 1), dest_id: '1', info: '超出步行测距范围', code: '3' } : { origin_id: String(i + 1), dest_id: '1', distance: String(d), duration: String(Math.round(d / 1.2)) };
    });
    return J({ count: String(results.length), results });
  }
  if (u.pathname.includes('/place/detail')) return J({ pois: [] });
  return J({});
};

const amap = require('../server/amap');
amap._rateGate.minIntervalMs = 0;
amap._rateGate.relax = () => {};
const kernel = require('../server/agent_kernel');
const { RoutePlanningAgent } = require('../server/route_planning_agent');
const { buildRoutePlan } = require('../server/planner');

/* ---------------- 假大模型 ---------------- */
const llmLog = [];
function fakeLLM({ nominate = true, explainText = null, fail = false } = {}) {
  return async (cfg, system, user) => {
    llmLog.push(system.slice(0, 12));
    if (fail) throw new Error('llm down');
    if (system.includes('提名')) {
      if (!nominate) return { places: [] };
      if (user.includes('测试博物院')) return { places: [{ name: '太和殿', why: '紫禁城规格最高的大殿', dwellMin: 25 }, { name: '御花园', why: '明清皇家园林，古柏与堆秀山', dwellMin: 30 }, { name: '不存在的殿', why: '编的' }] };
      return { places: [
        ['文殊院', '川西最大佛教禅院，红墙古柏', 40],
        ['大慈寺', '千年古刹，闹市里的清净地', 30],
        ['人民公园', '鹤鸣茶社喝盖碗茶看老成都', 35],
        ['虚构之塔', '模型编造的地点', 20],
        ['远方古镇', '同名但不在步行范围', 60],
      ] };
    }
    if (system.includes('评审')) {
      const items = [];
      for (const line of user.split('\n')) {
        const m = /^(\d+)\. ([^｜]+)｜/.exec(line);
        if (!m) continue;
        const name = m[2];
        const nominated = line.includes('智能体提名');
        const value = nominated ? 0.9 : /XR|购物中心/.test(name) ? 0.15 : /美食广场/.test(name) ? 0.3 : 0.5;
        items.push([Number(m[1]), value, nominated ? 35 : 15, /购物|XR/.test(name) ? '街区' : nominated ? '人文/历史' : '自然', nominated ? '' : '普通点位', /XR/.test(name) ? 1 : 0]);
      }
      return { r: items };
    }
    if (system.includes('复核员')) return { ops: [] };
    if (system.includes('讲解员')) {
      const f = JSON.parse(user);
      if (explainText) return { text: explainText(f) };
      const s = f.stops;
      return { text: `先到「${s[0].name}」，${s.length > 1 ? `最后在「${s[s.length - 1].name}」收尾，` : ''}全程约 ${f.totalMin} 分钟。${f.endWalkM > 500 ? `最后一段到终点还要走 ${f.endWalkM} 米。` : ''}` };
    }
    return {};
  };
}

const cfgOf = (llm = true) => ({
  amap: { webServiceKey: 'test' }, llm: { baseUrl: 'http://llm.invalid', apiKey: 'x', model: 'fake' },
  limits: { maxRoutingCalls: 110, maxLlmTokens: 4000 },
  providers: { map: 'amap', llm: llm ? 'http' : 'rules', tts: 'unavailable' }, routePlanningMode: 'agent',
  agent: { timeBudgetMs: 60000 },
});
function intentOf(extra = {}) {
  const s = Date.parse('2026-10-18T02:00:00Z');
  const budget = extra.budgetSec || 10800;
  return {
    id: 'int_t', intentId: 'int_t', revision: 1, objective: 'highlights', venueId: 'area_amap', scene: 'wander',
    origin: { point: O, label: O.label }, endpoint: { mode: 'fixed', point: E, label: E.label },
    startAtMs: s, latestEndAtMs: s + budget * 1000, budgetSec: budget,
    startAt: new Date(s).toISOString(), latestEndAt: new Date(s + budget * 1000).toISOString(),
    timezone: 'Asia/Shanghai', pace: 'normal', interests: [{ tag: '人文' }], rawText: '从起点广场走到终点地铁站，想看看人文古迹',
    hard: { mustVisitIds: [], avoidPoiIds: [], noRepeatedEdges: false, maxDistanceM: null, maxCostCny: null, stepFreeRequired: false },
    soft: { freePreferred: false, repeatRoadPenalty: 1, restPreferred: false, quietPreferred: false, stepFewPreferred: false },
    unresolved: [],
    ...extra,
  };
}
const ids = (solved) => solved.schedule.stops.map((s) => s.poi.id);

(async () => {
  const t0 = Date.now();
  /* ---------- 0. 名称匹配 ---------- */
  assert(kernel.nameMatches('太和殿', '测试博物院-太和殿', '测试博物院'));
  assert(kernel.nameMatches('宽窄巷子', '宽窄巷子(东门)'));
  assert(!kernel.nameMatches('成都大慈寺', '成都'), '过短的名称不能匹配长提名');
  assert(!kernel.nameMatches('文殊院', '文殊坊停车场'));

  /* ---------- 1. 提名 + 核实 ---------- */
  const cfg = cfgOf(true);
  const intent = intentOf();
  const nomTrace = await kernel.ensureNominations(cfg, intent, { deps: { chatJSON: fakeLLM() } });
  const nomNames = intent.agentKnowledge.nominated.map((n) => n.name).sort();
  assert.deepStrictEqual(nomNames, ['人民公园', '大慈寺', '文殊院'], '只有被高德核实且在范围内的提名才保留：' + nomNames);
  assert(nomTrace.misses.includes('虚构之塔') && nomTrace.misses.includes('远方古镇'), '编造/范围外的提名必须丢弃');
  assert(intent.agentKnowledge.nominated.every((n) => n.reason), '提名带理由');

  /* ---------- 2. 提名点进入候选池 ---------- */
  const { pack, graph } = await amap.buildAmapAreaPack(cfg, O, intent.budgetSec, E, { interests: ['人文'], nominated: intent.agentKnowledge.nominated });
  const nomInPack = pack.pois.filter((p) => p.nominated).map((p) => p.id).sort();
  assert.deepStrictEqual(nomInPack, ['am_K_DCS', 'am_K_RMGY', 'am_K_WSY'], '核实过的提名点必须进候选池：' + nomInPack);
  assert(pack.pois.find((p) => p.id === 'am_K_WSY').agentReason.includes('禅院'));

  /* ---------- 3. 评审落到候选 ---------- */
  const apTrace = await kernel.ensureAppraisal(cfg, intent, pack, { deps: { chatJSON: fakeLLM() } });
  assert(apTrace.count >= pack.pois.length - 1, '候选应被评审');
  const xr = pack.pois.find((p) => /XR/.test(p.name));
  if (xr) assert(xr.scenic <= 0.3 && xr.agentNoise, '噪声点必须压到收益门槛之下');
  const wsy = pack.pois.find((p) => p.id === 'am_K_WSY');
  assert.equal(wsy.agentValue, 0.9);
  assert.equal(wsy.dwellSec, 35 * 60, '停留时长按评审建议');
  assert.deepStrictEqual(wsy.tags, ['人文'], '分类按评审纠正');

  /* ---------- 4. 内核：求解 + 反思 + 解释 ---------- */
  const res = await kernel.runAgentKernel({ cfg, pack, intent, graph, planId: 'p1', preTrace: [nomTrace, apTrace], deps: { chatJSON: fakeLLM() } });
  assert.equal(res.status, 'ready');
  const main = res.solutions[0].solved;
  const mainIds = ids(main);
  const q = res.trace.find((t) => t.stage === 'agent.quality');
  assert(q && q.after >= q.before, '反思-修复只能让质量分变好');
  assert(res.trace.some((t) => t.stage === 'critic.round'), '要有反思轮次记录');
  assert(res.trace.some((t) => t.stage === 'agent.nominated') && res.trace.some((t) => t.stage === 'agent.appraised'));
  assert(mainIds.filter((x) => ['am_K_DCS', 'am_K_RMGY', 'am_K_WSY'].includes(x)).length >= 2, '主推荐应包含至少 2 个提名点：' + mainIds);
  assert(!mainIds.some((x) => xr && x === xr.id), '噪声点不应进主推荐');
  const plan = buildRoutePlan(pack, intent, graph, main, { version: 1, planId: 'p1' });
  assert(plan.stops.every((s) => !s.locked), '智能体选的点不能标成用户锁定');
  const wStop = plan.stops.find((s) => s.poiId === 'am_K_WSY');
  if (wStop) assert(wStop.whyText.includes('禅院'), '推荐理由用智能体给出的具体理由：' + wStop.whyText);
  assert(typeof res.agentRationale === 'string' && res.agentRationale.length > 10);
  const exTrace = res.trace.find((t) => t.stage === 'agent.explained');
  console.log('  片区 A→B：', plan.stops.map((s) => s.name).join(' → '), `| 末段 ${plan.endApproach.distanceM}m | Q ${q.before}→${q.after} | 理由(${exTrace.source})：${res.agentRationale}`);

  // 对照：不带智能体知识的基础智能体（同一模拟数据）
  {
    const base = await amap.buildAmapAreaPack(cfg, O, intent.budgetSec, E, { interests: ['人文'] });
    const b = new RoutePlanningAgent().plan({ pack: base.pack, intent: intentOf(), graph: base.graph, planId: 'b' });
    const bs = b.solutions[0].solved;
    // 用同一把尺子（带评审分的 pack）打分
    const evB = kernel.evaluateSolved(pack, intent, { ...bs, schedule: { ...bs.schedule, stops: bs.schedule.stops.map((s) => ({ ...s, poi: pack.pois.find((p) => p.id === s.poi.id) || s.poi })) } });
    const evK = kernel.evaluateSolved(pack, intent, main);
    console.log(`  对照：基础 ${bs.schedule.stops.map((s) => s.poi.name).join('→')} Q=${evB.Q} 末段${evB.metrics.endWalkM}m 商业${evB.metrics.commercialShare} ｜ 内核 Q=${evK.Q} 末段${evK.metrics.endWalkM}m 商业${evK.metrics.commercialShare}`);
    assert(evK.Q >= evB.Q, '内核方案质量不得低于基础方案');
    assert(evK.metrics.commercialShare <= evB.metrics.commercialShare, '商业化占比不得变高');
  }

  /* ---------- 5. 反思修复：求解器看走眼的低价值站被换掉；用户必去点不动 ---------- */
  {
    const it = intentOf();
    const { pack: pk, graph: gr } = await amap.buildAmapAreaPack(cfg, O, it.budgetSec, E, { interests: ['人文'] });
    // 模拟"类型先验高、评审很低"的分歧：求解器按 scenic 选它，评审说它不值得
    const first = new RoutePlanningAgent().plan({ pack: pk, intent: it, graph: gr, planId: 'c' }).solutions[0].solved;
    const victimId = ids(first)[0];
    const victim = pk.pois.find((p) => p.id === victimId);
    victim.agentValue = 0.05; victim.scenicPrior = victim.scenic;
    for (const p of pk.pois) if (p.id !== victimId && p.agentValue == null) p.agentValue = 0.6;
    const r = await kernel.runAgentKernel({ cfg: cfgOf(false), pack: pk, intent: it, graph: gr, planId: 'c' });
    const rounds = r.trace.filter((t) => t.stage === 'critic.round');
    assert(rounds[0].issues.some((x) => x.code === 'LOW_VALUE_STOP'), '应发现低价值站');
    assert(rounds.some((x) => x.accepted), '应采纳一个修复操作');
    assert(!ids(r.solutions[0].solved).includes(victimId), '低价值站应被去掉/替换');
    console.log('  反思修复：', rounds.map((x) => `R${x.round} ${x.before}→${x.after} ${x.accepted ? x.accepted.label : '—'}`).join(' ｜ '));

    // 同样的低价值站，但它是用户必去点 → 不得被去掉
    const it2 = intentOf({ hard: { ...it.hard, mustVisitIds: [victimId] } });
    const r2 = await kernel.runAgentKernel({ cfg: cfgOf(false), pack: pk, intent: it2, graph: gr, planId: 'c2' });
    assert(ids(r2.solutions[0].solved).includes(victimId), '用户必去点不得被智能体去掉');
    const p2 = buildRoutePlan(pk, it2, gr, r2.solutions[0].solved, { version: 1, planId: 'c2' });
    assert(p2.stops.find((s) => s.poiId === victimId).locked, '用户必去点仍标锁定');
    assert(p2.stops.filter((s) => s.locked).length === 1, '只有用户必去点标锁定');
  }

  /* ---------- 6. 推荐理由事实校验 ---------- */
  {
    const f = { stops: [{ order: 1, name: '文殊院', dwellMin: 40 }, { order: 2, name: '大慈寺', dwellMin: 30 }], totalMin: 150, distanceKm: 3.2, budgetMin: 180, endWalkM: 720, endWalkMin: 11, repeatM: 0, endLabel: '终点地铁站', place: '起点广场', changes: [] };
    assert(kernel.checkRationale('先看「文殊院」再到「大慈寺」，约 150 分钟；最后一段到终点还要走 720 米。', f));
    assert(!kernel.checkRationale('先看「文殊院」再到「大慈寺」，全程零回头路，最后到终点 720 米。', f), '绝对化用语要拒绝');
    assert(!kernel.checkRationale('先看「文殊院」再到「大慈寺」，约 95 分钟，最后到终点 720 米。', f), '编造的数字要拒绝');
    assert(!kernel.checkRationale('先看「文殊院」再到「大慈寺」，约 150 分钟，很值得一走。', f), '末段步行超 500 米必须交代');
    assert(!kernel.checkRationale('先看「文殊院」再到「青羊宫」，最后到终点 720 米。', f), '不在路线里的地名要拒绝');
    // 大模型写了不合格的理由 → 回退模板
    kernel.clearMemo();
    const it = intentOf();
    const { pack: pk, graph: gr } = await amap.buildAmapAreaPack(cfg, O, it.budgetSec, E, { interests: ['人文'] });
    const r = await kernel.runAgentKernel({ cfg, pack: pk, intent: it, graph: gr, planId: 'e', deps: { chatJSON: fakeLLM({ explainText: () => '这是一条零回头路的完美路线，强烈推荐。' }) } });
    const ex = r.trace.find((t) => t.stage === 'agent.explained');
    assert.equal(ex.source, 'template', '不合格文案必须回退模板');
    assert(!/零回头/.test(r.agentRationale));
  }

  /* ---------- 7. 大模型全挂：仍然出路线 ---------- */
  {
    kernel.clearMemo();
    const it = intentOf();
    const nt = await kernel.ensureNominations(cfg, it, { deps: { chatJSON: fakeLLM({ fail: true }) } });
    assert(nt.error && nt.count === 0, '提名失败要记录并回退');
    const { pack: pk, graph: gr } = await amap.buildAmapAreaPack(cfg, O, it.budgetSec, E, { interests: ['人文'], nominated: it.agentKnowledge.nominated });
    const at = await kernel.ensureAppraisal(cfg, it, pk, { deps: { chatJSON: fakeLLM({ fail: true }) } });
    assert(at.error, '评审失败要记录');
    const r = await kernel.runAgentKernel({ cfg, pack: pk, intent: it, graph: gr, planId: 'f', deps: { chatJSON: fakeLLM({ fail: true }) } });
    assert.equal(r.status, 'ready');
    assert(r.solutions.length >= 1);
    assert.equal(r.trace.find((t) => t.stage === 'agent.explained').source, 'template');
  }

  /* ---------- 8. 景区：提名点进池、围栏不误伤（顺带覆盖 resolveVenue 的 let/const 回归） ---------- */
  {
    kernel.clearMemo();
    const { buildLiveVenue } = require('../server/live_venue');
    const venueRef = { id: 'live:V_TEST', providerPoiId: 'V_TEST', name: '测试博物院', city: '北京市', coord: { lng: 116.3970, lat: 39.9170 } };
    const it = intentOf({
      venueId: 'live:V_TEST', venueRef, scene: 'venue', budgetSec: 7200,
      origin: { point: { lng: 116.3970, lat: 39.9140 }, label: '午门' }, endpoint: { mode: 'return_to_origin' },
    });
    const nt = await kernel.ensureNominations(cfg, it, { deps: { chatJSON: fakeLLM() } });
    assert.deepStrictEqual(it.agentKnowledge.nominated.map((n) => n.name).sort(), ['测试博物院-太和殿', '测试博物院-御花园'], JSON.stringify(nt));
    assert(nt.misses.includes('不存在的殿'));
    const live = await buildLiveVenue(cfg, venueRef, it.origin.point, it.budgetSec, { food: false, mustVisitIds: [], nominated: it.agentKnowledge.nominated });
    const nomIds = live.pack.pois.filter((p) => p.nominated).map((p) => p.id).sort();
    assert.deepStrictEqual(nomIds, ['am_K_TH', 'am_K_YHY'], '景区提名点进池：' + nomIds);
    const at = await kernel.ensureAppraisal(cfg, it, live.pack, { deps: { chatJSON: fakeLLM() } });
    const r = await kernel.runAgentKernel({ cfg, pack: live.pack, intent: it, graph: live.graph, planId: 'v', preTrace: [nt, at], deps: { chatJSON: fakeLLM() } });
    assert.equal(r.status, 'ready');
    const names = r.solutions[0].solved.schedule.stops.map((s) => s.poi.name);
    assert(names.some((n) => /太和殿|御花园/.test(n)), '景区主推荐应包含提名的核心景点：' + names);
    console.log('  景区：', names.join(' → '));
  }

  /* ---------- 9. 端到端：JobRunner.runPlanGenerate ---------- */
  {
    kernel.clearMemo();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentk-'));
    process.env.DATA_DIR = dir;
    const { createStore } = require('../server/store');
    const store = createStore(dir);
    const llm = require('../server/llm');
    llm.chatJSON = fakeLLM();
    llm.generateGuide = async (c, poi) => ({ summary: poi.name + '简介', shortScript: poi.name, detail: poi.name });
    const { JobRunner } = require('../server/jobs');
    const events = [];
    const runner = new JobRunner({ store, cfg: cfgOf(true), packs: [], sseHub: { publish: (jid, e) => events.push(e) } });
    const it = intentOf({ id: 'int_e2e', intentId: 'int_e2e' });
    store.insert('intents', it);
    store.insert('plans', { id: 'pl_e2e', intentId: it.id, status: 'queued' });
    const job = { id: 'job_e2e', type: 'plan.generate', planId: 'pl_e2e', requestRevision: 1 };
    store.insert('jobs', { ...job, status: 'running', updatedAt: new Date().toISOString() });
    await runner.runPlanGenerate(job);
    const planRow = store.byId('plans', 'pl_e2e');
    assert(['ready', 'conditional'].includes(planRow.status), '计划应就绪：' + planRow.status);
    assert(planRow.agentKernel && planRow.agentKernel.nominated.length === 3, '计划记录提名');
    assert(planRow.agentTrace.some((t) => t.stage === 'agent.quality'));
    const mainRv = store.byId('route_versions', planRow.mainRouteId);
    assert(mainRv.agentRationale && mainRv.agentStrategy.quality, '主推荐带理由与质量分');
    assert(events.some((e) => e.type === 'agent.progress' && e.payload.stage === 'nominate'));
    assert(store.byId('intents', it.id).agentKnowledge.appraisal, '评审结果随意图落库（重排沿用）');
    const apT = planRow.agentTrace.find((t) => t.stage === 'agent.appraised');
    assert(apT && apT.parallel === true && apT.fresh > 0 && !apT.error, '评审应与路网矩阵并行完成：' + JSON.stringify(apT && { parallel: apT.parallel, fresh: apT.fresh, error: apT.error }));
    assert(events.filter((e) => e.type === 'agent.progress' && e.payload.stage === 'appraise').length === 1, '评审进度事件只发一次');
    // 重建场所包：沿用同一套智能体知识
    const again = await runner.resolvePackGraph(store.byId('intents', it.id));
    assert(again.pack.pois.some((p) => p.nominated && p.agentValue != null), '重排时提名与评审仍生效');
    if (process.env.DEBUG_KERNEL) console.log(JSON.stringify(planRow.agentTrace.filter((t) => /agent|critic/.test(t.stage)), null, 1).slice(0, 6000));
    console.log('  端到端：', mainRv.title, '|', mainRv.stops.map((s) => s.name).join(' → '), '| 备选', planRow.routeIds.length - 1, '个');
  }

  console.log(`✅ 智能体内核回归通过（${Date.now() - t0}ms，高德模拟调用 ${amapCalls} 次，大模型调用 ${llmLog.length} 次）`);
  process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
