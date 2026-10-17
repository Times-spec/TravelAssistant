// 路线展示与逐步导引（规划页 / 游览页共用，2026-10-18）
//
// 解决三件事：
//  1. 路段状态统一口径：已走 / 当前这段 / 后续 / 回终点 —— 颜色、线宽、线型、箭头一套规则，
//     地图、图例、导引卡片都从这里取，不再各写各的（此前所有未走路段一律橙色粗线 + 满屏转向箭头）。
//  2. 逐步导引："到下一站怎么走"：优先用高德步行指令（leg.steps），没有时按路线折线几何合成
//     "出发向东北直行 120m → 左转直行 80m → 到达"。
//  3. 定位进度：GPS(WGS84) 转 GCJ-02 后投影到当前路段折线，得到"已走/剩余多少米、当前该做哪一步"。

/* ---------------- 路段状态与配色 ---------------- */
export const LEG_STYLE = {
  // 规划页（还没出发）：只区分"游览段"和"回终点"
  plan:    { color: '#0f6f4f', weight: 6, dashed: false, opacity: 0.92, dir: true,  z: 30, label: '游览路线' },
  planEnd: { color: '#5b8def', weight: 5, dashed: true,  opacity: 0.85, dir: false, z: 20, label: '末站→终点' },
  // 游览页
  walked:   { color: '#9aa7a1', weight: 4, dashed: true,  opacity: 0.55, dir: false, z: 10, label: '已走过' },
  current:  { color: '#1677ff', weight: 8, dashed: false, opacity: 1,    dir: true,  z: 60, label: '当前这段' },
  upcoming: { color: '#2f9e6e', weight: 5, dashed: false, opacity: 0.55, dir: false, z: 30, label: '后续路段' },
  ret:      { color: '#2f9e6e', weight: 4, dashed: true,  opacity: 0.5,  dir: false, z: 25, label: '回终点' },
};

/**
 * 每段路的状态。legs[i] 通向 stops[i]，末尾 isReturnLeg 的一段通向终点。
 * nextIdx：下一站在 stops 中的下标；全部到站时 = stops.length（当前段 = 回终点那段）。
 * nextIdx 为 null 表示规划页（没有"已走/当前"）。
 */
export function legStates(route, nextIdx) {
  return route.legs.map((leg, i) => {
    if (nextIdx == null) return leg.isReturnLeg ? 'planEnd' : 'plan';
    if (i < nextIdx) return 'walked';
    if (i === nextIdx) return 'current';
    return leg.isReturnLeg ? 'ret' : 'upcoming';
  });
}

/** 地图下方的图例（只列出本图实际出现的状态） */
export function legendEl(h, states, extra = []) {
  const order = ['walked', 'current', 'upcoming', 'ret', 'plan', 'planEnd'];
  const seen = order.filter((k) => states.includes(k));
  return h('div', { class: 'map-legend' },
    ...seen.map((k) => {
      const s = LEG_STYLE[k];
      return h('span', { class: 'lg-item' },
        h('i', { class: 'lg-line', style: `border-top:${Math.max(3, Math.round(s.weight / 1.6))}px ${s.dashed ? 'dashed' : 'solid'} ${s.color};opacity:${Math.max(0.7, s.opacity)}` }),
        s.label);
    }),
    ...extra.map(([dotColor, text]) => h('span', { class: 'lg-item' }, h('i', { class: 'lg-dot', style: `background:${dotColor}` }), text)));
}

