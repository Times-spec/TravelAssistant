'use strict';
// 仅在127.0.0.1启动截图夹具。重叠/终点合并用的是展示夹具，不是规划结果。
const assert = require('node:assert/strict');
const tk = require('../server/timekit');
const { startServer } = require('./live-demo-server');
const { demoFlow } = require('./live-demo-flow');
async function main() {
  const current = await startServer({ port: Number(process.env.PORT || 8191) });
  const flow = await demoFlow(current);
  const { store } = current.ctx;
  const route = store.byId('route_versions', flow.routeId);
  const ownerId = store.byId('plans', flow.planId).ownerId;
  const req = { user: { id: ownerId }, headers: {} };
  const fresh = await current.api.startTrip(req, {}, {}, { routeVersionId: route.routeId });
  const date = tk.msToZoned(Date.now() + 86400000, 'Asia/Shanghai').dateStr;
  const ni = await current.api.normalizeIntentApi(req, {}, {}, { form: {
    scene: 'venue', venueId: 'venue_qinghu', origin: { lng: 104.062, lat: 30.659, entranceId: 'gate_south', label: '南门' },
    startMode: 'later', startAtMs: tk.zonedTimeToMs(date, '09:00', 'Asia/Shanghai'), durationSec: 10800,
    budgetHardZero: true, mustVisitIds: ['poi_teahouse'], endpointMode: 'return_to_origin',
  } });
  const cp = await current.api.createPlan(req, {}, {}, { intentId: ni.intentId, revision: ni.revision });
  while (['queued', 'running'].includes(store.byId('jobs', cp.jobId).status)) await new Promise((resolve) => setTimeout(resolve, 100));
  const conditional = store.find('route_versions', (r) => r.planId === cp.planId)[0];
  assert.equal(conditional.status, 'conditional');
  // 只对截图用的路线副本制造同坐标输入，检验真实渲染函数对近邻/终点覆盖的处理。
  const basePlan = store.byId('plans', flow.planId);
  const fixture = structuredClone(route);
  fixture.id = fixture.routeId = 'rt_ui_markers'; fixture.planId = 'pln_ui_markers';
  fixture.title = '演示 · 地图标记重叠回归夹具';
  fixture.stops[2].coord = [...fixture.stops[1].coord];
  fixture.stops.at(-1).coord = [...fixture.legs.at(-1).geometry.coordinates.at(-1)];
  store.insert('route_versions', fixture);
  store.insert('plans', { ...structuredClone(basePlan), id: fixture.planId, mainRouteId: fixture.id, routeIds: [fixture.id], altRouteIds: [], currentJobId: null, title: fixture.title });
  current.ctx.testFixtures = { credential: flow.credential, conditionalPlanId: cp.planId, markerPlanId: fixture.planId, tripId: fresh.trip.id, flowRequests: flow.requests.length };
  const baseline = await startServer({ port: 8192, assetRef: 'd3c8dfe', harness: { api: current.api, ctx: current.ctx } });
  console.log(`Browser fixtures ready: ${current.base} (after), ${baseline.base} (before d3c8dfe)`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
