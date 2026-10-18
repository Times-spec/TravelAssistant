'use strict';
/**
 * 持久任务队列（文档 §9.3 / §17.1）：
 * - jobs 先落库（业务状态可查），runner 循环扫描待派发任务 = outbox 补偿，重启不丢任务。
 * - Worker 幂等：阶段写入前检查现状，重试不产生重复路线版本/事件。
 * - 阶段边界检查取消标志；事件带 seq，支持断线补偿。
 */
const { id, nowIso } = require('./util');
const { VenueGraph, solveAlternatives, buildRoutePlan, solveOnce, scheduleRoute, validatePlan, diffRoutes } = require('./planner');
const { buildGuideContent } = require('./providers');
const tk = require('./timekit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 固定终点的坐标（供实时路网单独建终点节点）；回起点/顺路结束返回 null */
function endpointPointOf(intent) {
  const ep = intent && intent.endpoint;
  if (!ep || ep.mode !== 'fixed' || !ep.point || !Number.isFinite(ep.point.lng)) return null;
  return { lng: ep.point.lng, lat: ep.point.lat, crs: 'GCJ02', label: ep.label || '终点' };
}

class JobRunner {
  constructor(ctx) {
    this.ctx = ctx; // {store, cfg, packs, sseHub}
    this.graphs = new Map();
    for (const p of ctx.packs) this.graphs.set(p.venue.id, new VenueGraph(p));
    this._timer = null;
    this._running = new Set();
  }
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick(), 250);
  }
  packOf(venueId) { return this.ctx.packs.find((p) => p.venue.id === venueId); }
  graphOf(venueId) { return this.graphs.get(venueId); }

  /** 不重复路段硬约束只适用于已核验步道网（自有演示场所包）；
   *  真实高德包（live:/area_amap）的街道网上任意两段步行路线几乎必然共享街段，
   *  硬约束会把多站路线压到一两站 → 放宽为"计量+诚实标注"（validatePlan/校验器按同一语义）。 */
  alignTraversalConstraint(intent, pack) {
    if (!pack) return;
    const isLive = pack.venue.live === true || intent.venueId === 'area_amap';
    if (isLive) intent.hard = { ...(intent.hard || {}), noRepeatedEdges: false };
    else if (intent.hard && intent.hard.noRepeatedEdges === undefined) intent.hard.noRepeatedEdges = true;
  }

  /** 场所包与图：真实场所/真实片区走高德实时构建；来源为自有数据的场所包直接取用 */
  async resolvePackGraph(intent) {
    const out = await this._resolvePackGraph(intent);
    this.alignTraversalConstraint(intent, out.pack);
    return out;
  }

  async _resolvePackGraph(intent) {
    if (this.ctx.cfg.providers.map !== 'amap') {
      const local = this.packOf(intent.venueId);
      if (local) return { pack: local, graph: this.graphOf(intent.venueId) };
      throw Object.assign(new Error('未配置高德 Key，无法使用真实场所数据'), { code: 'PROVIDER_NOT_CONFIGURED' });
    }
    const { buildAmapAreaPack } = require('./amap');
    if (intent.venueId === 'area_amap') {
      const area = await buildAmapAreaPack(this.ctx.cfg, { ...intent.origin.point, label: intent.origin.label }, intent.budgetSec, endpointPointOf(intent), {
        // 兴趣标签决定候选池排序（"想吃点东西"时餐饮点不该被展馆整体挤出）；
        // 室内偏好决定室内/露天点的相对权重（与候选评分层的 indoorAdj 同一口径）
        interests: (intent.interests || []).map((x) => x.tag),
        indoorPreferred: !!(intent.soft && intent.soft.indoorPreferred),
      });
      return area;
    }
    if (String(intent.venueId).startsWith('live:')) {
      if (!intent.venueRef) {
        throw Object.assign(new Error('缺少场所信息，无法构建真实场所数据'), { code: 'VENUE_DATA_INSUFFICIENT' });
      }
      const { buildLiveVenue } = require('./live_venue');
      const live = await buildLiveVenue(this.ctx.cfg, intent.venueRef, { ...intent.origin.point, label: intent.origin.label }, intent.budgetSec, {
        // 口味偏好决定餐饮/购物的降权；必去点即使不在半径内也要进候选池
        food: (intent.interests || []).some((i) => i.tag === '美食'),
        mustVisitIds: intent.hard.mustVisitIds || [],
        // 固定终点单独建节点，末站→终点这段参与排序
        endpoint: endpointPointOf(intent),
      });
      return { pack: live.pack, graph: live.graph };
    }
    const local = this.packOf(intent.venueId);
    if (local) return { pack: local, graph: this.graphOf(intent.venueId) };
    throw Object.assign(new Error('未知场所: ' + intent.venueId), { code: 'VENUE_DATA_INSUFFICIENT' });
  }

  emit(job, type, payload, routeVersion = null) {
    const { store, sseHub } = this.ctx;
    const last = store.find('job_events', (e) => e.jobId === job.id).reduce((m, e) => Math.max(m, e.seq), 0);
    const evt = {
      eventId: id('evt'), seq: last + 1, jobId: job.id,
      planId: job.planId || null, requestRevision: job.requestRevision || 1,
      routeVersion, occurredAt: nowIso(), type, payload,
    };
    store.insert('job_events', evt);
    sseHub.publish(job.id, evt);
    return evt;
  }

  tick() {
    const { store } = this.ctx;
    // outbox 补偿：queued 任务派发；running 超时任务回收重排（幂等前提）
    const staleMs = 5 * 60 * 1000;
    const jobs = store.find('jobs', (j) =>
      (j.status === 'queued' && !this._running.has(j.id)) ||
      (j.status === 'running' && Date.now() - new Date(j.updatedAt).getTime() > staleMs && !this._running.has(j.id)));
    for (const job of jobs.slice(0, 3)) {
      this._running.add(job.id);
      this.run(job).catch((e) => {
        console.error('[job] failed', job.id, e);
        this.ctx.store.update('jobs', job.id, { status: 'failed', error: { code: e.code || 'INTERNAL', message: e.message }, updatedAt: nowIso() });
        try { this.emit(job, 'job.failed', { code: e.code || 'INTERNAL', message: e.message, retryable: true }); } catch (_) {}
      }).finally(() => this._running.delete(job.id));
    }
  }

  async run(jobRow) {
    const { store } = this.ctx;
    const job = store.byId('jobs', jobRow.id);
    if (!job || job.status === 'cancelled' || job.status === 'completed') return;
    store.update('jobs', job.id, { status: 'running', updatedAt: nowIso() });
    try {
      if (job.type === 'plan.generate') await this.runPlanGenerate(job);
      else if (job.type === 'plan.edit') await this.runPlanEdit(job);
      else if (job.type === 'trip.replan') await this.runTripReplan(job);
      if (job.status !== 'cancelled') {
        const fresh = store.byId('jobs', job.id);
        if (fresh.status !== 'cancelled') {
          store.update('jobs', job.id, { status: 'completed', updatedAt: nowIso() });
          this.emit(fresh, 'job.completed', { status: 'completed' });
        }
      }
    } catch (e) {
      const err = { code: e.code || 'INTERNAL', message: e.message };
      store.update('jobs', job.id, { status: 'failed', updatedAt: nowIso(), error: err });
      // 规划任务异常（数据源/适配器/代码错误）→ 计划必须落到明确的 failed 终态并带上错误信息，
      // 否则会永远停在 solving，前端只能一直转圈，用户也看不到失败原因。
      if (job.type === 'plan.generate' && job.planId) {
        const plan = store.byId('plans', job.planId);
        if (plan && ['queued', 'retrieving', 'solving', 'verifying'].includes(plan.status)) {
          store.update('plans', job.planId, { status: 'failed', error: err, failedAt: nowIso() });
        }
      }
      this.emit(job, 'job.failed', { code: err.code, message: err.message, retryable: true });
    }
  }

  cancelled(job) {
    const fresh = this.ctx.store.byId('jobs', job.id);
    return fresh && fresh.cancelRequested;
  }

  /* ---------------- 规划生成：关键路径 + 内容路径（§9.1） ---------------- */
  async runPlanGenerate(job) {
    const { store, cfg } = this.ctx;
    const plan = store.byId('plans', job.planId);
    const intent = store.byId('intents', plan.intentId);
    const { pack, graph } = await this.resolvePackGraph(intent);
    const { confirmChips } = require('./domain');

    store.update('plans', plan.id, {
      status: 'retrieving',
      // 决策卡在刷新/重进后仍要能展示：把确认条件与预算随计划落库
      confirmChips: confirmChips(intent),
      budgetSec: intent.budgetSec,
    });
    this.emit(job, 'intent.normalized', { intentId: intent.intentId, revision: intent.revision, chips: confirmChips(intent), unresolved: intent.unresolved });
    await sleep(250);
    if (this.cancelled(job)) return;

    if (intent.unresolved.length) {
      store.update('plans', plan.id, { status: 'needs_clarification' });
      this.emit(job, 'clarification.required', { questions: intent.unresolved });
      return; // 等待用户确认后重新提交（新 revision → 新 plan 任务）
    }

    // 候选点
    const { scoreCandidates } = require('./planner');
    const originNear = graph.nearestNode(intent.origin.point);
    const startNodeId = intent.origin.entranceId && graph.nodeById.has(intent.origin.entranceId)
      ? intent.origin.entranceId : originNear.node.id;
    const cands = scoreCandidates(pack, intent, graph, startNodeId);
    const candidatePreview = { count: cands.length, names: cands.slice(0, 12).map((c) => c.poi.name) };
    store.update('plans', plan.id, { candidatePreview });
    this.emit(job, 'candidates.ready', {
      count: cands.length,
      names: candidatePreview.names,
      demo: cfg.demoMode && intent.venueId !== 'area_amap',
    });
    store.update('plans', plan.id, { status: 'solving' });
    await sleep(300);
    if (this.cancelled(job)) return;

    // 求解（主推荐 + 差异化备选）。agent 模式仍复用确定性求解器，
    // 但在其外层增加约束台账、独立验证、冲突分类和需确认的修复提议。
    let results;
    let agentResult = null;
    if (cfg.routePlanningMode === 'algorithm') {
      results = solveAlternatives(pack, intent, graph);
      store.update('plans', plan.id, { planningMode: 'algorithm' });
    } else {
      const { RoutePlanningAgent } = require('./route_planning_agent');
      agentResult = new RoutePlanningAgent().plan({ pack, intent, graph, planId: plan.id });
      results = agentResult.solutions;
      store.update('plans', plan.id, {
        planningMode: 'agent',
        constraintLedger: agentResult.constraintLedger,
        agentTrace: agentResult.trace,
        agentProposals: agentResult.proposals.map((proposal) => ({
          id: proposal.id,
          action: proposal.action,
          label: proposal.label,
          reason: proposal.reason,
          requiresConfirmation: proposal.requiresConfirmation,
          patch: proposal.patch,
          previewSummary: proposal.previewRoute ? routeSummary(proposal.previewRoute) : null,
        })),
      });
    }
    store.update('plans', plan.id, { status: 'verifying' });
    if (!results.length) {
      const probe = solveOnce(pack, intent, graph, { interestW: 1, timeCostW: 0.5, dwellFactor: 1 });
      // 闭园冲突更具体、也更有出路（夜间最常见）→ 优先于笼统的时间不足
      const { closedNowConflict } = require('./planner');
      const conflict = closedNowConflict(pack, intent) || (agentResult && agentResult.conflict) || probe.conflict || null;
      const proposals = agentResult ? agentResult.proposals.map((p) => ({
        id: p.id, action: p.action, label: p.label, reason: p.reason,
        requiresConfirmation: p.requiresConfirmation, patch: p.patch,
        previewSummary: p.previewRoute ? routeSummary(p.previewRoute) : null,
      })) : [];
      const status = proposals.length ? 'needs_clarification' : 'infeasible';
      store.update('plans', plan.id, { status, conflict, agentProposals: proposals });
      this.emit(job, 'job.failed', {
        code: (conflict && conflict.code) || 'NO_FEASIBLE_ROUTE',
        message: (conflict && conflict.message) || '无可行方案',
        retryable: false, conflict, proposals,
      });
      return;
    }

    const routeIds = [];
    let version = store.find('route_versions', (r) => r.planId === plan.id).length;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const existing = store.findOne('route_versions', (x) => x.planId === plan.id && x.version === version + 1);
      const plan_ = existing || buildRoutePlan(pack, intent, graph, r.solved, { version: version + 1, planId: plan.id });
      plan_.policyName = r.policy.name;
      // 主推荐的 Agent 策略说明随路线版本一起入库，否则只存在于内存里，客户端拿不到
      if (agentResult && i === 0) {
        plan_.agentRationale = agentResult.agentRationale || null;
        plan_.agentStrategy = agentResult.agentStrategy || null;
      }
      // 备选标题体现真实取向差异（主推荐不加后缀，避免读起来像次级方案）；
      // 三种策略都要有区分，否则主推 light、备选 balanced 时会撞成同一个标题
      if (i > 0) {
        plan_.title += r.policy.name === 'light' ? ' · 轻松版'
          : r.policy.name === 'full' ? ' · 全览版' : ' · 均衡版';
      }
      if (!existing) store.insert('route_versions', plan_);
      routeIds.push(plan_.routeId);
      version++;
      if (i === 0) {
        this.emit(job, 'route.ready', { routeId: plan_.routeId, status: plan_.status, title: plan_.title, summary: routeSummary(plan_) }, plan_.version);
        store.update('plans', plan.id, { status: plan_.status === 'verified' ? 'ready' : 'conditional', mainRouteId: plan_.routeId });
      } else {
        this.emit(job, 'route.alternative_ready', { routeId: plan_.routeId, status: plan_.status, title: plan_.title, summary: routeSummary(plan_) }, plan_.version);
      }
      await sleep(200);
      if (this.cancelled(job)) return;
    }
    store.update('plans', plan.id, { routeIds, altRouteIds: routeIds.slice(1) });

    // 内容路径：优先当前站/下一站（§9.1）；讲解失败不影响路线（§17.1）
    const main = store.byId('route_versions', routeIds[0]);
    const ttsAvailable = this.ctx.cfg.providers.tts === 'http';
    const stopsPoi = main.stops.map((s) => s.poiId);
    for (let i = 0; i < stopsPoi.length; i++) {
      if (this.cancelled(job)) return;
      const poiId = stopsPoi[i];
      try {
        const dup = store.findOne('guide_contents', (g) => g.planId === plan.id && g.poiId === poiId);
        let content = dup || buildGuideContent(pack, poiId, ttsAvailable);
        // 真实点位无资料时：LLM 生成并明确标注"未核验"（§11.1 来源要求）；无 LLM 则保持"内容暂缺"
        if (!content && this.ctx.cfg.providers.llm === 'http') {
          const poi0 = pack._poiById.get(poiId);
          if (poi0) {
            const { generateGuide } = require('./llm');
            const gen = await generateGuide(this.ctx.cfg, poi0, pack.venue.name);
            if (gen) {
              content = {
                poiId, contentVersion: 'llm-unverified-1', language: 'zh-CN',
                summary: gen.summary, shortScript: gen.shortScript, detail: gen.detail,
                claims: [{ text: '本内容为 AI 生成，未经资料核验，仅供参考', evidenceId: null, legend: false, evidenceTitle: null, reviewStatus: 'unverified' }],
                sources: [{ id: 'llm_gen', title: 'DeepSeek 生成内容（未经资料核验）', url: null, retrievedAt: nowIso(), reviewStatus: 'unverified', license: 'AI 生成' }],
                verifiedAt: null, audioStatus: ttsAvailable ? 'not_requested' : 'demo_unavailable',
                audioDurationSec: null, unverified: true, demo: false,
              };
            }
          }
        }
        if (content && !dup) {
          store.insert('guide_contents', { id: id('gd'), planId: plan.id, routeId: main.routeId, ...content, createdAt: nowIso() });
        }
        if (content) {
          this.emit(job, 'guide.text_ready', { poiId, order: i + 1, total: stopsPoi.length }, main.version);
        } else {
          // 无已核验资料 → 明确"内容暂缺"，不虚构（§11.2）
          this.emit(job, 'guide.text_ready', { poiId, order: i + 1, total: stopsPoi.length, failed: true, message: '该点位暂无已核验的讲解资料' }, main.version);
        }
        // 内容阶段发现影响路线成立的新事实 → 发风险事件而不是悄悄改路线（§9.1）
        const poi = pack._poiById.get(poiId);
        const node = pack._nodeById.get(poiId);
        if (poi && (poi.closedToday || (node && node.status !== 'open'))) {
          this.emit(job, 'route.risk_detected', { poiId, name: poi.name, reason: poi.closedReason || '临时关闭', evidenceIds: poi.hoursEvidenceIds || [] }, main.version);
        }
      } catch (e) {
        // 单站内容失败 → 记录并继续，绝不让路线失败
        this.emit(job, 'guide.text_ready', { poiId, order: i + 1, total: stopsPoi.length, failed: true, message: '讲解生成失败，可稍后重试' }, main.version);
      }
      await sleep(350); // 真实阶段耗时（内容生成占位为本地构建，不用虚构百分比）
    }
    store.update('plans', plan.id, { status: store.byId('plans', plan.id).status });
  }

  /* ---------------- 路线编辑（§10.3：产生修改请求 → 重算 → 校验后确认替换） ---------------- */
  async runPlanEdit(job) {
    const { store } = this.ctx;
    const plan = store.byId('plans', job.planId);
    const intent = store.byId('intents', plan.intentId);
    const { baseRouteId, edits } = job.payload;
    const base = store.byId('route_versions', baseRouteId);
    if (!base) throw Object.assign(new Error('基准路线版本不存在'), { code: 'NOT_FOUND' });
    const { pack, graph } = await this.resolvePackGraph(intent);

    const edited = { ...intent, hard: { ...intent.hard }, soft: { ...intent.soft } };
    const removeIds = edits.removeStopIds || [];
    const addIds = edits.addStopIds || [];
    const lockIds = edits.lockStopIds || [];
    const unlockIds = edits.unlockStopIds || [];
    edited.hard.mustVisitIds = [...new Set([...edited.hard.mustVisitIds.filter((x) => !unlockIds.includes(x)), ...lockIds, ...addIds])].filter((x) => !removeIds.includes(x));
    edited.hard.avoidPoiIds = [...new Set([...edited.hard.avoidPoiIds, ...removeIds])];
    edited.pace = intent.pace;

    let solved;
    if (Array.isArray(edits.reorder) && edits.reorder.length) {
      // 用户指定顺序：直接排程校验，不让求解器悄悄改回
      const startNodeId = base.startNodeId;
      const sch = scheduleRoute(pack, edited, graph, edits.reorder, { startNodeId, endNodeId: base.endNodeId });
      if (!sch.ok || sch.totals.totalSec > edited.budgetSec) {
        this.emit(job, 'job.failed', { code: 'NO_FEASIBLE_ROUTE', message: '调整顺序后超出时间预算或时间窗，未替换原路线', retryable: false });
        return;
      }
      solved = { status: 'ok', schedule: { ...sch, resolvedEndNodeId: base.endNodeId }, startNodeId, endNodeId: base.endNodeId };
    } else {
      const r = solveOnce(pack, edited, graph, { interestW: 1, timeCostW: 0.55, dwellFactor: 1 });
      if (r.status !== 'ok') {
        this.emit(job, 'job.failed', { code: r.conflict.code, message: r.conflict.message, retryable: false, conflict: r.conflict });
        return;
      }
      solved = r;
    }
    const version = store.find('route_versions', (x) => x.planId === plan.id).length + 1;
    const newPlan = buildRoutePlan(pack, edited, graph, solved, { version, planId: plan.id, parentVersion: base.version });
    store.insert('route_versions', newPlan);
    const routeIds = [...new Set([...(plan.routeIds || []), newPlan.routeId])];
    store.update('plans', plan.id, { routeIds });
    this.emit(job, 'route.ready', {
      routeId: newPlan.routeId, status: newPlan.status, title: newPlan.title,
      summary: routeSummary(newPlan), diffLines: diffRoutes(base, newPlan, { doneIds: doneIdsOf(store, plan.id) }), editedFrom: base.routeId,
    }, newPlan.version);
  }

  /* ---------------- 途中重排（§12.2/§12.3：只重排未完成部分，保留已访问事实） ---------------- */
  async runTripReplan(job) {
    const { store } = this.ctx;
    const trip = store.byId('trips', job.tripId);
    const base = store.byId('route_versions', job.payload.baseRouteId);
    const plan = store.byId('plans', trip.planId);
    const intent0 = store.byId('intents', plan.intentId);
    const { cause, data = {}, currentNodeId } = job.payload;
    const { pack, graph } = await this.resolvePackGraph(intent0);

    const visitedIds = store.find('trip_events', (e) => e.tripId === trip.id && e.type === 'arrive_confirm').map((e) => e.data.poiId);
    const skippedIds = store.find('trip_events', (e) => e.tripId === trip.id && e.type === 'stop_skipped').map((e) => e.data.poiId);
    const remaining = base.stops.filter((s) => !visitedIds.includes(s.poiId) && !skippedIds.includes(s.poiId));
    // 没有剩余站点就没有可重排的对象（加点和"我要回去了"除外），不要生成"跳过已到访点"之类的空方案
    if (!remaining.length && cause !== 'finish_requested' && cause !== 'stop_add_requested') {
      const e = new Error('所有站点都已逛完，没有需要重排的行程。可以直接结束游览，或用「我要回去了」计算返程。');
      e.code = 'NOTHING_TO_REPLAN';
      throw e;
    }
    const locked = remaining.filter((s) => s.locked).map((s) => s.poiId);

    // 新预算：以"现在"为起点（§12.2 不能从过时的规划起点计算返程；预定未来行程以预定时刻为准）
    const nowMs = intent0.startAtMs && intent0.startAtMs > Date.now() ? intent0.startAtMs : Date.now();
    let latestEndAtMs = intent0.latestEndAtMs;
    if (cause === 'deadline_changed' && data.newLatestEndClock) {
      const z = tk.msToZoned(nowMs, intent0.timezone);
      latestEndAtMs = tk.zonedTimeToMs(z.dateStr, data.newLatestEndClock, intent0.timezone);
      if (latestEndAtMs <= nowMs) latestEndAtMs += 24 * 3600 * 1000;
    }
    const queueExtraSec = cause === 'queue_reported' ? Math.round((data.extraWaitMin || 0) * 60) : 0;

    const startNode = graph.nodeById.get(currentNodeId) || graph.nodeById.get(base.startNodeId);
    const edited = {
      ...intent0,
      origin: { point: { lng: startNode.lng, lat: startNode.lat, crs: 'GCJ02' }, poiId: startNode.type === 'poi' ? startNode.id : null, entranceId: startNode.type === 'entrance' ? startNode.id : null, label: startNode.name },
      startAtMs: nowMs, startAt: tk.msToZoned(nowMs, intent0.timezone).iso,
      latestEndAtMs, latestEndAt: tk.msToZoned(latestEndAtMs, intent0.timezone).iso,
      budgetSec: Math.max(300, Math.floor((latestEndAtMs - nowMs) / 1000) - queueExtraSec),
      hard: { ...intent0.hard }, soft: { ...intent0.soft },
    };
    edited.hard.mustVisitIds = [...locked];
    edited.hard.avoidPoiIds = [...new Set([...intent0.hard.avoidPoiIds, ...visitedIds, ...skippedIds])];
    if (cause === 'stop_skipped' && data.poiId) edited.hard.avoidPoiIds.push(data.poiId);
    if (cause === 'closure_reported' && data.poiId) edited.hard.avoidPoiIds.push(data.poiId);
    if (cause === 'stop_add_requested' && data.poiId) edited.hard.mustVisitIds.push(data.poiId);
    if (cause === 'fatigue_reported') {
      edited.soft.restPreferred = true;
      edited.pace = 'easy';
      // 疲劳：主动放弃剩余可选点中价值较低的一半（锁定点保留，§12.1）。
      // 按"去掉它能省多少路"丢点，而不是丢最后几站：A→B 路线里最后几站恰是靠近终点的顺路站，
      // 丢掉它们会让末段空走 1km+（2026-10-18 线上实测"春熙路→天府广场"疲劳重排末段 1388m）
      const optional = remaining.filter((s) => !s.locked).map((s) => s.poiId);
      const dropN = Math.ceil(optional.length / 2);
      if (dropN > 0) edited.hard.avoidPoiIds.push(...pickFatigueDrops(graph, startNode.id, remaining, base.endNodeId, dropN));
      edited.hard.avoidPoiIds = [...new Set(edited.hard.avoidPoiIds)];
    }
    if (cause === 'rain_reported') {
      // 减少露天段：剩余露天点让位，可信室内备选由候选评分自然上浮（§12.1）
      const outdoor = remaining.filter((s) => !s.locked && !s.indoor).map((s) => s.poiId);
      edited.hard.avoidPoiIds.push(...outdoor);
      edited.hard.avoidPoiIds = [...new Set(edited.hard.avoidPoiIds)];
    }
    if (cause === 'finish_requested') {
      // 直接回结束点：排除全部剩余点
      edited.hard.mustVisitIds = [];
      edited.hard.avoidPoiIds = [...new Set([...edited.hard.avoidPoiIds, ...remaining.map((s) => s.poiId)])];
    }
    // 除"想加地方"与"下雨替换室内备选"外，重排不引入原路线之外的新点（§12.1：只计算剩余行程）
    if (cause !== 'stop_add_requested' && cause !== 'rain_reported') {
      const inBase = new Set(base.stops.map((s) => s.poiId));
      for (const p of pack.pois) if (!inBase.has(p.id)) edited.hard.avoidPoiIds.push(p.id);
      edited.hard.avoidPoiIds = [...new Set(edited.hard.avoidPoiIds)];
    }

    const r = solveOnce(pack, edited, graph, { interestW: 1, timeCostW: 0.55, dwellFactor: 1 });
    if (r.status !== 'ok') {
      this.emit(job, 'job.failed', { code: r.conflict.code, message: r.conflict.message, retryable: false, conflict: r.conflict });
      return;
    }
    const version = store.find('route_versions', (x) => x.planId === plan.id).length + 1;
    const proposal = buildRoutePlan(pack, edited, graph, r, { version, planId: plan.id, parentVersion: base.version });
    proposal.isProposal = true;
    proposal.proposalCause = cause;
    store.insert('route_versions', proposal);
    const diff = diffRoutes(base, proposal, { doneIds: [...visitedIds, ...skippedIds] });
    this.emit(job, 'route.alternative_ready', {
      routeId: proposal.routeId, status: proposal.status, title: proposal.title,
      summary: routeSummary(proposal), diffLines: diff, isReplanProposal: true,
      proposalId: proposal.routeId, baseRouteId: base.routeId, cause,
    }, proposal.version);
    store.update('jobs', job.id, { result: { proposalRouteId: proposal.routeId, diffLines: diff } });
  }
}