/* ---------------- 几何工具 ---------------- */
const M_LAT = 110940;
const mLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
export function distM(a, b) {
  const k = mLng((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * M_LAT);
}
function dedupe(coords) {
  const out = [];
  for (const c of coords || []) {
    const l = out[out.length - 1];
    if (!l || Math.abs(l[0] - c[0]) > 1e-9 || Math.abs(l[1] - c[1]) > 1e-9) out.push(c);
  }
  return out;
}
const bearingOf = (a, b) => (Math.atan2((b[0] - a[0]) * mLng(a[1]), (b[1] - a[1]) * M_LAT) * 180 / Math.PI + 360) % 360;
const COMPASS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const compassOf = (deg) => COMPASS[Math.round(deg / 45) % 8];

/**
 * 折线上的岔口级转向：方向变化 ≥ turnDeg 且前后两段都不短于 minSegM；近邻合并防曲线连发。
 * 返回 { idx（顶点下标）, coord, delta（>0 左转）, bearingOut, big }
 */
export function polylineTurns(coordsIn, { minSegM = 14, turnDeg = 40, bigDeg = 72, mergeM = 30 } = {}) {
  const pts = dedupe(coordsIn);
  if (pts.length < 3) return [];
  const turns = [];
  for (let i = 1; i < pts.length - 1; i++) {
    if (distM(pts[i - 1], pts[i]) < minSegM || distM(pts[i], pts[i + 1]) < minSegM) continue;
    const b1 = bearingOf(pts[i - 1], pts[i]), b2 = bearingOf(pts[i], pts[i + 1]);
    let delta = b1 - b2; // 罗盘角顺时针为正 → 左转为正
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    if (Math.abs(delta) < turnDeg) continue;
    turns.push({ idx: i, coord: pts[i], delta, bearingOut: b2, big: Math.abs(delta) >= bigDeg });
  }
  const merged = [];
  for (const t of turns) {
    const prev = merged[merged.length - 1];
    if (prev && distM(prev.coord, t.coord) < mergeM) {
      if (Math.abs(t.delta) > Math.abs(prev.delta)) merged[merged.length - 1] = t;
      continue;
    }
    merged.push(t);
  }
  return merged;
}
export const turnWord = (delta) => {
  const a = Math.abs(delta);
  if (a >= 150) return '掉头';
  const side = delta > 0 ? '左' : '右';
  return a >= 72 ? side + '转' : '向' + side + '前方';
};

/** 折线累计里程（米） */
function cumulative(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + distM(pts[i - 1], pts[i]));
  return acc;
}

/**
 * 当前段的逐步导引。
 * 返回 { source: 'amap'|'geometry', totalM, steps: [{ kind, title, detail, startM, coord }] }
 * kind: start | left | right | slight-left | slight-right | uturn | straight | arrive
 */
export function legGuidance(leg, toName) {
  const pts = dedupe(leg && leg.geometry && leg.geometry.coordinates);
  const acc = cumulative(pts);
  const geomM = acc[acc.length - 1] || 0;
  const totalM = Math.round(leg.distanceM || geomM);
  const scale = geomM > 0 ? totalM / geomM : 1; // 几何长度 → 服务端公布的步行距离
  const arrive = { kind: 'arrive', title: `到达「${toName}」`, detail: '', startM: totalM, coord: pts[pts.length - 1] || null };
  const kindOf = (w) => (/掉头/.test(w) ? 'uturn' : /左前|向左前/.test(w) ? 'slight-left' : /右前|向右前/.test(w) ? 'slight-right' : /左/.test(w) ? 'left' : /右/.test(w) ? 'right' : 'straight');

  if (Array.isArray(leg.steps) && leg.steps.length) {
    // 高德步行指令：action 描述的是"这一步走完后"的动作，所以第 i 步的转向出现在第 i+1 步开头
    const steps = [];
    let along = 0;
    leg.steps.forEach((s, i) => {
      const prevAction = i ? (leg.steps[i - 1].action || '') : '';
      const startIdx = Math.min(pts.length - 1, Math.max(0, s.startIdx || 0));
      steps.push({
        kind: i === 0 ? 'start' : kindOf(prevAction),
        title: i === 0 ? `出发${s.road ? '，沿' + s.road : ''}` : `${prevAction || '继续直行'}${s.road ? '，进入' + s.road : ''}`,
        detail: (s.instruction || '').replace(/<[^>]+>/g, '') || `步行 ${Math.round(s.distanceM)}m`,
        startM: Math.round(along),
        coord: pts[startIdx] || null,
      });
      along += s.distanceM || 0;
    });
    return { source: 'amap', totalM, steps: [...steps, arrive] };
  }

  // 几何合成：每个岔口一步
  if (pts.length < 2) return { source: 'geometry', totalM, steps: [arrive] };
  const turns = polylineTurns(pts);
  const cuts = [0, ...turns.map((t) => t.idx), pts.length - 1];
  const steps = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k], b = cuts[k + 1];
    const segM = Math.round((acc[b] - acc[a]) * scale);
    const dir = compassOf(bearingOf(pts[a], pts[Math.min(b, a + 1)]));
    if (k === 0) {
      steps.push({ kind: 'start', title: `出发，向${dir}走`, detail: `直行约 ${roundM(segM)}`, startM: 0, coord: pts[0] });
    } else {
      const t = turns[k - 1];
      const w = turnWord(t.delta);
      steps.push({ kind: kindOf(w), title: w, detail: `再走约 ${roundM(segM)}`, startM: Math.round(acc[a] * scale), coord: pts[a] });
    }
  }
  return { source: 'geometry', totalM, steps: [...steps, arrive] };
}
export const roundM = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + 'km' : (m >= 100 ? Math.round(m / 10) * 10 : Math.max(5, Math.round(m / 5) * 5)) + 'm');

