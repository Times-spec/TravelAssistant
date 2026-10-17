'use strict';

/**
 * 路线规划智能体 (Route Planning Agent)。
 *
 * 核心架构：
 * 1. 约束台账与拓扑预检 (Constraint Ledger & Topology Precheck)
 * 2. 宏观游览策略制定 (Tour Strategy & Macro-flow Formulation)
 * 3. 组合求解与独立验证 (Solver Orchestration & Independent Verification)
 * 4. 多维反思与修复提议生成 (Reflection, Substitution & Repair Proposals)
 * 5. 可解释性因果链与说明生成 (Explainable Rationale & Synthesis)
 */
const { solveAlternatives, solveOnce, buildRoutePlan } = require('./planner');
const { hardConstraintsOf } = require('./route_constraints');
const { haversineM } = require('./geo');

const PROBE_POLICY = { name: 'probe', interestW: 1, timeCostW: 0.55, dwellFactor: 1 };

function compileConstraintLedger(intent) {
  const hard = hardConstraintsOf(intent);
  const rows = [
    { id: 'system.no_repeated_edges', kind: 'route.edge_repeat', hardness: 'hard', source: 'system_default', value: hard.noRepeatedEdges ? 0 : null, unit: 'count' },
    { id: 'user.must_visit', kind: 'poi.must_visit', hardness: 'hard', source: 'user', value: [...(intent.hard?.mustVisitIds || [])] },
    { id: 'user.avoid', kind: 'poi.avoid', hardness: 'hard', source: 'user', value: [...(intent.hard?.avoidPoiIds || [])] },
    { id: 'user.latest_end', kind: 'time.latest_end', hardness: 'hard', source: 'user', value: intent.latestEndAt },
  ];
  if (hard.maxDistanceM != null) rows.push({ id: 'user.max_distance', kind: 'route.max_distance', hardness: 'hard', source: 'user', value: hard.maxDistanceM, unit: 'm' });
  if (hard.maxCostCny != null) rows.push({ id: 'user.max_cost', kind: 'route.max_cost', hardness: 'hard', source: 'user', value: hard.maxCostCny, unit: 'CNY' });
  for (const [key, value] of Object.entries(intent.soft || {})) {
    if (value) rows.push({ id: `preference.${key}`, kind: key, hardness: 'soft', source: 'user_or_profile', value });
  }
  return rows;
}

/** 与求解器分离的独立验证器，避免“求解成功”被误当成“可以发布”。 */
function verifyRoutePlan(plan) {
  const violations = [];
  for (let i = 1; i < plan.legs.length; i++) {
    if (plan.legs[i - 1].toNodeId !== plan.legs[i].fromNodeId) {
      violations.push({ code: 'LEG_DISCONTINUITY', legIndex: i });
    }
  }
  const returnTrip = !!(plan.startNodeId != null && plan.endNodeId === plan.startNodeId
    && plan.legs.length && plan.legs[plan.legs.length - 1].isReturnLeg);
  const sightLegs = returnTrip ? plan.legs.slice(0, -1) : plan.legs;
  if (plan.noRepeatedEdges !== false) {
    const used = new Set();
    const legsToCheck = plan.strictNoRepeat ? plan.legs : sightLegs;
    for (const leg of legsToCheck) {
      const keys = leg.physicalSegmentKeys?.length
        ? leg.physicalSegmentKeys
        : (leg.edgeIds || []).map((eid) => `e:${eid}`);
      for (const key of keys) {
        if (used.has(key)) violations.push({ code: 'REPEATED_PHYSICAL_SEGMENT', key });
        used.add(key);
      }
    }
  }
  for (const c of plan.constraints || []) {
    if (c.result === 'fail') violations.push({ code: 'DECLARED_CONSTRAINT_FAILED', key: c.key });
  }
  return { ok: violations.length === 0, violations };
}

function candidatePlans(pack, intent, graph, planId) {
  return solveAlternatives(pack, intent, graph).map((result, index) => {
    const plan = buildRoutePlan(pack, intent, graph, result.solved, { version: index + 1, planId });
    plan.policyName = result.policy.name;
    return { plan, result };
  });
}

/** 图的邻接表：已核验路网与真实高德包现在同构；万一适配器没提供，降级为"无拓扑信息"而不是崩溃 */
function adjOf(graph, nodeId) {
  return graph.adj ? (graph.adj.get(nodeId) || []) : [];
}

