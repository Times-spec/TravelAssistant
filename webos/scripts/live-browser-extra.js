async (page) => {
  const fixture = await page.evaluate(async () => (await fetch('/__test/fixtures')).json());
  await page.goto('about:blank');
  await page.unroute(`**/v1/trips/${fixture.tripId}`); await page.unroute('**/v1/legs/steps?**');
  await page.unroute('**/v1/plans/pln_ui_queue'); await page.unroute('**/v1/jobs/job_ui_queue/events**');
  const response = await page.request.get(`http://127.0.0.1:8191/v1/trips/${fixture.tripId}`, { headers: { authorization: `Bearer ${fixture.credential}` } });
  const initial = await response.json();
  const errors = [], failures = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) failures.push(r.status()); });
  const leg = initial.route.legs[0];
  const tripUrl = `**/v1/trips/${fixture.tripId}`;
  await page.route(tripUrl, (route) => route.fulfill({ json: { ...initial, route: { ...initial.route, legs: [{ ...leg, provider: 'amap-walking', steps: null }, ...initial.route.legs.slice(1)] } } }));
  let requests = 0;
  await page.route('**/v1/legs/steps?**', (route) => { requests++; return route.fulfill({ json: {
    steps: [{ instruction: '沿回归测试步道前行', road: '回归测试步道', distanceM: leg.distanceM, startIdx: 0 }],
    geometry: leg.geometry.coordinates, distanceM: leg.distanceM, available: true,
  } }); });
  await page.goto(`http://127.0.0.1:8191/#/trip/${fixture.tripId}`);
  await page.locator('.gs-src').filter({ hasText: '高德步行指引' }).waitFor();
  await page.getByRole('button', { name: '全程', exact: true }).click();
  await page.getByRole('button', { name: '本段', exact: true }).click();
  if (requests !== 1) throw new Error('缺失steps的路段重复请求');
  await page.unroute('**/v1/legs/steps?**');
  let fallbackRequests = 0;
  await page.route('**/v1/legs/steps?**', (route) => { fallbackRequests++; return route.fulfill({ json: { steps: [], available: false } }); });
  await page.reload();
  await page.locator('.gs-src').filter({ hasText: '按路线走向生成' }).waitFor();
  await page.getByRole('button', { name: '全程', exact: true }).click();
  await page.getByRole('button', { name: '本段', exact: true }).click();
  if (fallbackRequests !== 1) throw new Error('失败的steps请求被重复重试');
  await page.context().grantPermissions(['geolocation'], { origin: 'http://127.0.0.1:8191' });
  await page.context().setGeolocation({ latitude: 30.659, longitude: 104.062, accuracy: 20 });
  await page.getByRole('button', { name: '我的位置', exact: true }).click();
  await page.waitForTimeout(200);
  await page.unroute(tripUrl); await page.unroute('**/v1/legs/steps?**');
  const queuePlan = { plan: { id: 'pln_ui_queue', status: 'queued', currentJobId: 'job_ui_queue', planningMode: 'agent' }, versions: [], guides: [] };
  await page.route('**/v1/plans/pln_ui_queue', (route) => route.fulfill({ json: queuePlan }));
  let sse = 0, polls = 0;
  await page.route('**/v1/jobs/job_ui_queue/events**', (route) => {
    const payload = { queuePosition: 2, phase: 'queued', phaseLabel: '等待派发', activePhaseLabel: '正在检索候选', jobStatus: 'queued' };
    if ((route.request().headers().accept || '').includes('text/event-stream')) {
      sse++; return route.fulfill({ contentType: 'text/event-stream', body: `event: job.progress\ndata: ${JSON.stringify({ type: 'job.progress', jobId: 'job_ui_queue', payload })}\n\n` });
    }
    polls++; return route.fulfill({ json: { ...payload, events: [], lastSeq: 0 } });
  });
  await page.goto('http://127.0.0.1:8191/#/plan/pln_ui_queue');
  await page.waitForFunction(() => document.body.textContent.includes('前面还有 2 个任务 · 正在检索候选'));
  await page.getByRole('button', { name: '收起 ▴', exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes('前面还有 2 个任务 · 正在检索候选'));
  await page.getByRole('button', { name: '展开 ▾', exact: true }).click();
  await page.locator('.job-progress').filter({ hasText: '前面还有 2 个任务' }).waitFor();
  await page.waitForTimeout(2800);
  if (!sse || !polls) throw new Error('SSE或轮询分支没有被验证');
  if (errors.length || failures.length) throw new Error(JSON.stringify({ errors, failures }));
  const report = { navigationSteps: 'passed', stepsRequests: requests, fallback: 'geometry', failedStepsRequests: fallbackRequests, locationClick: 'passed', queueText: '前面还有 2 个任务 · 正在检索候选', expandedAndCollapsed: true, sse: sse > 0, polling: polls > 0, consoleErrors: errors, failedResponses: failures };
  await page.goto(`http://127.0.0.1:8191/#/trip/${fixture.tripId}`);
  return report;
}
