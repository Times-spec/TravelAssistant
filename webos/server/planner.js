'use strict';
/**
 * 规划器（文档 §8）：推荐层 / 求解层 / 路由层 / 校验层 分离。
 * - 路由层：场所包已核验路网 Dijkstra（无路径时标 unreachable，绝不用直线冒充步道）。
 * - 求解层：必去骨架 → 按收益/增量时间插入 → 局部换序(2-opt) → 全量时间校验。
 * - 校验层：§8.7 发布前清单；硬约束不过不发布为 verified。
 * - 不可行：返回结构化 Conflict（§8.8），含最小调整建议。
 */
const tk = require('./timekit');
const { id, nowIso, clamp } = require('./util');
const { createTraversalConstraintState, repeatedEdgeMetrics } = require('./route_constraints');

const SOLVER_VERSION = 'heuristic-1.1.0';
const POLICY_VERSION = 'policy-2026-09-2';
const WALK_SPEED = { easy: 0.9, normal: 1.1, active: 1.3 }; // m/s

/* ================= 路由层：已核验路网 ================= */
class VenueGraph {
  constructor(pack) {
    this.pack = pack;
    this.nodeById = new Map(pack.nodes.map((n) => [n.id, n]));
    this.adj = new Map();
    this.edgeById = new Map(pack.edges.map((e) => [e.id, e]));
    for (const e of pack.edges) {
      if (e.closed || !e.walkAllowed) continue;
      if (!this.adj.has(e.from)) this.adj.set(e.from, []);
      if (!this.adj.has(e.to)) this.adj.set(e.to, []);
      this.adj.get(e.from).push({ to: e.to, edge: e });
      this.adj.get(e.to).push({ to: e.from, edge: e }); // 无向步行边；有向禁行按有向处理（本包无）
    }
    this._cache = new Map();
  }
  /** Dijkstra 最短步行路径；不可达返回 {status:'unreachable'}，绝不回退直线（§8.6） */
  route(fromId, toId, opts = {}) {
    if (fromId === toId) return { status: 'ok', distanceM: 0, nodeIds: [fromId], edgeIds: [], geometry: this._geom([fromId]) };
    const forbiddenEdgeIds = opts.forbiddenEdgeIds || null;
    const cacheable = !forbiddenEdgeIds || forbiddenEdgeIds.size === 0;
    const key = fromId + '>' + toId;
    if (cacheable && this._cache.has(key)) return this._cache.get(key);
    const dist = new Map([[fromId, 0]]);
    const prev = new Map();
    const visited = new Set();
    const pq = [[0, fromId]];
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, u] = pq.shift();
      if (visited.has(u)) continue;
      visited.add(u);
      if (u === toId) break;
      for (const { to, edge } of this.adj.get(u) || []) {
        if (forbiddenEdgeIds && forbiddenEdgeIds.has(edge.id)) continue;
        const nd = d + edge.lengthM;
        if (nd < (dist.get(to) ?? Infinity)) {
          dist.set(to, nd);
          prev.set(to, { from: u, edgeId: edge.id });
          pq.push([nd, to]);
        }
      }
    }
    let result;
    if (!dist.has(toId)) {
      result = { status: 'unreachable', distanceM: null, nodeIds: [], edgeIds: [], geometry: [] };
    } else {
      const nodeIds = [toId];
      const edgeIds = [];
      let cur = toId;
      while (cur !== fromId) {
        const p = prev.get(cur);
        edgeIds.unshift(p.edgeId);
        nodeIds.unshift(p.from);
        cur = p.from;
      }
      result = { status: 'ok', distanceM: dist.get(toId), nodeIds, edgeIds, geometry: this._geom(nodeIds) };
    }
    if (cacheable) {
      this._cache.set(key, result);
      this._cache.set(toId + '>' + fromId, result.status === 'ok'
        ? { ...result, nodeIds: [...result.nodeIds].reverse(), edgeIds: [...result.edgeIds].reverse(), geometry: [...result.geometry].reverse() }
        : result);
    }
    return result;
  }
  _geom(nodeIds) {
    return nodeIds.map((nid) => {
      const n = this.nodeById.get(nid);
      return [n.lng, n.lat];
    });
  }
  nearestNode(point, types) {
    let best = null, bestD = Infinity;
    for (const n of this.pack.nodes) {
      if (types && !types.includes(n.type)) continue;
      const d = Math.hypot((n.lng - point.lng) * 95803, (n.lat - point.lat) * 110940);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best ? { node: best, distanceM: Math.round(bestD) } : null;
  }
}

/* ================= 推荐层：候选评分（§7.4 / §8.3 软得分归一化） ================= */
function scoreCandidates(pack, intent, graph, originNodeId) {
  const interestTags = new Set(intent.interests.map((i) => i.tag));
  const avoid = new Set(intent.hard.avoidPoiIds);
  const out = [];
  for (const poi of pack.pois) {
    if (avoid.has(poi.id)) continue;
    const node = graph.nodeById.get(poi.entranceNode);
    if (!node || node.status !== 'open') continue; // 关闭点不进入候选（必去点另行追问）
    const interestHit = poi.tags.filter((t) => interestTags.has(t)).length;
    const interestScore = interestTags.size ? interestHit / Math.max(1, poi.tags.length) : 0.3;
    const scenic = poi.scenic ?? 0.5;
    const costPenalty = intent.soft.freePreferred && poi.ticketKnown && poi.ticketCny > 0 ? 0.3 : 0;
    const quietBonus = intent.soft.quietPreferred && ['自然', '公园湿地'].some((t) => poi.tags.includes(t)) ? 0.1 : 0;
    const distM = graph.route(originNodeId, poi.entranceNode).distanceM ?? 5000;
    const distPenalty = clamp(distM / 2000, 0, 1);
    const coverageBonus = intent.objective === 'poi_coverage' ? 0.35 : 0;
    const relaxAdj = intent.objective === 'relax' ? (scenic >= 0.6 ? 0.2 : -0.25) : 0; // 不默认"点越多越好"（§2.2）
    const score = interestScore + scenic * 0.8 + coverageBonus + quietBonus + relaxAdj - costPenalty - distPenalty * 0.5;
    out.push({ poi, score, distM, must: intent.hard.mustVisitIds.includes(poi.id) });
  }
  // 必去点即使分低也保留在最前
  out.sort((a, b) => (b.must - a.must) || (b.score - a.score));
  return out.slice(0, 24); // maxPoiCandidates 初值
}

