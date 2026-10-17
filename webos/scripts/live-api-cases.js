'use strict';
const assert = require('node:assert/strict');
const { createHarness } = require('./live-test-support');
let passed = 0;
async function check(name, fn) { await fn(); console.log(`PASS ${name}`); passed++; }
function tripHarness() {
  const h = createHarness();
  h.ctx.store.insert('route_versions', { id: 'route', routeId: 'route', planId: 'plan', startNodeId: 'origin', stops: [
    { poiId: 'poi-1', name: '第一站', entranceNodeId: 'node-1' }, { poiId: 'poi-2', name: '第二站', entranceNodeId: 'node-2' },
  ] });
  h.ctx.store.insert('trips', { id: 'trip', ownerId: h.req.user.id, planId: 'plan', activeRouteVersionId: 'route', status: 'active' });
  return h;
}
async function main() {
  await check('T5 无定位从最后到达站入口重排', async () => {
    const { api, ctx, req } = tripHarness();
    ctx.store.insert('trip_events', { tripId: 'trip', type: 'arrive_confirm', data: { poiId: 'poi-1' }, occurredAt: '2026-10-18T09:00:00+08:00' });
    ctx.store.insert('trip_events', { tripId: 'trip', type: 'arrive_confirm', data: { poiId: 'poi-2' }, occurredAt: '2026-10-18T10:00:00+08:00' });
    const r = await api.replanTrip(req, { id: 'trip' }, {}, { cause: 'fatigue_reported' });
    assert.equal(ctx.store.byId('jobs', r.jobId).payload.currentNodeId, 'node-2');
  });
  await check('T5 尚无到访记录才从起点重排', async () => {
    const { api, ctx, req } = tripHarness();
    const r = await api.replanTrip(req, { id: 'trip' }, {}, { cause: 'fatigue_reported' });
    assert.equal(ctx.store.byId('jobs', r.jobId).payload.currentNodeId, 'origin');
  });
  await check('T5 显式当前位置优先', async () => {
    const { api, ctx, req } = tripHarness();
    ctx.store.insert('trip_events', { tripId: 'trip', type: 'arrive_confirm', data: { poiId: 'poi-1' } });
    const r = await api.replanTrip(req, { id: 'trip' }, {}, { cause: 'fatigue_reported', currentNodeId: 'manual-position' });
    assert.equal(ctx.store.byId('jobs', r.jobId).payload.currentNodeId, 'manual-position');
  });
  await check('T5 历史路线和弱网旧到达事件不会重置位置', async () => {
    const { api, ctx, req } = tripHarness();
    ctx.store.insert('route_versions', { id: 'proposal', routeId: 'proposal', planId: 'plan', startNodeId: 'node-2', stops: [] });
    ctx.store.update('trips', 'trip', { activeRouteVersionId: 'proposal' });
    ctx.store.insert('trip_events', { tripId: 'trip', type: 'arrive_confirm', data: { poiId: 'poi-2' }, occurredAt: '2026-10-18T10:00:00+08:00' });
    ctx.store.insert('trip_events', { tripId: 'trip', type: 'arrive_confirm', data: { poiId: 'poi-1' }, occurredAt: '2026-10-18T09:00:00+08:00' });
    const r = await api.replanTrip(req, { id: 'trip' }, {}, { cause: 'finish_requested' });
    assert.equal(ctx.store.byId('jobs', r.jobId).payload.currentNodeId, 'node-2');
  });
  console.log(`API: ${passed} passed, 0 failed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