// 导引图标用内联 SVG：↰↱⮌ 这类字符在部分安卓字体里是方框
const ROT = { start: 0, straight: 0, left: -90, right: 90, 'slight-left': -45, 'slight-right': 45 };
export function stepIconSvg(kind) {
  if (kind === 'arrive') return '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 21V4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M7 4h11l-2.5 4L18 12H7z" fill="currentColor"/></svg>';
  if (kind === 'uturn') return '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 20V9a4 4 0 0 1 8 0v8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M12.5 14l3.5 4 3.5-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const r = ROT[kind] ?? 0;
  const stroke = 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
  if (Math.abs(r) === 90) { // 左/右转：竖直上来再横向折出；左转为右转的镜像
    const flip = r < 0 ? ' transform="translate(24 0) scale(-1 1)"' : '';
    return `<svg viewBox="0 0 24 24" width="16" height="16"><g${flip}><path d="M7 21v-8a4 4 0 0 1 4-4h8" ${stroke}/><path d="M15 5l4 4-4 4" ${stroke}/></g></svg>`;
  }
  // 直行 / 稍向左右：同一支箭头按角度旋转
  return `<svg viewBox="0 0 24 24" width="16" height="16"><g transform="rotate(${r} 12 12)"><path d="M12 20V5" ${stroke}/><path d="M6.5 10.5L12 5l5.5 5.5" ${stroke}/></g></svg>`;
}

/**
 * 把定位点投影到路段折线：alongM=沿线已走（按步行距离折算），offM=离路线的横向偏离。
 */
export function projectOnLeg(leg, pt) {
  const pts = dedupe(leg && leg.geometry && leg.geometry.coordinates);
  if (pts.length < 2 || !pt) return null;
  const acc = cumulative(pts);
  const geomM = acc[acc.length - 1] || 1;
  const scale = (leg.distanceM || geomM) / geomM;
  const k = mLng(pt[1]);
  let best = { off: Infinity, along: 0 };
  for (let i = 1; i < pts.length; i++) {
    const ax = (pts[i - 1][0] - pt[0]) * k, ay = (pts[i - 1][1] - pt[1]) * M_LAT;
    const bx = (pts[i][0] - pt[0]) * k, by = (pts[i][1] - pt[1]) * M_LAT;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) best = { off, along: acc[i - 1] + t * Math.sqrt(len2) };
  }
  const alongM = Math.round(best.along * scale);
  return { alongM, remainM: Math.max(0, Math.round((leg.distanceM || geomM) - alongM)), offM: Math.round(best.off) };
}

/** 当前该执行哪一步（进度已走过它的起点） */
export function activeStepIdx(guide, alongM) {
  let idx = 0;
  guide.steps.forEach((s, i) => { if (s.kind !== 'arrive' && alongM + 8 >= s.startM) idx = i; });
  return idx;
}

/* ---------------- 坐标：设备 GPS(WGS84) → 高德(GCJ-02) ----------------
 * 路线坐标都是 GCJ-02，浏览器定位是 WGS84；国内两者相差数百米，不转换的话
 * "离下一站还有多远 / 你好像到了"会整体偏一截。 */
