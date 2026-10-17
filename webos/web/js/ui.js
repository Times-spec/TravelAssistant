import { LEG_STYLE, legStates, polylineTurns, turnWord, distM } from './routeview.js';
// UI 工具：DOM 构建、toast、底部 sheet、SVG 地图组件（平移/缩放只改视图，不改行程 §10.3）
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

let sheetReturnFocus = null;
let sheetKeyHandler = null;
let sheetOverflow = '';

export function openSheet(title, contentEl) {
  const sheet = document.getElementById('sheet');
  const body = document.getElementById('sheet-body');
  if (sheet.classList.contains('hidden')) {
    sheetReturnFocus = document.activeElement;
    sheetOverflow = document.body.style.overflow;
  }
  if (sheetKeyHandler) document.removeEventListener('keydown', sheetKeyHandler);
  body.innerHTML = '';
  body.setAttribute('role', 'dialog');
  body.setAttribute('aria-modal', 'true');
  body.setAttribute('aria-labelledby', 'sheet-title');
  body.setAttribute('tabindex', '-1');
  body.append(h('div', { class: 'sheet-heading' },
    h('div', { class: 'sheet-title', id: 'sheet-title' }, title),
    h('button', { class: 'sheet-close', 'aria-label': '关闭弹层', onclick: closeSheet }, '×')), contentEl);
  sheet.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.getElementById('view').inert = true;
  document.getElementById('app-header').inert = true;
  sheet.querySelector('.sheet-mask').onclick = closeSheet;
  const focusables = () => [...body.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
    .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
  sheetKeyHandler = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeSheet(); }
    if (event.key !== 'Tab') return;
    const items = focusables();
    const first = items[0], last = items[items.length - 1];
    if (!first) { event.preventDefault(); body.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  };
  document.addEventListener('keydown', sheetKeyHandler);
  // 聚焦容器，手机上不自动唤起键盘，也不滚动背景页面。
  body.focus({ preventScroll: true });
}
export function closeSheet() {
  const sheet = document.getElementById('sheet');
  if (sheet.classList.contains('hidden')) return;
  sheet.classList.add('hidden');
  document.body.style.overflow = sheetOverflow;
  document.getElementById('view').inert = false;
  document.getElementById('app-header').inert = false;
  if (sheetKeyHandler) document.removeEventListener('keydown', sheetKeyHandler);
  sheetKeyHandler = null;
  if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus({ preventScroll: true });
  sheetReturnFocus = null;
}

export const fmtMin = (sec) => {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const hh = Math.floor(m / 60), r = m % 60;
  return r ? `${hh} 小时 ${r} 分` : `${hh} 小时`;
};
export const fmtKm = (m) => m >= 1000 ? (m / 1000).toFixed(1) + 'km' : Math.round(m) + 'm';
export const fmtClock = (iso) => iso ? iso.slice(11, 16) : '--:--';

/* ---------------- SVG 地图 ----------------
 * 输入：nodes/edges（场所包）+ route legs/stops + 用户位置。
 * 坐标：GCJ02 lng/lat → 局部米制平面。拖动/缩放仅改变 viewBox（§10.3 第一类拖动）。
 */
export class SvgMap {
  constructor(container, { height = 300, onPick = null } = {}) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('height', height);
    this.onPick = onPick;
    this.root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.svg.appendChild(this.root);
    container.appendChild(this.svg);
    this.view = { x: 0, y: 0, w: 800, h: 600 };
    this._bindGestures();
  }
  _bindGestures() {
    let drag = null;
    let pinch = null;
    this.svg.addEventListener('pointerdown', (e) => {
      this.svg.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
    });
    this.svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const rect = this.svg.getBoundingClientRect();
      const scale = this.view.w / rect.width;
      const dx = (e.clientX - drag.x) * scale, dy = (e.clientY - drag.y) * scale;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      this.view.x = drag.vx - dx;
      this.view.y = drag.vy - dy;
      this._apply();
    });
    this.svg.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved && this.onPick) {
        const pt = this._clientToWorld(e.clientX, e.clientY);
        this.onPick(pt);
      }
      drag = null; pinch = null;
    });
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.15 : 0.87;
      this.view.w *= f; this.view.h *= f;
      this._apply();
    }, { passive: false });
    this.svg.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (pinch && pinch.d) {
          const f = pinch.d / d;
          this.view.w = pinch.w * f; this.view.h = pinch.hh * f;
          this._apply();
        } else {
          pinch = { d, w: this.view.w, hh: this.view.h };
        }
      }
    }, { passive: false });
  }
  _clientToWorld(cx, cy) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: this.view.x + ((cx - rect.left) / rect.width) * this.view.w,
      y: this.view.y + ((cy - rect.top) / rect.height) * this.view.h,
    };
  }
  _apply() {
    this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
    // 缩放分级（视口宽度≈可见米数）：远图只看路线骨架，中图出现站名与转向箭头，近图补转向文字
    const w = this.view.w;
    this.svg.classList.toggle('am-z-far', w > 2200);
    this.svg.classList.toggle('am-z-mid', w > 900 && w <= 2200);
    this.svg.classList.toggle('am-z-near', w <= 900);
  }
  fit(bounds, pad = 60) {
    const w = Math.max(50, bounds.maxX - bounds.minX + pad * 2);
    const hgt = Math.max(50, bounds.maxY - bounds.minY + pad * 2);
    this.view = { x: bounds.minX - pad, y: bounds.minY - pad, w, h: hgt };
    this._apply();
  }
  clear() { this.root.innerHTML = ''; }
  el(name, attrs) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    this.root.appendChild(e);
    return e;
  }
}