/** 拓扑连通性诊断：识别死胡同、唯一桥梁与不可避免重复结构 */
function analyzeTopology(graph, pack) {
  const deadEndPois = new Map();
  for (const poi of pack.pois) {
    const adj = adjOf(graph, poi.entranceNode);
    if (adj.length === 1) {
      deadEndPois.set(poi.id, { poi, bridgeEdge: adj[0].edge, toNode: adj[0].to });
    }
  }
  return { deadEndPois };
}

/** 为冲突的死胡同点位寻找同主题环线替代点 */
function findAlternativePoi(pack, graph, targetPoiId, usedPoiIds, intent) {
  const targetPoi = pack.pois.find((p) => p.id === targetPoiId);
  if (!targetPoi) return null;
  const targetTags = new Set(targetPoi.tags || []);
  const avoid = new Set([...(intent.hard?.avoidPoiIds || []), ...usedPoiIds, targetPoiId]);

  const pool = pack.pois.filter((p) => {
    if (avoid.has(p.id)) return false;
    const node = graph.nodeById.get(p.entranceNode);
    if (!node || node.status !== 'open') return false;
    return adjOf(graph, p.entranceNode).length > 1; // 仅选择处于环网中的点位
  });

  pool.sort((a, b) => {
    const aMatch = a.tags.filter((t) => targetTags.has(t)).length;
    const bMatch = b.tags.filter((t) => targetTags.has(t)).length;
    if (bMatch !== aMatch) return bMatch - aMatch;
    return (b.scenic || 0) - (a.scenic || 0);
  });

  return pool[0] || null;
}

/** 宏观策略与自然语言推荐理由合成 */
function synthesizeTourRationale(plan, intent) {
  const stops = plan.stops || [];
  const topNames = stops.slice(0, 3).map((s) => `「${s.name}」`).join('、');
  const durMin = Math.round((plan.totals?.totalSec || 0) / 60);
  const distKm = ((plan.totals?.distanceM || 0) / 1000).toFixed(1);
  const isLoop = plan.startNodeId != null && plan.endNodeId === plan.startNodeId;
  // 单站谈不上"线路形态"：不足 2 站不写环形闭环/单向游览
  const flowType = stops.length >= 2 ? (isLoop ? '环形闭环' : '单向游览') : '';
  const namesText = stops.length > 1 ? `途经${topNames}等核心点位` : `途经${topNames}`;

  let rationale = `已为你规划${stops.length}站${flowType}路线，${namesText}。`;
  rationale += `全程预估耗时约 ${durMin} 分钟，步行 ${distKm} 公里。`;
  // 有重复距离就不能说"零重复/零回头路"：如实说明有多少米沿原路走回
  const repeatedM = Math.round(plan.repeatedDistanceM || 0);
  if (repeatedM > 0) {
    rationale += isLoop
      ? `返程有约 ${repeatedM} 米沿原路走回（回起点的必经通勤）；`
      : `途中有约 ${repeatedM} 米沿原路走回；`;
  } else {
    rationale += `路线已严格规划为零回头路，完全避免重复行走；`;
  }
  if (intent.pace === 'easy') {
    rationale += `整体节奏舒缓，预留了充足的休息与观景缓冲。`;
  } else {
    rationale += `流线顺畅连贯，适合兼顾风景与步道漫游。`;
  }
  return {
    flowType,
    summary: rationale,
    pace: intent.pace || 'normal',
    highlights: stops.map((s) => ({ poiId: s.poiId, name: s.name, reason: s.whyText })),
  };
}

class RoutePlanningAgent {
  constructor({ maxRepairAttempts = 4 } = {}) {
    this.maxRepairAttempts = maxRepairAttempts;
  }

