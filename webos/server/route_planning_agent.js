'use strict';

/**
 * 有界路线规划智能体。
 *
 * LLM/自然语言层只负责产出 NormalizedIntent；本模块负责把一次规划组织成
 * “约束台账 → 求解 → 独立验证 → 修复提议 → 可解释结果”的确定性闭环。
 * 智能体不会静默放宽硬约束，所有 repair 都以 requiresConfirmation 提议返回。
 */
const { solveAlternatives, solveOnce, buildRoutePlan } = require('./planner');
const { hardConstraintsOf } = require('./route_constraints');

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

/** 与求解器分离的最后一道验证，避免“求解成功”被误当成“可以发布”。
 * 豁免规则与 scheduleRoute/validatePlan 一致：
 * ① 返程回起点属通勤段，允许沿去程走回（真实街道网回程必然重复去程）；
 * ② plan.noRepeatedEdges === false 时（真实高德包放宽），重复只计量不拦截。 */
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

class RoutePlanningAgent {
  constructor({ maxRepairAttempts = 3 } = {}) {
    this.maxRepairAttempts = maxRepairAttempts;
  }

  plan({ pack, intent, graph, planId = 'agent_plan' }) {
    const trace = [];
    const ledger = compileConstraintLedger(intent);
    trace.push({ stage: 'constraints.compiled', count: ledger.length });

    const plans = candidatePlans(pack, intent, graph, planId);
    trace.push({ stage: 'solver.completed', candidates: plans.length });
    const verified = plans.map(({ plan, result }) => ({ plan, result, verification: verifyRoutePlan(plan) }))
      .filter((x) => x.verification.ok);
    trace.push({ stage: 'verifier.completed', accepted: verified.length, rejected: plans.length - verified.length });
    if (verified.length) {
      return {
        status: 'ready', route: verified[0].plan, alternatives: verified.slice(1).map((x) => x.plan),
        solutions: verified.map((x) => x.result),
        constraintLedger: ledger, verification: verified[0].verification, proposals: [], trace,
      };
    }

    const probe = solveOnce(pack, intent, graph, PROBE_POLICY);
    const conflict = probe.conflict || { code: 'NO_FEASIBLE_ROUTE', message: '当前约束组合下没有找到可发布路线' };
    trace.push({ stage: 'conflict.classified', code: conflict.code });
    const proposals = [];

    // 严格无重复 + 死胡同必去：不放宽道路约束，尝试把必去点改为终点。
    if (conflict.code === 'NO_NON_REPEATING_ROUTE' && intent.endpoint.mode === 'return_to_origin') {
      for (const poiId of intent.hard?.mustVisitIds || []) {
        if (proposals.length >= this.maxRepairAttempts) break;
        const node = graph.nodeById.get(poiId);
        if (!node) continue;
        const patched = {
          ...intent,
          endpoint: {
            mode: 'fixed', poiId, entranceId: poiId, label: node.name,
            point: { lng: node.lng, lat: node.lat, crs: 'GCJ02' },
          },
          hard: { ...intent.hard }, soft: { ...intent.soft },
        };
        const repaired = candidatePlans(pack, patched, graph, `${planId}_repair_${proposals.length + 1}`)
          .map((x) => x.plan)
          .find((plan) => verifyRoutePlan(plan).ok);
        if (repaired) {
          proposals.push({
            id: `end_at_${poiId}`, action: 'change_endpoint', requiresConfirmation: true,
            label: `改为在「${node.name}」结束`, reason: '保留必去点和零重复路段，但不再返回起点',
            patch: { endpoint: patched.endpoint }, previewRoute: repaired,
          });
        }
      }
    }

    trace.push({ stage: 'repair.proposed', count: proposals.length });
    return {
      status: proposals.length ? 'needs_user_decision' : 'infeasible', route: null, alternatives: [],
      solutions: [],
      conflict, constraintLedger: ledger, verification: { ok: false, violations: [] }, proposals, trace,
    };
  }
}

module.exports = { RoutePlanningAgent, compileConstraintLedger, verifyRoutePlan };
