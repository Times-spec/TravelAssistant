'use strict';
/**
 * A→B 终点回归（模拟高德，不调外网）。
 *
 * 用户反馈：「最后一个景点应该靠近终点，否则末站→终点来回走一段无法解释」。
 * 根因：实时路网只有起点一个端口，固定终点被吸附到最近的候选点，末站→真实终点这段不参与排序。
 * 不变式：
 *   1. 固定终点（离起点较远）时，图里有独立终点节点 am_end，路线最后一段真的走到 am_end；
 *   2. 末站比首站更靠近终点（顺路而行，不是逛完起点附近再空走过去）；
 *   3. 路线输出 endApproach，正向路段带高德逐步导引 steps；
 *   4. 回起点模式行为不变（没有 am_end）。
 *
 * 运行：node scripts/planner-endpoint.js
 */
const assert = require('assert');
const { haversineM } = require('../server/geo');

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (!u.hostname.includes('restapi.amap.com')) return realFetch(url, opts);
  const q = u.searchParams;
  const J = (o) => new Response(JSON.stringify({ status: '1', info: 'OK', infocode: '10000', ...o }), { status: 200 });
  if (u.pathname.includes('/place/around')) {
    const [lng, lat] = q.get('location').split(',').map(Number);
    const tc = (q.get('types') || '110000').split('|')[0];
    const k = [...tc].reduce((a, c) => a + c.charCodeAt(0), 0) % 7; // 不同类型错开位置
    const pois = Array.from({ length: 4 }, (_, i) => {
      const plng = lng + (i - 1.5) * 0.002 + k * 0.0004, plat = lat + ((i % 2) ? 0.0015 : -0.0015) + (k - 3) * 0.0003;
      return {
        id: `P${Math.round(plng * 1e4)}_${Math.round(plat * 1e4)}_${tc}`, name: `点${tc.slice(0, 3)}_${Math.round(plng * 1e4) % 1000}`,
        typecode: tc.length === 6 ? tc : '110200', type: '风景名胜', address: '某路', location: `${plng.toFixed(6)},${plat.toFixed(6)}`,
        distance: String(Math.round(haversineM({ lng, lat }, { lng: plng, lat: plat }))), cityname: '成都市', adname: '锦江区',
      };
    });
    return J({ count: String(pois.length), pois });
  }
  if (u.pathname.includes('/direction/walking')) {
    const a = q.get('origin'), b = q.get('destination');
    const [x1, y1] = a.split(',').map(Number), [x2, y2] = b.split(',').map(Number);
    const d = Math.round(haversineM({ lng: x1, lat: y1 }, { lng: x2, lat: y2 }) * 1.25);
    const mid = `${x2},${y1}`; // L 形路线：先东西再南北，制造一个转弯
    return J({ route: { paths: [{ distance: String(d), duration: String(Math.round(d / 1.2)), steps: [
      { instruction: '沿测试路向东步行', action: '右转', road: '测试路', distance: String(Math.round(d / 2)), polyline: `${a};${mid}` },
      { instruction: '沿示例街步行到达目的地', action: '', road: '示例街', distance: String(Math.round(d / 2)), polyline: `${mid};${b}` },
    ] }] } });
  }
  return J({});
};

const { buildAmapAreaPack } = require('../server/amap');
const { solveOnce, buildRoutePlan } = require('../server/planner');

const cfg = { amap: { webServiceKey: 'test' }, limits: { maxRoutingCalls: 60 } };
const policy = { interestW: 1, timeCostW: 0.55, dwellFactor: 1 };
const O = { lng: 104.0, lat: 30.0, crs: 'GCJ02', label: '起点广场' };
const E = { lng: 104.03, lat: 30.0, crs: 'GCJ02', label: '终点地铁站' };
function intentOf(endpoint) {
  const s = Date.parse('2026-10-18T01:00:00Z');
  return {
    intentId: 'i', revision: 1, objective: 'highlights',
    origin: { point: O, label: O.label }, endpoint,
    startAtMs: s, latestEndAtMs: s + 10800000, budgetSec: 10800,
    startAt: new Date(s).toISOString(), latestEndAt: new Date(s + 10800000).toISOString(),
    timezone: 'Asia/Shanghai', pace: 'normal', interests: [],
    hard: { mustVisitIds: [], avoidPoiIds: [], noRepeatedEdges: false, maxDistanceM: null, maxCostCny: null, stepFreeRequired: false },
    soft: { freePreferred: false, repeatRoadPenalty: 1, restPreferred: false, quietPreferred: false, stepFewPreferred: false },
  };
}

