async (page) => {
  const fixture = await page.evaluate(async () => (await fetch('/__test/fixtures')).json());
  const errors = [], failures = [], measurements = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) failures.push({ url: r.url(), status: r.status() }); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().clearPermissions();
  const ready = async () => {
    await page.getByRole('button', { name: '开始游览', exact: true }).waitFor();
    await page.locator('.map-wrap svg').waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  for (const [label, base] of [['before', 'http://127.0.0.1:8192'], ['after', 'http://127.0.0.1:8191']]) {
    await page.goto(base);
    await page.evaluate((credential) => localStorage.setItem('st_session', credential), fixture.credential);
    await page.goto(`${base}/#/plan/${fixture.conditionalPlanId}`); await ready();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
    const space = await page.evaluate(() => ({ barHeight: document.querySelector('.bottom-bar').getBoundingClientRect().height,
      barTop: document.querySelector('.bottom-bar').getBoundingClientRect().top,
      contentBottom: document.querySelector('.timeline').getBoundingClientRect().bottom,
      paddingBottom: getComputedStyle(document.getElementById('view')).paddingBottom }));
    measurements.push({ label, ...space });
    if (label === 'after' && space.contentBottom > space.barTop) throw new Error('底部文字仍被操作条覆盖');
    await page.screenshot({ path: `scripts/evidence/${label}-plan-bottom.png` });
    await page.goto(`${base}/#/plan/${fixture.markerPlanId}`); await ready();
    await page.locator('.map-wrap').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 64));
    await page.waitForTimeout(150);
    const mapText = await page.locator('.map-wrap svg').textContent();
    if (label === 'after' && (!mapText.includes('2·3') || !mapText.includes('/终'))) throw new Error('合并编号未渲染');
    await page.screenshot({ path: `scripts/evidence/${label}-map-overlap.png` });
    // 在同一输入下放大终点附近，修复前的终点会被末站编号盖住。
    const lastText = label === 'after' ? await page.locator('.map-wrap svg text').filter({ hasText: /^(?:起\/)?7\/终$/ }).boundingBox()
      : await page.locator('.map-wrap svg text').filter({ hasText: /^7$/ }).boundingBox();
    if (lastText) {
      const mapBox = await page.locator('.map-wrap svg').boundingBox();
      const x = lastText.x + lastText.width / 2, y = lastText.y + lastText.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2, { steps: 8 });
      await page.mouse.up(); await page.mouse.wheel(0, -220);
    }
    await page.screenshot({ path: `scripts/evidence/${label}-last-endpoint.png` });
    await page.goto(`${base}/#/trip/${fixture.tripId}`);
    await page.getByRole('button', { name: '本段', exact: true }).waitFor();
    await page.locator('.guide-steps').waitFor();
    await page.getByRole('button', { name: '全程', exact: true }).click();
    await page.getByRole('button', { name: '本段', exact: true }).click();
    if (!await page.getByRole('button', { name: '我的位置', exact: true }).isVisible()) throw new Error('定位按钮缺失');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `scripts/evidence/${label}-trip.png` });
  }
  const report = { viewport: [390, 844], screenshots: 8, measurements, consoleErrors: errors, failedResponses: failures, mapToggle: 'passed', locationButton: 'visible' };
  await page.evaluate((r) => localStorage.setItem('st_browser_evidence', JSON.stringify(r)), report);
  if (errors.length || failures.length) throw new Error('浏览器出现错误或HTTP失败');
  return report;
}
