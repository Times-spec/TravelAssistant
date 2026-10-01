'use strict';
/**
 * 规划器回归基准（不启服务、不调外网）：直连本地场所包，按 目标×时长 矩阵
 * 打印各政策的站点数/总时长，用于验证"半天只排 3-4 个点"类问题的修复与回归。
 * 运行：node scripts/planner-bench.js [场所包文件名，默认 qinghu-park.json]
 */
const path = require('path');
const { loadPacks } = require('../server/providers');
const { VenueGraph, solveAlternatives, buildRoutePlan } = require('../server/planner');

const file = process.argv[2] || '';
const ROOT = path.join(__dirname, '..');
const packs = loadPacks(ROOT).filter((p) => p.venue.id && p.venue.name);
const pack = (file && packs.find((p) => file === path.basename(p.__file || '') || p.venue.name.includes(file)))
  || packs.find((p) => p.venue.name.includes('青湖'))
  || packs[0];
if (!pack) { console.error('未找到场所包'); process.exit(1); }

const graph = new VenueGraph(pack);
const startNode = pack.venue.entrances[0];
const startMs = (() => { const d = new Date(); d.setHours(14, 0, 0, 0); return d.getTime(); })();

function makeIntent(objective, budgetSec) {
  return {
    schemaVersion: '1.0', intentId: 'int_bench', revision: 1, scene: 'venue',
    objective,
    venueId: pack.venue.id, venueRef: null,
    origin: { point: { lng: 104.062, lat: 30.659, crs: 'GCJ02' }, poiId: null, entranceId: startNode, label: '入口' },
    endpoint: { mode: 'return_to_origin' },
    startAt: new Date(startMs).toISOString(), latestEndAt: new Date(startMs + budgetSec * 1000).toISOString(),
    startAtMs: startMs, latestEndAtMs: startMs + budgetSec * 1000,
    budgetSec, dualConstraint: false,
    timezone: 'Asia/Shanghai', mobility: 'walk', pace: 'normal',
    interests: [{ tag: '自然', weight: 1 }],
    hard: { mustVisitIds: [], avoidPoiIds: [], maxDistanceM: null, maxCostCny: null, stepFreeRequired: false },
    soft: { freePreferred: false, repeatRoadPenalty: 1, restPreferred: false, quietPreferred: false, stepFewPreferred: false },
    guideStyle: 'normal', rawText: '', textEngine: 'rules', unresolved: [],
  };
}

console.log(`场所包: ${pack.venue.name}（POI ${pack.pois.length}，图节点 ${pack.nodes.length}）`);
console.log('政策说明: balanced=主推荐, light=轻松版, full=全览版\n');
let worst = Infinity;
for (const objective of ['highlights', 'poi_coverage', 'relax']) {
  for (const budgetSec of [7200, 14400]) {
    const intent = makeIntent(objective, budgetSec);
    const results = solveAlternatives(pack, intent, graph);
    const label = `${objective.padEnd(12)} ${(budgetSec / 3600).toFixed(0)}h`;
    if (!results.length) { console.log(`${label}  无可行方案`); continue; }
    const line = results.map((r) => {
      const plan = buildRoutePlan(pack, intent, graph, r.solved, { version: 1, planId: 'plan_bench' });
      return `${r.policy.name}: ${plan.stops.length}站/${Math.round(plan.totals.totalSec / 60)}min/${(plan.totals.distanceM / 1000).toFixed(1)}km`;
    }).join('  |  ');
    const main = results[0];
    const mainPlan = buildRoutePlan(pack, intent, graph, main.solved, { version: 1, planId: 'plan_bench' });
    if (mainPlan.stops.length < worst) worst = mainPlan.stops.length;
    console.log(`${label}  ${line}`);
  }
}
console.log(`\n主推荐最少站数（2h 档预期 2-4，半天 4h 档预期 ≥5）`);

/* ================= 真实高德街景数据集 =================
 * 演示包点位 scenic 全 ≥0.6、边短停留短，relax 分支怎么改都是绿的——
 * 2026-09-30"半天 8-10 站"的修复就是这样漏掉了真实链路的（真实街点 scenic 0.4-0.5，
 * 城市 wander 默认 relax → relaxAdj -0.25 压死全部街点 + 填充阶段被跳过 → 半天 2 站）。
 * 这里按 amap.js mapType 的真实 dwell/scenic/tags 构造街区场景做回归。 */
const { solveOnce } = require('../server/planner');
const { mapType, EXCLUDE_NAME_RE } = require('../server/amap');

