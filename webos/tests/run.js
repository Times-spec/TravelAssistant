// 线上多场景实测：每个场景独立游客会话，保存完整计划 JSON，输出汇总指标
const fs = require('fs');
const B = (process.env.BASE_URL || 'http://47.99.241.85').replace(/\/$/, '');
async function api(T, m, p, b) {
  const o = { method: m, headers: {} };
  if (T) o.headers.authorization = 'Bearer ' + T;
  if (b !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(b); }
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(B + p, o); const txt = await r.text();
      let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 200) }; }
      j._status = r.status; return j;
    } catch (e) { if (k === 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
}
const hav = (a, b) => { const R = 6371000, r = Math.PI / 180; const dl = (b.lat - a.lat) * r, dn = (b.lng - a.lng) * r; const s = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const O = (lng, lat, label, city) => ({ lng, lat, crs: 'GCJ02', label, source: 'search', city });
const P = (lng, lat) => ({ lng, lat, crs: 'GCJ02' });
const CASES = require('./cases.js')(O, P);
async function runCase(c) {
  const t0 = Date.now();
  const s = await api(null, 'POST', '/v1/sessions/guest'); const T = s.sessionToken;
  const d = new Date(); d.setDate(d.getDate() + 1); d.setUTCHours(2, 0, 0, 0); // 明天 10:00
  const form = { objective: 'highlights', timeMode: 'duration', durationSec: 10800, startMode: 'later', startAtMs: d.getTime(), startTouched: true, durationTouched: true, mobility: 'walk', pace: 'normal', interests: [], mustVisitIds: [], avoidPoiIds: [], endpointMode: 'return_to_origin', ...c.form };
  if (form.endpointMode === 'fixed' || c.form.endpointMode) form.endpointTouched = true;
  if (c.textOnly) { form.durationTouched = false; form.durationSec = 7200; }
  const ni = await api(T, 'POST', '/v1/intents/normalize', { form, text: c.text || '', timezone: 'Asia/Shanghai' });
  if (!ni.intentId) return { id: c.id, name: c.name, err: 'normalize ' + JSON.stringify(ni).slice(0, 300) };
  const intent = ni.intent || {};
  if (ni.unresolved && ni.unresolved.length) return { id: c.id, name: c.name, err: 'unresolved ' + JSON.stringify(ni.unresolved).slice(0, 300), budgetMin: intent.budgetSec / 60 };
  const pl = await api(T, 'POST', '/v1/plans', { intentId: ni.intentId, revision: ni.revision, idempotencyKey: 'k' + Math.random() });
  if (!pl.planId) return { id: c.id, name: c.name, err: 'plans ' + JSON.stringify(pl).slice(0, 300) };
  let job;
  for (let i = 0; i < 100; i++) { job = await api(T, 'GET', '/v1/jobs/' + pl.jobId); if (['completed', 'failed', 'cancelled'].includes(job.job && job.job.status)) break; await new Promise((r) => setTimeout(r, 2000)); }
  const p = await api(T, 'GET', '/v1/plans/' + pl.planId);
  fs.writeFileSync(`out/${c.id}.json`, JSON.stringify({ case: c, normalize: ni, job, plan: p }, null, 1));
  const plan = p.plan || {};
  const out = { id: c.id, name: c.name, sec: Math.round((Date.now() - t0) / 1000), job: job.job && job.job.status, jobErr: job.job && (job.job.error || job.job.errorCode), budgetMin: Math.round(intent.budgetSec / 60), planStatus: plan.status, kernel: plan.agentKernel ? { llm: plan.agentKernel.llm, q: plan.agentKernel.quality, nominated: (plan.agentKernel.nominated || []).length } : null, versions: [] };
  for (const v of (p.versions || []).filter((x) => !x.isProposal)) {
    const legs = v.legs || [];
    const last = legs[legs.length - 1];
    const walkSec = legs.reduce((a, l) => a + (l.durationSec || 0), 0);
    const dwellSec = (v.stops || []).reduce((a, s) => a + (s.dwellSec || 0), 0);
    const endPt = form.endpointMode === 'fixed' ? form.endpointPoint : form.endpointMode === 'return_to_origin' ? form.origin : null;
    out.versions.push({
      title: v.title, status: v.status, role: v.role || v.kind,
      n: (v.stops || []).length, stops: (v.stops || []).map((s) => `${s.name}(${Math.round((s.dwellSec || 0) / 60)}m)`),
      totalMin: Math.round((v.totals && v.totals.totalSec || 0) / 60), walkMin: Math.round(walkSec / 60), dwellMin: Math.round(dwellSec / 60),
      km: ((v.totals && v.totals.distanceM || 0) / 1000).toFixed(2),
      lastLegM: last ? Math.round(last.distanceM || 0) : null, lastLegIsEnd: last ? !!(last.isReturnLeg || last.toEnd || last.isEndLeg) : null,
      lastStopToEndStraight: endPt && v.stops && v.stops.length ? Math.round(hav(v.stops.at(-1).coord || v.stops.at(-1), endPt)) : null,
      warnings: (v.warnings || []).map((w) => w.code + ':' + (w.message || '').slice(0, 60)),
      rationale: (v.agentRationale || '').slice(0, 160),
    });
  }
  return out;
}
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const pick = process.env.CASES ? process.env.CASES.split(',') : CASES.map((c) => c.id);
  const conc = Number(process.env.CONC || 2);
  const todo = CASES.filter((c) => pick.includes(c.id));
  const res = [];
  let k = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (k < todo.length) {
      const c = todo[k++];
      const r = await runCase(c).catch((e) => ({ id: c.id, name: c.name, err: e.stack }));
      res.push(r);
      fs.appendFileSync('summary.jsonl', JSON.stringify(r) + '\n');
      console.log(`[done] ${r.id} ${r.name} ${r.err ? 'ERR ' + r.err.slice(0, 200) : r.sec + 's ' + r.job}`);
    }
  }));
})();