// lng/lat → 局部米制（与 server geo.makeProjector 同参数）
export function makeProjector(origin) {
  const mPerDegLat = 110940;
  const mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return {
    toXY(p) { return { x: (p.lng - origin.lng) * mPerDegLng, y: -(p.lat - origin.lat) * mPerDegLat }; }, // y 翻转：北在上
  };
}

/* ---------------- 高德 JS 底图（真实路线用；演示场所包仍用 SVG 路网） ---------------- */
let amapLoading = null;
export function loadAmap(jsKey, securityCode) {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (amapLoading) return amapLoading;
  window._AMapSecurityConfig = { securityJsCode: securityCode };
  amapLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${jsKey}`;
    s.onload = () => (window.AMap ? resolve(window.AMap) : reject(new Error('AMap 加载异常')));
    s.onerror = () => { amapLoading = null; reject(new Error('AMap 脚本加载失败')); };
    document.head.appendChild(s);
    setTimeout(() => { if (!window.AMap) { amapLoading = null; reject(new Error('AMap 加载超时')); } }, 12000);
  });
  return amapLoading;
}

function stopMarkerContent(text, bg, big) {
  const d = big ? 30 : 24;
  return `<div style="width:${d}px;height:${d}px;border-radius:50%;background:${bg};color:#fff;
    display:flex;align-items:center;justify-content:center;font:700 ${big ? 14 : 12}px/1 sans-serif;
    border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)${big ? ',0 0 0 6px rgba(22,119,255,.18)' : ''}">${text}</div>`;
}
const badgeContent = (text, bg) => `<div style="min-width:22px;height:22px;padding:0 5px;border-radius:11px;background:${bg};color:#fff;display:flex;align-items:center;justify-content:center;font:700 12px/1 sans-serif;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3);white-space:nowrap">${text}</div>`;
const turnArrowSvg = () => `<svg width="20" height="20" viewBox="0 0 24 24" style="display:block">
  <circle cx="12" cy="12" r="10.5" fill="#fff" stroke="#1677ff" stroke-width="2"/>
  <path d="M12 5.5 L17 15.5 L12 12.8 L7 15.5 Z" fill="#1677ff"/></svg>`;