function makeCityPack() {
  // (名称, typecode, 经向偏移°) —— 经向 0.001° ≈ 111m。培训机构/学校故意混入，
  // 用于验证 searchAround 同款名称黑名单过滤（真实链路在检索层就滤掉它们）。
  const raw = [
    ['市立博物馆', '140100', 0.009],
    ['某考研培训学校', '141400', 0.012],
    ['某大学', '141201', -0.011],
    ['城市书房', '140500', -0.006],
    ['滨河公园', '110101', 0.005],
    ['老城步行街', '061000', -0.003],
    ['纸间书店', '061205', 0.002],
    ['转角咖啡馆', '050500', -0.002],
    ['文创礼品店', '061209', 0.007],
    ['人民公园东门', '110101', -0.009],
  ];
  const pois = raw
    .filter(([name]) => !EXCLUDE_NAME_RE.test(name)) // 与 amap.js searchAround 同款过滤
    .map(([name, typecode, dx], i) => {
      const m = mapType(typecode, name);
      return {
        id: 'am_diag' + i, name, entranceNode: 'am_diag' + i, tags: m.tags, indoor: false,
        scenic: m.scenic, dwellMinSec: 600, dwellSec: m.dwellSec, openWindows: null,
        ticketCny: null, ticketKnown: false, costNote: '', reservation: 'unknown', hoursEvidenceIds: [],
        typecode, _dx: dx,
      };
    });
  const nodeIds = ['am_origin', ...pois.map((p) => p.id)];
  const coord = (nid) => {
    if (nid === 'am_origin') return { lng: 104.06, lat: 30.65 };
    const p = pois.find((q) => q.id === nid);
    return { lng: 104.06 + p._dx, lat: 30.65 };
  };
  const edges = [];
  let eseq = 0;
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const a = coord(nodeIds[i]), b = coord(nodeIds[j]);
      edges.push({
        id: 'ce' + (++eseq), from: nodeIds[i], to: nodeIds[j],
        lengthM: Math.round(Math.hypot((a.lng - b.lng) * 95803, (a.lat - b.lat) * 110940)),
        walkAllowed: true, closed: false, stepsKnown: true, steps: 0,
      });
    }
  }
  const pack = {
    venue: { id: 'area_amap', name: '真实街景模拟（mapType 同构）', entrances: ['am_origin'], coverageScope: { scopeLabel: 'bench' }, packVersion: 'bench-city' },
    nodes: nodeIds.map((nid) => ({ id: nid, name: nid === 'am_origin' ? '起点' : pois.find((q) => q.id === nid).name, type: nid === 'am_origin' ? 'entrance' : 'poi', status: 'open', ...coord(nid) })),
    edges,
    pois,
    evidence: [],
    _poiById: new Map(), _nodeById: new Map(), _evById: new Map(),
  };
  pack._poiById = new Map(pack.pois.map((p) => [p.id, p]));
  pack._nodeById = new Map(pack.nodes.map((n) => [n.id, n]));
  return { pack, blocked: raw.filter(([name]) => EXCLUDE_NAME_RE.test(name)).map(([name]) => name) };
}

function makeCityIntent(objective, interests, budgetSec) {
  const startMs2 = (() => { const d = new Date(); d.setHours(14, 0, 0, 0); return d.getTime(); })();
  return {
    schemaVersion: '1.0', intentId: 'int_city', revision: 1, scene: 'city',
    objective, venueId: 'area_amap', venueRef: null,
    origin: { point: { lng: 104.06, lat: 30.65, crs: 'GCJ02' }, poiId: null, entranceId: 'am_origin', label: '起点' },
    endpoint: { mode: 'flexible' },
    startAt: new Date(startMs2).toISOString(), latestEndAt: new Date(startMs2 + budgetSec * 1000).toISOString(),
    startAtMs: startMs2, latestEndAtMs: startMs2 + budgetSec * 1000,
    budgetSec, dualConstraint: false, timezone: 'Asia/Shanghai', mobility: 'walk', pace: 'normal',
    interests: interests.map((t) => ({ tag: t, weight: 1 })),
    hard: { mustVisitIds: [], avoidPoiIds: [], maxDistanceM: null, maxCostCny: null, stepFreeRequired: false, noRepeatedEdges: false },
    soft: { freePreferred: false, repeatRoadPenalty: 1, restPreferred: false, quietPreferred: false, stepFewPreferred: false },
    guideStyle: 'normal', rawText: '', textEngine: 'rules', unresolved: [],
  };
}

console.log('\n===== 真实街景数据集（半天 4h，城市闲逛）=====');
const city = makeCityPack();
console.log(`候选 ${city.pack.pois.length} 个；黑名单拦截: ${city.blocked.join('、') || '（无）'}`);
let fail = 0;
const cases = [
  ['highlights', []],
  ['highlights', ['人文']],
  ['highlights', ['街区', '美食']],
  ['relax', []],
  ['relax', ['人文']],
];
for (const [objective, interests] of cases) {
  const intent = makeCityIntent(objective, interests, 14400);
  const graph2 = new VenueGraph(city.pack);
  const r = solveOnce(city.pack, intent, graph2, { interestW: 1.0, timeCostW: 0.55, dwellFactor: 1 });
  const label = `${objective.padEnd(11)} 兴趣[${interests.join(',')}]`;
  if (r.status !== 'ok') { console.log(`${label}  不可行: ${r.conflict && r.conflict.code}`); fail++; continue; }
  const plan = buildRoutePlan(city.pack, intent, graph2, r, { version: 1, planId: 'bench_city' });
  const names = plan.stops.map((s) => s.name);
  const hasSchool = names.some((n) => EXCLUDE_NAME_RE.test(n));
  const expectedMin = objective === 'relax' ? 4 : 5;
  const okStops = plan.stops.length >= expectedMin;
  console.log(`${label}  ${plan.stops.length}站/${Math.round(plan.totals.totalSec / 60)}min/${(plan.totals.distanceM / 1000).toFixed(1)}km  ${plan.stops.map((s) => s.name).join('→')}`);
  if (hasSchool) { console.log(`  ✗ 失败: 学校/培训机构进入了路线`); fail++; }
  else if (!okStops) { console.log(`  ✗ 失败: 站数不足（预期 ≥${expectedMin}）`); fail++; }
  else console.log(`  ✓ 黑名单未命中、站数达标（≥${expectedMin}）`);
}
console.log(fail ? `\n街景回归: ${fail} 项失败` : '\n街景回归: 全部通过');