function outOfChina(lng, lat) { return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271; }
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
}
function tLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
}
export function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  const a = 6378245.0, ee = 0.00669342162296594323;
  let dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

/* ---------------- SVG 降级渲染（演示场所 / 高德底图不可用） ---------------- */
// 两种地图共享合并规则；只合并展示编号，不修改站点坐标、顺序或路线。
export function stopMarkerGroups(route, opts = {}) {
  const stops = route.stops || [];
  const parents = stops.map((_, i) => i);
  const root = (i) => parents[i] === i ? i : (parents[i] = root(parents[i]));
  for (let i = 0; i < stops.length; i++) for (let j = i + 1; j < stops.length; j++) {
    if (distM(stops[i].coord, stops[j].coord) < 25) parents[root(j)] = root(i);
  }
  const lastLeg = route.legs[route.legs.length - 1];
  const end = lastLeg && lastLeg.geometry.coordinates.at(-1);
  const first = route.legs[0]?.geometry.coordinates[0];
  const groups = new Map();
  stops.forEach((stop, index) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ stop, index });
  });
  return [...groups.values()].map((members) => {
    const current = members.find((m) => m.stop.poiId === opts.nextPoiId);
    const anchor = current || members[0];
    const states = members.map((m) => opts.stopState ? opts.stopState(m.stop) : null);
    const state = states.every((s) => s === 'done') ? 'done' : states.every((s) => s === 'skip') ? 'skip' : null;
    const endsHere = !!(end && members.some((m) => m.index === stops.length - 1 && distM(m.stop.coord, end) < 60));
    const startsHere = !!(endsHere && first && distM(first, anchor.stop.coord) < 30);
    const numbers = members.map((m) => m.index + 1).join('·');
    const text = endsHere ? (startsHere ? '起/' : '') + numbers + '/终' : members.length > 1 ? numbers : state === 'done' ? '✓' : state === 'skip' ? '✕' : numbers;
    return { coord: anchor.stop.coord, text, endsHere, startsHere, state, isNext: !!current, label: current ? current.stop.name : null, title: members.map((m) => `${m.index + 1}. ${m.stop.name}`).join(' / ') };
  });
}

/**
 * 与高德底图同一套规则画路线。返回 { bounds, legBounds[] } 供"本段/全程"切换取景。
 * opts: { states, currentIdx, stopState(st), nextPoiId, labels: 'all'|'key', drawLabel(map,p,text,dy,color) }
 */