export class AmapRouteMap {
  constructor(container, { AMap, height = 300 }) {
    this.AMap = AMap;
    container.style.height = height + 'px';
    container.style.width = '100%';
    container.classList.add('am-route-map');
    // resizeEnable：容器尺寸在创建后才稳定（挂载时序/弹层/旋转）时自动重算画布，避免 0×0 空白
    this.map = new AMap.Map(container, { zoom: 15, viewMode: '2D', mapStyle: 'amap://styles/fresh', resizeEnable: true });
    this.overlays = [];
    // 缩放分级：远图只看路线骨架与站点圆点，中图出现站名与转向箭头，近图再补"左转/右转"文字。
    // 用容器 class 承载，CSS 控制显隐，避免逐 marker 更新。
    const applyTier = () => {
      const z = this.map.getZoom();
      container.classList.toggle('am-z-far', z < 15);
      container.classList.toggle('am-z-mid', z >= 15 && z < 16.5);
      container.classList.toggle('am-z-near', z >= 16.5);
    };
    this.map.on('zoomchange', applyTier);
    applyTier();
  }
  clear() {
    if (this.overlays.length) { this.map.remove(this.overlays); this.overlays = []; }
  }
  // AMap 2.0：构造函数创建的覆盖物不会自动上图，必须 map.add（否则路线与标记全部不可见）
  _add(o) { this.overlays.push(o); this.map.add(o); return o; }
  /**
   * 路线渲染（规划页 / 游览页共用一套口径，见 routeview.js LEG_STYLE）
   * opts.states：每段路的状态（legStates 计算）；缺省为规划页口径
   * opts.currentIdx：当前这段的下标（只有这一段画转向箭头）
   * opts.nextPoiId / opts.stopState(st)：站点状态；opts.labels: 'all' | 'key'（只标下一站）
   * opts.fit：'all' | 'leg'（默认 all）
   */
  renderRoute(route, opts = {}) {
    const AMap = this.AMap;
    this.clear();
    this.route = route;
    const states = opts.states || legStates(route, null);
    this.legOverlays = [];
    route.legs.forEach((leg, i) => {
      const st = LEG_STYLE[states[i]];
      const cur = states[i] === 'current';
      this.legOverlays[i] = this._add(new AMap.Polyline({
        path: leg.geometry.coordinates.map(([lng, lat]) => new AMap.LngLat(lng, lat)),
        strokeColor: st.color, strokeWeight: st.weight, strokeOpacity: st.opacity,
        strokeStyle: st.dashed ? 'dashed' : 'solid', strokeDasharray: st.dashed ? [8, 8] : undefined,
        isOutline: cur, outlineColor: '#ffffff', borderWeight: cur ? 2 : 0,
        showDir: st.dir, dirColor: '#ffffff',
        lineJoin: 'round', lineCap: 'round', zIndex: st.z,
      }));
    });
    // 起点 / 终点：A→B 路线单独标"终"（此前默认"终点即最后一站"，末站→终点那段因此无从解释）
    const first = route.legs.length && route.legs[0].geometry.coordinates[0];
    const last = route.legs[route.legs.length - 1];
    const endPt = last && last.isReturnLeg ? last.geometry.coordinates[last.geometry.coordinates.length - 1] : null;
    const sameEnd = first && endPt && distM(first, endPt) < 30;
    if (first) {
      this._add(new AMap.Marker({ position: new AMap.LngLat(first[0], first[1]), content: badgeContent(sameEnd ? '起/终' : '起', '#0f6f4f'), anchor: 'center', title: '起点', zIndex: 45 }));
    }
    if (endPt && !sameEnd) {
      this._add(new AMap.Marker({ position: new AMap.LngLat(endPt[0], endPt[1]), content: badgeContent('终', '#c2410c'), anchor: 'center', title: (route.endApproach && route.endApproach.endName) || '终点', zIndex: 45 }));
    }
    route.stops.forEach((s, i) => {
      const isNext = opts.nextPoiId && s.poiId === opts.nextPoiId;
      const state = opts.stopState ? opts.stopState(s) : null;
      const bg = state === 'skip' ? '#b8c2bd' : state === 'done' ? '#8a9a92' : isNext ? '#1677ff' : '#0f6f4f';
      const text = state === 'skip' ? '✕' : state === 'done' ? '✓' : String(i + 1);
      const showLabel = opts.labels !== 'key' || isNext;
      this._add(new AMap.Marker({
        position: new AMap.LngLat(s.coord[0], s.coord[1]),
        content: stopMarkerContent(text, bg, isNext),
        anchor: 'center', title: s.name, zIndex: isNext ? 55 : 50,
        label: showLabel ? { content: `<div class="am-label-halo${state ? ' dim' : ''}${isNext ? ' next' : ''}">${s.name}</div>`, direction: 'top' } : undefined,
      }));
    });
    // 转向箭头只画当前这段（后续路段的转向此刻用不上，画满屏只会更乱）
    if (opts.currentIdx != null && route.legs[opts.currentIdx]) {
      for (const t of polylineTurns(route.legs[opts.currentIdx].geometry.coordinates)) {
        this._add(new AMap.Marker({
          position: new AMap.LngLat(t.coord[0], t.coord[1]), content: turnArrowSvg(), angle: t.bearingOut,
          anchor: 'center', title: turnWord(t.delta), zIndex: 62,
        }));
      }
    }
    if (opts.fit === 'leg' && opts.currentIdx != null) this.fitLeg(opts.currentIdx);
    else this.fitAll();
  }
  fitAll() {
    if (this.overlays.length) this.map.setFitView(this.overlays.filter((o) => o !== this.userMarker && o !== this.userCircle), false, [48, 40, 40, 40]);
  }
  /** 只看当前这段（+ 我的位置）：游览时默认视角 */
  fitLeg(i) {
    const o = this.legOverlays && this.legOverlays[i];
    if (!o) return this.fitAll();
    const list = [o];
    // 人离这段路很远（还没到场/定位漂移）时不把人框进来，否则"本段"会被缩成全城视角
    if (this.userMarker && this.route && this.route.legs[i]) {
      const cs = this.route.legs[i].geometry.coordinates;
      const u = this.userMarker.getPosition();
      if (cs.length && distM([u.lng, u.lat], cs[Math.floor(cs.length / 2)]) < 1500) list.push(this.userMarker);
    }
    this.map.setFitView(list, false, [56, 48, 48, 48], 18);
  }
  /** 我的位置（GCJ-02）：蓝点 + 精度圈 */
  setUser(pt, accuracy) {
    const AMap = this.AMap;
    if (!pt) return;
    const pos = new AMap.LngLat(pt[0], pt[1]);
    if (!this.userMarker) {
      this.userMarker = new AMap.Marker({ position: pos, anchor: 'center', zIndex: 70, content: '<div class="user-dot"></div>', title: '我的位置' });
      this.userCircle = new AMap.Circle({ center: pos, radius: Math.min(accuracy || 30, 200), strokeWeight: 0, fillColor: '#1677ff', fillOpacity: 0.12, zIndex: 9 });
      this.map.add([this.userCircle, this.userMarker]);
    } else {
      this.userMarker.setPosition(pos);
      this.userCircle.setCenter(pos);
      this.userCircle.setRadius(Math.min(accuracy || 30, 200));
    }
  }
  centerUser() { if (this.userMarker) this.map.setCenter(this.userMarker.getPosition()); }
  destroy() { try { this.map.destroy(); } catch (e) {} }
}
