'use strict';
/** 线上实测问题（2026-10-18）回归：走廊选点、终点重复点、疲劳丢点、差异文案、顺路结束、末段文案 */
const assert = require('assert');
const { corridorT, pickCorridor, END_DUP_M, COMMERCIAL_EXPERIENCE_RE, EXCLUDE_NAME_RE } = require('../server/amap');
const { pickFatigueDrops } = require('../server/jobs');
const { diffRoutes } = require('../server/planner');
const { normalizeIntent, confirmChips } = require('../server/domain');
const { haversineM } = require('../server/geo');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓', name); };

const o = { lng: 104.080, lat: 30.655 }, e = { lng: 104.055, lat: 30.666 }; // 春熙路 → 宽窄巷子约 2.7km
const mk = (id, t, scenic = 0.7, tag = '人文') => {
  const c = { id, lng: o.lng + (e.lng - o.lng) * t, lat: o.lat + (e.lat - o.lat) * t, scenic, tags: [tag] };
  c.corridorT = corridorT(o, e, c); c.detourM = 0; return c;
};
ok('corridorT 端点为 0/1', () => {
  assert(Math.abs(corridorT(o, e, o)) < 1e-9); assert(Math.abs(corridorT(o, e, e) - 1) < 1e-9);
});
ok('起点密集时终点段仍保底 ≥30% 候选', () => {
  const list = [];
  for (let i = 0; i < 30; i++) list.push(mk('o' + i, 0.05 + i * 0.002, 0.8, ['人文', '街区', '美食', '建筑'][i % 4]));
  for (let i = 0; i < 4; i++) list.push(mk('e' + i, 0.85 + i * 0.03, 0.5, ['人文', '街区'][i % 2]));
  const picked = pickCorridor(list, 12, true);
  assert.strictEqual(picked.length, 12);
  const endSeg = picked.filter((c) => c.corridorT >= 2 / 3).length;
  assert(endSeg >= 4, 'endSeg=' + endSeg);
});
ok('END_DUP_M 合理', () => assert(END_DUP_M >= 30 && END_DUP_M <= 100));
ok('排除学校、商业体验馆降权', () => {
  assert(EXCLUDE_NAME_RE.test('北京市东城区灯市口小学'));
  assert(!EXCLUDE_NAME_RE.test('人民公园'));
  assert(COMMERCIAL_EXPERIENCE_RE.test('8D飞览历险展')); assert(!COMMERCIAL_EXPERIENCE_RE.test('宽窄巷子'));
});
ok('疲劳丢点：丢最绕的而不是最后一站', () => {
  const pts = { s: [0, 0], a: [0, 500], b: [600, 300], c: [0, 1000], end: [0, 1100] };
  const graph = { route: (x, y) => { const p = pts[x], q = pts[y]; return { distanceM: Math.hypot(p[0] - q[0], p[1] - q[1]) }; } };
  const rem = [{ poiId: 'A', entranceNodeId: 'a' }, { poiId: 'B', entranceNodeId: 'b' }, { poiId: 'C', entranceNodeId: 'c' }];
  assert.deepStrictEqual(pickFatigueDrops(graph, 's', rem, 'end', 1), ['B']);
  rem[1].locked = true;
  assert.notDeepStrictEqual(pickFatigueDrops(graph, 's', rem, 'end', 1), ['B']);
});
ok('差异文案不把已到访站写成"跳过"', () => {
  const base = { stops: [{ poiId: 'A', name: '甲' }, { poiId: 'B', name: '乙' }, { poiId: 'C', name: '丙' }], totals: { distanceM: 2000 }, endArrivalAt: '2026-10-18T15:00:00+08:00' };
  const prop = { stops: [{ poiId: 'C', name: '丙' }], totals: { distanceM: 900 }, endArrivalAt: '2026-10-18T14:40:00+08:00' };
  const lines = diffRoutes(base, prop, { doneIds: ['A'] });
  assert(lines.some((l) => l.includes('跳过乙')) && !lines.some((l) => l.includes('甲')), lines.join('|'));
});
ok('自定义兴趣关键词进需求、不被标签白名单丢弃', () => {
  const it = normalizeIntent({
    text: '', timezone: 'Asia/Shanghai',
    form: { scene: 'wander', origin: { lng: 104.062, lat: 30.659 }, interests: [] },
    profile: { interests: ['自然', '咖啡'] },
  }, [], null);
  assert(it.interests.some((x) => x.tag === '咖啡'), JSON.stringify(it.interests));
  assert(confirmChips(it).some((c) => c.field === 'interests' && c.label.includes('咖啡')), JSON.stringify(confirmChips(it)));
});
void haversineM;
console.log(`live-fixes: ${n} passed`);
