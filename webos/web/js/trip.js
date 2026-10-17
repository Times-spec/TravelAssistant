// 游览执行页：下一站优先 + 到站确认 + 快捷重排（提议—确认—提交）+ 讲解播放（§11/§12）
import { get, post, subscribeJob } from './api.js';
import { h, toast, openSheet, closeSheet, SvgMap, makeProjector, fmtMin, fmtKm, fmtClock, loadAmap, AmapRouteMap } from './ui.js';
import { legStates, legendEl, renderSvgRoute, legGuidance, projectOnLeg, activeStepIdx, wgs84ToGcj02, distM, stepIconSvg, roundM } from './routeview.js';
import { state, getVenuePack } from './app.js';
import { drawPackBase, drawMapLabel } from './home.js';

export function renderTrip(view, ctx, tripId) {
  const cleanups = [];
  let tripData = null;
  let watchId = null;
  let arrivalSamples = [];
  let speaking = false;
  let routeMap = null; // 当前高德底图实例：重渲染先销毁旧实例，避免 WebGL 上下文泄漏
  let renderSeq = 0;   // 渲染代际计数：并发 reload（到站/切前台/可见性）时旧渲染作废
  // 地图视角："本段"只看当前要走的这一段 + 我的位置（默认）；"全程"看整条路线。
  // 此前地图永远 fit 全程、所有未走路段同色同粗还带满屏转向箭头，"去下一站怎么走"淹没在全局里。
  let mapMode = 'leg';
  let lastPos = null;   // { pt:[lng,lat] GCJ-02, acc, at }
  let liveHooks = [];   // 定位更新时只刷新这些局部（剩余距离、当前步、到站提示），不整页重绘
  let svgView = null;   // SVG 降级地图的状态（重绘/取景/我的位置）
  const stepRequests = new Map(); // 每个方向的一段只请求一次；失败保留几何导引。

  // 途中调整的可点选项（AI 兜底路径与服务端 cause 一一对应）
  const quick = [
    ['😮‍💨', '我累了', () => quickReplan('fatigue_reported', {}, '将减少剩余步行、增加休息，并提供提前结束选项')],
    ['🌧️', '下雨了', () => quickReplan('rain_reported', {}, '将减少露天路段，优先室内点位')],
    ['⏭️', '这站不去了', pickSkipStop],
    ['⏳', '排队太久', askQueueTime],
    ['🚧', '这里关门了', pickClosedStop],
    ['⌛', '只剩 30 分钟', askDeadline],
    ['🔙', '我要回去了', () => quickReplan('finish_requested', {}, '将计算回到终点的路线')],
    ['➕', '想加一个地方', pickAddStop],
  ];

  const root = h('div', {});
  view.append(root);

  const bottomBar = h('div', { class: 'bottom-bar hidden' });
  document.getElementById('app').append(bottomBar);
  cleanups.push(() => { bottomBar.remove(); stopSpeak(); if (routeMap) { routeMap.destroy(); routeMap = null; } });

  async function reload() {
    tripData = await get('/v1/trips/' + tripId);
    render();
  }

  function visitedSet() {
    return new Set(tripData.events.filter((e) => e.type === 'arrive_confirm').map((e) => e.data.poiId));
  }
  function skippedSet() {
    return new Set(tripData.events.filter((e) => e.type === 'stop_skipped').map((e) => e.data.poiId));
  }
  function nextStop() {
    const route = tripData.route;
    if (!route) return null;
    const v = visitedSet(), s = skippedSet();
    return route.stops.find((st) => !v.has(st.poiId) && !s.has(st.poiId)) || null;
  }
  function currentNodeId() {
    const route = tripData.route;
    const visited = tripData.events.filter((e) => e.type === 'arrive_confirm');
    if (visited.length) {
      const last = visited[visited.length - 1];
      const stop = route.stops.find((st) => st.poiId === last.data.poiId);
      if (stop) return stop.entranceNodeId;
    }
    return route.startNodeId;
  }

  function endNameOf(route) {
    if (route.endApproach && route.endApproach.endName) return route.endApproach.endName;
    return String(route.endLabel || '终点').replace(/^终点：|^返回|^顺路结束于/, '') || '终点';
  }

  async function render() {
    const seq = ++renderSeq; // 重渲染代际：await 之后若已有更新的渲染，本轮作废
    root.innerHTML = '';
    liveHooks = [];
    svgView = null;
    const route = tripData.route;
    const trip = tripData.trip;
    if (!route) { root.append(h('div', { class: 'card empty' }, '路线数据缺失')); return; }
    if (trip.status !== 'active' && trip.status !== 'paused') {
      location.hash = '#/finish/' + tripId;
      return;
    }
    const next = nextStop();
    const v = visitedSet(), s = skippedSet();
    const stopState = (st) => (v.has(st.poiId) ? 'done' : s.has(st.poiId) ? 'skip' : null);

    // 当前这段 = 通往下一站的那段；全部到站后 = 回终点那段
    const nextIdx = next ? route.stops.findIndex((st) => st.poiId === next.poiId) : route.stops.length;
    let curLeg = route.legs[nextIdx] || null;
    if (curLeg && !curLeg.steps?.length && (curLeg.provider || '').startsWith('amap')) {
      const points = curLeg.geometry.coordinates;
      if (points.length >= 2) {
        const key = `${points[0].join(',')}>${points.at(-1).join(',')}`;
        if (!stepRequests.has(key)) {
          stepRequests.set(key, get(`/v1/legs/steps?from=${encodeURIComponent(points[0].join(','))}&to=${encodeURIComponent(points.at(-1).join(','))}`)
            .then((result) => {
              // 只补充同一条步行路径的指令；若高德另选道路，继续按既有折线导引。
              const supplement = { geometry: { coordinates: result.geometry || [] }, distanceM: result.distanceM };
              const aligned = result.geometry?.length >= 2 && result.geometry.every((p) => (projectOnLeg(curLeg, p)?.offM ?? Infinity) <= 50)
                && points.every((p) => (projectOnLeg(supplement, p)?.offM ?? Infinity) <= 50);
              if (result.steps?.length && aligned) {
                stepRequests.set(key, result);
                if (seq === renderSeq) return render();
              } else stepRequests.set(key, null);
            }).catch(() => { stepRequests.set(key, null); }));
        }
        const result = stepRequests.get(key);
        if (result && Array.isArray(result.steps)) {
          curLeg = { ...curLeg, steps: result.steps.map((step) => {
            const p = result.geometry[step.startIdx || 0];
            let startIdx = 0;
            for (let i = 1; i < points.length; i++) if (p && distM(p, points[i]) < distM(p, points[startIdx])) startIdx = i;
            return { ...step, startIdx };
          }) };
        }
      }
    }
    const states = legStates(route, nextIdx);
    const endName = endNameOf(route);
    const target = next
      ? { name: next.name, coord: next.coord, isEnd: false }
      : curLeg ? { name: endName, coord: curLeg.geometry.coordinates[curLeg.geometry.coordinates.length - 1], isEnd: true } : null;

    /* ① 站点进度条：起 → ✓1 → ●2 → 3 → 终（替代原来的一排 chips） */
    root.append(progressStrip(route, stopState, next, endName, trip));

    /* ② 地图：本段/全程切换 + 定位 + 图例 */
    const isDemoMap = route.legs.length && (route.legs[0].provider || '').startsWith('demo');
    const mapWrap = h('div', { class: 'map-wrap trip-map' });
    const mapBox = h('div', { class: 'map-box' });
    const segLeg = h('button', { class: 'seg-btn' }, '本段');
    const segAll = h('button', { class: 'seg-btn' }, '全程');
    const syncSeg = () => { segLeg.classList.toggle('on', mapMode === 'leg'); segAll.classList.toggle('on', mapMode === 'all'); };
    syncSeg();
    const locBtn = h('button', { class: 'map-fab', title: '我的位置', 'aria-label': '我的位置' }, '◎');
    mapWrap.append(mapBox,
      h('div', { class: 'map-seg' }, segLeg, segAll),
      locBtn);
    // 高德地图必须在容器挂载进文档后再创建：脱离文档的容器宽高为 0，
    // AMap 会把画布初始化成 0×0，地图从此一片空白（此前游览页地图空白的根因）
    const legend = legendEl(h, states, [['#1677ff', '下一站'], ['#8a9a92', '已到访']]);
    root.append(mapWrap, legend);

    const mapOpts = () => ({
      states, currentIdx: curLeg ? nextIdx : null, nextPoiId: next ? next.poiId : null, stopState,
      labels: mapMode === 'leg' ? 'key' : 'all', fit: mapMode === 'leg' && curLeg ? 'leg' : 'all',
    });
    let usedAmap = false;
    if (!isDemoMap && state.config.amapJsKey) {
      try {
        const AMap = await loadAmap(state.config.amapJsKey, state.config.amapJsSecurityCode);
        if (seq !== renderSeq) return;
        if (routeMap) { routeMap.destroy(); routeMap = null; } // 到站/暂停/切回前台会重渲染
        const div = h('div', {});
        mapBox.append(div);
        const rm = new AmapRouteMap(div, { AMap, height: 300 });
        routeMap = rm;
        if (lastPos) rm.setUser(lastPos.pt, lastPos.acc);
        rm.renderRoute(route, mapOpts());
        usedAmap = true;
      } catch (e) {
        mapBox.innerHTML = '';
      }
    }
    if (!usedAmap) {
      let pack = null;
      try {
        const planInfo = await get('/v1/plans/' + route.planId);
        pack = await getVenuePack({ id: planInfo.plan.venueId, ref: planInfo.plan.venueRef });
      } catch (e) { /* 真实场所/片区无静态场所包时仅绘制路线 */ }
      if (seq !== renderSeq) return;
      if (pack && (pack.edges || []).some((e) => e.closed)) legend.append(h('span', { class: 'lg-item' }, h('i', { class: 'lg-line', style: 'border-top:2px dashed #d97706' }), '封闭路段'));
      const firstPt = route.legs[0].geometry.coordinates[0];
      const proj = makeProjector(pack ? pack.venue.center : { lng: firstPt[0], lat: firstPt[1] });
      const map = new SvgMap(mapBox, { height: 300 });
      svgView = { map, proj, pack, userEl: null };
      const draw = () => {
        map.clear();
        if (pack) drawPackBase(map, pack, proj, { quiet: true });
        const r = renderSvgRoute(map, route, proj, { ...mapOpts(), drawLabel: drawMapLabel });
        svgView.bounds = r.bounds; svgView.legBounds = r.legBounds; svgView.userEl = null;
        drawSvgUser();
        fitSvg(mapOpts().fit === 'leg' ? nextIdx : null);
      };
      svgView.draw = draw;
      draw();
      mapBox.append(h('div', { class: 'map-note' }, isDemoMap ? '演示地图（虚构场所数据）' : '路网示意图'));
    }
    const setMode = (m) => {
      mapMode = m; syncSeg();
      if (routeMap) routeMap.renderRoute(route, mapOpts());
      else if (svgView) svgView.draw();
    };
    segLeg.onclick = () => setMode('leg');
    segAll.onclick = () => setMode('all');
    locBtn.onclick = () => locateMe();

    /* ③ 到站提示（§11.5：定位辅助提示 + 一键确认；不自动判定） */
    const hintBox = h('div', {});
    root.append(hintBox);

    /* ④ 下一站卡：先说去哪、还有多远，再说到了看什么 */
    const remainEl = h('div', { class: 'ns-dist' });
    const setRemain = (remainM, offM) => {
      const m = remainM ?? (curLeg ? curLeg.distanceM : 0);
      const sec = curLeg && curLeg.distanceM ? Math.round(curLeg.travelSec * (m / curLeg.distanceM)) : 0;
      remainEl.innerHTML = '';
      remainEl.append(...[ // 原生 append 会把 null 变成字符串 "null"，必须先过滤
        h('b', {}, (remainM != null ? '还剩 ' : '') + fmtKm(m)),
        ` · 步行约 ${fmtMin(sec)}`,
        offM != null && offM > 60 ? h('span', { class: 'tag warn', style: 'margin-left:6px' }, `偏离路线约 ${roundM(offM)}`) : null,
      ].filter(Boolean));
    };
    if (next) {
      setRemain(null);
      const teaserSlot = h('div', { class: 'guide-teaser' }, '看点准备中…');
      root.append(h('div', { class: 'card next-stop' },
        h('div', { class: 'ns-kicker' }, `下一站 · 第 ${nextIdx + 1} / ${route.stops.length} 站`,
          next.locked ? h('span', { class: 'tag lock', style: 'margin-left:6px' }, '必去') : null),
        h('h3', { class: 'ns-name' }, next.name),
        curLeg ? remainEl : null,
        teaserSlot,
        h('div', { class: 'tl-meta' }, `建议停留 ${fmtMin(next.dwellSec)}`
          + (next.openWindows ? ' · 开放 ' + next.openWindows.map((w) => w.join('-')).join(' / ') : '')),
        h('button', { class: 'btn btn-primary btn-block', style: 'margin-top:10px', onclick: () => confirmArrive(next) }, '我已到达 ✓'),
        h('div', { class: 'ns-actions' },
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openGuideCard(next) }, '看讲解'),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => askGuide(next) }, '问导游'),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openExternalNav(next) }, '高德导航 ↗')),
        h('div', { id: 'guide-slot' })));
      loadTeaser(next, teaserSlot);   // 到站前就告诉用户"到了看什么"
    } else {
      if (curLeg) setRemain(null);
      root.append(h('div', { class: 'card next-stop done' },
        h('div', { class: 'ns-kicker' }, '所有站点已完成 🎉'),
        h('h3', { class: 'ns-name' }, curLeg ? `去终点「${endName}」` : '可以结束游览了'),
        curLeg ? remainEl : null,
        h('button', { class: 'btn btn-primary btn-block', style: 'margin-top:10px', onclick: finish }, curLeg ? '已到终点，结束游览' : '结束游览'),
        curLeg && target ? h('div', { class: 'ns-actions' },
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openExternalNav({ name: target.name, coord: target.coord }) }, '高德导航 ↗')) : null));
    }

    /* ⑤ 怎么走：当前这段的逐步导引（定位可用时高亮当前一步） */
    let guide = null;
    if (curLeg && target) {
      guide = legGuidance(curLeg, target.name);
      const items = guide.steps.map((st, i) => h('li', { class: 'gs-step' + (st.kind === 'arrive' ? ' arrive' : ''), 'data-i': i },
        (() => { const ic = h('span', { class: 'gs-ico' }); ic.innerHTML = stepIconSvg(st.kind); return ic; })(),
        h('div', { class: 'gs-body' },
          h('div', { class: 'gs-title' }, st.title),
          st.detail ? h('div', { class: 'gs-detail' }, st.detail) : null),
        st.kind !== 'arrive' && st.kind !== 'start' ? h('span', { class: 'gs-at' }, roundM(st.startM) + ' 处') : null));
      const list = h('ol', { class: 'gs-list' }, ...items);
      const markStep = (idx) => items.forEach((li, i) => { li.classList.toggle('active', i === idx); li.classList.toggle('past', i < idx); });
      markStep(0);
      root.append(h('div', { class: 'card guide-steps' },
        h('div', { class: 'row' },
          h('p', { class: 'card-title', style: 'margin:0' }, `怎么走 · ${roundM(guide.totalM)}`),
          h('span', { class: 'gs-src' }, guide.source === 'amap' ? '高德步行指引' : '按路线走向生成 · 以现场路牌为准')),
        list));
      liveHooks.push((pos) => {
        const pr = projectOnLeg(curLeg, pos.pt);
        if (!pr) return;
        if (pr.offM <= 80) markStep(activeStepIdx(guide, pr.alongM));
        setRemain(pr.offM <= 80 ? pr.remainM : null, pr.offM);
      });
    }

    /* 到站 / 到终点的定位提示 */
    if (target) {
      arrivalSamples = [];
      liveHooks.push((pos) => {
        if (pos.acc > 50) return; // 精度不足不提示（§11.5）
        const d = distM(pos.pt, target.coord);
        if (d > 40) { arrivalSamples = []; return; }
        const now = Date.now();
        arrivalSamples.push(now);
        arrivalSamples = arrivalSamples.filter((t) => now - t < 20000); // 持续 20 秒多个合格采样
        if (arrivalSamples.length < 2 || hintBox.hasChildNodes()) return;
        hintBox.append(h('div', { class: 'arrive-hint' },
          target.isEnd ? `📍 你好像已经到终点「${target.name}」附近了` : `📍 你好像已经到「${target.name}」附近了（定位推断，精度约 ${Math.round(pos.acc)}m）`,
          h('div', { style: 'margin-top:6px' },
            h('button', { class: 'btn btn-primary btn-sm', onclick: () => (target.isEnd ? finish() : confirmArrive(next, 'inferred')) }, target.isEnd ? '结束游览' : '是的，我到了'),
            ' ',
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { hintBox.innerHTML = ''; arrivalSamples = []; } }, '还没有'))));
      });
    }

    /* ⑥ 行程单：默认折叠，需要时再展开 */
    const visitedTotal = v.size;
    root.append(h('details', { class: 'card itin' },
      h('summary', {}, `行程单 · 共 ${route.stops.length} 站`, h('span', { class: 'itin-sub' }, `预计 ${fmtClock(route.endArrivalAt)} 到终点`)),
      ...route.stops.map((st, i) => {
        const done = v.has(st.poiId), skip = s.has(st.poiId);
        return h('div', { class: 'poi-result', onclick: () => openGuideCard(st) },
          h('div', { class: 'n', style: skip ? 'text-decoration:line-through;color:var(--ink-2)' : '' },
            `${i + 1}. ${st.name} `,
            done ? h('span', { class: 'tag' }, '已到访') : skip ? h('span', { class: 'tag warn' }, '已跳过') : next && st.poiId === next.poiId ? h('span', { class: 'tag next' }, '下一站') : null),
          h('div', { class: 'a' }, `${fmtClock(st.visitStartAt)} - ${fmtClock(st.departureAt)} · ${st.tags.join('、')}`));
      }),
      h('div', { class: 'poi-result' },
        h('div', { class: 'n' }, `终点 · ${endName}`),
        h('div', { class: 'a' }, `预计 ${fmtClock(route.endArrivalAt)} 到达 · 已到访 ${visitedTotal} 站 · 路线 v${route.version}`))));

    /* 底部操作：调整行程是游览中最常用的动作，放到主按钮位 */
    bottomBar.classList.remove('hidden');
    bottomBar.innerHTML = '';
    bottomBar.append(
      trip.status === 'active'
        ? h('button', { class: 'btn btn-ghost bb-narrow', onclick: pauseTrip }, '暂停')
        : h('button', { class: 'btn btn-ghost bb-narrow', onclick: resumeTrip }, '继续'),
      h('button', { class: 'btn btn-primary', onclick: () => openAdjustSheet() }, '调整行程'),
      h('button', { class: 'btn btn-ghost bb-narrow', onclick: finish }, '结束'));

    ensureWatch();
    if (lastPos) liveHooks.forEach((f) => f(lastPos));
  }

  function progressStrip(route, stopState, next, endName, trip) {
    const nodes = [h('span', { class: 'pg-node pg-end' }, '起')];
    route.stops.forEach((st, i) => {
      const stt = stopState(st);
      const isNext = next && st.poiId === next.poiId;
      nodes.push(h('i', { class: 'pg-link' + (stt || isNext ? ' on' : '') }));
      nodes.push(h('span', { class: 'pg-node' + (stt === 'done' ? ' done' : stt === 'skip' ? ' skip' : isNext ? ' next' : ''), title: st.name },
        stt === 'done' ? '✓' : stt === 'skip' ? '✕' : String(i + 1)));
    });
    nodes.push(h('i', { class: 'pg-link' + (!next ? ' on' : '') }));
    nodes.push(h('span', { class: 'pg-node pg-end' + (!next ? ' next' : ''), title: endName }, '终'));
    const remaining = route.stops.filter((st) => !stopState(st)).length;
    return h('div', { class: 'trip-progress' },
      h('div', { class: 'pg-track' }, ...nodes),
      h('div', { class: 'pg-sub' },
        `剩 ${remaining} 站 · 预计 ${fmtClock(route.endArrivalAt)} 到终点`,
        trip.status === 'paused' ? h('span', { class: 'tag warn', style: 'margin-left:6px' }, '已暂停') : null));
  }

  /* ---- SVG 降级地图：取景与我的位置 ---- */
  function fitSvg(legIdx) {
    if (!svgView) return;
    const b = legIdx != null && svgView.legBounds[legIdx] ? { ...svgView.legBounds[legIdx] } : svgView.pack ? null : { ...svgView.bounds };
    if (!b) return; // 演示场所：全程视角沿用场所底图的取景
    if (legIdx != null && lastPos) {
      const p = svgView.proj.toXY({ lng: lastPos.pt[0], lat: lastPos.pt[1] });
      if (Math.hypot(p.x - (b.minX + b.maxX) / 2, p.y - (b.minY + b.maxY) / 2) < 1500) {
        b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x); b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y);
      }
    }
    svgView.map.fit(b, 50);
  }
  function drawSvgUser() {
    if (!svgView || !lastPos) return;
    const p = svgView.proj.toXY({ lng: lastPos.pt[0], lat: lastPos.pt[1] });
    if (!svgView.userEl) {
      svgView.userHalo = svgView.map.el('circle', { r: 14, fill: '#1677ff', opacity: 0.18 });
      svgView.userEl = svgView.map.el('circle', { r: 6.5, fill: '#1677ff', stroke: '#fff', 'stroke-width': 2.5 });
    }
    for (const el of [svgView.userEl, svgView.userHalo]) { el.setAttribute('cx', p.x); el.setAttribute('cy', p.y); }
  }

  /* ---- 定位：一个持续 watch 服务地图蓝点、剩余距离、当前步与到站提示 ---- */
  function onPosition(pos) {
    const pt = wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude); // 路线是 GCJ-02，设备给的是 WGS84
    lastPos = { pt, acc: pos.coords.accuracy, at: Date.now() };
    if (routeMap) routeMap.setUser(pt, lastPos.acc);
    drawSvgUser();
    liveHooks.forEach((f) => f(lastPos));
  }
  function ensureWatch() {
    if (watchId != null || !navigator.geolocation) return;
    // §5.1-7：开始游览后才启动持续定位；离开页面时清理
    watchId = navigator.geolocation.watchPosition(onPosition, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }
  function locateMe() {
    if (!navigator.geolocation) { toast('当前环境不支持定位'); return; }
    if (lastPos && Date.now() - lastPos.at < 30000) {
      if (routeMap) routeMap.centerUser(); else fitSvg(null);
      return;
    }
    toast('正在定位…', 1500);
    navigator.geolocation.getCurrentPosition((pos) => {
      onPosition(pos);
      if (routeMap) routeMap.centerUser();
    }, () => toast('无法获取定位，请检查定位权限'), { enableHighAccuracy: true, timeout: 10000 });
  }

  /* ---- 到站确认 ---- */
  async function confirmArrive(stop, confirmType = 'manual') {
    try {
      await post(`/v1/trips/${tripId}/events`, {
        eventId: 'arr_' + stop.poiId + '_' + Date.now(),
        type: 'arrive_confirm',
        data: { poiId: stop.poiId },
        confirmType, // manual=高可信；inferred=定位推断（§11.5）
      });
      toast('已记录到访：' + stop.name);
      stopSpeak();
      await reload();
      // 导游行为：到站后直接把讲解端上来，而不是让用户自己找入口
      try { await openGuideCard(stop); } catch (e) { /* 讲解未就绪时静默 */ }
    } catch (e) { toast(e.message); }
  }

  function openExternalNav(stop) {
    // §12.5：外部导航只表达"导航到下一站"，不宣称会完整执行原线路
    const url = `https://uri.amap.com/navigation?to=${stop.coord[0]},${stop.coord[1]},${encodeURIComponent(stop.name)}&mode=walk&coordinate=gcj02&callnative=1`;
    toast('将打开高德导航到下一站（外部地图按自身规则算路）');
    window.open(url, '_blank');
  }

  /* ---- 讲解（§11.4：手动点击播放；自动播放不假设可用） ---- */
  let utter = null;
  function stopSpeak() {
    speaking = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    utter = null;
  }
  /* ---- 导游能力：到站前看点预告 / 到站讲解 / 现场问答 / 记一笔 ---- */
  const guideCache = new Map();
  async function loadGuide(stop) {
    if (guideCache.has(stop.poiId)) return guideCache.get(stop.poiId);
    const p = get(`/v1/guides/${stop.poiId}?planId=${tripData.route.planId}`).catch(() => null);
    guideCache.set(stop.poiId, p);
    return p;
  }
  async function loadTeaser(stop, slot) {
    const g = await loadGuide(stop);
    if (!g) { slot.textContent = '这个点位暂无已核验讲解，到了可以先看现场标识，或用「问导游」试试'; return; }
    const first = (g.summary || '').split(/[。；]/)[0];
    slot.innerHTML = '';
    // 注意：原生 append 会把 null 变成字符串 "null"，必须先过滤
    slot.append(...[
      h('span', { class: 'tag' }, '到了看什么'),
      first ? first + '。' : '讲解已就绪，点「看讲解」查看',
      g.unverified ? h('span', { class: 'tag warn', style: 'margin-left:6px' }, 'AI 生成未核验') : null,
    ].filter(Boolean));
  }

  async function openGuideCard(stop) {
    const box = h('div', {});
    openSheet(stop.name + ' · 讲解', box);
    const g = await loadGuide(stop);
    if (!g) {
      box.append(h('div', { class: 'empty' }, '这个点位还没有已核验的讲解资料。可以点「问导游」提问，我会如实告诉你有没有资料。'));
      return;
    }
    const speakBtn = h('button', { class: 'btn btn-primary btn-sm' }, '▶ 听讲解');
    speakBtn.onclick = () => {
      if (speaking) { stopSpeak(); speakBtn.textContent = '▶ 听讲解'; return; }
      if (!window.speechSynthesis) { toast('当前环境不支持语音合成，请阅读文本'); return; }
      try {
        utter = new SpeechSynthesisUtterance((g.summary || '') + '。' + (g.shortScript || ''));
        utter.lang = 'zh-CN';
        utter.onend = () => { speaking = false; speakBtn.textContent = '▶ 听讲解'; };
        window.speechSynthesis.speak(utter);
        speaking = true; speakBtn.textContent = '⏸ 停止';
      } catch (e) { toast('播放失败，请阅读文本'); }
    };
    const claimNodes = (g.claims || []).map((c, i) => h('div', { class: 'highlight-item' },
      h('div', { class: 'h-teaser' }, '[' + (i + 1) + '] ' + c.text,
        c.legend ? h('span', { class: 'tag warn', style: 'margin-left:4px' }, '传说') : null),
      c.evidenceTitle ? h('div', { class: 'src' }, '来源：' + c.evidenceTitle) : null));
    box.append(
      h('div', { class: 'guide-block' },
        h('div', { style: 'font-weight:600;margin-bottom:4px' }, '眼前看什么'),
        h('div', {}, g.summary || '（暂无）')),
      h('div', { class: 'guide-block', style: 'margin-top:8px' },
        h('div', { style: 'font-weight:600;margin-bottom:4px' }, '简短讲解'),
        h('div', {}, g.shortScript || '（暂无）')));
    if (claimNodes.length) {
      box.append(h('div', { style: 'margin-top:10px' },
        h('div', { style: 'font-weight:600;margin-bottom:6px' }, '看点与典故'), ...claimNodes));
    }
    if (g.detail) {
      box.append(h('details', { style: 'margin-top:8px' },
        h('summary', { style: 'cursor:pointer;color:var(--green)' }, '深入了解'),
        h('div', { class: 'guide-block' }, g.detail)));
    }
    box.append(...[
      h('div', { class: 'row', style: 'margin-top:10px' }, speakBtn,
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { closeSheet(); addNote(stop); } }, '记一笔')),
      h('div', { class: 'src', style: 'margin-top:8px' }, '来源：' + (g.sources || []).map((x) => x.title).join('；')),
      g.unverified ? h('div', { class: 'src', style: 'color:var(--warn)' }, '⚠ 本讲解为 AI 生成，未经资料核验，仅供参考') : null,
    ].filter(Boolean));
  }

  /** 现场问答：只依据该点位已核验资料回答；没有资料就如实说 */
  function askGuide(stop) {
    const input = h('input', { placeholder: '想问点什么？例如：这里有什么典故？' });
    const ansBox = h('div', {});
    const btn = h('button', { class: 'btn btn-primary btn-sm' }, '问');
    const ask = async () => {
      const q = input.value.trim();
      if (!q) { toast('先输入想问的问题'); return; }
      btn.disabled = true;
      ansBox.innerHTML = '';
      ansBox.append(h('div', { class: 'empty' }, '导游正在查资料…'));
      try {
        const r = await post('/v1/ai/ask', { tripId, planId: tripData.route.planId, poiId: stop.poiId, poiName: stop.name, question: q });
        ansBox.innerHTML = '';
        ansBox.append(h('div', { class: 'ask-answer' },
          r.answer,
          h('div', { class: 'src' }, r.notice || (r.hasMaterial ? '回答仅依据该点位的已核验讲解资料' : '暂无已核验资料')),
          (r.usedClaims && r.usedClaims.length)
            ? h('div', { class: 'src' }, '依据：' + r.usedClaims.map((c) => c.text.slice(0, 24)).join('；'))
            : null,
          (r.sources && r.sources.length) ? h('div', { class: 'src' }, '资料：' + r.sources.map((x) => x.title).join('；')) : null));
      } catch (e) {
        ansBox.innerHTML = '';
        ansBox.append(h('div', { class: 'ask-answer' }, '问不出来：' + e.message));
      } finally { btn.disabled = false; }
    };
    btn.onclick = ask;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
    openSheet('问导游 · ' + stop.name, h('div', {},
      h('div', { class: 'tl-meta' }, '只依据该点位已核验的讲解资料回答；资料里没有的，我会直接说没有。'),
      h('div', { class: 'ask-row' }, input, btn),
      ansBox,
      h('div', { class: 'chips', style: 'margin-top:10px' },
        ['这里有什么值得看的？', '有什么典故或传说？', '大概要逛多久？'].map((q) =>
          h('button', { class: 'chip', onclick: () => { input.value = q; ask(); } }, q)))));
  }

  /** 刚离开的那一站（已确认到访的最后一站）：写笔记默认记在它名下 */
  function lastVisitedStop() {
    const route = tripData.route;
    const visits = tripData.events.filter((e) => e.type === 'arrive_confirm');
    if (!visits.length) return null;
    const last = visits[visits.length - 1];
    return route.stops.find((st) => st.poiId === last.data.poiId) || null;
  }

  /** 记一笔：现场感受默认记在"刚逛完的那站"名下（写的是刚看到的，不是要去的） */
  function addNote(stop) {
    const visited = lastVisitedStop();
    const target = visited || stop;
    const ta = h('textarea', { class: 'input', style: 'min-height:70px', placeholder: '写一句此刻的感受，例如：湖边的风很舒服，看到两只白鹭' });
    openSheet('记一笔 · ' + target.name + (visited ? '（刚逛完）' : '（即将前往）'), h('div', {},
      ta,
      h('button', {
        class: 'btn btn-primary btn-block', style: 'margin-top:8px',
        onclick: async () => {
          const text = ta.value.trim();
          if (!text) { toast('写点什么吧'); return; }
          try {
            await post(`/v1/trips/${tripId}/events`, {
              eventId: 'note_' + target.poiId + '_' + Date.now(), type: 'note',
              data: { poiId: target.poiId, text },
            });
            closeSheet(); toast('已记下这一笔');
          } catch (e) { toast(e.message); }
        },
      }, '保存')));
  }

  /* ---- 调整行程弹层：AI 一句话 + 按钮兜底 ---- */
  function openAdjustSheet() {
    const input = h('textarea', {
      class: 'ai-input', style: 'min-height:62px;border-bottom:1px dashed var(--line)',
      placeholder: '说说想怎么调整，例如：我有点累了 / 跳过下一站 / 再加一个地方 / 五点前必须走',
    });
    const aiBtn = h('button', { class: 'btn btn-primary btn-block', style: 'margin-top:8px' }, '让 AI 安排');
    const reply = h('div', { class: 'tl-meta', style: 'margin-top:6px' });
    aiBtn.onclick = async () => {
      const text = input.value.trim();
      if (!text) { toast('先说一句想怎么调整'); return; }
      aiBtn.disabled = true; aiBtn.textContent = 'AI 正在理解…';
      try {
        const r = await post('/v1/ai/command', { text, tripId });
        reply.textContent = r.reply || '';
        if (r.action === 'replan') {
          const data = {};
          if (r.data.poiId) { data.poiId = r.data.poiId; data.reason = 'user_command'; }
          if (r.data.extraWaitMin) data.extraWaitMin = r.data.extraWaitMin;
          if (r.data.newLatestEndClock) data.newLatestEndClock = r.data.newLatestEndClock;
          closeSheet();
          if (r.cause === 'stop_skipped' && !data.poiId) { pickSkipStop(); return; }
          if (r.cause === 'closure_reported' && !data.poiId) { pickClosedStop(); return; }
          if (r.cause === 'stop_add_requested' && !data.poiId) { pickAddStop(); return; }
          if (r.cause === 'queue_reported' && !data.extraWaitMin) { askQueueTime(); return; }
          if (r.cause === 'deadline_changed' && !data.newLatestEndClock) { askDeadline(); return; }
          quickReplan(r.cause, data, null);
        } else if (!r.reply) {
          reply.textContent = '没太理解，试试"我累了""跳过下一站""再加一个地方"';
        }
      } catch (e) {
        reply.textContent = e.message;
      } finally {
        aiBtn.disabled = false; aiBtn.textContent = '让 AI 安排';
      }
    };
    openSheet('调整行程', h('div', {},
      input,
      h('div', { class: 'tl-meta', style: 'margin-top:6px' }, 'AI 只做行程调整与解答，不会擅自改你的锁定站点'),
      aiBtn, reply,
      h('div', { class: 'field-label', style: 'margin-top:14px' }, '或者直接点'),
      h('div', { class: 'quick-grid' }, quick.map(([e, name, fn]) =>
        h('button', { class: 'quick-btn', onclick: () => { closeSheet(); fn(); } }, h('span', { class: 'e' }, e), name)))));
  }

  /* ---- 快捷重排 ---- */
  function quickReplan(cause, data, confirmText) {
    const doIt = async () => {
      closeSheet();
      toast('正在重排剩余行程…');
      try {
        const r = await post(`/v1/trips/${tripId}/replans`, {
          baseRouteId: tripData.trip.activeRouteVersionId,
          cause, data, currentNodeId: currentNodeId(),
        });
        watchReplanJob(r.jobId);
      } catch (e) {
        if (e.code === 'LOCKED_STOP_SKIP') {
          openSheet('确认跳过锁定点？', h('div', {},
            h('p', {}, e.message),
            h('button', {
              class: 'btn btn-primary btn-block',
              onclick: () => { closeSheet(); quickReplan(cause, { ...data, confirmedUnlock: true }, null); },
            }, '确认放弃锁定并跳过')));
        } else {
          toast(e.message, 3500);
        }
      }
    };
    if (confirmText) {
      openSheet('确认调整', h('div', {},
        h('p', {}, confirmText),
        h('button', { class: 'btn btn-primary btn-block', onclick: doIt }, '确认'),
        h('button', { class: 'btn btn-ghost btn-block', onclick: closeSheet }, '取消')));
    } else doIt();
  }

  function watchReplanJob(jobId) {
    const un = subscribeJob(jobId, (evt) => {
      const p = evt.payload || {};
      if (evt.type === 'route.alternative_ready' && p.isReplanProposal) {
        un();
        showProposal(p);
      } else if (evt.type === 'job.failed') {
        un();
        toast(p.message || '重排后不可行，保留当前路线', 4500);
      }
    });
    cleanups.push(un);
  }

  function showProposal(p) {
    // §12.3：差异可见，用户确认后才切换
    openSheet('调整方案（确认后生效）', h('div', {},
      h('ul', { class: 'diff-list' }, (p.diffLines || []).map((l) => h('li', {}, l))),
      h('div', { class: 'tl-meta', style: 'margin-bottom:10px' },
        `新方案：${p.summary.stopCount} 站 · ${fmtKm(p.summary.distanceM)} · ${p.summary.endLabel}`),
      h('button', {
        class: 'btn btn-primary btn-block',
        onclick: async () => {
          try {
            await post(`/v1/trips/${tripId}/replans/${p.proposalId}/accept`, {
              baseVersionId: tripData.trip.activeRouteVersionId,
              idempotencyKey: 'acc_' + Date.now(),
            });
            closeSheet();
            toast('已切换到新路线');
            stopSpeak();
            await reload();
          } catch (e) {
            if (e.code === 'ROUTE_VERSION_CONFLICT') {
              closeSheet();
              toast('路线已在别处更新，正在刷新…');
              await reload();
            } else toast(e.message);
          }
        },
      }, '接受新路线'),
      h('button', { class: 'btn btn-ghost btn-block', onclick: () => { closeSheet(); toast('已保留原路线'); } }, '保留原路线')));
  }

  function remainingStops() {
    const v = visitedSet(), s = skippedSet();
    return tripData.route.stops.filter((st) => !v.has(st.poiId) && !s.has(st.poiId));
  }
  function pickSkipStop() {
    openSheet('跳过哪一站？', h('div', {}, remainingStops().map((st) =>
      h('div', {
        class: 'poi-result',
        onclick: () => { closeSheet(); quickReplan('stop_skipped', { poiId: st.poiId, reason: 'user_skip' }, `将跳过「${st.name}」并重排剩余行程`); },
      }, h('div', { class: 'n' }, st.name, st.locked ? h('span', { class: 'tag lock' }, ' 必去') : null)))));
  }
  function pickClosedStop() {
    openSheet('哪个点位关闭了？（仅影响你的行程，核验前不会传播）', h('div', {}, remainingStops().map((st) =>
      h('div', {
        class: 'poi-result',
        onclick: () => { closeSheet(); quickReplan('closure_reported', { poiId: st.poiId }, `将从你的行程中排除「${st.name}」`); },
      }, h('div', { class: 'n' }, st.name)))));
  }
  function askQueueTime() {
    const input = h('input', { class: 'input', type: 'number', min: 5, max: 120, value: 20 });
    openSheet('预计还要排多久？', h('div', {},
      h('div', { class: 'field-label' }, '预计等待（分钟）'),
      input,
      h('button', {
        class: 'btn btn-primary btn-block', style: 'margin-top:10px',
        onclick: () => { const m = Number(input.value) || 20; closeSheet(); quickReplan('queue_reported', { extraWaitMin: m }, null); },
      }, '重新计算时间')));
  }
  function askDeadline() {
    const now = new Date(Date.now() + 30 * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    const input = h('input', { class: 'input', type: 'time', value: `${pad(now.getHours())}:${pad(now.getMinutes())}` });
    openSheet('新的最晚结束时间', h('div', {},
      h('div', { class: 'field-label' }, '最晚几点前到终点'),
      input,
      h('button', {
        class: 'btn btn-primary btn-block', style: 'margin-top:10px',
        onclick: () => { closeSheet(); quickReplan('deadline_changed', { newLatestEndClock: input.value }, null); },
      }, '以此重新规划')));
  }
  function pickAddStop() {
    const input = h('input', { class: 'input', placeholder: '搜索想去的点位…' });
    const list = h('div', {});
    input.addEventListener('input', async () => {
      const q = input.value.trim();
      if (!q) return;
      const r = await get(`/v1/places/search?q=${encodeURIComponent(q)}`);
      list.innerHTML = '';
      for (const item of r.results.filter((x) => x.kind === 'poi')) {
        list.append(h('div', {
          class: 'poi-result',
          onclick: () => { closeSheet(); quickReplan('stop_add_requested', { poiId: item.id }, null); },
        }, h('div', { class: 'n' }, item.name), h('div', { class: 'a' }, item.address)));
      }
    });
    openSheet('想加一个地方', h('div', {}, input, list));
  }

  /* ---- 暂停/继续/结束 ---- */
  async function pauseTrip() {
    await post(`/v1/trips/${tripId}/events`, { type: 'trip_paused', data: {} });
    toast('已暂停（Web 版为前台助手，切后台不保证持续记录）');
    reload();
  }
  async function resumeTrip() {
    await post(`/v1/trips/${tripId}/events`, { type: 'trip_resumed', data: {} });
    reload();
  }
  async function finish() {
    openSheet('结束本次游览？', h('div', {},
      h('p', {}, '结束后将生成本次行程回顾'),
      h('button', {
        class: 'btn btn-primary btn-block',
        onclick: async () => {
          closeSheet();
          try {
            await post(`/v1/trips/${tripId}/finish`, { idempotencyKey: 'fin_' + Date.now() });
            stopSpeak();
            location.hash = '#/finish/' + tripId;
          } catch (e) { toast(e.message); }
        },
      }, '结束并生成回顾'),
      h('button', { class: 'btn btn-ghost btn-block', onclick: closeSheet }, '再逛一会儿')));
  }

  /* ---- 返回恢复（§12.5：visibilitychange/pageshow 触发状态恢复） ---- */
  const onVisible = () => { if (!document.hidden) reload().catch(() => {}); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onVisible);
  cleanups.push(() => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pageshow', onVisible);
    if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  });

  reload().catch((e) => root.append(h('div', { class: 'card empty' }, e.message)));
  return () => cleanups.forEach((f) => f());
}
