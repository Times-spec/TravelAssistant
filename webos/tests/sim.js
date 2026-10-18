'use strict';
// 离线模拟：高德 around/distance/walking/detail 模拟，比较新旧代码的站数/利用率/末段
const ROOT = process.argv[2] || require('path').join(__dirname, '..');
const { haversineM } = require(ROOT + '/server/geo');
let calls = { distance: 0, walking: 0, around: 0 };
const TYPES = ['110101', '110200', '140100', '050100', '061000', '060100', '140400', '050500'];
const NAMES = { '110101': '公园', '110200': '古寺', '140100': '博物馆', '050100': '老字号餐馆', '061000': '步行街', '060100': '书店', '140400': '美术馆', '050500': '咖啡馆' };
function poisNear(lng, lat, radius, types) {
  // 确定性伪随机网格：每 ~250m 一个格子，部分格子有 POI
  const out = [];
  const step = 0.0026;
  for (let gx = -12; gx <= 12; gx++) for (let gy = -12; gy <= 12; gy++) {
    const cx = Math.round(lng / step) + gx, cy = Math.round(lat / step) + gy;
    const h = Math.abs(Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453) % 1;
    if (h > 0.55) continue;
    const tc = TYPES[Math.floor(h * 1000) % TYPES.length];
    if (!types.some((t) => tc.startsWith(t.replace(/0+$/, '')))) continue;
    const plng = cx * step + (h - 0.3) * 0.001, plat = cy * step + (0.3 - h) * 0.001;
    const d = haversineM({ lng, lat }, { lng: plng, lat: plat });
    if (d > radius) continue;
    out.push({ id: `S${cx}_${cy}`, name: `${NAMES[tc]}${Math.abs(cx * 31 + cy) % 97}号`, typecode: tc, type: NAMES[tc], address: '某路', location: `${plng.toFixed(6)},${plat.toFixed(6)}`, distance: String(Math.round(d)) });
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, 15);
}
const walkD = (a, b) => Math.round(haversineM(a, b) * 1.3);
global.fetch = async (url) => {
  const u = new URL(String(url));
  const q = u.searchParams;
  const J = (o) => new Response(JSON.stringify({ status: '1', info: 'OK', infocode: '10000', ...o }), { status: 200 });
  const P = (s) => { const [lng, lat] = s.split(',').map(Number); return { lng, lat }; };
  if (u.pathname.includes('/place/around')) { calls.around++; const c = P(q.get('location')); const pois = poisNear(c.lng, c.lat, Number(q.get('radius')), (q.get('types') || '').split('|')); return J({ count: String(pois.length), pois }); }
  if (u.pathname.includes('/v3/distance')) {
    calls.distance++;
    if (process.env.NO_DIST) return J({ results: [] });
    const d = P(q.get('destination'));
    const results = q.get('origins').split('|').map((o, i) => { const dist = walkD(P(o), d); return dist > 6500 ? { origin_id: String(i + 1), dest_id: '1', info: '超出范围', code: '3' } : { origin_id: String(i + 1), dest_id: '1', distance: String(dist), duration: String(Math.round(dist / 1.2)) }; });
    return J({ count: String(results.length), results });
  }
  if (u.pathname.includes('/direction/walking')) {
    calls.walking++;
    const a = P(q.get('origin')), b = P(q.get('destination'));
    const d = walkD(a, b);
    const mid = `${b.lng},${a.lat}`;
    return J({ route: { paths: [{ distance: String(d), duration: String(Math.round(d / 1.2)), steps: [
      { instruction: '向东步行', action: '右转', road: '测试路', distance: String(Math.round(d / 2)), polyline: `${q.get('origin')};${mid}` },
      { instruction: '到达', action: '', road: '示例街', distance: String(Math.round(d / 2)), polyline: `${mid};${q.get('destination')}` }] }] } });
  }
  return J({ count: '0', pois: [] });
};
const { buildAmapAreaPack } = require(ROOT + '/server/amap');
const planner = require(ROOT + '/server/planner');
const cfg = { amap: { webServiceKey: 't' }, limits: { maxRoutingCalls: 110, maxPoiCandidates: 24 } };
const O = { lng: 104.0806, lat: 30.6575, crs: 'GCJ02', label: '起点' };
const E = { lng: 104.0556, lat: 30.6700, crs: 'GCJ02', label: '终点' };
function intentOf(budgetSec, endpoint) {
  const s = Date.parse('2026-10-19T02:00:00Z');
  return { intentId: 'i', revision: 1, objective: 'highlights', origin: { point: O, label: O.label }, endpoint,
    startAtMs: s, latestEndAtMs: s + budgetSec * 1000, budgetSec, timezone: 'Asia/Shanghai', pace: 'normal', interests: [],
    hard: { mustVisitIds: [], avoidPoiIds: [], noRepeatedEdges: false }, soft: { repeatRoadPenalty: 1 } };
}
(async () => {
  const rows = [];
  for (const [label, budget, ep] of [['1h回起点', 3600, { mode: 'return_to_origin' }], ['3h回起点', 10800, { mode: 'return_to_origin' }], ['5h回起点', 18000, { mode: 'return_to_origin' }], ['3h A→B', 10800, { mode: 'fixed', point: E, label: '终点' }], ['2h 顺路', 7200, { mode: 'flexible' }]]) {
    calls = { distance: 0, walking: 0, around: 0 };
    const t0 = Date.now();
    const intent = intentOf(budget, ep);
    const { pack, graph } = await buildAmapAreaPack(cfg, O, budget, ep.mode === 'fixed' ? E : null, {});
    const tb = Date.now() - t0;
    const results = planner.solveAlternatives(pack, intent, graph);
    const r0 = results[0];
    let solved = r0.solved;
    if (planner.hydrateSolved) solved = await planner.hydrateSolved(pack, intent, graph, solved);
    const plan = planner.buildRoutePlan(pack, intent, graph, solved, { version: 1, planId: 'p' });
    const sch = solved.schedule;
    if (process.env.DBG) console.log(label, plan.legs.map((l) => (l.geometry || []).length + ":" + l.provider).join(" "));
    rows.push({ label, cands: pack.pois.length, stops: sch.stops.length, util: Math.round(sch.totals.totalSec / budget * 100) + '%', dwell: sch.stops.map((s) => Math.round(s.dwellSec / 60)).join('/'), endLeg: sch.endLeg ? Math.round(sch.endLeg.distanceM) : null, km: Math.round(sch.totals.distanceM / 100) / 10, status: plan.status, geo: plan.legs.every((l) => l.provider === 'amap-walking') ? 'real' : 'sketch', calls: `d${calls.distance}/w${calls.walking}`, buildMs: tb, policy: r0.policy.name });
  }
  console.table(rows);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
