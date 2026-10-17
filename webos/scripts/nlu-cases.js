'use strict';
// 确定性的 NLU 回归：node scripts/nlu-cases.js。模型 HTTP 使用本地桩，不需要 Key。
const assert = require('node:assert/strict');
const path = require('node:path');
const { ruleNLU, normalizeIntent, confirmChips } = require('../server/domain');
const { loadPacks } = require('../server/providers');
const { llmNLU } = require('../server/llm');
const { createHarness } = require('./live-test-support');
const packs = loadPacks(path.join(__dirname, '..'));
const cfg = { llm: { baseUrl: 'http://llm.test', apiKey: '', model: 'test' }, limits: { maxLlmTokens: 1000 } };
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}
function at(clock, fn) {
  const realNow = Date.now;
  Date.now = () => Date.parse(`2026-10-18T${clock}:00+08:00`);
  try { return fn(); } finally { Date.now = realNow; }
}
function intent(text, form = {}, parsed = null) {
  return normalizeIntent({ text, timezone: 'Asia/Shanghai', form: {
    scene: 'wander', origin: { lng: 104.062, lat: 30.659 }, ...form,
  } }, packs, parsed);
}
async function modelResult(result, fn) {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }] }) });
  try { return await fn(); } finally { global.fetch = realFetch; }
}
async function main() {
  for (const [text, start, end, duration] of [
    ['下午两点到五点逛逛', '14:00', '17:00', 10800],
    ['14:00-17:00', '14:00', '17:00', 10800],
    ['上午九点半至十一点', '09:30', '11:00', 5400],
    ['14：15～17：45', '14:15', '17:45', 12600],
    ['晚上十点到凌晨一点', '22:00', '01:00', 10800],
  ]) await check(`T1 规则 ${text}`, () => {
    const p = ruleNLU(text);
    assert.equal(p.startClock, start); assert.equal(p.latestEndClock, end); assert.equal(p.durationSec, duration);
  });
  await check('T1 两点以后有开始时刻', () => assert.equal(ruleNLU('下午两点以后出发').startClock, '14:00'));
  await check('T1 确认条同时显示出发与三小时', () => at('09:00', () => {
    const i = intent('下午两点到五点逛逛', { durationSec: 7200, durationTouched: false, startMode: 'now' });
    assert.equal(i.startAt, '2026-10-18T14:00:00+08:00'); assert.equal(i.budgetSec, 10800);
    const chips = confirmChips(i).map((c) => c.label);
    assert(chips.includes('10/18 14:00 出发')); assert(chips.some((c) => c.replace(/\s/g, '') === '3小时'));
  }));
  await check('T1 开始已过仍保留当日截止', () => at('15:00', () => {
    const i = intent('下午两点到五点逛逛');
    assert.equal(i.startAtMs, Date.now()); assert.equal(i.latestEndAt, '2026-10-18T17:00:00+08:00'); assert.equal(i.budgetSec, 7200);
  }));
  await check('T1 显式表单时间优先', () => at('09:00', () => {
    const i = intent('下午两点到五点逛逛', { startMode: 'later', startAtMs: Date.parse('2026-10-18T13:00:00+08:00'), durationSec: 3600 });
    assert.equal(i.startAt.slice(11, 16), '13:00'); assert.equal(i.budgetSec, 3600);
  }));
  await check('T1 显式选择现在出发优先', () => at('09:00', () => {
    assert.equal(intent('下午两点以后', { startMode: 'now', startTouched: true }).startAtMs, Date.now());
  }));
  await check('T1 已截止时间窗不静默顺延', () => at('18:00', () => assert.throws(() => intent('下午两点到五点'), /开始时间已晚于截止时间/)));
  await check('T1 HTTP 模型提取与合并', async () => {
    await modelResult({ startClock: '14:00', latestEndClock: '17:00', durationSec: 10800 }, async () => {
      const p = await llmNLU(cfg, '下午两点到五点逛逛'); assert.equal(p.startClock, '14:00');
      at('09:00', () => assert.equal(intent('下午两点到五点逛逛', {}, p).budgetSec, 10800));
    });
  });
  await check('T1 模型非法钟点被丢弃', () => modelResult({ startClock: '29:90', latestEndClock: '25:00' }, async () => {
    const p = await llmNLU(cfg, '逛逛'); assert.equal(p.startClock, null); assert.equal(p.latestEndClock, null);
  }));
  for (const text of ['从春熙路走到宽窄巷子', '逛到宽窄巷子', '最后到宽窄巷子', '去宽窄巷子结束']) {
    await check(`T2 规则 ${text}`, () => {
      const p = ruleNLU(text); assert.equal(p.endPlaceName, '宽窄巷子');
      if (text.startsWith('从')) { assert.equal(p.scene, 'wander'); assert.equal(p.venueName, null); }
    });
  }
  await check('T2 地理编码选15km内最近点并显示固定终点', async () => {
    const { api, ctx, req } = createHarness({ providers: { map: 'amap', llm: 'rules' } });
    const amap = require('../server/amap'); const original = amap.textSearch;
    let searchedCity;
    amap.textSearch = async (_cfg, name, city) => {
      assert.equal(name, '宽窄巷子'); searchedCity = city;
      return [{ name, coord: { lng: 104.8, lat: 30.9 } }, { name, coord: { lng: 104.06, lat: 30.66 } }];
    };
    try {
      const r = await api.normalizeIntentApi(req, {}, {}, { text: '从春熙路走到宽窄巷子', form: { origin: { lng: 104.065, lat: 30.66, city: '成都' } } });
      assert.equal(searchedCity, '成都'); assert.equal(r.intent.scene, 'wander');
      assert.equal(r.intent.endpoint.mode, 'fixed'); assert.equal(r.intent.endpoint.point.lng, 104.06);
      assert(r.chips.some((c) => c.label === '终点：宽窄巷子')); assert.equal(ctx.store.byId('intents', r.intentId).endpoint.mode, 'fixed');
    } finally { amap.textSearch = original; }
  });
  await check('T2 无近邻终点必须追问', async () => {
    const { api, req } = createHarness();
    const r = await api.normalizeIntentApi(req, {}, {}, { text: '走到宽窄巷子', form: { origin: { lng: 104.065, lat: 30.66 } } });
    assert(r.unresolved.some((u) => u.field === 'endpoint' && u.question.includes('宽窄巷子')));
  });
  await check('T2 表单显式终点优先', async () => {
    const { api, req } = createHarness();
    const r = await api.normalizeIntentApi(req, {}, {}, { text: '走到宽窄巷子', form: {
      origin: { lng: 104.065, lat: 30.66 }, endpointTouched: true, endpointMode: 'flexible',
    } });
    assert.equal(r.intent.endpoint.mode, 'flexible'); assert.equal(r.unresolved.length, 0);
  });
  await check('T2 HTTP 模型目的地字段被保留', () => modelResult({ scene: 'wander', venueName: null, endPlaceName: '宽窄巷子' }, async () => {
    const p = await llmNLU(cfg, '从春熙路走到宽窄巷子');
    assert.equal(p.scene, 'wander'); assert.equal(p.venueName, null); assert.equal(p.endPlaceName, '宽窄巷子');
  }));
  console.log(`NLU: ${passed} passed, 0 failed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
