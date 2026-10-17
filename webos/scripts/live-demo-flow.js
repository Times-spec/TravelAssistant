'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tk = require('../server/timekit');
const { startServer } = require('./live-demo-server');
async function demoFlow(server) {
  let credential = null;
  const requests = [];
  const call = async (method, path, body) => {
    const response = await fetch(server.base + path, { method, headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    requests.push({ method, path, status: response.status });
    const json = await response.json(); assert(response.ok, `${method} ${path}: ${response.status} ${json.message}`); return json;
  };
  const waitJob = async (jobId) => {
    for (let i = 0; i < 120; i++) {
      const { job } = await call('GET', `/v1/jobs/${jobId}`);
      if (job.status === 'failed') throw new Error(JSON.stringify(job.error));
      if (job.status === 'completed') return job;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('演示任务超时');
  };
  const session = await call('POST', '/v1/sessions/guest'); credential = session.sessionToken;
  const date = tk.msToZoned(Date.now() + 86400000, 'Asia/Shanghai').dateStr;
  const normalized = await call('POST', '/v1/intents/normalize', { text: '', form: {
    scene: 'venue', venueId: 'venue_qinghu', objective: 'highlights', durationSec: 10800,
    origin: { lng: 104.062, lat: 30.659, crs: 'GCJ02', entranceId: 'gate_south', label: '南门' },
    startMode: 'later', startAtMs: tk.zonedTimeToMs(date, '09:00', 'Asia/Shanghai'),
    endpointMode: 'return_to_origin', mobility: 'walk', pace: 'normal', interests: [],
  } });
  const planning = await call('POST', '/v1/plans', { intentId: normalized.intentId, revision: normalized.revision });
  await waitJob(planning.jobId);
  const plan = await call('GET', `/v1/plans/${planning.planId}`);
  const route = plan.versions.find((v) => v.routeId === plan.plan.mainRouteId) || plan.versions[0];
  assert(route && route.stops.length >= 3, '演示路线至少三站');
  const started = await call('POST', '/v1/trips', { routeVersionId: route.routeId });
  const trip = started.trip;
  await call('POST', `/v1/trips/${trip.id}/events`, { type: 'arrive_confirm', data: { poiId: route.stops[0].poiId } });
  const command = await call('POST', '/v1/ai/command', { text: '我累了', tripId: trip.id });
  assert.equal(command.action, 'replan'); assert.equal(command.cause, 'fatigue_reported');
  const replan = await call('POST', `/v1/trips/${trip.id}/replans`, { baseRouteId: route.routeId, cause: command.cause, data: command.data });
  assert.equal(server.ctx.store.byId('jobs', replan.jobId).payload.currentNodeId, route.stops[0].entranceNodeId);
  const job = await waitJob(replan.jobId);
  assert(job.result && job.result.proposalRouteId, '疲劳重排产生真实提议');
  await call('POST', `/v1/trips/${trip.id}/replans/${job.result.proposalRouteId}/accept`, { baseVersionId: route.routeId });
  const finished = await call('POST', `/v1/trips/${trip.id}/finish`, {});
  assert(['finished', 'ended_early'].includes(finished.trip.status)); assert(finished.trip.finishedAt);
  return { planId: planning.planId, routeId: route.routeId, tripId: trip.id, stops: route.stops.length, endStatus: finished.trip.status, requests, credential };
}
async function main() {
  const server = await startServer();
  try {
    const result = await demoFlow(server);
    if (process.argv.includes('--record')) {
      fs.mkdirSync(path.join(__dirname, 'evidence'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, 'evidence/demo-flow-report.json'), JSON.stringify({ stops: result.stops, endStatus: result.endStatus, requestCount: result.requests.length, requests: result.requests }, null, 2) + '\n');
    }
    console.log(`PASS 演示场所完整流程：规划${result.stops}站 → 开始 → 到达 → 我累了 → 接受提议 → 结束；${result.requests.length}次HTTP请求均为2xx`);
  }
  finally { await server.close(); }
}
if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { demoFlow };
