async (page) => {
  const fixtures = await page.evaluate(async () => (await fetch('/__test/fixtures')).json());
  await page.evaluate((credential) => localStorage.setItem('st_session', credential), fixtures.credential);
  await page.goto(`http://127.0.0.1:8191/#/plan/${fixtures.conditionalPlanId}`);
}