(async () => {
  /* ---------- 1~3. 固定终点 ---------- */
  {
    const intent = intentOf({ mode: 'fixed', point: E, label: E.label });
    const { pack, graph } = await buildAmapAreaPack(cfg, O, intent.budgetSec, E);
    assert(graph.nodes.has('am_end'), '固定终点应建独立节点 am_end');
    assert(pack.venue.entrances.includes('am_end'));
    const solved = solveOnce(pack, intent, graph, policy);
    assert.equal(solved.status, 'ok', JSON.stringify(solved.conflict || {}));
    assert.equal(solved.endNodeId, 'am_end', '终点不得再被吸附到最近的候选点');
    const sch = solved.schedule;
    assert(sch.endLeg && sch.endLeg.toNodeId === 'am_end', '最后一段必须真的走到终点');
    const stops = sch.stops.map((s) => graph.nodes.get(s.nodeId));
    assert(stops.length >= 2, '应排出多站路线，实际 ' + stops.length);
    const dEnd = (n) => haversineM(n, E);
    assert(dEnd(stops[stops.length - 1]) < dEnd(stops[0]), '末站应比首站更靠近终点');
    const route = buildRoutePlan(pack, intent, graph, solved, { version: 1, planId: 'p' });
    assert(route.endApproach && route.endApproach.endNodeId === 'am_end' && !route.endApproach.returnTrip);
    assert(route.legs[route.legs.length - 1].isReturnLeg);
    assert(route.legs.some((l) => Array.isArray(l.steps) && l.steps[0].instruction), '正向路段应带高德逐步导引');
    assert(route.endApproach.distanceM < 600, '有终点附近候选时末段不应空走 ' + route.endApproach.distanceM + 'm');
    assert(/前\/中\/后段/.test(pack.venue.coverageScope.scopeLabel), '走廊候选应分段统计');
    assert(!pack.pois.some((p) => haversineM(graph.nodes.get(p.id), E) < 60), '离终点 <60m 的点不应作为候选');
    console.log('  固定终点：', stops.map((n) => `${n.name}(距终点${Math.round(dEnd(n))}m)`).join(' → '), `→ 终点 ${route.endApproach.distanceM}m`);
  }
  /* ---------- 4. 回起点不受影响 ---------- */
  {
    const intent = intentOf({ mode: 'return_to_origin' });
    const { graph, pack } = await buildAmapAreaPack(cfg, O, intent.budgetSec, null);
    assert(!graph.nodes.has('am_end'));
    const solved = solveOnce(pack, intent, graph, policy);
    assert.equal(solved.status, 'ok');
    assert.equal(solved.schedule.endLeg.toNodeId, 'am_origin');
  }
  /* ---------- 5. 顺路结束：在末站直接结束，不再走回起点 ---------- */
  {
    const intent = intentOf({ mode: 'flexible' });
    const { graph, pack } = await buildAmapAreaPack(cfg, O, intent.budgetSec, null);
    const solved = solveOnce(pack, intent, graph, policy);
    assert.equal(solved.status, 'ok');
    assert(!solved.schedule.endLeg, '顺路结束不应有返程段');
    const route = buildRoutePlan(pack, intent, graph, solved, { version: 1, planId: 'p' });
    assert(route.endLabel.startsWith('顺路结束于') && !route.endLabel.includes('起点'), route.endLabel);
    assert(!route.endApproach);
  }
  console.log('✅ 终点回归通过：独立终点节点 / 末站靠近终点 / endApproach 与逐步导引 / 回起点不变 / 顺路结束在末站 / 末段不空走');
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
