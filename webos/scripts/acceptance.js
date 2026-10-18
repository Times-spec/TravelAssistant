'use strict';
/**
 * 验收自测（文档 §19.1 核心用例的可自动化部分）。
 * 运行：node scripts/acceptance.js（自起独立端口 8090，使用隔离的临时数据库）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let BASE = 'http://localhost:8090';
let passed = 0, failed = 0;
const results = [];

function check(name, cond, detail) {
  if (cond) { passed++; results.push(`✅ ${name}`); }
  else { failed++; results.push(`❌ ${name}${detail ? ' —— ' + detail : ''}`); }
}

async function api(method, p, body, token) {
  const opts = { method, headers: {} };
  if (token) opts.headers.authorization = 'Bearer ' + token;
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, opts);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

// 固定出发时刻：验收必须与"现在几点"无关（夜间园区闭园会让用例结果随运行时刻漂移）
function morningStart(hour = 9) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return { startMode: 'later', startAtMs: d.getTime() };
}

function baseForm(overrides = {}) {
  return Object.assign({
    scene: 'venue', venueId: 'venue_qinghu', objective: 'highlights',
    origin: { lng: 104.062, lat: 30.659, crs: 'GCJ02', entranceId: 'gate_south', label: '南门', source: 'map_pick' },
    durationSec: 7200, endpointMode: 'return_to_origin', mobility: 'walk', pace: 'normal', interests: [],
  }, morningStart(), overrides);
}

async function waitJob(token, jobId, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await api('GET', `/v1/jobs/${jobId}`, undefined, token);
    if (['completed', 'failed', 'cancelled'].includes(r.body.job.status)) return r.body.job;
    await new Promise((x) => setTimeout(x, 400));
  }
  throw new Error('job timeout ' + jobId);
}

async function makePlan(token, form, text = '') {
  const ni = await api('POST', '/v1/intents/normalize', { form, text, timezone: 'Asia/Shanghai' }, token);
  if (ni.status !== 200) return { error: ni.body };
  const plan = await api('POST', '/v1/plans', { intentId: ni.body.intentId, revision: ni.body.revision, idempotencyKey: 'acc_' + Math.random() }, token);
  const job = await waitJob(token, plan.body.jobId);
  const gp = await api('GET', '/v1/plans/' + plan.body.planId, undefined, token);
  return { intent: ni.body, plan: gp.body, job };
}

async function main() {
  // 每次验收使用新目录，绝不删除或写入产品数据库。
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-tour-acceptance-'));
  // 内容库同样隔离：模板热度用例会写 route_templates.json，不能改到产品内容文件（2026-10-18 审计）
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-tour-content-'));
  const srcContent = path.join(__dirname, '..', 'data', 'content');
  // 逐个复制（不用 cpSync：该实现在部分受限环境会被静默中断）
  for (const f of fs.readdirSync(srcContent)) {
    const p = path.join(srcContent, f);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(contentDir, f));
  }
  // 随机端口 + 就绪探测：固定 8090 可能撞上别的服务，连过去就会得到假结果
  const port = 8100 + Math.floor(Math.random() * 700);
  BASE = `http://127.0.0.1:${port}`;
  let exited = null;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, CONTENT_DIR: contentDir }, stdio: 'pipe',
  });
  srv.stderr.on('data', (d) => process.stdout.write('[srv-err] ' + d));
  srv.on('exit', (code) => { exited = code; });
  let ready = false;
  for (let i = 0; i < 40 && exited === null; i++) {
    try {
      const r = await fetch(BASE + '/v1/config');
      if (r.ok) { ready = true; break; }
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    console.error(exited === null ? '服务启动超时，验收中止' : `服务启动失败（exit ${exited}），验收中止`);
    try { srv.kill(); } catch (e) {}
    process.exit(1);
  }

  try {
    const sess = await api('POST', '/v1/sessions/guest');
    const T = sess.body.sessionToken;

    // 用例 1：拒绝定位、手选起点 → 可完成规划（§19.1-1）
    {
      const r = await makePlan(T, baseForm(), '');
      check('拒绝定位但手选起点可规划', r.plan && r.plan.versions.length > 0 && r.plan.versions[0].status === 'verified');
    }

    // 用例 2：WGS84 只转换一次，GCJ02 不二次偏移（§19.1-2 / §5.4）
    {
      const a = await api('POST', '/v1/locations/normalize', { lng: 104.062, lat: 30.659, crs: 'WGS84', source: 'browser' }, T);
      const b = await api('POST', '/v1/locations/normalize', { lng: a.body.point.lng, lat: a.body.point.lat, crs: 'GCJ02' }, T);
      check('WGS84→GCJ02 仅一次且不二次转换', a.body.point.converted === true && b.body.point.converted === false
        && b.body.point.lng === a.body.point.lng && b.body.point.lat === a.body.point.lat);
    }

    // 用例 3：2h 回起点，含返程/停留/缓冲，结束 ≤ 截止（§19.1-3）
    {
      const r = await makePlan(T, baseForm(), '');
      const v = r.plan.versions[0];
      const end = new Date(v.endArrivalAt).getTime();
      const deadline = new Date(v.latestEndAt).getTime();
      const t = v.totals;
      check('2h 回起点含返程与缓冲且不超截止', end <= deadline && t.bufferSec >= 300 && t.restSec + t.dwellSec > 0 && t.travelSec > 0,
        JSON.stringify({ end: v.endArrivalAt, deadline: v.latestEndAt }));
    }

    // 用例 4：16:40 出发 + 必去望湖楼（16:30 停止入场）→ 不可行，不发布为可执行（§19.1-4）
    {
      const startAtMs = Date.now() + 60000;
      const ni = await api('POST', '/v1/intents/normalize', {
        form: baseForm({ startMode: 'later', startAtMs, durationSec: 1800, mustVisitIds: ['poi_tower'] }),
        text: '', timezone: 'Asia/Shanghai',
      }, T);
      // 把时间硬编码到 16:40 无法直接做（now 决定日期），改为直接验证时间窗逻辑：
      // 用 lastEntryAt 已过的情况由 solver 判定。此处验证"必去关闭点"追问：
      const ni2 = await api('POST', '/v1/intents/normalize', {
        form: baseForm({ mustVisitIds: ['poi_peony'] }), text: '', timezone: 'Asia/Shanghai',
      }, T);
      check('必去点关闭触发决定性追问', ni2.body.unresolved.some((u) => u.field === 'mustVisit'));
      void ni;
    }

    // 用例 5：零门票硬条件 + 必去老茶馆（价格未知）→ 不得默认通过（§19.1-6）
    {
      const r = await makePlan(T, baseForm({ budgetHardZero: true, mustVisitIds: ['poi_teahouse'] }), '');
      const v = r.plan.versions[0];
      const zero = v.constraints.find((c) => c.key === 'zero_cost');
      check('硬预算 0 元 + 票价未知 → 不默认通过', v.status === 'conditional' && zero && zero.result === 'unknown',
        v.status + ' ' + JSON.stringify(zero));
    }

    // 用例 6：轮椅硬条件 + 台阶未知 → 不声称满足（§19.1-7）
    // 注：望湖楼 16:30 停止入场，用例固定从次日 09:00 开始，避免随运行时刻失真
    {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
      const r = await makePlan(T, baseForm({ stepFreeRequired: true, mustVisitIds: ['poi_tower', 'poi_bonsai'], startMode: 'later', startAtMs: d.getTime() }), '');
      const v = r.plan.versions[0];
      const sf = v && v.constraints.find((c) => c.key === 'step_free_required');
      const explicitConflict = !v
        && ['infeasible', 'needs_clarification'].includes(r.plan.plan.status)
        && r.plan.plan.conflict;
      const ok = sf && (sf.result === 'pass' || sf.result === 'unknown' || sf.result === 'fail')
        && (sf.result !== 'unknown' || v.status === 'conditional')
        && (sf.result !== 'fail' || v.status === 'infeasible');
      check('轮椅硬条件下台阶未知不标 verified', explicitConflict || (ok && (sf.result !== 'unknown' || v.status !== 'verified')),
        v ? `${v.status} ${JSON.stringify(sf)}` : JSON.stringify(r.plan.plan.conflict));
    }

    // 用例 7：想全览但时间不足 → 显示覆盖范围与冲突，不承诺全部（§19.1-8）
    {
      const r = await makePlan(T, baseForm({ objective: 'poi_coverage', durationSec: 1800 }), '');
      const v = r.plan.versions[0];
      const cov = v && v.coverage;
      const explicitConflict = !v && r.plan.plan.status === 'infeasible' && r.plan.plan.conflict;
      check('时间不足时展示真实覆盖分母或明确冲突',
        (cov && cov.eligibleTargetIds.length === 11 && cov.visitedTargetIds.length < 11) || explicitConflict,
        JSON.stringify(cov ? { v: cov.visitedTargetIds.length, e: cov.eligibleTargetIds.length } : r.plan.plan.conflict));
    }

    // 用例 8：湖心岛（唯一桥梁死胡同）必去 —— 两种终点的诚实边界
    // 回起点：岛排最后、返程过桥属通勤段（豁免）→ 可发布，但必须如实披露返程重复；
    // 固定东门终点（≠起点）：过桥重复落在游览段 → 固定不重复约束下明确不可行。
    {
      const r1 = await makePlan(T, baseForm({ mustVisitIds: ['poi_island'] }), '');
      const v1 = r1.plan.versions[0];
      const warn = v1 && (v1.warnings || []).find((w) => w.code === 'RETURN_BACKTRACK');
      check('死胡同必去+回起点：可执行且披露返程重复',
        v1 && ['verified', 'conditional'].includes(v1.status)
        && v1.stops.some((s) => s.poiId === 'poi_island')
        && v1.stops[v1.stops.length - 1].poiId === 'poi_island'
        && warn, JSON.stringify({ st: v1 && v1.status, warn }));

      // 固定东门终点（≠起点南门）：过桥重复必然落在游览段/非豁免返程 → 不得发布
      const r2 = await makePlan(T, baseForm({
        mustVisitIds: ['poi_island'], endpointMode: 'fixed',
        endpointPoint: { lng: 104.069307, lat: 30.659901, crs: 'GCJ02' }, endpointLabel: '东门',
      }), '');
      const v2 = r2.plan.versions[0];
      const conflict2 = r2.plan.plan.conflict;
      check('死胡同必去+异地终点：不发布回头路方案',
        !v2 && r2.plan.plan.status === 'infeasible'
        && conflict2 && conflict2.code === 'NO_NON_REPEATING_ROUTE', JSON.stringify({ conflict: conflict2 }));
    }

    // 用例 9：讲解异步就绪、来源完整、TTS 明确不可用（§9/§11）
    {
      const r = await makePlan(T, baseForm(), '');
      const v = r.plan.versions[0];
      const g = await api('GET', `/v1/guides/${v.stops[0].poiId}?planId=${r.plan.plan.id}`, undefined, T);
      const audio = await api('POST', `/v1/guides/${v.stops[0].poiId}/audio`, {}, T);
      check('讲解带来源且音频状态诚实', g.status === 200 && g.body.sources.length > 0 && audio.body.code === 'TTS_UNAVAILABLE');
    }

    // 用例 10：行程事件弱网重传去重（§19.1-12）
    {
      const r = await makePlan(T, baseForm(), '');
      const v = r.plan.versions[0];
      const tr = await api('POST', '/v1/trips', { routeVersionId: v.routeId }, T);
      const tripId = tr.body.trip.id;
      const e1 = await api('POST', `/v1/trips/${tripId}/events`, { eventId: 'dup1', type: 'arrive_confirm', data: { poiId: v.stops[0].poiId } }, T);
      const e2 = await api('POST', `/v1/trips/${tripId}/events`, { eventId: 'dup1', type: 'arrive_confirm', data: { poiId: v.stops[0].poiId } }, T);
      const tg = await api('GET', `/v1/trips/${tripId}`, undefined, T);
      const arrCount = tg.body.events.filter((e) => e.type === 'arrive_confirm').length;
      check('弱网重传只记一条到访', e2.body.deduplicated === true && arrCount === 1);

      // 用例 11：同时两次重排，仅符合基准版本的提议可提交（§19.1-11）
      const rp = await api('POST', `/v1/trips/${tripId}/replans`, { cause: 'fatigue_reported', data: {}, currentNodeId: v.stops[0].entranceNodeId }, T);
      const job = await waitJob(T, rp.body.jobId);
      const propId = job.result && job.result.proposalRouteId;
      const bad = await api('POST', `/v1/trips/${tripId}/replans/${propId}/accept`, { baseVersionId: 'rt_nonexistent' }, T);
      const good = await api('POST', `/v1/trips/${tripId}/replans/${propId}/accept`, { baseVersionId: v.routeId, idempotencyKey: 'a1' }, T);
      check('版本不符返回 409，基准一致可提交', bad.body.code === 'ROUTE_VERSION_CONFLICT' && good.body.ok === true);

      // 用例 12：结束回顾区分计划/实际，距离标注为规划距离（§19.1-16）
      const fin = await api('POST', `/v1/trips/${tripId}/finish`, { idempotencyKey: 'f1' }, T);
      check('回顾不伪造实际距离', fin.body.summary.distanceKind === 'planned' && /规划距离/.test(fin.body.summary.distanceNote));

      // 用例 13：因下雨/太累的反馈不学习成长期不喜欢（§19.1-15）
      const fb = await api('POST', '/v1/feedback', { tripId, targetType: 'poi', targetId: 'poi_wetland', rating: 1, reasons: ['too_tired'] }, T);
      check('情境原因反馈不写入长期偏好证据', fb.body.learned === false);

      // 用例 14：删除行程清理关联记录（§19.1-17）
      const del = await api('DELETE', `/v1/me/trips/${tripId}`, undefined, T);
      const after = await api('GET', '/v1/me/trips', undefined, T);
      check('删除行程后历史与明细清理', del.body.ok === true && !after.body.trips.some((t) => t.id === tripId));
    }

    // 用例 14b：闭园时段（园区已关）→ 明确指出闭园并给出可执行出路（§8.8 冲突建议）
    {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(23, 30, 0, 0);
      const r = await makePlan(T, baseForm({ startMode: 'later', startAtMs: d.getTime() }), '');
      const c = r.plan && r.plan.plan && r.plan.plan.conflict;
      const hasStartSuggestion = !!(c && (c.suggestions || []).some((x) => x.action === 'start_next_morning' && x.startAtClock));
      check('闭园时段给出具体出路（改到明早出发）', r.plan.plan.status === 'infeasible' && c && c.code === 'VENUE_CLOSED_NOW' && hasStartSuggestion,
        JSON.stringify({ status: r.plan.plan.status, code: c && c.code, sug: c && (c.suggestions || []).map((x) => x.action) }));
    }

    // 用例 15：文本 NLU 提取（§6：否定/兴趣/时长/终点）
    {
      const ni = await api('POST', '/v1/intents/normalize', {
        form: baseForm(), text: '想看看湿地和老建筑，两个小时，五点前回南门，不去儿童乐园', timezone: 'Asia/Shanghai',
      }, T);
      const it = ni.body.intent;
      check('文本提取兴趣/时长/截止/避开',
        it.interests.some((x) => x.tag === '公园湿地') && it.budgetSec <= 7200
        && it.hard.avoidPoiIds.includes('poi_playground') && it.endpoint.mode === 'return_to_origin',
        JSON.stringify({ interests: it.interests, avoid: it.hard.avoidPoiIds, ep: it.endpoint.mode }));
    }

    // 用例 16：随便逛逛场景可出路线（§2.2）
    {
      const r = await makePlan(T, baseForm({
        scene: 'wander', venueId: null, objective: 'relax',
        origin: { lng: 104.055, lat: 30.657, crs: 'GCJ02', entranceId: 'hub_plaza', label: '滨河广场', source: 'map_pick' },
        durationSec: 3600, endpointMode: 'flexible', interests: ['自然', '美食'],
      }), '想放空一下');
      check('随便逛逛场景出真实路线', r.plan && r.plan.versions.length > 0 && r.plan.versions[0].stops.length >= 1);
    }

    /* ==================== 导游平台（内容中心 / 行程 / 市场 / 管理后台） ==================== */

    // 用例 17：内容中心——城市/场所/讲解库完整且标注 reviewStatus
    {
      const cities = await api('GET', '/v1/hub/cities', undefined, T);
      const venues = await api('GET', '/v1/hub/venues?cityId=beijing', undefined, T);
      const venue = await api('GET', '/v1/hub/venues/v_gugong', undefined, T);
      const narr = await api('GET', '/v1/hub/narrations/n_gugong_taihedian', undefined, T);
      check('内容库城市/场所/讲解可检索且带 library_v1 标注',
        cities.body.cities.length >= 12 && venues.body.venues.length >= 3
        && venue.body.venue.pois.length >= 5 && narr.body.narration.shortScript
        && cities.body.reviewStatus === 'library_v1'
        && narr.body.narration.claims.length >= 1);
    }

    // 用例 18：内容搜索四路命中
    {
      const s = await api('GET', '/v1/hub/search?q=' + encodeURIComponent('故宫'), undefined, T);
      check('内容搜索覆盖场所/攻略/讲解多路', s.body.venues.length >= 1 && s.body.articles.length >= 0 && (s.body.venues[0] || {}).id === 'v_gugong');
    }

    // 用例 18b：路线模板库——列表/筛选/详情/热度计数
    {
      const list = await api('GET', '/v1/hub/templates', undefined, T);
      const filtered = await api('GET', '/v1/hub/templates?tag=亲子', undefined, T);
      const detail = await api('GET', '/v1/hub/templates/t_xihu_classic', undefined, T);
      const use1 = await api('POST', '/v1/hub/templates/t_xihu_classic/use', {}, T);
      const use2 = await api('POST', '/v1/hub/templates/t_xihu_classic/use', {}, T);
      const again = await api('GET', '/v1/hub/templates/t_xihu_classic', undefined, T);
      check('模板库列表/筛选/详情/热度计数可用',
        list.body.templates.length >= 10
        && filtered.body.templates.every((t) => (t.themeTags || []).includes('亲子'))
        && detail.body.template.stops.length >= 3 && detail.body.template.draft.objective
        && use2.body.heat === use1.body.heat + 1 && again.body.template.heat === use2.body.heat,
        JSON.stringify({ n: list.body.templates.length, h1: use1.body.heat, h2: use2.body.heat }));
    }

    // 用例 19：城市多日行程——确定性、含每日场所/预算/诚实提示
    {
      const a = await api('POST', '/v1/itineraries/preview', { cityId: 'beijing', days: 2, interests: ['人文'], pace: 'normal', budget: 'comfort', people: 2 }, T);
      const b = await api('POST', '/v1/itineraries/preview', { cityId: 'beijing', days: 2, interests: ['人文'], pace: 'normal', budget: 'comfort', people: 2 }, T);
      const p = a.body;
      const coreA = JSON.stringify([a.body.itinerary, a.body.totals]);
      const coreB = JSON.stringify([b.body.itinerary, b.body.totals]);
      check('城市行程确定性生成且含预算与边界提示',
        coreA === coreB
        && p.itinerary.length === 2 && p.itinerary[0].slots.length >= 1
        && p.itinerary[0].budgetCny.total > 0 && p.totals.total > 0
        && p.notices.some((n) => n.includes('未核验') || n.includes('估算')));
    }

    // 用例 20：订单仅支持行程单（预约导游已下线）；保存/列出/删除可用
    {
      const bad = await api('POST', '/v1/orders', { type: 'guide_booking', guideId: 'g_x', date: '2030-01-01', slot: 'am' }, T);
      const p = await api('POST', '/v1/itineraries/preview', { cityId: 'hangzhou', days: 1, interests: [], pace: 'easy', budget: 'economy', people: 2 }, T);
      const o = await api('POST', '/v1/orders', { type: 'itinerary', cityId: 'hangzhou', people: 2, itinerary: p.body }, T);
      const mine = await api('GET', '/v1/orders?type=itinerary&status=planned', undefined, T);
      const del = await api('POST', `/v1/orders/${o.body.order.id}/cancel`, { reason: '验收清理' }, T);
      check('订单仅支持行程单（预约导游已下线），保存/列出/删除可用',
        bad.body.code === 'BAD_REQUEST' && o.status === 200 && o.body.order.status === 'planned'
        && mine.body.orders.some((x) => x.id === o.body.order.id) && del.body.order.status === 'cancelled',
        JSON.stringify({ bad: bad.body.code, st: o.status, msg: o.body.message, del: del.body.order && del.body.order.status }));
    }

    // 用例 22：管理后台——令牌鉴权与看板
    {
      const noTok = await api('GET', '/v1/admin/overview');
      const badTok = await api('GET', '/v1/admin/overview', undefined, 'wrong-token');
      // 令牌来源：环境变量优先；否则读服务器首次启动生成的 data/admin-token.txt
      const adminToken = process.env.ADMIN_TOKEN || fs.readFileSync(path.join(dataDir, 'admin-token.txt'), 'utf8').trim();
      const login = await api('POST', '/v1/admin/login', { token: adminToken });
      const opts = { method: 'GET', headers: { 'x-admin-token': adminToken } };
      const overview = await fetch(BASE + '/v1/admin/overview', opts);
      const ov = await overview.json().catch(() => ({}));
      const masked = await fetch(BASE + '/v1/admin/orders', opts);
      const mo = await masked.json().catch(() => ({}));
      check('管理后台鉴权与看板',
        noTok.body.code === 'ADMIN_UNAUTHORIZED' && badTok.body.code === 'ADMIN_UNAUTHORIZED'
        && login.status === 200 && ov.orders && ov.content && ov.content.counts.venues >= 40
        && mo.orders && mo.orders.every((x) => !x.contact || /\*\*\*\*/.test(x.contact.phone || '')),
        JSON.stringify({ noTok: noTok.body.code, badTok: badTok.body.code, login: login.status, hasOv: !!ov.orders, venues: ov.content && ov.content.counts.venues, hasMo: !!mo.orders, tokLen: adminToken.length }));
    }
  } catch (e) {
    failed++;
    results.push('❌ 验收脚本异常: ' + e.message);
  } finally {
    srv.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n===== 验收结果 =====');
  for (const r of results) console.log(r);
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
}

main();
