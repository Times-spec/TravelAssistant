// 路线页：真实阶段进度（SSE）+ 主推荐/备选 + 地图 + 时间轴 + 站点编辑（§9.2/§10）
import { get, post, subscribeJob } from './api.js';
import { h, toast, openSheet, closeSheet, SvgMap, makeProjector, fmtMin, fmtKm, fmtClock, loadAmap, AmapRouteMap, svgTurnMarkers } from './ui.js';
import { state, getVenuePack } from './app.js';
import { buildIntentPayload } from './home.js';
import { drawPackBase, drawMapLabel } from './home.js';

export function renderPlan(view, ctx, planId) {
  let unsub = null;
  let planData = null;
  let selRouteId = null;
  let editMode = false;
  const cleanupFns = [];

  const stageState = { intent: 'active', candidates: 'todo', route: 'todo', alt: 'todo', guide: 'todo', done: 'todo' };
  // 只重置阶段键：stageState 上还挂着 confirmText / candidateInfo 等展示字段，不能被一并写成 'done'
  const STAGE_KEYS = ['intent', 'candidates', 'route', 'alt', 'guide', 'done'];

  const root = h('div', {});
  view.append(root);

  // 顶部常驻返回口：此前只有规划不可行时才有"返回修改条件"，规划成功后用户反而无处可回
  const backBar = h('div', { style: 'margin-bottom:2px' },
    h('button', { class: 'link-btn', onclick: () => { location.hash = '#/'; } }, '‹ 返回调整条件'));
  root.append(backBar);

  const progressCard = h('div', { class: 'card' });
  const chipsBar = h('div', { class: 'confirm-bar hidden' });
  const conflictCard = h('div', { class: 'card hidden' });
  const routesBox = h('div', {});
  const mapWrap = h('div', { class: 'map-wrap hidden' });
  const timelineBox = h('div', {});
  root.append(chipsBar, progressCard, conflictCard, routesBox, mapWrap, timelineBox);

  const bottomBar = h('div', { class: 'bottom-bar hidden' });
  document.getElementById('app').append(bottomBar);
  cleanupFns.push(() => bottomBar.remove());

  let taskFailed = false; // 任务级失败：立即停掉阶段动画，改显示失败卡片
  let agentCollapsed = false; // 决策链可收起（默认展开：等待期它就是进度）

  const SOFT_LABELS = {
    freePreferred: '免费优先', repeatRoadPenalty: '少走回头路', restPreferred: '多休息',
    quietPreferred: '安静', stepFewPreferred: '少台阶', stepFreeRequired: '轮椅可达',
  };

  function agentTrace(stage) {
    const list = (planData && planData.plan && planData.plan.agentTrace) || [];
    return list.find((t) => t.stage === stage) || null;
  }

  /** 约束台账：硬约束用绿 chip，软偏好用灰 chip；没有台账时不占位 */
  function ledgerChips(ledger) {
    const chips = [];
    for (const r of ledger || []) {
      if (r.kind === 'route.edge_repeat') chips.push({ text: '不重复路段', hard: true });
      else if (r.kind === 'poi.must_visit' && (r.value || []).length) chips.push({ text: `必去 ${r.value.length} 处`, hard: true });
      else if (r.kind === 'poi.avoid' && (r.value || []).length) chips.push({ text: `避开 ${r.value.length} 处`, hard: true });
      else if (r.kind === 'time.latest_end' && r.value) chips.push({ text: `最晚 ${fmtClock(r.value)} 到终点`, hard: true });
      else if (r.kind === 'route.max_distance' && r.value != null) chips.push({ text: `步行 ≤ ${(r.value / 1000).toFixed(1)}km`, hard: true });
      else if (r.kind === 'route.max_cost' && r.value != null) chips.push({ text: r.value === 0 ? '零门票（硬条件）' : `预算 ≤ ¥${r.value}`, hard: true });
      else if (r.hardness === 'soft' && SOFT_LABELS[r.kind]) chips.push({ text: SOFT_LABELS[r.kind], hard: false });
    }
    if (!chips.length) return null;
    return h('div', { class: 'agent-ledger' },
      ...chips.map((c) => h('span', { class: 'agent-chip' + (c.hard ? '' : ' soft') }, c.text)));
  }

  /** 智能体决策过程：等待时按真实任务事件逐步点亮；完成后保留为可回看的决策链 */
  function renderStages() {
    if (taskFailed) { progressCard.classList.add('hidden'); return; }
    const plan = planData && planData.plan;
    const ledger = (plan && plan.constraintLedger) || [];
    const topology = agentTrace('topology.analyzed');
    const solver = agentTrace('solver.completed');
    const verifier = agentTrace('verifier.completed');
    const repair = agentTrace('repair.proposed');
    const isAgent = !plan || plan.planningMode !== 'algorithm';
    const allDone = stageState.done === 'done';
    const solverDone = !!solver || stageState.route === 'done';
    const intentDone = stageState.intent === 'done' || solverDone;
    const candDone = stageState.candidates === 'done' || solverDone;
    const verifyDone = !!verifier || stageState.alt === 'done';
    const hasVersions = !!(planData && planData.versions && planData.versions.length);

    // trace 里的 ms 是"从智能体开始到该步结束"的累计值，展示时换算成单步耗时
    const stepMs = (end, start) => {
      if (!end || end.ms == null) return null;
      const d = end.ms - (start && start.ms != null ? start.ms : 0);
      return d <= 0 ? '<1ms' : d + 'ms';
    };
    const steps = [];
    const push = (state, label, detail, ms) => steps.push({ state, label, detail, ms });
    push(intentDone ? 'done' : 'active', '理解需求',
      stageState.confirmText || '解析游玩方式、目的地、时长与偏好');
    push(candDone ? 'done' : stageState.candidates === 'active' ? 'active' : 'pending', '候选检索',
      stageState.candidateInfo != null
        ? `命中 ${stageState.candidateInfo} 个候选点${stageState.candidateNames ? ' · ' + stageState.candidateNames : ''}`
        : '按兴趣匹配与步行距离评分');
    push(solverDone ? 'done' : candDone && !allDone ? 'active' : 'pending', '组合求解',
      solver
        ? `生成 ${solver.candidates} 个候选方案${topology ? `（拓扑预检：死胡同 ${topology.deadEndCount} 处）` : ''}`
        : (solverDone ? '按固定策略直接求解' : '确定性求解：编排顺序、停留与时间窗'),
      stepMs(solver, topology));
    if (isAgent) {
      push(verifyDone ? 'done' : solverDone ? 'active' : 'pending', '独立验证',
        verifier ? `通过 ${verifier.accepted} 个 / 拒绝 ${verifier.rejected} 个` : '分离式校验器复核硬约束与可发布性',
        stepMs(verifier, solver));
    }
    // 讲解只在有路线版本时才生成；不可行/待确认的计划不该出现"讲解已就绪"
    if (hasVersions) {
      push(allDone || stageState.guide === 'done' ? 'done' : stageState.guide === 'active' ? 'active' : 'pending', '讲解补充',
        stageState.guideDetail || (allDone ? '各站讲解已就绪' : '为每站准备可核验的讲解'));
    }
    if (repair && repair.count > 0) {
      push('done', '修复提议', `${repair.count} 条待确认方案（不放宽硬约束）`, stepMs(repair, verifier));
    }

    const activeStep = steps.find((s) => s.state === 'active');
    const summary = allDone
      ? `${steps.length} 步完成${verifier ? ` · 独立验证通过 ${verifier.accepted} 个方案` : ''}`
      : (activeStep ? `正在${activeStep.label}…` : '准备中…');

    progressCard.classList.remove('hidden');
    progressCard.innerHTML = '';
    // 原生 append 会把 null 变成字面量 "null"，先过滤再展开
    progressCard.append(...[
      h('div', { class: 'agent-head' },
        h('div', { class: 'agent-head-left' },
          h('div', { class: 'agent-title' }, '🤖 智能体决策过程'),
          h('span', { class: 'agent-badge' }, isAgent ? '有界智能体' : '算法直解')),
        h('button', { class: 'link-btn', onclick: () => { agentCollapsed = !agentCollapsed; renderStages(); } },
          agentCollapsed ? '展开 ▾' : '收起 ▴')),
      h('div', { class: 'agent-sub' },
        agentCollapsed ? summary : (isAgent
          ? '只编排「约束台账 → 求解 → 独立验证 → 修复提议」，不直接生成道路'
          : '当前为算法直解模式，未启用智能体编排')),
      agentCollapsed ? null : h('div', { class: 'agent-steps' }, ...steps.map((s) =>
        h('div', { class: 'agent-step' },
          h('span', { class: 'agent-dot ' + s.state }, s.state === 'done' ? '✓' : s.state === 'active' ? '●' : '·'),
          h('span', { class: 'agent-name' }, s.label),
          h('span', { class: 'agent-detail' }, s.detail || ''),
          s.ms != null ? h('span', { class: 'agent-ms' }, s.ms) : null))),
      agentCollapsed ? null : ledgerChips(ledger),
    ].filter(Boolean));
  }

  let altExpanded = false;
  function routeCards() {
    routesBox.innerHTML = '';
    if (!planData || !planData.versions.length) return;
    const versions = planData.versions.filter((v) => !v.isProposal);
    const render = (v, i) => {
      const s = v.summary;
      const sel = selRouteId === v.routeId;
      return h('div', {
        class: 'route-card' + (sel ? ' sel' : ''),
        onclick: () => { selRouteId = v.routeId; refreshRouteViews(); },
      },
        h('div', { class: 'rc-title' },
          h('span', { class: 'badge ' + (i === 0 ? 'badge-main' : 'badge-alt') }, i === 0 ? '主推荐' : '备选'),
          v.title,
          h('span', { class: 'badge badge-' + v.status }, statusText(v.status))),
        h('div', { class: 'rc-stats' },
          h('span', {}, '约 ' + fmtMin(s.durationSec)),
          h('span', {}, fmtKm(s.distanceM)),
          h('span', {}, s.stopCount + ' 站'),
          h('span', {}, s.endLabel),
          h('span', {}, s.hasUnknownCost ? '费用部分待确认' : s.knownCostCny > 0 ? `约 ¥${s.knownCostCny}` : '门票 ¥0')),
        s.coverage ? h('div', { class: 'tl-meta' }, `${s.coverage.scopeLabel}，本路线覆盖 ${s.coverage.visited} 个`) : null,
        v.agentRationale ? h('div', { class: 'rc-rationale' }, v.agentRationale) : null,
        v.repeatRatio > 0.05 ? h('div', { class: 'tl-meta' },
          `重复路段约 ${Math.round(v.repeatRatio * 100)}%`
          + (v.sightRepeatRatio > 0.05 ? `；其中游览段约 ${Math.round(v.sightRepeatRatio * 100)}% 为死胡同/唯一通道等必要重复` : '')
          + (v.returnOverlapM > 50 ? `；返程约 ${fmtKm(v.returnOverlapM)} 沿去程走回（回起点的必经通勤）` : '')) : null,
        tradeoffText(versions, v) ? h('div', { class: 'rc-tradeoff' }, tradeoffText(versions, v)) : null,
        (v.warnings || []).map((w) => h('div', { class: 'rc-warn' }, '⚠ ' + w.message)));
    };
    routesBox.append(render(versions[0], 0));
    if (versions.length > 1) {
      if (altExpanded) {
        versions.slice(1).forEach((v, idx) => routesBox.append(render(v, idx + 1)));
        routesBox.append(h('button', { class: 'alt-toggle', onclick: () => { altExpanded = false; routeCards(); } }, '收起备选 ▴'));
      } else {
        routesBox.append(h('button', { class: 'alt-toggle', onclick: () => { altExpanded = true; routeCards(); } },
          `查看 ${versions.length - 1} 条备选方案 ▾`));
      }
    }
  }

  function tradeoffText(versions, v) {
    if (versions[0].routeId === v.routeId) return null;
    const main = versions[0];
    const dDist = main.totals.distanceM - v.totals.distanceM;
    const dStops = v.stops.length - main.stops.length;
    const parts = [];
    if (Math.abs(dDist) >= 100) parts.push(dDist > 0 ? `少走约 ${(dDist / 1000).toFixed(1)}km` : `多走约 ${(-dDist / 1000).toFixed(1)}km`);
    if (dStops !== 0) parts.push(dStops > 0 ? `多 ${dStops} 站` : `少 ${-dStops} 站`);
    const missing = main.stops.filter((s) => !v.stops.some((x) => x.poiId === s.poiId)).map((s) => s.name);
    if (missing.length) parts.push('不经过' + missing.slice(0, 2).join('、'));
    return parts.length ? '取舍：' + parts.join('，') : null;
  }

  let map = null;
  let amapMap = null; // 当前高德底图实例：事件流会反复触发重绘，先销毁旧实例避免上下文泄漏
  let loadSeq = 0;    // 加载代际：SSE 事件连发时重叠的 loadPlan/renderMap，旧一轮作废
  cleanupFns.push(() => { if (amapMap) { amapMap.destroy(); amapMap = null; } });
  async function refreshRouteViews() {
    const seq = loadSeq;
    routeCards();
    const v = planData && planData.versions.find((x) => x.routeId === selRouteId);
    if (!v) return;
    await renderMap(v, seq);
    if (seq !== loadSeq) return;
    renderTimeline(v);
    renderBottom(v);
  }

  async function renderMap(v, seq) {
    seq = seq ?? ++loadSeq;
    mapWrap.classList.remove('hidden');
    mapWrap.innerHTML = '';
    const isDemoMap = (v.legs[0].provider || '').startsWith('demo');
    // 真实路线：优先高德 JS 底图（§5.5 安全密钥浏览器端配置）；失败回退 SVG 路网渲染
    if (!isDemoMap && state.config.amapJsKey) {
      try {
        const AMap = await loadAmap(state.config.amapJsKey, state.config.amapJsSecurityCode);
        if (seq !== loadSeq) return;
        if (amapMap) { amapMap.destroy(); amapMap = null; }
        const div = h('div', {});
        mapWrap.append(div, h('div', { class: 'map-note' }, '高德真实路网 · 可拖动缩放'));
        const rm = new AmapRouteMap(div, { AMap, height: 300 });
        amapMap = rm;
        rm.renderRoute(v, {});
        return;
      } catch (e) {
        mapWrap.innerHTML = '';
        toast('高德底图加载失败，已切换为路网示意图', 3000);
      }
    }
    const intent = await getIntentOfPlan();
    if (seq !== loadSeq) return;
    let pack = null;
    try {
      pack = await getVenuePack({ id: intent.venueId, ref: planData.plan.venueRef });
    } catch (e) { /* 真实场所/片区无静态场所包时仅绘制路线 */ }
    if (seq !== loadSeq) return;
    const firstPt = v.legs[0].geometry.coordinates[0];
    const center = pack ? pack.venue.center : { lng: firstPt[0], lat: firstPt[1] };
    const proj = makeProjector(center);
    map = new SvgMap(mapWrap, { height: 300 });
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const grow = (p) => { bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x); bounds.minY = Math.min(bounds.minY, p.y); bounds.maxY = Math.max(bounds.maxY, p.y); };
    if (pack) {
      drawPackBase(map, pack, proj);
    }
    // 路线：真实路段几何（§10.2 已走/未走在游览页区分）
    for (const leg of v.legs) {
      const pts = leg.geometry.coordinates.map(([lng, lat]) => proj.toXY({ lng, lat }));
      pts.forEach(grow);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p.x + ' ' + p.y).join(' ');
      map.el('path', { d, fill: 'none', stroke: leg.isReturnLeg ? '#1d4ed8' : '#e8a13c', 'stroke-width': 4.5, 'stroke-linecap': 'round', 'stroke-dasharray': leg.isReturnLeg ? '8 6' : 'none', opacity: 0.95 });
    }
    // 起终点与编号站点
    v.stops.forEach((s, i) => {
      const p = proj.toXY({ lng: s.coord[0], lat: s.coord[1] });
      grow(p);
      map.el('circle', { cx: p.x, cy: p.y, r: 11, fill: '#0f6f4f', stroke: '#fff', 'stroke-width': 2.5 });
      const t = map.el('text', { x: p.x, y: p.y + 4, 'font-size': 11, fill: '#fff', 'text-anchor': 'middle', 'font-weight': 700 });
      t.textContent = i + 1;
      drawMapLabel(map, p, s.name, -17);
    });
    if (!pack) map.fit(bounds, 60);
    svgTurnMarkers(map, v.legs, proj);
    const sp = proj.toXY({ lng: firstPt[0], lat: firstPt[1] });
    drawMapLabel(map, sp, '起点', 22, '#0f6f4f');
    mapWrap.append(h('div', { class: 'map-note' }, isDemoMap ? '演示地图（虚构场所数据）· 可拖动缩放' : '高德真实路网（示意） · 可拖动缩放'));
  }

  async function getIntentOfPlan() {
    return { venueId: planData.plan.venueId || 'venue_qinghu' };
  }

  function renderTimeline(v) {
    timelineBox.innerHTML = '';
    const card = h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('p', { class: 'card-title', style: 'margin:0' }, `时间轴 · 预计 ${fmtClock(v.endArrivalAt)} 到达终点`),
        h('button', {
          class: 'link-btn', style: 'flex:none',
          onclick: () => { editMode = !editMode; refreshRouteViews(); toast(editMode ? '编辑模式：可移除/锁定/换序' : '已退出编辑模式'); },
        }, editMode ? '完成编辑' : '调整站点')),
      h('div', { class: 'timeline' }));
    const tl = card.querySelector('.timeline');
    v.stops.forEach((s, i) => {
      const leg = v.legs[i]; // 到站路段
      const item = h('div', { class: 'tl-item' },
        h('div', { class: 'tl-rail' },
          h('div', { class: 'tl-num' }, i + 1),
          i < v.stops.length - 1 || v.legs[v.stops.length] ? h('div', { class: 'tl-line' }) : null),
        h('div', { class: 'tl-body' },
          h('div', { class: 'tl-name' }, s.name,
            s.locked ? h('span', { class: 'tag lock' }, '已锁定') : null,
            s.ticketCny === null ? h('span', { class: 'tag warn' }, '费用未知') : null),
          h('div', { class: 'tl-meta' },
            `${fmtClock(s.arrivalAt)} 到达 · 建议停留 ${fmtMin(s.dwellSec)}${s.waitSec > 60 ? ' · 需等待开门 ' + fmtMin(s.waitSec) : ''}`),
          h('div', { class: 'tl-tags' }, s.tags.map((t) => h('span', { class: 'tag' }, t)),
            h('span', { class: 'tag' }, s.indoor ? '室内' : '露天')),
          h('div', { class: 'tl-actions' },
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openStopDetail(v, s, i) }, '详情 · 讲解'),
            editMode ? h('button', { class: 'btn btn-ghost btn-sm', disabled: i === 0, onclick: () => reorderStop(v, i, -1) }, '↑') : null,
            editMode ? h('button', { class: 'btn btn-ghost btn-sm', disabled: i === v.stops.length - 1, onclick: () => reorderStop(v, i, 1) }, '↓') : null,
            editMode ? h('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: () => toggleLock(v, s),
            }, s.locked ? '解锁' : '锁定') : null,
            editMode && !s.locked ? h('button', { class: 'btn btn-danger btn-sm', onclick: () => removeStop(v, s) }, '移除') : null),
          leg && i === 0 ? h('div', { class: 'tl-leg' }, `从起点步行 ${fmtKm(leg.distanceM)} · 约 ${fmtMin(leg.travelSec)}`) : null,
          v.legs[i + 1] && i < v.stops.length - 1 ? h('div', { class: 'tl-leg' }, `去下一站：步行 ${fmtKm(v.legs[i + 1].distanceM)} · 约 ${fmtMin(v.legs[i + 1].travelSec)}`) : null,
          i === v.stops.length - 1 && v.legs[v.stops.length] ? h('div', { class: 'tl-leg' }, `返回终点：步行 ${fmtKm(v.legs[v.stops.length].distanceM)} · 约 ${fmtMin(v.legs[v.stops.length].travelSec)}（含 ${fmtMin(v.totals.bufferSec)} 机动时间）`) : null));
      tl.append(item);
    });
    timelineBox.append(card);
  }

  async function openStopDetail(v, s) {
    const box = h('div', {});
    box.append(...[
      h('div', { class: 'tl-meta', style: 'margin-bottom:6px' }, '为何推荐：' + s.whyText),
      s.openWindows ? h('div', { class: 'tl-meta' }, '开放依据：' + s.openWindows.map((w) => w.join('-')).join(' / ') + '（见来源）') : null,
      s.costNote ? h('div', { class: 'tl-meta', style: 'color:var(--warn)' }, '费用：' + s.costNote) : null,
    ].filter(Boolean));
    const guideBox = h('div', { class: 'guide-block' }, '讲解加载中…');
    box.append(guideBox);
    openSheet(s.name, box);
    try {
      const g = await get(`/v1/guides/${s.poiId}?planId=${planId}`);
      guideBox.innerHTML = '';
      guideBox.append(
        h('div', { style: 'font-weight:600;margin-bottom:4px' }, '眼前看什么'),
        h('div', {}, g.summary),
        h('div', { style: 'font-weight:600;margin:10px 0 4px' }, '简短讲解（约 30-60 秒）'),
        h('div', {}, g.shortScript),
        h('details', { style: 'margin-top:10px' },
          h('summary', { style: 'cursor:pointer;color:var(--green)' }, '深入了解（含来源）'),
          h('div', { style: 'margin-top:6px' }, g.detail),
          g.claims.map((c) => h('div', { class: 'tl-meta' }, `• ${c.text}${c.legend ? '（传说）' : ''} —— ${c.evidenceTitle || '来源未知'}`)),
          h('div', { class: 'src' }, '来源：' + g.sources.map((x) => x.title).join('；')),
          g.unverified ? h('div', { class: 'src', style: 'color:var(--warn)' }, '⚠ 本讲解为 AI 生成，未经资料核验，仅供参考' ) : null,
          g.demo ? h('div', { class: 'src', style: 'color:var(--warn)' }, '演示内容：点位与事实为虚构数据' ) : null));
    } catch (e) {
      guideBox.textContent = e.code === 'NOT_FOUND' ? '讲解准备中，稍后可查看' : e.message;
    }
  }

  /* ---- 编辑动作（§10.3：产生修改请求 → 重算 → 确认替换） ---- */
  async function submitEdit(edits) {
    try {
      const r = await post(`/v1/plans/${planId}/edits`, { baseRouteId: selRouteId, edits });
      toast('正在重新计算…');
      const un = subscribeJob(r.jobId, (evt) => {
        if (evt.type === 'route.ready') {
          un();
          toast('已生成新版本：' + (evt.payload.diffLines || []).join('；'));
          loadPlan(true, evt.payload.routeId);
        } else if (evt.type === 'job.failed') {
          un();
          toast(evt.payload.message || '修改后不可行，已保留原路线', 4000);
        }
      });
      cleanupFns.push(un);
    } catch (e) { toast(e.message); }
  }
  function removeStop(v, s) { submitEdit({ removeStopIds: [s.poiId] }); }
  function toggleLock(v, s) { submitEdit(s.locked ? { unlockStopIds: [s.poiId] } : { lockStopIds: [s.poiId] }); }
  function reorderStop(v, i, dir) {
    const order = v.stops.map((s) => s.entranceNodeId);
    const j = i + dir;
    [order[i], order[j]] = [order[j], order[i]];
    submitEdit({ reorder: order });
  }

  function renderBottom(v) {
    bottomBar.classList.remove('hidden');
    bottomBar.innerHTML = '';
    if (v.status === 'infeasible') return;
    // 条件性提示作为操作条内的整行（不再绝对定位悬浮遮挡时间轴）
    if (v.status === 'conditional') {
      bottomBar.append(h('div', { class: 'cond-note' },
        h('span', { class: 'tag warn' }, '条件性方案：有待确认项，详见警告')));
    }
    const startBtn = h('button', { class: 'btn btn-primary', onclick: () => startTrip(v) }, '开始游览');
    bottomBar.append(startBtn);
  }

  /** 把冲突建议变成可执行的动作：能直接改条件的就地重算，需要用户选的才回首页 */
  async function applySuggestion(s) {
    const d = state.draft;
    if (s.action === 'start_next_morning' || s.action === 'start_at_clock') {
      const clock = s.startAtClock || '09:00';
      const [hh, mm] = clock.split(':').map(Number);
      const at = new Date();
      at.setHours(hh, mm, 0, 0);
      if (at.getTime() <= Date.now() + 60000) at.setDate(at.getDate() + 1); // 今天已过 → 明天
      d.startMode = 'later';
      d.startAtMs = at.getTime();
      d.timeMode = 'duration';
      saveDraftSafe();
      toast('已改为 ' + clock + ' 出发，正在重新规划…');
      return replan();
    }
    if (s.action === 'switch_scene') {
      d.scene = 'wander';
      d.venueId = null;
      d.venueRef = null;
      saveDraftSafe();
      toast('已改为周边闲逛，正在重新规划…');
      return replan();
    }
    if (s.action === 'extend_time') {
      d.durationSec = Math.min(28800, d.durationSec + 1800);
      saveDraftSafe();
      toast('预算增加 30 分钟，正在重新规划…');
      return replan();
    }
    if (s.action === 'change_endpoint' || s.action === 'change_endpoint_flexible') {
      const ep = (s.patch && s.patch.endpoint) || null;
      if (s.action === 'change_endpoint_flexible' || !ep || ep.mode === 'flexible') {
        d.endpointMode = 'flexible';
        d.endpointPoint = null; d.endpointLabel = null;
        d.endpointEntranceId = null; d.endpointPoiId = null;
      } else {
        d.endpointMode = 'fixed';
        d.endpointPoint = ep.point || null;
        d.endpointLabel = ep.label || '指定终点';
        d.endpointEntranceId = ep.entranceId || null;
        d.endpointPoiId = ep.poiId || null;
      }
      saveDraftSafe();
      toast('已调整终点，正在重新规划…');
      return replan();
    }
    if (s.action === 'substitute_poi' || s.action === 'prune_low_yield') {
      const hard = (s.patch && s.patch.hard) || {};
      const pois = (s.patch && s.patch.pois) || {};
      const mergePois = (list, ids, meta) => {
        const known = new Map((list || []).map((x) => [x.id, x]));
        const extra = new Map((meta || []).map((x) => [x.id, x]));
        return ids.map((id) => known.get(id) || extra.get(id) || { id, name: id });
      };
      if (Array.isArray(hard.mustVisitIds)) d.mustVisit = mergePois(d.mustVisit, hard.mustVisitIds, pois.mustVisit);
      if (Array.isArray(hard.avoidPoiIds)) d.avoid = mergePois(d.avoid, hard.avoidPoiIds, pois.avoid);
      saveDraftSafe();
      toast(s.action === 'substitute_poi' ? '已替换冲突点位，正在重新规划…' : '已避开该点位，正在重新规划…');
      return replan();
    }
    if (s.action === 'allow_commute_backtrack') {
      // 明确允许返程通勤折返（覆盖文本里"不重复"的解析结果）
      d.avoidRepeat = false;
      saveDraftSafe();
      toast('已允许必要的返程折返，正在重新规划…');
      return replan();
    }
    toast('已记录调整方向「' + s.label + '」，请回到首页修改条件');
    location.hash = '#/';
  }

  function saveDraftSafe() {
    try { localStorage.setItem('st_draft_v1', JSON.stringify(state.draft)); } catch (e) {}
  }

  async function replan() {
    try {
      const ni = await post('/v1/intents/normalize', buildIntentPayload(state.draft));
      if (ni.intent.autoResolvedVenue && !state.draft.venueRef) {
        state.draft.venueId = ni.intent.venueId;
        state.draft.venueRef = ni.intent.venueRef;
        saveDraftSafe();
      }
      const plan = await post('/v1/plans', { intentId: ni.intentId, revision: ni.revision, idempotencyKey: 'plan_' + Date.now() });
      location.hash = '#/plan/' + plan.planId;
    } catch (e) { toast(e.message, 3500); }
  }

  async function startTrip(v) {
    try {
      const r = await post('/v1/trips', { routeVersionId: v.routeId });
      if (r.warnings && r.warnings.length) toast(r.warnings[0], 4500);
      location.hash = '#/trip/' + r.trip.id;
    } catch (e) { toast(e.message, 3500); }
  }

  function showConflict(conflict, status) {
    conflictCard.classList.remove('hidden');
    conflictCard.innerHTML = '';
    conflictCard.append(
      h('h3', {}, status === 'needs_clarification' ? '⚠ 需要你确认一个调整' : '⚠ 当前条件下没有可行方案'),
      h('div', { style: 'margin-bottom:8px' }, conflict.message),
      h('div', { class: 'tl-meta', style: 'margin-bottom:8px' }, '可以这样调整：'),
      h('div', { class: 'chips' }, (conflict.suggestions || []).map((s) =>
        h('button', { class: 'chip', onclick: () => applySuggestion(s) }, s.label))),
      h('button', { class: 'btn btn-ghost btn-block', onclick: () => { location.hash = '#/'; } }, '返回修改条件'));
  }

  /** 任务级失败（数据源/服务异常）：停掉进度动画，给出可执行的两个出口 */
  function showFailure(message) {
    taskFailed = true;
    progressCard.classList.add('hidden');
    conflictCard.classList.remove('hidden');
    conflictCard.innerHTML = '';
    conflictCard.append(
      h('h3', {}, '⚠ 规划任务失败'),
      h('div', { style: 'margin-bottom:8px' }, message || '任务执行出错，路线没有生成'),
      h('div', { class: 'tl-meta', style: 'margin-bottom:8px' }, '多为数据源或网络临时问题，可以直接重试；反复失败可回去调整条件'),
      h('div', { class: 'chips' },
        h('button', { class: 'chip', onclick: retryPlan }, '重试'),
        h('button', { class: 'chip', onclick: () => { location.hash = '#/'; } }, '返回修改条件')));
  }

  async function retryPlan() {
    if (!planData || !planData.plan) return;
    const p = planData.plan;
    try {
      toast('正在重试…');
      const r = await post('/v1/plans', {
        intentId: p.intentId, revision: p.intentRevision, idempotencyKey: 'plan_' + Date.now(),
      });
      location.hash = '#/plan/' + r.planId;
    } catch (e) { toast(e.message, 3500); }
  }

  async function loadPlan(keepSel, selectRouteId) {
    const seq = ++loadSeq;
    const data = await get('/v1/plans/' + planId);
    if (seq !== loadSeq) return; // 已有更新的加载在跑，本轮结果作废
    planData = data;
    // 编辑/换序产生的新版本要立刻选中：否则页面继续渲染旧版本，
    // 用户点完 ↑↓ 看到顺序纹丝不动（2026-09-30 修）
    if (selectRouteId && planData.versions.some((v) => v.routeId === selectRouteId)) {
      selRouteId = selectRouteId;
    } else if (!keepSel || !planData.versions.some((v) => v.routeId === selRouteId)) {
      const main = planData.versions.find((v) => v.routeId === planData.plan.mainRouteId) || planData.versions[0];
      selRouteId = main ? main.routeId : null;
    }
    if (planData.plan.status === 'failed') {
      showFailure((planData.plan.error && planData.plan.error.message) || '任务执行出错，路线没有生成');
      return;
    }
    if (['infeasible', 'needs_clarification'].includes(planData.plan.status) && planData.plan.conflict) {
      showConflict(planData.plan.conflict, planData.plan.status);
    }
    // 计划里已经落了 agentTrace / constraintLedger：刷新或重进页面也能回看决策链
    renderStages();
    if (selRouteId) await refreshRouteViews();
  }

  /* ---- 事件流（§9.2：阶段由真实任务事件驱动，不模拟百分比） ---- */
  async function boot() {
    renderStages();
    try {
      await loadPlan();
    } catch (e) {
      progressCard.innerHTML = '';
      progressCard.append(h('div', { class: 'empty' }, e.message));
      return;
    }
    const jobId = planData.plan.currentJobId;
    if (['ready', 'conditional', 'infeasible'].includes(planData.plan.status) && planData.versions.length) {
      STAGE_KEYS.forEach((k) => { stageState[k] = 'done'; });
      renderStages();
    }
    if (!jobId) return;
    if (['completed', 'failed', 'cancelled'].includes(planData.plan.jobStatus)) return;
    unsub = subscribeJob(jobId, async (evt) => {
      const p = evt.payload || {};
      if (evt.type === 'intent.normalized') {
        stageState.intent = 'done'; stageState.candidates = 'active';
        if (p.chips) {
          stageState.confirmText = p.chips.map((c) => c.label).slice(0, 4).join(' · ');
          chipsBar.classList.remove('hidden');
          chipsBar.innerHTML = '';
          chipsBar.append(...p.chips.map((c) => h('span', { class: 'cchip', onclick: () => { location.hash = '#/'; } }, c.label)));
        }
      } else if (evt.type === 'clarification.required') {
        stageState.intent = 'active';
        toast('有需要确认的条件，请返回修改');
      } else if (evt.type === 'candidates.ready') {
        stageState.candidates = 'done'; stageState.route = 'active';
        stageState.candidateInfo = p.count;
        stageState.candidateNames = (p.names || []).slice(0, 3).join('、');
      } else if (evt.type === 'route.ready') {
        stageState.route = 'done'; stageState.alt = 'active'; stageState.guide = 'active';
        await loadPlan();
      } else if (evt.type === 'route.alternative_ready') {
        stageState.alt = 'done';
        await loadPlan(true);
      } else if (evt.type === 'guide.text_ready') {
        stageState.guide = 'active';
        stageState.guideDetail = `讲解就绪 ${p.order}/${p.total}${p.failed ? '（本站失败，可游览中重试）' : ''}`;
        await loadPlan(true);
      } else if (evt.type === 'route.risk_detected') {
        toast(`⚠ 路线风险：${p.name} ${p.reason}`, 5000);
      } else if (evt.type === 'job.failed') {
        if (p.conflict) {
          stageState.route = stageState.route === 'done' ? 'done' : 'active';
          showConflict(p.conflict, (p.proposals && p.proposals.length) ? 'needs_clarification' : 'infeasible');
          renderStages();
        } else {
          // 任务级异常：停表、显示失败卡片（重试 / 返回修改条件）
          showFailure(p.message);
        }
      } else if (evt.type === 'job.completed') {
        STAGE_KEYS.forEach((k) => { if (stageState[k] !== 'done') stageState[k] = 'done'; });
        stageState.done = 'done';
        await loadPlan(true);
      }
      renderStages();
    });
  }

  boot();
  return () => { if (unsub) unsub(); cleanupFns.forEach((f) => f()); };
}

function statusText(s) {
  return s === 'verified' ? '已核验' : s === 'conditional' ? '条件性方案' : '不可行';
}