/* ================= 时间排程（§8.4） ================= */
function scheduleRoute(pack, intent, graph, nodeSeq, opts = {}) {
  const tz = intent.timezone;
  const speed = WALK_SPEED[intent.pace] || WALK_SPEED.normal;
  const poiById = new Map(pack.pois.map((p) => [p.id, p]));
  const dwellFactor = opts.dwellFactor || 1;
  const legs = [];
  const stops = [];
  let t = intent.startAtMs;
  let prevNode = opts.startNodeId;
  const problems = [];
  const traversal = createTraversalConstraintState(intent, graph);

  for (const nodeId of nodeSeq) {
    const r = traversal.route(prevNode, nodeId);
    if (r.status !== 'ok') {
      problems.push({ nodeId, code: r.code || (traversal.hard.noRepeatedEdges ? 'no_non_repeating_path' : 'unreachable') });
      return { ok: false, problems, constraintMetrics: traversal.metrics() };
    }
    const travelSec = Math.round(r.distanceM / speed);
    const arrival = t + travelSec * 1000;
    legs.push({ fromNodeId: prevNode, toNodeId: nodeId, mode: 'walk', distanceM: r.distanceM, travelSec, edgeIds: r.edgeIds, geometry: r.geometry, physicalSegmentKeys: r.physicalSegmentKeys || null, repeatDetection: r.repeatDetection || 'edge-id-exact', provider: r.provider || null });
    const poi = poiById.get(nodeId);
    if (!poi) { // 途经纯节点（理论上 nodeSeq 都是 POI，防御）
      t = arrival; prevNode = nodeId; continue;
    }
    let visitStart = arrival;
    if (!tk.inWindows(visitStart, poi.openWindows, tz)) {
      const openAt = tk.nextWindowOpen(visitStart, poi.openWindows, tz);
      if (openAt == null) { problems.push({ nodeId, code: 'closed_no_window' }); return { ok: false, problems }; }
      visitStart = openAt; // 等待开门（等待时间计入预算）
    }
    if (poi.lastEntryAt) {
      const z = tk.msToZoned(visitStart, tz);
      const lastEntry = tk.zonedTimeToMs(z.dateStr, poi.lastEntryAt, tz);
      if (visitStart > lastEntry) { problems.push({ nodeId, code: 'after_last_entry' }); return { ok: false, problems }; }
    }
    const dwellSec = Math.round((poi.dwellSec || 900) * dwellFactor);
    let departure = visitStart + dwellSec * 1000;
    // 多段窗口：离开不得晚于当前窗口结束（§8.4 午休不能被压成全天区间）
    if (poi.openWindows && poi.openWindows.length) {
      const z = tk.msToZoned(visitStart, tz);
      for (const w of poi.openWindows) {
        const [ws, we] = tk.windowToMs(z.dateStr, w, tz);
        if (visitStart >= ws && visitStart < we) {
          if (departure > we) { problems.push({ nodeId, code: 'over_close' }); return { ok: false, problems }; }
          break;
        }
      }
    }
    const waitSec = Math.round((visitStart - arrival) / 1000);
    stops.push({ nodeId, poi, arrivalMs: arrival, visitStartMs: visitStart, departureMs: departure, dwellSec, waitSec });
    t = departure;
    prevNode = nodeId;
  }

  // 休息（§8.4：总预算含休息；easy/restPreferred 在中段插入 10 分钟）
  let restSec = 0;
  if ((intent.soft.restPreferred || intent.pace === 'easy') && stops.length >= 2) {
    restSec = 600;
    const midIdx = Math.max(1, Math.floor(stops.length / 2)) - 1;
    const shift = (stops[midIdx].departureMs += restSec * 1000);
    for (let i = midIdx + 1; i < stops.length; i++) {
      stops[i].arrivalMs += restSec * 1000;
      stops[i].visitStartMs += restSec * 1000;
      stops[i].departureMs += restSec * 1000;
    }
    t = shift;
    void t;
    // 重新校验被推移的站点窗口
    for (let i = midIdx + 1; i < stops.length; i++) {
      const s = stops[i];
      if (!tk.inWindows(s.visitStartMs, s.poi.openWindows, tz)) { problems.push({ nodeId: s.nodeId, code: 'rest_shift_closed' }); return { ok: false, problems }; }
    }
    t = stops[stops.length - 1].departureMs;
  }

  // 结束点
  let endNodeId = opts.endNodeId;
  let endLeg = null;
  if (endNodeId && endNodeId !== prevNode) {
    // 优先尝试不走重复路的返回；若无解且属于回到起点的通勤段且非严格模式，才允许沿去程折返
    const isReturnTrip = opts.isReturnTrip || endNodeId === opts.startNodeId || (intent.endpoint?.mode === 'return_to_origin');
    const strictNoRepeat = intent.hard?.noRepeatedEdges !== false && (intent.soft?.repeatRoadPenalty === 1 || opts.strictNoRepeat);
    let r = traversal.route(prevNode, endNodeId, { allowRepeat: false });
    if (r.status !== 'ok' && isReturnTrip && !strictNoRepeat) {
      r = traversal.route(prevNode, endNodeId, { allowRepeat: true });
    }
    if (r.status !== 'ok') {
      problems.push({ nodeId: endNodeId, code: r.code || (traversal.hard.noRepeatedEdges ? 'end_requires_repeated_edge' : 'end_unreachable') });
      return { ok: false, problems, constraintMetrics: traversal.metrics() };
    }
    endLeg = { fromNodeId: prevNode, toNodeId: endNodeId, mode: 'walk', distanceM: r.distanceM, travelSec: Math.round(r.distanceM / speed), edgeIds: r.edgeIds, geometry: r.geometry, physicalSegmentKeys: r.physicalSegmentKeys || null, repeatDetection: r.repeatDetection || 'edge-id-exact', provider: r.provider || null, isReturnLeg: true };
  }
  const endArrivalMs = t + (endLeg ? endLeg.travelSec * 1000 : 0);

  const travelSec = legs.reduce((s, l) => s + l.travelSec, 0) + (endLeg ? endLeg.travelSec : 0);
  const dwellSecTotal = stops.reduce((s, x) => s + x.dwellSec, 0);
  const waitSecTotal = stops.reduce((s, x) => s + x.waitSec, 0);
  const distanceM = legs.reduce((s, l) => s + l.distanceM, 0) + (endLeg ? endLeg.distanceM : 0);

  // 缓冲：总预算 10%~15%，带上限（§8.4）
  const bufferSec = clamp(Math.round(intent.budgetSec * 0.12), 300, 1800);
  const totalSec = Math.round((endArrivalMs - intent.startAtMs) / 1000) + bufferSec;
  const finalConstraint = traversal.validateFinal(stops);
  if (!finalConstraint.ok) {
    problems.push({ code: finalConstraint.code, ...finalConstraint.details });
    return { ok: false, problems, constraintMetrics: traversal.metrics() };
  }

  return {
    ok: true, stops, legs, endLeg, endArrivalMs, restSec, bufferSec,
    totals: { travelSec, dwellSec: dwellSecTotal, waitSec: waitSecTotal, restSec, bufferSec, distanceM, totalSec },
    constraintMetrics: traversal.metrics(),
  };
}

