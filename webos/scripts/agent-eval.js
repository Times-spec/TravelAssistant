'use strict';
/**
 * 智能体路线质量评测（对真实运行中的服务跑场景集，输出可对比的指标）。
 *
 *   BASE_URL=http://47.99.241.85 node scripts/agent-eval.js            # 评测线上
 *   BASE_URL=http://localhost:8080 CASES=1,3,5 node scripts/agent-eval.js
 *   OUT=eval.json …                                                    # 另存明细
 *
 * 指标：站数、时长利用率、A→B 末段空走、商业类占比、核心景点覆盖（每个场景给出公认必看清单）、
 *       质量分（智能体内核自评）、推荐理由来源、规划耗时。部署前后各跑一次即可对比改进幅度。
 */
const BASE = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const OUT = process.env.OUT || '';
let TOKEN = '';

async function api(method, p, body) {
  const o = { method, headers: {} };
  if (TOKEN) o.headers.authorization = 'Bearer ' + TOKEN;
  if (body !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, o);
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return { raw: t.slice(0, 200), _status: r.status }; }
}
const P = (lng, lat, label) => ({ lng, lat, crs: 'GCJ02', label, source: 'search' });
const COMMERCIAL_RE = /(购物中心|百货|广场店|旗舰店|专卖店|超市|便利店|美食广场|美食城|XR|VR|体验馆|飞行影院|奥秘|沉浸式|网红|IFS|太古里|百盛|万达|银泰|大厦)/i;

const CASES = [
  { id: '1', name: '成都春熙路 闲逛 3h 回起点', form: { scene: 'wander', origin: P(104.0807, 30.6573, '春熙路'), endpointMode: 'return_to_origin' }, core: ['大慈寺', '东大街', '水井坊', '合江亭', '九眼桥'] },
  { id: '2', name: '春熙路→宽窄巷子 3h A→B', form: { scene: 'wander', origin: P(104.0807, 30.6573, '春熙路'), endpointMode: 'fixed', endpointPoint: { lng: 104.0556, lat: 30.6697, crs: 'GCJ02' }, endpointLabel: '宽窄巷子' }, core: ['大慈寺', '天府广场', '人民公园', '文殊院', '少城', '宽窄巷子', '四川博物院', '鹤鸣茶社'] },
  { id: '3', name: '杭州湖滨→断桥 2h A→B', form: { scene: 'wander', origin: P(120.163, 30.258, '湖滨'), durationSec: 7200, endpointMode: 'fixed', endpointPoint: { lng: 120.152, lat: 30.2595, crs: 'GCJ02' }, endpointLabel: '断桥残雪' }, core: ['白堤', '断桥', '北山街', '少年宫', '湖滨', '音乐喷泉', '保俶塔', '宝石山', '杭州西湖'] },
  { id: '4', name: '春熙路 2h 顺路结束 人文', form: { scene: 'wander', origin: P(104.0807, 30.6573, '春熙路'), endpointMode: 'flexible', durationSec: 7200, interests: [{ tag: '人文' }] }, core: ['大慈寺', '水井坊', '合江亭', '文殊院', '东大街'] },
  { id: '5', name: '故宫 午门→神武门 3h', form: { scene: 'venue', venueId: 'live:B000A8UIN8', venueRef: { id: 'live:B000A8UIN8', name: '故宫博物院', lng: 116.397029, lat: 39.917839, city: '北京市', district: '东城区' }, origin: P(116.397, 39.9155, '午门'), endpointMode: 'fixed', endpointPoint: { lng: 116.3971, lat: 39.9240, crs: 'GCJ02' }, endpointLabel: '神武门' }, core: ['太和殿', '中和殿', '保和殿', '乾清宫', '交泰殿', '坤宁宫', '御花园', '珍宝馆', '钟表馆', '养心殿'] },
  { id: '6', name: '春熙路 1h 想吃点东西', form: { scene: 'wander', origin: P(104.0807, 30.6573, '春熙路'), durationSec: 3600, endpointMode: 'return_to_origin', pace: 'easy' }, text: '想吃点东西，不想走太多路', core: ['龙抄手', '钟水饺', '赖汤圆', '韩包子', '小吃', '担担面', '串串', '火锅'] },
];