/** 已到访/已跳过的点（编辑重排时同样不应出现在差异文案里） */
function doneIdsOf(store, planId) {
  const trips = store.find('trips', (t) => t.planId === planId && (t.status === 'active' || t.status === 'paused'));
  if (!trips.length) return [];
  const tid = trips[trips.length - 1].id;
  return store.find('trip_events', (e) => e.tripId === tid && (e.type === 'arrive_confirm' || e.type === 'stop_skipped')).map((e) => e.data.poiId);
}

/**
 * 疲劳时选哪些站放弃：逐个移除"边际绕行"最大的可选站（prev→s→next 比 prev→next 多走的路），
 * 每移除一个重新计算，锁定站不动；距离未知时视为 0（不优先丢）。
 */
function pickFatigueDrops(graph, startNodeId, remaining, endNodeId, dropN) {
  const seq = remaining.map((s) => ({ poiId: s.poiId, node: s.entranceNodeId, locked: !!s.locked }));
  const d = (a, b) => {
    if (!a || !b || a === b) return 0;
    const r = graph.route(a, b);
    return r && Number.isFinite(r.distanceM) ? r.distanceM : null;
  };
  const drops = [];
  while (drops.length < dropN) {
    let best = -1, bestSave = -Infinity;
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].locked) continue;
      const prev = i === 0 ? startNodeId : seq[i - 1].node;
      const next = i === seq.length - 1 ? endNodeId : seq[i + 1].node;
      const a = d(prev, seq[i].node), b = next ? d(seq[i].node, next) : 0, c = next ? d(prev, next) : 0;
      const save = a == null || b == null || c == null ? 0 : a + b - c;
      if (save > bestSave) { bestSave = save; best = i; }
    }
    if (best < 0) break;
    drops.push(seq[best].poiId);
    seq.splice(best, 1);
  }
  return drops;
}