export function renderSvgRoute(map, route, proj, opts = {}) {
  const states = opts.states || legStates(route, null);
  const bounds = emptyBounds();
  const legBounds = [];
  const order = route.legs.map((_, i) => i).sort((a, b) => LEG_STYLE[states[a]].z - LEG_STYLE[states[b]].z);
  for (const i of order) {
    const leg = route.legs[i];
    const st = LEG_STYLE[states[i]];
    const pts = leg.geometry.coordinates.map(([lng, lat]) => proj.toXY({ lng, lat }));
    const lb = emptyBounds();
    pts.forEach((p) => { grow(bounds, p); grow(lb, p); });
    legBounds[i] = lb;
    const d = pts.map((p, j) => (j ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
    if (states[i] === 'current') map.el('path', { d, fill: 'none', stroke: '#fff', 'stroke-width': st.weight * 0.75 + 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    map.el('path', {
      d, fill: 'none', stroke: st.color, 'stroke-width': st.weight * 0.75, opacity: st.opacity,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': st.dashed ? '7 6' : 'none',
    });
    if (st.dir) svgDirChevrons(map, pts, states[i] === 'current' ? '#fff' : 'rgba(255,255,255,.9)');
  }
  // 转向箭头只画"当前这段"：后续路段的转向现在用不上，画出来只会把地图搅乱
  if (opts.currentIdx != null && route.legs[opts.currentIdx]) {
    for (const t of polylineTurns(route.legs[opts.currentIdx].geometry.coordinates)) {
      const p = proj.toXY({ lng: t.coord[0], lat: t.coord[1] });
      map.el('circle', { cx: p.x, cy: p.y, r: 9, fill: '#fff', stroke: '#1677ff', 'stroke-width': 2, class: 'am-turn-arrow' });
      map.el('path', { d: 'M0,-5.5 L4.2,3.8 L0,1.6 L-4.2,3.8 Z', fill: '#1677ff', transform: `translate(${p.x} ${p.y}) rotate(${t.bearingOut})`, class: 'am-turn-arrow' });
    }
  }
  // 起点 / 终点
  const first = route.legs[0] && route.legs[0].geometry.coordinates[0];
  const last = route.legs.length && route.legs[route.legs.length - 1];
  const endPt = last && last.geometry.coordinates[last.geometry.coordinates.length - 1];
  const markers = stopMarkerGroups(route, opts);
  const mergedEnd = markers.some((m) => m.endsHere);
  const sameEnd = first && endPt && distM(first, endPt) < 30;
  if (first && !markers.some((m) => m.startsHere)) svgBadge(map, proj.toXY({ lng: first[0], lat: first[1] }), sameEnd && !mergedEnd ? '起/终' : '起', '#0f6f4f', bounds);
  if (endPt && !sameEnd && !mergedEnd) svgBadge(map, proj.toXY({ lng: endPt[0], lat: endPt[1] }), '终', '#c2410c', bounds);
  // 站点：下一站最醒目；已到访/跳过弱化；标签只给关键站点，避免互相压字
  markers.forEach((marker) => {
    const point = proj.toXY({ lng: marker.coord[0], lat: marker.coord[1] });
    grow(bounds, point);
    const canvas = map.pin ? map.pin(point) : map;
    const p = map.pin ? { x: 0, y: 0 } : point;
    const { state, isNext } = marker;
    const fill = state === 'skip' ? '#b8c2bd' : state === 'done' ? '#8a9a92' : isNext ? '#1677ff' : '#0f6f4f';
    if (isNext) canvas.el('circle', { cx: p.x, cy: p.y, r: 17, fill: '#1677ff', opacity: 0.18 });
    const width = Math.max(isNext ? 24 : 20, marker.text.length * 7 + 10);
    canvas.el('rect', { x: p.x - width / 2, y: p.y - 11, width, height: 22, rx: 11, fill, stroke: '#fff', 'stroke-width': 2.5, class: 'route-stop-marker' });
    const t = canvas.el('text', { x: p.x, y: p.y + 4, 'font-size': isNext ? 12 : 10.5, fill: '#fff', 'text-anchor': 'middle', 'font-weight': 700 });
    t.textContent = marker.text;
    if (isNext && opts.drawLabel) opts.drawLabel(canvas, p, marker.label, -20, '#0b4fbf');
  });
  return { bounds, legBounds };
}
function svgDirChevrons(map, pts, color) {
  // 每 ~70m 一个小箭头，指示行进方向
  let carry = 35;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let pos = carry;
    while (pos < len) {
      const x = a.x + ((b.x - a.x) * pos) / len, y = a.y + ((b.y - a.y) * pos) / len;
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90;
      map.el('path', { d: 'M-2.6,1.8 L0,-1.6 L2.6,1.8', fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linecap': 'round', transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${ang.toFixed(0)})` });
      pos += 70;
    }
    carry = pos - len;
  }
}
function svgBadge(map, p, text, bg, bounds) {
  grow(bounds, p);
  const canvas = map.pin ? map.pin(p) : map;
  if (map.pin) p = { x: 0, y: 0 };
  const w = text.length > 1 ? 30 : 20;
  canvas.el('rect', { x: p.x - w / 2, y: p.y - 10, width: w, height: 20, rx: 10, fill: bg, stroke: '#fff', 'stroke-width': 2 });
  const t = canvas.el('text', { x: p.x, y: p.y + 4, 'font-size': 11, fill: '#fff', 'text-anchor': 'middle', 'font-weight': 700 });
  t.textContent = text;
}
export function emptyBounds() { return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; }
export function grow(b, p) { b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x); b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y); }