async function runCase(c) {
  const t0 = Date.now();
  const d = new Date(); d.setDate(d.getDate() + 1); d.setUTCHours(2, 0, 0, 0); // 明天北京时间 10:00，避开闭园/夜间
  const form = { objective: 'highlights', timeMode: 'duration', durationSec: 10800, startMode: 'later', startAtMs: d.getTime(), mobility: 'walk', pace: 'normal', interests: [], mustVisitIds: [], avoidPoiIds: [], ...c.form };
  const ni = await api('POST', '/v1/intents/normalize', { form, text: c.text || '', timezone: 'Asia/Shanghai' });
  if (!ni.intentId) return { ...c, err: 'normalize: ' + JSON.stringify(ni).slice(0, 160) };
  const pl = await api('POST', '/v1/plans', { intentId: ni.intentId, revision: ni.revision, idempotencyKey: 'eval' + Math.random() });
  if (!pl.planId) return { ...c, err: 'plans: ' + JSON.stringify(pl).slice(0, 160) };
  let job = null;
  for (let i = 0; i < 100; i++) {
    job = await api('GET', '/v1/jobs/' + pl.jobId);
    if (['completed', 'failed', 'cancelled'].includes(job.job && job.job.status)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const p = await api('GET', '/v1/plans/' + pl.planId);
  const versions = (p.versions || []).filter((v) => !v.isProposal);
  const main = versions[0];
  const sec = Math.round((Date.now() - t0) / 1000);
  if (!main) return { ...c, sec, err: 'no route: ' + JSON.stringify((p.plan && p.plan.conflict) || job.job.error || {}).slice(0, 160) };
  const names = main.stops.map((s) => s.name);
  const coreHit = c.core.filter((k) => names.some((n) => n.includes(k)));
  const k = (p.plan && p.plan.agentKernel) || null;
  const ex = ((p.plan && p.plan.agentTrace) || []).find((t) => t.stage === 'agent.explained');
  return {
    id: c.id, name: c.name, sec, stops: names, n: names.length,
    util: Math.round((main.totals.totalSec / form.durationSec) * 100),
    km: Math.round(main.totals.distanceM / 100) / 10,
    endWalkM: form.endpointMode === 'fixed' && main.endApproach ? main.endApproach.distanceM : null,
    commercial: Math.round((names.filter((n) => COMMERCIAL_RE.test(n)).length / Math.max(1, names.length)) * 100),
    core: `${coreHit.length}/${Math.min(c.core.length, Math.max(names.length, 1))}`, coreHit,
    quality: k && k.quality ? `${Math.round(k.quality.before * 100)}→${Math.round(k.quality.after * 100)}` : '-',
    nominated: k ? (k.nominated || []).length : null,
    rationaleBy: ex ? ex.source : '-', rationale: (main.agentRationale || '').slice(0, 140), title: main.title,
    alts: versions.length - 1,
  };
}

(async () => {
  const s = await api('POST', '/v1/sessions/guest');
  TOKEN = s.sessionToken;
  if (!TOKEN) { console.error('无法创建访客会话：', JSON.stringify(s).slice(0, 200)); process.exit(1); }
  const pick = (process.env.CASES || CASES.map((c) => c.id).join(',')).split(',');
  const rows = [];
  for (const c of CASES.filter((x) => pick.includes(x.id))) {
    const r = await runCase(c).catch((e) => ({ id: c.id, name: c.name, err: e.message }));
    rows.push(r);
    if (r.err) { console.log(`\n## ${c.id} ${c.name}  ❌ ${r.err}`); continue; }
    console.log(`\n## ${r.id} ${r.name}  (${r.sec}s)  ${r.title}`);
    console.log(`   ${r.n}站 ${r.km}km 时长利用${r.util}%${r.endWalkM != null ? ` 末段${r.endWalkM}m` : ''} 商业${r.commercial}% 核心${r.core}[${r.coreHit.join('、')}] Q ${r.quality} 提名${r.nominated ?? '-'} 备选${r.alts}`);
    console.log(`   ${r.stops.join(' → ')}`);
    console.log(`   理由(${r.rationaleBy})：${r.rationale}`);
  }
  const ok = rows.filter((r) => !r.err);
  const avg = (f) => (ok.length ? Math.round(ok.reduce((a, r) => a + f(r), 0) / ok.length) : 0);
  const ab = ok.filter((r) => r.endWalkM != null);
  console.log(`\n== 汇总 ${ok.length}/${rows.length} 成功 | 平均耗时 ${avg((r) => r.sec)}s | 平均时长利用 ${avg((r) => r.util)}% | 平均商业占比 ${avg((r) => r.commercial)}% | A→B 平均末段 ${ab.length ? Math.round(ab.reduce((a, r) => a + r.endWalkM, 0) / ab.length) : '-'}m | 核心命中 ${ok.reduce((a, r) => a + r.coreHit.length, 0)} 个`);
  if (OUT) require('fs').writeFileSync(OUT, JSON.stringify(rows, null, 1));
  process.exit(0);
})();