  plan({ pack, intent, graph, planId = 'agent_plan' }) {
    const t0 = Date.now();
    const trace = [];
    const mark = (stage, extra = {}) => {
      const row = { stage, ms: Date.now() - t0, ...extra };
      trace.push(row);
      return row;
    };
    const ledger = compileConstraintLedger(intent);
    mark('constraints.compiled', { count: ledger.length });

    const topo = analyzeTopology(graph, pack);
    mark('topology.analyzed', { deadEndCount: topo.deadEndPois.size });

    // 1. 尝试直接求解
    const plans = candidatePlans(pack, intent, graph, planId);
    mark('solver.completed', { candidates: plans.length });
    const verified = plans.map(({ plan, result }) => ({ plan, result, verification: verifyRoutePlan(plan) }))
      .filter((x) => x.verification.ok);
    mark('verifier.completed', { accepted: verified.length, rejected: plans.length - verified.length });

    if (verified.length) {
      const mainPlan = verified[0].plan;
      const rationaleData = synthesizeTourRationale(mainPlan, intent);
      mainPlan.agentRationale = rationaleData.summary;
      mainPlan.agentStrategy = rationaleData;
      return {
        status: 'ready',
        route: mainPlan,
        alternatives: verified.slice(1).map((x) => x.plan),
        solutions: verified.map((x) => x.result),
        constraintLedger: ledger,
        verification: verified[0].verification,
        agentRationale: rationaleData.summary,
        agentStrategy: rationaleData,
        proposals: [],
        trace,
      };
    }

    // 2. 求解受阻时，进行结构化冲突分类与多维修复提议生成
    const probe = solveOnce(pack, intent, graph, PROBE_POLICY);
    const conflict = probe.conflict || { code: 'NO_FEASIBLE_ROUTE', message: '当前约束组合下没有找到可发布路线', suggestions: [] };
    mark('conflict.classified', { code: conflict.code });
    const proposals = [];

    // 场景 A：严格无重复 + 死胡同必去点冲突（如湖心岛）
    if (conflict.code === 'NO_NON_REPEATING_ROUTE' && intent.endpoint.mode === 'return_to_origin') {
      const musts = intent.hard?.mustVisitIds || [];
      for (const poiId of musts) {
        if (proposals.length >= this.maxRepairAttempts) break;
        const node = graph.nodeById.get(poiId);
        if (!node) continue;
        const deadEndInfo = topo.deadEndPois.get(poiId);

        // 策略 1：更改终点（就地结束，实现 100% 零回头路）
        const patchedEnd = {
          ...intent,
          endpoint: {
            mode: 'fixed', poiId, entranceId: poiId, label: node.name,
            point: { lng: node.lng, lat: node.lat, crs: 'GCJ02' },
          },
          hard: { ...intent.hard }, soft: { ...intent.soft },
        };
        const repairedEnd = candidatePlans(pack, patchedEnd, graph, `${planId}_repair_end_${poiId}`)
          .map((x) => x.plan)
          .find((plan) => verifyRoutePlan(plan).ok);
        if (repairedEnd) {
          proposals.push({
            id: `end_at_${poiId}`,
            action: 'change_endpoint',
            requiresConfirmation: true,
            label: `改为在「${node.name}」结束`,
            reason: '保留必去点和零重复路段，但不再返回起点（就地出园或打车）',
            patch: { endpoint: patchedEnd.endpoint },
            previewRoute: repairedEnd,
          });
        }

        // 策略 2：同类环网替代点（替换冲突点，保持 100% 零重复闭环）
        const altPoi = findAlternativePoi(pack, graph, poiId, musts, intent);
        if (altPoi) {
          const patchedSub = {
            ...intent,
            hard: {
              ...intent.hard,
              mustVisitIds: musts.map((id) => (id === poiId ? altPoi.id : id)),
              avoidPoiIds: [...(intent.hard?.avoidPoiIds || []), poiId],
            },
          };
          const repairedSub = candidatePlans(pack, patchedSub, graph, `${planId}_repair_sub_${altPoi.id}`)
            .map((x) => x.plan)
            .find((plan) => verifyRoutePlan(plan).ok);
          if (repairedSub) {
            proposals.push({
              id: `substitute_${poiId}_with_${altPoi.id}`,
              action: 'substitute_poi',
              requiresConfirmation: true,
              label: `将「${node.name}」替换为环线上的「${altPoi.name}」`,
              reason: '用同类水景景观替代死胡同点位，在绝不走回头路的前提下顺利闭环回到起点',
              patch: {
                hard: {
                  mustVisitIds: patchedSub.hard.mustVisitIds,
                  avoidPoiIds: patchedSub.hard.avoidPoiIds,
                },
                // 前端草稿保存的是带名字的对象，而不是裸 id；把名字一并带回，点击后无需再查
                pois: {
                  mustVisit: [{ id: altPoi.id, name: altPoi.name }],
                  avoid: [{ id: poiId, name: node.name }],
                },
              },
              previewRoute: repairedSub,
            });
          }
        }

        // 策略 3：豁免末段通勤折返（保留回到起点，明确说明折返距离）
        const patchedRelax = {
          ...intent,
          hard: { ...intent.hard, strictNoRepeat: false },
          soft: { ...intent.soft, repeatRoadPenalty: 0 },
        };
        const repairedRelax = candidatePlans(pack, patchedRelax, graph, `${planId}_repair_relax`)
          .map((x) => x.plan)
          .find((plan) => plan.stops?.some((s) => s.poiId === poiId));
        if (repairedRelax) {
          // 桥梁距离：优先用真实步行边长度；边上没有可信距离时降级为两点直线估算（仅用于文案）
          const meters = (() => {
            if (deadEndInfo) {
              const bridge = deadEndInfo.bridgeEdge;
              if (bridge && Number.isFinite(bridge.lengthM)) return Math.round(bridge.lengthM);
              const a = graph.nodeById && graph.nodeById.get(poiId);
              const b = graph.nodeById && graph.nodeById.get(deadEndInfo.toNode);
              if (a && b && Number.isFinite(a.lng) && Number.isFinite(a.lat) && Number.isFinite(b.lng) && Number.isFinite(b.lat)) {
                return Math.round(haversineM(a, b));
              }
            }
            return Math.round(repairedRelax.repeatedDistanceM || 100);
          })();
          proposals.push({
            id: `allow_return_backtrack_${poiId}`,
            action: 'allow_commute_backtrack',
            requiresConfirmation: true,
            label: `保留回到起点，允许「${node.name}」往返必要折返约${meters}米`,
            reason: `该景点为唯一桥梁连接；游览段保持零重复，仅最后回程通勤过桥时折返`,
            patch: { soft: { repeatRoadPenalty: 0 }, hard: { strictNoRepeat: false } },
            previewRoute: repairedRelax,
          });
        }
      }
    }

    // 场景 B：时间预算不足或步行距离超限，生成智能剪枝建议
    if (['TIME_BUDGET_EXCEEDED', 'MAX_DISTANCE_EXCEEDED'].includes(conflict.code)) {
      const candidates = pack.pois.filter((p) => !(intent.hard?.mustVisitIds || []).includes(p.id) && !(intent.hard?.avoidPoiIds || []).includes(p.id));
      if (candidates.length) {
        const sorted = [...candidates].sort((a, b) => (a.scenic || 0) - (b.scenic || 0));
        const prunePoi = sorted[0];
        const patchedPrune = {
          ...intent,
          hard: { ...intent.hard, avoidPoiIds: [...(intent.hard?.avoidPoiIds || []), prunePoi.id] },
        };
        const repairedPrune = candidatePlans(pack, patchedPrune, graph, `${planId}_repair_prune`)
          .map((x) => x.plan)
          .find((plan) => verifyRoutePlan(plan).ok);
        if (repairedPrune) {
          proposals.push({
            id: `prune_${prunePoi.id}`,
            action: 'prune_low_yield',
            requiresConfirmation: true,
            label: `放弃偏远点「${prunePoi.name}」，确保时间在预算内`,
            reason: '减少长距离往返步行，保留核心精华体验并满足时限',
            patch: {
              hard: { avoidPoiIds: patchedPrune.hard.avoidPoiIds },
              pois: { avoid: [{ id: prunePoi.id, name: prunePoi.name }] },
            },
            previewRoute: repairedPrune,
          });
        }
      }
    }

    // 将 Agent 提议同步到 conflict.suggestions 中，便于前端 UI 直接渲染为调整 Chips
    conflict.suggestions = [
      ...(conflict.suggestions || []),
      ...proposals.map((p) => ({
        action: p.action,
        label: p.label,
        effect: p.reason,
        patch: p.patch,
      })),
    ];

    mark('repair.proposed', { count: proposals.length });
    return {
      status: proposals.length ? 'needs_user_decision' : 'infeasible',
      route: null,
      alternatives: [],
      solutions: [],
      conflict,
      constraintLedger: ledger,
      verification: { ok: false, violations: [] },
      proposals,
      trace,
    };
  }
}

module.exports = { RoutePlanningAgent, compileConstraintLedger, verifyRoutePlan, synthesizeTourRationale };
