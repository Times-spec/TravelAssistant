'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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
  await check('T6 导航步骤50m网格缓存且有方向和过期', async () => {
    const { api, req, ctx } = createHarness({ providers: { map: 'amap', llm: 'rules' } });
    const amap = require('../server/amap'); const realRoute = amap.walkingRoute; const realNow = Date.now;
    let now = 1000000, calls = 0; Date.now = () => now;
    amap.walkingRoute = async () => { calls++; return { steps: [{ instruction: '沿测试步道走', distanceM: 80 }], distanceM: 80, durationSec: 60, geometry: [[104.06, 30.66], [104.061, 30.661]], provider: 'amap-walking' }; };
    try {
      assert(api.match('GET', '/v1/legs/steps'));
      const a = await api.legSteps(req, {}, { from: '104.060001,30.660001', to: '104.061001,30.661001' });
      const b = await api.legSteps(req, {}, { from: '104.060002,30.660002', to: '104.061002,30.661002' });
      assert.equal(a.steps.length, 1); assert.equal(b.cached, true); assert.equal(calls, 1);
      await api.legSteps(req, {}, { from: '104.061001,30.661001', to: '104.060001,30.660001' }); assert.equal(calls, 2);
      now += 1800001;
      await api.legSteps(req, {}, { from: '104.060001,30.660001', to: '104.061001,30.661001' }); assert.equal(calls, 3);
      assert.equal(ctx.cfg.limits.maxLlmTokens, 1000);
    } finally { amap.walkingRoute = realRoute; Date.now = realNow; }
  });
  await check('T6 步骤失败返回空列表并限制频繁调用', async () => {
    const { api, req } = createHarness({ providers: { map: 'amap', llm: 'rules' } });
    const amap = require('../server/amap'); const realRoute = amap.walkingRoute;
    amap.walkingRoute = async () => { throw new Error('provider unavailable'); };
    try {
      const r = await api.legSteps(req, {}, { from: '104.06,30.66', to: '104.061,30.661' }); assert.deepEqual(r.steps, []);
      for (let i = 0; i < 59; i++) await api.legSteps(req, {}, { from: '104.06,30.66', to: '104.061,30.661' });
      await assert.rejects(() => api.legSteps(req, {}, { from: '104.06,30.66', to: '104.061,30.661' }), (e) => e.status === 429);
    } finally { amap.walkingRoute = realRoute; }
  });
  await check('T8 同用户并发提交只产生一个规划任务', async () => {
    const { api, req, ctx } = createHarness();
    ctx.store.insert('intents', { id: 'intent', intentId: 'intent', ownerId: req.user.id, revision: 1 });
    const results = await Promise.all([api.createPlan(req, {}, {}, { intentId: 'intent', revision: 1 }), api.createPlan(req, {}, {}, { intentId: 'intent', revision: 1 })]);
    assert.equal(results[0].jobId, results[1].jobId); assert.equal(ctx.store.find('jobs', () => true).length, 1);
    assert.equal(results[1].reused, true);
  });
  await check('T8 SSE和轮询提供相同的排队位置和阶段', async () => {
    const { api, req, ctx } = createHarness();
    ctx.store.insert('jobs', { id: 'first', ownerId: 'another-user', type: 'plan.generate', status: 'running', createdAt: '2026-10-18T09:00:00Z' });
    ctx.store.insert('jobs', { id: 'second', ownerId: req.user.id, type: 'plan.generate', status: 'queued', createdAt: '2026-10-18T09:01:00Z' });
    const poll = await api.jobEvents(req, { id: 'second' }, { poll: 1 }, {});
    assert.equal(poll.queuePosition, 1); assert.equal(poll.phase, 'queued'); assert.equal(poll.activePhaseLabel, '正在检索候选');
    const snapshot = await api.getJob(req, { id: 'second' }); assert.equal(snapshot.job.queuePosition, 1);
    const streamReq = Object.assign(new EventEmitter(), req, { headers: { accept: 'text/event-stream' } });
    const chunks = []; const res = { writeHead() {}, write: (chunk) => chunks.push(chunk) };
    await api.jobEvents(streamReq, { id: 'second' }, {}, {}, res); streamReq.emit('close');
    const stream = chunks.join(''); assert(stream.includes('event: job.progress')); assert(stream.includes('"queuePosition":1'));
  });
  console.log(`API: ${passed} passed, 0 failed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