/* ================= 求解层（§8.2 启发式） ================= */
function solveOnce(pack, intent, graph, policy) {
  const originNear = graph.nearestNode(intent.origin.point);
  const startNodeId = intent.origin.entranceId && graph.nodeById.has(intent.origin.entranceId)
    ? intent.origin.entranceId
    : (intent.origin.poiId && graph.nodeById.has(intent.origin.poiId) ? intent.origin.poiId : originNear.node.id);
  let endNodeId = null;
  if (intent.endpoint.mode === 'return_to_origin') endNodeId = startNodeId;
  else if (intent.endpoint.mode === 'fixed') {
    endNodeId = intent.endpoint.entranceId && graph.nodeById.has(intent.endpoint.entranceId)
      ? intent.endpoint.entranceId
      : (intent.endpoint.poiId && graph.nodeById.has(intent.endpoint.poiId)
        ? intent.endpoint.poiId
        : graph.nearestNode(intent.endpoint.point).node.id);
  } else {
    endNodeId = null; // flexible：求解后在候选端口中选总耗时最小者
  }

  const cands = scoreCandidates(pack, intent, graph, startNodeId);
  if (!cands.length) {
    // 零候选但终点可达 → "直接结束/返程"也是合法方案（疲劳提前结束、我要回去了）
    const emptySch = scheduleRoute(pack, intent, graph, [], { startNodeId, endNodeId: endNodeId || startNodeId });
    if (emptySch.ok && emptySch.totals.totalSec <= intent.budgetSec) {
      return { status: 'ok', schedule: { ...emptySch, resolvedEndNodeId: endNodeId || startNodeId }, startNodeId, endNodeId: endNodeId || startNodeId, candidateCount: 0 };
    }
    return { status: 'infeasible', conflict: noCandidatesConflict(intent) };
  }

  // 1) 必去骨架：最近邻排序
  const musts = cands.filter((c) => c.must).map((c) => c.poi.entranceNode);
  const skeleton = nearestNeighborOrder(graph, startNodeId, musts);
  let seq = [...skeleton];

  const constraintProblems = [];
  const trySchedule = (s) => {
    const ends = endNodeId ? [endNodeId] : pack.venue.entrances;
    let best = null;
    for (const en of ends) {
      const sch = scheduleRoute(pack, intent, graph, s, { startNodeId, endNodeId: en, dwellFactor: policy.dwellFactor });
      if (!sch.ok && sch.problems) constraintProblems.push(...sch.problems);
      if (sch.ok && sch.totals.totalSec <= intent.budgetSec && (!best || sch.totals.totalSec < best.totals.totalSec)) {
        best = { ...sch, resolvedEndNodeId: en };
      }
    }
    return best;
  };

  // 2) 可选点按"收益 / 增量时间"插入（第一个点先保证有内容，"没排到任何点"对用户没有价值）。
  //    成本必须用增量时长（插入后总时长 − 插入前总时长）：若用全程总时长当成本，
  //    行程刚过一两个小时收益就恒负，半天预算只排得进两三个点（2026-09-30 修复）。
  const optional = cands.filter((c) => !c.must);
  let insertedAny = seq.length > 0;
  let curSch = seq.length ? trySchedule(seq) : null;
  const tryInsert = (cand) => {
    const nid = cand.poi.entranceNode;
    const baseSec = curSch ? curSch.totals.totalSec : 0;
    let bestPos = -1, bestDelta = Infinity, bestTrial = null;
    for (let pos = 0; pos <= seq.length; pos++) {
      const trial = [...seq.slice(0, pos), nid, ...seq.slice(pos)];
      const sch = trySchedule(trial);
      if (!sch) continue;
      // 当要求不重复路段时，可选点绝对不能导致引入重复路段
      if (intent.hard?.noRepeatedEdges !== false && sch.constraintMetrics?.repeatedEdgeIds?.length > 0) {
        continue;
      }
      const delta = sch.totals.totalSec - baseSec;
      // 避免荒谬的大绕路：如果为了看这个点增加的步行时间远超停留时间
      const dwellSec = (cand.poi.dwellSec || 900) * policy.dwellFactor;
      const walkDeltaSec = delta - dwellSec;
      if (walkDeltaSec > 1800 && walkDeltaSec > dwellSec * 2.5) {
        continue;
      }
      const gain = cand.score * policy.interestW - delta / 3600 * policy.timeCostW;
      // 首个点位放宽收益门槛（否则离起点较远时会一个点都排不进去）
      const accepted = (gain > 0 || !insertedAny) && delta < bestDelta;
      if (accepted) { bestDelta = delta; bestPos = pos; bestTrial = sch; }
    }
    if (bestPos >= 0) {
      seq.splice(bestPos, 0, nid);
      curSch = bestTrial;
      insertedAny = true;
      return true;
    }
    return false;
  };
  for (const cand of optional) tryInsert(cand);

  // 3) 预算填充：主循环按收益门槛收敛后，剩余预算还装得下一个点就继续补——
  //    用户给的是"半天"，不该只逛两三个点就闲着。按分数密度（score/增量小时）挑最划算的候选。
  //    relax 目标除外（§2.2：放松不堆点，少而精是合法结果）。
  if (intent.objective !== 'relax') {
    while (true) {
      const pool = optional.filter((c) => !seq.includes(c.poi.entranceNode));
      if (!pool.length) break;
      const baseSec = curSch ? curSch.totals.totalSec : 0;
      let chosen = null;
      for (const cand of pool) {
        const nid = cand.poi.entranceNode;
        let bestPos = -1, bestDelta = Infinity, bestTrial = null;
        for (let pos = 0; pos <= seq.length; pos++) {
          const trial = [...seq.slice(0, pos), nid, ...seq.slice(pos)];
          const sch = trySchedule(trial);
          if (sch && (!intent.hard?.noRepeatedEdges || sch.constraintMetrics?.repeatedEdgeIds?.length === 0)) {
            const delta = sch.totals.totalSec - baseSec;
            const dwellSec = (cand.poi.dwellSec || 900) * policy.dwellFactor;
            const walkDeltaSec = delta - dwellSec;
            if (walkDeltaSec > 1800 && walkDeltaSec > dwellSec * 2.5) continue;
            if (delta < bestDelta) {
              bestDelta = delta; bestPos = pos; bestTrial = sch;
            }
          }
        }
        if (bestTrial) {
          const density = cand.score * 3600 / Math.max(600, bestDelta);
          if (!chosen || density > chosen.density) chosen = { nid, pos: bestPos, sch: bestTrial, density };
        }
      }
      if (!chosen) break; // 剩余候选一个都塞不进预算
      seq.splice(chosen.pos, 0, chosen.nid);
      curSch = chosen.sch;
      insertedAny = true;
    }
  }

  // 4) 2-opt 局部换序（限量迭代）
  let bestSch = trySchedule(seq);
  for (let iter = 0; iter < 5 && seq.length >= 3; iter++) {
    let improved = false;
    for (let i = 0; i < seq.length - 1; i++) {
      for (let j = i + 1; j < seq.length; j++) {
        const trial = [...seq.slice(0, i), ...seq.slice(i, j + 1).reverse(), ...seq.slice(j + 1)];
        const sch = trySchedule(trial);
        if (sch) {
          const prevRepeats = bestSch?.constraintMetrics?.repeatedEdgeIds?.length || 0;
          const newRepeats = sch.constraintMetrics?.repeatedEdgeIds?.length || 0;
          if (newRepeats < prevRepeats || (newRepeats === prevRepeats && sch.totals.totalSec < bestSch.totals.totalSec - 15)) {
            seq = trial; bestSch = sch; improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }
  bestSch = trySchedule(seq);

  if (!seq.length) {
    if (constraintProblems.some((p) => ['REPEATED_EDGE', 'no_non_repeating_path', 'end_requires_repeated_edge'].includes(p.code))) {
      return { status: 'infeasible', conflict: noBacktrackingConflict(intent) };
    }
    return { status: 'infeasible', conflict: noCandidatesConflict(intent) };
  }
  if (!bestSch) {
    if (constraintProblems.some((p) => ['REPEATED_EDGE', 'no_non_repeating_path', 'end_requires_repeated_edge'].includes(p.code))) {
      return { status: 'infeasible', conflict: noBacktrackingConflict(intent) };
    }
    return { status: 'infeasible', conflict: buildTimeConflict(pack, intent, graph, seq, startNodeId, endNodeId) };
  }
  return { status: 'ok', schedule: bestSch, startNodeId, endNodeId: bestSch.resolvedEndNodeId, candidateCount: cands.length };
}

function nearestNeighborOrder(graph, startId, nodeIds) {
  const remaining = [...nodeIds];
  const order = [];
  let cur = startId;
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = graph.route(cur, remaining[i]).distanceM ?? Infinity;
      if (d < bd) { bd = d; bi = i; }
    }
    cur = remaining.splice(bi, 1)[0];
    order.push(cur);
  }
  return order;
}

/* ================= 校验层（§8.7 发布前清单） ================= */
function validatePlan(pack, intent, graph, solved) {
  const constraints = [];
  const warnings = [];
  const { schedule } = solved;
  const evPack = pack.evidence.map((e) => e.id);

  // 1. 地点与入口可解析、属于规划区域
  const allKnown = schedule.stops.every((s) => graph.nodeById.has(s.nodeId));
  constraints.push({ key: 'places_resolvable', result: allKnown ? 'pass' : 'fail', evidenceIds: evPack.slice(0, 1) });
  // 2. 路段连续、来自已核验路网（非直线）
  const legsOk = [...schedule.legs, ...(schedule.endLeg ? [schedule.endLeg] : [])].every((l) => l.edgeIds.length >= 0 && l.distanceM != null);
  constraints.push({ key: 'legs_verified_network', result: legsOk ? 'pass' : 'fail', evidenceIds: ['ev_pack_survey'] });
  // 3. 时间预算一致
  const timeOk = schedule.totals.totalSec <= intent.budgetSec && schedule.endArrivalMs <= intent.latestEndAtMs;
  constraints.push({ key: 'time_budget', result: timeOk ? 'pass' : 'fail', evidenceIds: [] });
  // 4. 必去在、避开不在
  const stopIds = new Set(schedule.stops.map((s) => s.nodeId));
  constraints.push({ key: 'must_visit_present', result: intent.hard.mustVisitIds.every((m) => stopIds.has(m)) ? 'pass' : 'fail', evidenceIds: [] });
  constraints.push({ key: 'avoid_absent', result: intent.hard.avoidPoiIds.every((a) => !stopIds.has(a)) ? 'pass' : 'fail', evidenceIds: [] });
  // 不重复路段约束：已核验步道网（演示场所包）保持硬约束；真实高德包放宽为"计量+诚实标注"
  // （真实街道网上任意两段步行路线几乎必然共享街段，硬约束会把多站路线压到 2 站）。
  const allLegs = [...schedule.legs, ...(schedule.endLeg ? [schedule.endLeg] : [])];
  const returnTrip = !!(schedule.endLeg && solved.endNodeId === solved.startNodeId);
  const sightLegs = returnTrip ? schedule.legs : allLegs;
  const noRepeatHard = intent.hard?.noRepeatedEdges !== false;
  const repeat = repeatedEdgeMetrics(sightLegs, graph);
  const repeatApprox = sightLegs.some((l) => l.repeatDetection === 'geometry-grid-approx');
  constraints.push({
    key: 'no_repeated_edges',
    result: repeat.repeatedEdgeIds.length ? (noRepeatHard ? 'fail' : 'unknown') : repeatApprox ? 'unknown' : 'pass',
    evidenceIds: repeat.repeatedEdgeIds,
    verification: repeatApprox ? 'polyline_spatial_match_approx' : 'physical_edge_id_exact',
  });
  if (!noRepeatHard && repeat.repeatedDistanceM > 30) {
    warnings.push({
      code: 'REPEAT_ALLOWED',
      message: `真实路网放宽"零重复"硬约束：游览段含约 ${Math.round(repeat.repeatedDistanceM)}m 重复路段（已在下方如实计量）`,
      evidenceIds: [],
    });
  }
  if (returnTrip) {
    const seen = new Set(sightLegs.flatMap((l) => l.physicalSegmentKeys || (l.edgeIds || []).map((e) => 'e:' + e)));
    const retKeys = schedule.endLeg.physicalSegmentKeys || (schedule.endLeg.edgeIds || []).map((e) => 'e:' + e);
    const overlap = retKeys.filter((k) => seen.has(k)).length;
    const overlapM = Math.round(schedule.endLeg.distanceM * overlap / Math.max(1, retKeys.length));
    warnings.push({
      code: 'RETURN_BACKTRACK',
      message: overlap > 0
        ? `返程约 ${Math.round(schedule.endLeg.distanceM)}m，其中约 ${overlapM}m 沿去程走回（回到起点的必经通勤）`
        : '返程与去程路段不重叠',
      evidenceIds: [],
    });
  }
  if (repeatApprox && !repeat.repeatedEdgeIds.length) {
    warnings.push({ code: 'BACKTRACKING_APPROXIMATED', message: '真实路线已按折线空间匹配规避重叠，但地图服务未提供稳定道路 ID，无法证明绝对零重复', evidenceIds: [] });
  }
  // 5. 无障碍硬条件：未知台阶不得标为可执行（§8.7-5）
  if (intent.hard.stepFreeRequired) {
    const usedEdges = new Set();
    for (const l of [...schedule.legs, ...(schedule.endLeg ? [schedule.endLeg] : [])]) l.edgeIds.forEach((e) => usedEdges.add(e));
    let unknown = false, hasSteps = false;
    for (const eid of usedEdges) {
      const e = graph.edgeById.get(eid);
      if (e && !e.stepsKnown) unknown = true;
      if (e && e.steps > 0) hasSteps = true;
    }
    constraints.push({ key: 'step_free_required', result: hasSteps ? 'fail' : unknown ? 'unknown' : 'pass', evidenceIds: [...usedEdges].slice(0, 3) });
    if (unknown && !hasSteps) warnings.push({ code: 'STEPS_UNKNOWN', message: '部分路段台阶情况未核验，无法满足"轮椅可达"的确认要求，方案仅供参考', evidenceIds: [] });
  }
  // 6. 费用硬条件：0 元硬约束下票价未知不得默认通过（§19.1）
  if (intent.hard.maxCostCny === 0) {
    const unknownCost = schedule.stops.filter((s) => !s.poi.ticketKnown);
    const paidStops = schedule.stops.filter((s) => s.poi.ticketKnown && s.poi.ticketCny > 0);
    if (paidStops.length) constraints.push({ key: 'zero_cost', result: 'fail', evidenceIds: [] });
    else if (unknownCost.length) {
      constraints.push({ key: 'zero_cost', result: 'unknown', evidenceIds: ['ev_teahouse_cost_unknown'] });
      warnings.push({ code: 'COST_UNKNOWN', message: `${unknownCost.map((s) => s.poi.name).join('、')}消费未知，不能保证零预算`, evidenceIds: [] });
    } else {
      constraints.push({ key: 'zero_cost', result: 'pass', evidenceIds: [] });
    }
  }
  // 信息不确定性提示
  const unknownPrice = schedule.stops.filter((s) => !s.poi.ticketKnown);
  if (unknownPrice.length) warnings.push({ code: 'PRICE_UNKNOWN', message: `${unknownPrice.map((s) => s.poi.name).join('、')}价格未核验，预估费用不含该部分`, evidenceIds: [] });
  // 开放时间未核验（真实高德候选没有营业时间表）→ 条件性方案，不假装已知（§7.1）
  const hoursUnknown = schedule.stops.filter((s) => !s.poi.openWindows);
  if (hoursUnknown.length) {
    constraints.push({ key: 'hours_unverified', result: 'unknown', evidenceIds: ['ev_amap_live'] });
    warnings.push({ code: 'HOURS_UNKNOWN', message: `${hoursUnknown.map((s) => s.poi.name).join('、')}的开放时间未核验，出发前请现场确认`, evidenceIds: [] });
  }

  const hasFail = constraints.some((c) => c.result === 'fail');
  const hasUnknown = constraints.some((c) => c.result === 'unknown');
  const status = hasFail ? 'infeasible' : hasUnknown ? 'conditional' : 'verified';
  return { constraints, warnings, status };
}

/* ================= 组装 RoutePlan（§15.2） ================= */
function buildRoutePlan(pack, intent, graph, solved, versionInfo) {
  const { schedule } = solved;
  const validation = validatePlan(pack, intent, graph, solved);
  const tz = intent.timezone;
  const fmt = (ms) => tk.msToZoned(ms, tz).iso;

  // 重复路段率（§8.5：物理路段 ID 合并正反向）
  const allLegs = [...schedule.legs, ...(schedule.endLeg ? [schedule.endLeg] : [])];
  const repeat = repeatedEdgeMetrics(allLegs, graph);

  // 费用
  let knownCostCny = 0, hasUnknownCost = false;
  for (const s of schedule.stops) {
    if (s.poi.ticketKnown && s.poi.ticketCny > 0) knownCostCny += s.poi.ticketCny;
    if (!s.poi.ticketKnown) hasUnknownCost = true;
  }

  // 覆盖（§2.1：清楚分母）
  const openPoiIds = pack.pois.filter((p) => {
    const n = graph.nodeById.get(p.entranceNode);
    return n && n.status === 'open' && !intent.hard.avoidPoiIds.includes(p.id);
  }).map((p) => p.id);
  const visitedTargetIds = schedule.stops.map((s) => s.nodeId).filter((x) => openPoiIds.includes(x));

  // 主题命名
  const tagCount = {};
  for (const s of schedule.stops) for (const t of s.poi.tags) tagCount[t] = (tagCount[t] || 0) + 1;
  const topTag = Object.entries(tagCount).sort((a, b) => b[1] - a[1])[0];
  const isCity = pack.venue.id === 'area_amap';
  const themes = isCity
    ? { 自然: '城市绿线', 公园湿地: '公园漫步', 人文: '城市人文漫步', 建筑: '街区建筑巡礼', 美食: '逛吃路线', 街区: '街区闲逛' }
    : { 自然: '水边慢走', 公园湿地: '湿地观鸟', 人文: '人文漫步', 建筑: '老建筑巡礼', 美食: '逛吃路线', 街区: '街区闲逛' };
  const title = (topTag && themes[topTag[0]]) || (isCity ? '城市漫步' : '公园漫步');

  const endLabel = intent.endpoint.mode === 'return_to_origin'
    ? `返回${graph.nodeById.get(solved.startNodeId).name}`
    : intent.endpoint.mode === 'fixed'
      ? `终点：${intent.endpoint.label || graph.nodeById.get(solved.endNodeId).name}`
      : `顺路结束于${graph.nodeById.get(solved.endNodeId).name}`;

  const stops = schedule.stops.map((s, i) => ({
    stopId: id('stp'),
    order: i + 1,
    poiId: s.poi.id,
    name: s.poi.name,
    entranceNodeId: s.nodeId,
    coord: [graph.nodeById.get(s.nodeId).lng, graph.nodeById.get(s.nodeId).lat],
    tags: s.poi.tags,
    indoor: s.poi.indoor,
    arrivalAt: fmt(s.arrivalMs),
    visitStartAt: fmt(s.visitStartMs),
    departureAt: fmt(s.departureMs),
    dwellSec: s.dwellSec,
    waitSec: s.waitSec,
    locked: intent.hard.mustVisitIds.includes(s.poi.id),
    ticketCny: s.poi.ticketKnown ? s.poi.ticketCny : null,
    costNote: s.poi.costNote || null,
    openWindows: s.poi.openWindows || null,
    whyText: buildWhy(s.poi, intent),
    guideStatus: 'empty',
  }));

  const legs = allLegs.map((l, i) => ({
    legId: id('leg'),
    order: i,
    fromNodeId: l.fromNodeId,
    toNodeId: l.toNodeId,
    mode: 'walk',
    travelSec: l.travelSec,
    distanceM: l.distanceM,
    edgeIds: l.edgeIds,
    physicalSegmentKeys: l.physicalSegmentKeys || undefined,
    repeatDetection: l.repeatDetection || 'edge-id-exact',
    geometry: { crs: 'GCJ02', coordinates: l.geometry },
    provider: l.provider || 'demo-venue-network',
    verifiedAt: pack.evidence[0] ? pack.evidence[0].retrievedAt : null,
    isReturnLeg: i === allLegs.length - 1 && !!schedule.endLeg && l === schedule.endLeg,
  }));

  const routeId = id('rt');
  return {
    id: routeId, // store 主键
    routeId,
    version: versionInfo.version,
    intentRevision: intent.revision,
    planId: versionInfo.planId,
    parentVersion: versionInfo.parentVersion || null,
    status: validation.status,
    title,
    endLabel,
    themeTags: topTag ? [topTag[0]] : [],
    stops,
    legs,
    totals: {
      travelSec: schedule.totals.travelSec,
      dwellSec: schedule.totals.dwellSec,
      waitSec: schedule.totals.waitSec,
      restSec: schedule.restSec,
      bufferSec: schedule.bufferSec,
      totalSec: schedule.totals.totalSec,
      distanceM: schedule.totals.distanceM,
      knownCostCny,
      hasUnknownCost,
    },
    endArrivalAt: fmt(schedule.endArrivalMs),
    startAt: intent.startAt,
    latestEndAt: intent.latestEndAt,
    repeatRatio: Math.round(repeat.repeatRatio * 100) / 100,
    repeatedDistanceM: Math.round(repeat.repeatedDistanceM),
    coverage: {
      kind: 'poi',
      visitedTargetIds,
      eligibleTargetIds: openPoiIds,
      scopeLabel: pack.venue.coverageScope.scopeLabel,
      packVersion: pack.venue.packVersion,
    },
    constraints: validation.constraints,
    warnings: validation.warnings,
    createdAt: nowIso(),
    revalidateAfter: fmt(schedule.endArrivalMs + 3600000),
    provenance: { solverVersion: SOLVER_VERSION, policyVersion: POLICY_VERSION, dataVersion: pack.venue.packVersion },
    noRepeatedEdges: intent.hard?.noRepeatedEdges !== false, // 独立校验器按同一语义复核
    strictNoRepeat: !!(intent.hard?.noRepeatedEdges !== false && (intent.soft?.repeatRoadPenalty === 1 || intent.hard?.strictNoRepeat)),
    startNodeId: solved.startNodeId,
    endNodeId: solved.endNodeId,
    candidateCount: solved.candidateCount || 0,
  };
}

function buildWhy(poi, intent) {
  const reasons = [];
  const hits = poi.tags.filter((t) => intent.interests.some((i) => i.tag === t));
  if (hits.length) reasons.push(`符合你的${hits.join('、')}偏好`);
  if (poi.scenic >= 0.8) reasons.push('园内景观价值最高的点位之一');
  if (intent.hard.mustVisitIds.includes(poi.id)) reasons.push('你指定的必去点');
  if (!reasons.length) reasons.push('顺路且停留时间可控');
  return reasons.join('；');
}

/* ================= 备选方案（§10.1：真实差异 + 去重） ================= */
function solveAlternatives(pack, intent, graph) {
  const policies = [
    { name: 'balanced', interestW: 1.0, timeCostW: 0.55, dwellFactor: 1 },
    { name: 'light', interestW: 0.8, timeCostW: 1.1, dwellFactor: 0.85 },   // 少走点
    { name: 'full', interestW: 1.3, timeCostW: 0.35, dwellFactor: 0.9 },    // 多看点
  ];
  const results = [];
  for (const p of policies) {
    const r = solveOnce(pack, intent, graph, p);
    if (r.status !== 'ok') continue;
    const sig = new Set(r.schedule.stops.map((s) => s.nodeId));
    const dup = results.some((old) => {
      const inter = [...sig].filter((x) => old.sig.has(x)).length;
      const jac = inter / Math.max(1, sig.size + old.sig.size - inter);
      return jac > 0.75; // 近似重复过滤（§10.1）
    });
    if (!dup && sig.size) results.push({ policy: p, solved: r, sig });
  }
  return results; // 第一条为主推荐，其余为备选；数据只支持一条时就一条
}

/* ================= 不可行 Conflict（§8.8） ================= */

/**
 * 闭园/闭馆冲突：当前时段园内点位全部不在开放窗口内。
 * 这比"没有可行方案"具体得多，也是夜间最常见的真实情况——必须给出可执行的出路，
 * 而不是让用户对着死胡同发呆（建议默认给"改到明早 09:00 出发"）。
 */
function closedNowConflict(pack, intent) {
  const inWindow = (poi, tMs) => {
    if (!poi.openWindows || !poi.openWindows.length) return true; // 时间未知不判定为关闭
    const clock = new Date(tMs).toTimeString().slice(0, 5);
    return poi.openWindows.some(([o, c]) => clock >= o && clock < c);
  };
  const allDay = pack.pois.filter((p) => !p.openWindows || !p.openWindows.length);
  const closed = pack.pois.filter((p) => !inWindow(p, intent.startAtMs));
  if (!closed.length || allDay.length) return null; // 还有点位可用 → 不算闭园

  // 找出最近一次开园时间（今天的下个开放时刻，否则明天最早开放时刻）
  const clockNow = new Date(intent.startAtMs).toTimeString().slice(0, 5);
  let next = null;
  for (const p of pack.pois) {
    for (const [open] of (p.openWindows || [])) {
      if (open > clockNow && (!next || open < next.open)) next = { open, sameDay: true };
      if (!next || (!next.sameDay && open < next.open)) {
        if (!next) next = { open, sameDay: false };
      }
    }
  }
  const earliestTomorrow = pack.pois
    .flatMap((p) => (p.openWindows || []).map(([o]) => o))
    .sort()[0] || '09:00';
  const label = next && next.sameDay ? `今天 ${next.open}` : `明早 ${earliestTomorrow}`;
  const openSample = pack.pois.find((p) => p.openWindows && p.openWindows.length);
  return {
    code: 'VENUE_CLOSED_NOW',
    message: `当前时间（${clockNow}）园内点位均已关闭，最近可入场时间是${label}`,
    violations: [{
      field: 'open_hours',
      message: `园区开放时间示例：${openSample ? openSample.openWindows.map((w) => w.join('-')).join(' / ') : '未知'}`,
      evidenceIds: openSample ? (openSample.hoursEvidenceIds || []) : [],
    }],
    suggestions: [
      { action: 'start_next_morning', label: `改到${label} 出发`, effect: '按开放时间重新规划', startAtClock: next && next.sameDay ? next.open : earliestTomorrow },
      { action: 'switch_scene', label: '改成周边随便逛逛', effect: '周边点位不受园区开放时间限制' },
    ],
  };
}

function noCandidatesConflict(intent) {
  return {
    code: 'VENUE_DATA_INSUFFICIENT',
    message: '当前条件下没有可推荐的点位（可能全部被避开或关闭）',
    violations: [{ field: 'candidates', message: '候选集为空', evidenceIds: [] }],
    suggestions: [
      { action: 'relax_avoid', label: '减少避开点', effect: '恢复部分候选' },
      { action: 'extend_time', label: '换个时间段', effect: '避开关闭窗口' },
    ],
  };
}

function noBacktrackingConflict(intent) {
  const returning = intent.endpoint.mode === 'return_to_origin';
  return {
    code: 'NO_NON_REPEATING_ROUTE',
    message: returning
      ? '在当前路网和站点条件下，无法在不重复任何物理路段的前提下返回起点'
      : '在当前路网和站点条件下，没有找到不重复物理路段的可行路线',
    violations: [{ field: 'no_repeated_edges', message: '部分目标位于死胡同、桥接路段之后，或可用环路不足', evidenceIds: [] }],
    suggestions: [
      { action: 'change_endpoint_flexible', label: '改为顺路结束', effect: '避免为返回起点而重复路段' },
      { action: 'remove_stop', label: '减少位于支路末端的站点', effect: '保留无重复环线' },
    ],
  };
}

function buildTimeConflict(pack, intent, graph, seq, startNodeId, endNodeId) {
  // 用必去骨架估算最小需要时长
  const bareIntent = { ...intent, soft: { ...intent.soft, restPreferred: false }, pace: intent.pace };
  const sch = endNodeId
    ? scheduleRoute(pack, bareIntent, graph, seq.length ? seq : [], { startNodeId, endNodeId })
    : null;
  const needMin = sch && sch.ok ? Math.ceil(sch.totals.totalSec / 60) : null;
  const haveMin = Math.floor(intent.budgetSec / 60);
  const suggestions = [];
  const optionalInSeq = seq.filter((n) => !intent.hard.mustVisitIds.includes(n));
  if (optionalInSeq.length) {
    const last = graph.nodeById.get(optionalInSeq[optionalInSeq.length - 1]);
    suggestions.push({ action: 'remove_stop', label: `去掉「${last ? last.name : '最后一站'}」`, effect: '释放约 20-30 分钟' });
  }
  if (intent.endpoint.mode === 'fixed' && pack.venue.entrances.length > 1) {
    const other = pack.venue.entrances.find((e) => e !== endNodeId);
    if (other) suggestions.push({ action: 'change_endpoint', label: `改从${graph.nodeById.get(other).name}结束`, effect: '可能缩短返程' });
  }
  suggestions.push({ action: 'extend_time', label: '延后 30 分钟', effect: '预算增加 30 分钟' });
  return {
    code: 'NO_FEASIBLE_ROUTE',
    message: needMin
      ? `保留当前站点与约束，估算至少需要约 ${needMin} 分钟，你只有 ${haveMin} 分钟`
      : '在当前约束下没有找到可行方案',
    violations: [{ field: 'time_budget', message: `需要约 ${needMin ?? '?'} 分钟 > 预算 ${haveMin} 分钟`, evidenceIds: [] }],
    suggestions,
  };
}

/* ================= 版本差异文案（§12.3 提议—确认） ================= */
function diffRoutes(oldPlan, newPlan) {
  const lines = [];
  const oldIds = oldPlan.stops.map((s) => s.poiId);
  const newIds = newPlan.stops.map((s) => s.poiId);
  const removed = oldPlan.stops.filter((s) => !newIds.includes(s.poiId));
  const added = newPlan.stops.filter((s) => !oldIds.includes(s.poiId));
  if (removed.length) lines.push(`跳过${removed.map((s) => s.name).join('、')}`);
  if (added.length) lines.push(`新增${added.map((s) => s.name).join('、')}`);
  if (!removed.length && !added.length && oldIds.join() !== newIds.join()) lines.push('调整了站点顺序');
  const dDist = oldPlan.totals.distanceM - newPlan.totals.distanceM;
  if (Math.abs(dDist) >= 100) lines.push(dDist > 0 ? `预计少走 ${(dDist / 1000).toFixed(1)}km` : `预计多走 ${(-dDist / 1000).toFixed(1)}km`);
  const oldEnd = oldPlan.endArrivalAt.slice(11, 16);
  const newEnd = newPlan.endArrivalAt.slice(11, 16);
  if (oldEnd !== newEnd) lines.push(`预计 ${newEnd} 到达终点（原 ${oldEnd}）`);
  else lines.push(`仍可 ${newEnd} 前到达终点`);
  return lines;
}

module.exports = { VenueGraph, solveAlternatives, solveOnce, scoreCandidates, scheduleRoute, buildRoutePlan, diffRoutes, validatePlan, closedNowConflict, SOLVER_VERSION, POLICY_VERSION };