function routeSummary(plan) {
  return {
    title: plan.title,
    durationSec: plan.totals.totalSec,
    distanceM: plan.totals.distanceM,
    stopCount: plan.stops.length,
    endLabel: plan.endLabel,
    endArrivalAt: plan.endArrivalAt,
    knownCostCny: plan.totals.knownCostCny,
    hasUnknownCost: plan.totals.hasUnknownCost,
    coverage: plan.coverage ? { visited: plan.coverage.visitedTargetIds.length, eligible: plan.coverage.eligibleTargetIds.length, scopeLabel: plan.coverage.scopeLabel } : null,
    repeatRatio: plan.repeatRatio,
    sightRepeatRatio: plan.sightRepeatRatio,
    returnOverlapM: plan.returnOverlapM,
    status: plan.status,
    warnings: plan.warnings,
  };
}

/* ---------------- 任务创建（先落库 = outbox） ---------------- */
function createJob(store, { type, ownerId, planId = null, tripId = null, payload = {}, requestRevision = 1 }) {
  const job = {
    id: id('job'), type, ownerId, planId, tripId, payload, requestRevision,
    status: 'queued', cancelRequested: false, attempts: 0, result: null, error: null,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  store.insert('jobs', job);
  return job;
}

module.exports = { pickFatigueDrops, JobRunner, createJob, routeSummary };
