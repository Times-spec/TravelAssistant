// 首页（向导版）：先让用户做选择，再生成路线。
// 三步：① 想怎么逛 → ② 哪个地方 → ③ 怎么安排（起点/时间/偏好）→ 生成路线。
// AI 不再是入口，而是每一步都能调用的助手（"一句话帮我填"）与游览中的导游（见 trip.js）。
import { post, get } from './api.js';
import { h, toast, openSheet, closeSheet, SvgMap, makeProjector, loadAmap } from './ui.js';
import { saveDraft, state, getVenuePack } from './app.js';

const INTERESTS = ['自然', '公园湿地', '街区', '人文', '建筑', '美食'];
const DURATION_PRESETS = [[1800, '30 分钟'], [3600, '1 小时'], [7200, '2 小时'], [14400, '半天'], [28800, '一天']];

export function renderHome(view) {
  const d = state.draft;
  const cleanupFns = [];
  const rerender = () => { view.innerHTML = ''; renderHome(view); };
  if (!d.step) d.step = 1;
  const goStep = (n) => { d.step = n; saveDraft(); rerender(); };

  /* ================= 步骤条 ================= */
  const stepsBar = h('div', { class: 'steps' },
    stepDot(1, '想怎么逛'), stepLine(1), stepDot(2, '哪个地方'), stepLine(2), stepDot(3, '怎么安排'));
  function stepDot(n, label) {
    const clickable = d.step > n; // 只能往回点，前进仍走底部主按钮（保证必填校验）
    return h('div', {
      class: 'step' + (d.step === n ? ' active' : d.step > n ? ' done' : ''),
      style: clickable ? 'cursor:pointer' : undefined,
      title: clickable ? '回到这一步' : undefined,
      onclick: clickable ? () => goStep(n) : undefined,
    },
      h('span', { class: 'step-dot' }, d.step > n ? '✓' : String(n)),
      h('span', { class: 'step-label' }, label));
  }
  function stepLine(n) { return h('span', { class: 'step-line' + (d.step > n ? ' done' : '') }); }

  /* ================= 第一步：想怎么逛（两种玩法，生态位不同） ================= */
  const step1 = h('div', { class: 'step-body' },
    h('h3', { class: 'sec-title' }, '你打算怎么逛？'),
    choiceCard('venue', '🏞️', '景区游玩', '选一个公园 / 景区 / 校园，生成园内游览路线，把精华走全', d.scene === 'venue'),
    choiceCard('wander', '🚶', '城市闲逛', '从学校 / 家 / 酒店出发，按"想看什么"逛一圈，对周围不熟也行', d.scene === 'wander'),
    h('div', { class: 'tl-meta', style: 'margin-top:8px' }, '不知道选哪个？景区游玩先定地方，城市闲逛从脚下出发'),
  );
  function choiceCard(scene, emoji, title, desc, sel) {
    return h('button', {
      class: 'choice-card' + (sel ? ' sel' : ''),
      onclick: () => {
        d.scene = scene;
        if (scene === 'wander') { d.venueId = null; d.venueRef = null; }
        if (scene === 'venue') d.interests = []; // 场所属性不由游客选，兴趣标签只属于城市闲逛
        applySceneDefaults(scene);
        saveDraft();
        goStep(scene === 'venue' && !d.venueId && !d.venueRef ? 2 : 3);
      },
    }, h('span', { class: 'choice-e' }, emoji),
      h('div', {}, h('div', { class: 'choice-t' }, title), h('div', { class: 'choice-d' }, desc)));
  }
  // 场景级出口默认值：景区默认"自动挑顺路的门"出园，闲逛默认回到起点；已指定过出口（fixed）则尊重原选择
  function applySceneDefaults(scene) {
    const untouched = !d.endpointPoint && !d.endpointEntranceId && !d.endpointPoiId;
    if (scene === 'venue' && untouched && d.endpointMode === 'return_to_origin') d.endpointMode = 'flexible';
    if (scene === 'wander' && untouched && d.endpointMode === 'flexible') d.endpointMode = 'return_to_origin';
  }

  /* ================= 第二步：哪个地方 ================= */
  const step2 = h('div', { class: 'step-body' },
    h('h3', { class: 'sec-title' }, '逛哪个地方？'),
    d.venueRef
      ? h('div', { class: 'picked' },
        h('div', { class: 'picked-name' }, '🏞️ ' + d.venueRef.name),
        h('div', { class: 'tl-meta' }, [d.venueRef.district, d.venueRef.city].filter(Boolean).join(' · ')),
        h('div', { class: 'chips', style: 'margin-top:8px' },
          h('button', { class: 'chip', onclick: () => openVenueSearch() }, '换一个'),
          h('button', { class: 'chip', onclick: () => goStep(3) }, '就这里，下一步')))
      : h('div', {},
        h('button', { class: 'btn btn-ghost btn-block', onclick: openVenueSearch }, '🔍 搜索公园 / 景区 / 校园'),
        h('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:8px', onclick: findNearbyVenues }, '📍 看看我附近有什么可逛的'),
        h('div', { id: 'nearby-list', style: 'margin-top:8px' }),
        h('div', { class: 'tl-meta', style: 'margin-top:10px' }, '不知道去哪？也可以展开下面的"一句话"，我来帮你找')),
  );

  async function findNearbyVenues() {
    const box = document.getElementById('nearby-list');
    if (!box) return;
    box.innerHTML = '<div class="empty">正在获取位置…</div>';
    try {
      const pos = await new Promise((res, rej) => {
        if (!navigator.geolocation) return rej(new Error('当前环境不支持定位'));
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 });
      });
      box.innerHTML = '<div class="empty">正在查找附近可逛的地方…</div>';
      const norm = await post('/v1/locations/normalize', {
        lng: pos.coords.longitude, lat: pos.coords.latitude, crs: 'WGS84', source: 'device', accuracyM: pos.coords.accuracy,
      });
      const r = await get(`/v1/places/nearby-venues?lng=${norm.point.lng}&lat=${norm.point.lat}&radius=3000`);
      if (!r.results.length) { box.innerHTML = '<div class="empty">3 公里内没有检索到公园/景区</div>'; return; }
      box.innerHTML = '';
      for (const v of r.results) {
        box.append(h('div', {
          class: 'poi-result',
          onclick: () => {
            d.venueId = v.id;
            d.venueRef = { id: v.id, name: v.name, lng: v.coord.lng, lat: v.coord.lat, city: v.city, district: v.district };
            d.origin = { lng: norm.point.lng, lat: norm.point.lat, crs: 'GCJ02', label: '当前位置', source: 'device' };
            applySceneDefaults('venue');
            saveDraft(); toast('已选择：' + v.name); goStep(3);
          },
        }, h('div', { class: 'n' }, v.name, h('span', { class: 'tag' }, (v.distanceM / 1000).toFixed(1) + 'km')),
          h('div', { class: 'a' }, v.disambiguation || v.address || '')));
      }
    } catch (e) {
      box.innerHTML = '';
      box.append(h('div', { class: 'empty' }, e && e.code === 1 ? '定位权限被拒绝，可改用搜索' : ('获取失败：' + (e.message || ''))));
    }
  }

  /* ================= 第三步：怎么安排（按模式分流字段） ================= */
  // 景区游玩：场所自带人文/自然等属性，不是游客选的 → 用"想怎么体验"表达玩法；
  // 城市闲逛：终点与兴趣标签是主字段（"从学校出发逛半天，想看看人文和美食"）。
  const isVenueScene = d.scene !== 'wander';
  const step3 = h('div', { class: 'step-body' },
    h('h3', { class: 'sec-title' }, '怎么安排？'),
    h('div', { class: 'field' },
      h('div', { class: 'field-label' }, h('span', {}, '从哪里出发'), h('button', { class: 'link-btn', onclick: openOriginSheet }, '更改')),
      h('div', { class: 'value-row' }, d.origin ? '📍 ' + d.origin.label : '未选择（当前位置 / 搜索定位 / 地图精确选点）')),
    isVenueScene ? h('div', { class: 'field' },
      h('div', { class: 'field-label' }, h('span', {}, '从哪个门出'), h('span', { class: 'tl-meta' }, '决定路线往哪个门收尾')),
      h('div', { class: 'chips' },
        [['return_to_origin', '回到起点'], ['flexible', '自动挑顺路的门'], ['fixed', '指定门 / 位置']].map(([v, label]) =>
          h('button', {
            class: 'chip' + (d.endpointMode === v ? ' sel' : ''),
            onclick: () => {
              d.endpointMode = v;
              if (v !== 'fixed') { d.endpointPoint = null; d.endpointLabel = null; d.endpointEntranceId = null; d.endpointPoiId = null; }
              saveDraft(); rerender();
            },
          }, label)),
        d.endpointMode === 'fixed' ? h('button', { class: 'chip sel', onclick: () => openPointPicker('endpoint') }, d.endpointLabel ? '📍 ' + d.endpointLabel : '🚪 选出口') : null)) : null,
    h('div', { class: 'field' },
      h('div', { class: 'field-label' }, h('span', {}, '逛多久'), h('button', { class: 'link-btn', onclick: openTimeSheet }, '按时间点安排')),
      h('div', { class: 'chips' }, DURATION_PRESETS.map(([sec, label]) =>
        h('button', {
          class: 'chip' + (d.timeMode === 'duration' && d.durationSec === sec ? ' sel' : ''),
          onclick: () => { d.timeMode = 'duration'; d.durationSec = sec; saveDraft(); rerender(); },
        }, label)),
        d.timeMode === 'arriveBy' ? h('span', { class: 'chip sel' }, d.latestEndClock + ' 前到终点') : null)),
    isVenueScene
      ? h('div', { class: 'field' },
        h('div', { class: 'field-label' }, h('span', {}, '想怎么体验'), h('span', { class: 'tl-meta' }, '场所的风格由它自己决定，这里选你的玩法')),
        h('div', { class: 'chips' },
          [['highlights', '精华打卡'], ['poi_coverage', '全都逛到'], ['relax', '休闲放松']].map(([v, label]) =>
            h('button', { class: 'chip' + ((d.objective || 'highlights') === v ? ' sel' : ''), onclick: () => { d.objective = v; saveDraft(); rerender(); } }, label))))
      : h('div', { class: 'field' },
        h('div', { class: 'field-label' }, h('span', {}, '终点'), h('span', { class: 'tl-meta' }, '逛完去哪，决定路线往哪边收')),
        h('div', { class: 'chips' },
          [['return_to_origin', '回到起点'], ['flexible', '顺路结束'], ['fixed', '指定地点']].map(([v, label]) =>
            h('button', { class: 'chip' + (d.endpointMode === v ? ' sel' : ''), onclick: () => { d.endpointMode = v; saveDraft(); rerender(); } }, label)),
          d.endpointMode === 'fixed' ? h('button', { class: 'chip sel', onclick: () => openPointPicker('endpoint') }, d.endpointLabel ? '📍 ' + d.endpointLabel : '🔍 选终点') : null)),
    // 景区游玩不问"想看什么"：场所自带人文/自然属性，兴趣标签是城市闲逛的专属字段
    ...(isVenueScene ? [] : [h('div', { class: 'field' },
      h('div', { class: 'field-label' }, h('span', {}, '想看什么'), h('span', { class: 'tl-meta' }, '可多选，决定沿途看点')),
      h('div', { class: 'chips' }, INTERESTS.map((t) =>
        h('button', {
          class: 'chip' + (d.interests.includes(t) ? ' sel' : ''),
          onclick: () => {
            d.interests = d.interests.includes(t) ? d.interests.filter((x) => x !== t) : [...d.interests, t];
            saveDraft(); rerender();
          },
        }, t))))]),
    h('div', { class: 'field' },
      h('div', { class: 'field-label' }, h('span', {}, '怎么走')),
      h('div', { class: 'chips' },
        [['easy', '轻松'], ['normal', '适中'], ['active', '多走走']].map(([v, label]) =>
          h('button', { class: 'chip' + (d.pace === v ? ' sel' : ''), onclick: () => { d.pace = v; saveDraft(); rerender(); } }, label)),
        toggleChip('restPreferred', '多休息'), toggleChip('quietPreferred', '安静点'),
        toggleChip('stepFew', '少台阶'), toggleChip('stepFreeRequired', '轮椅可达'))),
    h('div', { class: 'chips', style: 'margin-top:4px' },
      h('button', { class: 'chip', onclick: openPrefSheet }, '更多条件（必去 / 避开 / 预算 / 讲解详略）▾')),
  );
  function toggleChip(key, label) {
    return h('button', {
      class: 'chip' + (d[key] ? ' sel' : ''),
      onclick: () => { d[key] = !d[key]; saveDraft(); rerender(); },
    }, label);
  }

  /* ================= AI 助手（可选，不主导） ================= */
  const aiBox = h('div', { class: 'card ai-assist' },
    h('button', {
      class: 'link-btn', onclick: (e) => {
        const body = document.getElementById('ai-assist-body');
        const opened = body.classList.toggle('hidden');
        e.currentTarget.textContent = opened ? '💬 说不清楚？用一句话让我帮你填 ▾' : '收起 ▴';
      },
    }, '💬 说不清楚？用一句话让我帮你填 ▾'),
    h('div', { class: 'hidden', id: 'ai-assist-body' },
      h('textarea', {
        class: 'ai-input', style: 'min-height:64px;margin-top:6px',
        placeholder: '例如：人民公园，两小时，精华打卡；或：从学校出发逛半天，想看人文和美食',
        oninput: (ev) => { d.text = ev.target.value; saveDraft(); },
      }, d.text || ''),
      h('button', { class: 'btn btn-ghost btn-block', onclick: submitWithText }, '让 AI 帮我填好并规划')));
  async function submitWithText() {
    if (!(d.text || '').trim()) { toast('先说一句想怎么逛'); return; }
    await doSubmit();
  }

  /* ================= 底部按钮 ================= */
  const primary = h('button', { class: 'btn btn-primary btn-lg', onclick: onPrimary }, primaryLabel());
  // 进入第 2/3 步后提供回退出口：景区 2→1、3→2；闲逛 3→1（闲逛没有第 2 步）
  const backBtn = d.step > 1
    ? h('button', { class: 'btn btn-ghost btn-lg', onclick: () => goStep(d.step === 2 ? 1 : d.scene === 'venue' ? 2 : 1) }, '‹ 上一步')
    : null;
  const bottomBar = h('div', { class: 'bottom-bar' }, backBtn, primary);
  function primaryLabel() {
    if (d.step === 1) return '下一步';
    if (d.step === 2) return (d.venueRef || d.venueId) ? '下一步' : '先去选地方';
    return '生成路线';
  }
  async function onPrimary() {
    if (d.step === 1) {
      if (!d.scene) { toast('先选一种逛法'); return; }
      return goStep(d.scene === 'venue' && !d.venueId && !d.venueRef ? 2 : 3);
    }
    if (d.step === 2) {
      if (!d.venueRef && !d.venueId) { toast('先搜索并选定一个地方'); return; }
      return goStep(3);
    }
    await doSubmit();
  }

  /* ================= 提交 ================= */
  async function doSubmit() {
    if (state.config.setupRequired) { toast('服务端未配置地图服务，请按提示配置后使用', 4000); return; }
    if (d.scene === 'venue' && !d.venueId && !d.venueRef) { goStep(2); toast('先选定一个地方'); return; }
    if (!d.origin) { openOriginSheet(); toast('先确定从哪里出发'); return; }
    primary.disabled = true;
    const old = primary.textContent;
    primary.textContent = '正在规划…';
    try {
      const ni = await post('/v1/intents/normalize', buildIntentPayload(d));
      if (ni.unresolved && ni.unresolved.length) { showClarification(ni, buildIntentPayload(d)); return; }
      if (ni.intent.autoResolvedVenue && !d.venueRef) {
        d.venueId = ni.intent.venueId; d.venueRef = ni.intent.venueRef; d.scene = 'venue'; saveDraft();
      }
      if (ni.intent.originApproach) {
        d.origin = { lng: ni.intent.origin.point.lng, lat: ni.intent.origin.point.lat, crs: 'GCJ02', label: ni.intent.origin.label, source: 'venue' };
        saveDraft();
        toast((ni.notices && ni.notices[0] && ni.notices[0].message) || '起点已改到场所入口', 5000);
      }
      const plan = await post('/v1/plans', { intentId: ni.intentId, revision: ni.revision, idempotencyKey: 'plan_' + Date.now() });
      location.hash = '#/plan/' + plan.planId;
    } catch (e) {
      toast(e.message, 3500);
    } finally {
      primary.disabled = false;
      primary.textContent = old;
    }
  }

  /* ================= 追问 ================= */
  async function showClarification(ni, basePayload) {
    const box = h('div', {});
    for (const q of ni.unresolved) {
      box.append(h('div', { class: 'card', style: 'box-shadow:none;border:1px solid var(--line)' },
        h('div', { style: 'font-weight:600;margin-bottom:4px' }, q.question),
        h('div', { class: 'tl-meta', style: 'margin-bottom:8px' }, q.reason),
        h('div', { class: 'chips' }, (q.options || ['ok']).map((op, i) =>
          h('button', { class: 'chip', onclick: () => applyClarification(q, op, basePayload, i) },
            (q.optionLabels && q.optionLabels[i]) || optionLabel(q.field, op))))));
    }
    openSheet('需要确认一下', box);
  }

  async function applyClarification(q, op, basePayload, idx) {
    if (q.field === 'mobility') { d.mobility = op; basePayload.form.mobility = op; }
    if (q.field === 'venueId' && String(op).startsWith('live:')) {
      try {
        const label = ((q.optionLabels && q.optionLabels[idx]) || '').split('（')[0];
        const r = await get(`/v1/places/search?kind=venue&q=${encodeURIComponent(label)}`);
        const hit = r.results.find((x) => x.id === op);
        if (hit) {
          d.venueId = hit.id;
          d.venueRef = { id: hit.id, name: hit.name, lng: hit.coord.lng, lat: hit.coord.lat, city: hit.city, district: hit.district };
          basePayload.form.venueId = hit.id;
          basePayload.form.venueRef = d.venueRef;
        }
      } catch (e) { /* 保持首个匹配 */ }
      saveDraft();
    }
    if (q.field === 'mustVisit' && op === 'remove') { basePayload.form.mustVisitIds = []; d.mustVisit = []; saveDraft(); }
    closeSheet();
    try {
      const ni = await post('/v1/intents/normalize', basePayload);
      if (ni.unresolved && ni.unresolved.length) { showClarification(ni, basePayload); return; }
      const plan = await post('/v1/plans', { intentId: ni.intentId, revision: ni.revision, idempotencyKey: 'plan_' + Date.now() });
      location.hash = '#/plan/' + plan.planId;
    } catch (e) { toast(e.message, 3500); }
  }

  /* ================= 弹层：场所搜索 ================= */
  function openVenueSearch() {
    const input = h('input', { class: 'input', placeholder: '公园 / 景区 / 校园名称，如：人民公园' });
    const city = h('input', { class: 'input', placeholder: '城市（可选，用于消歧）', style: 'margin-top:8px' });
    const list = h('div', { style: 'margin-top:6px' });
    const doSearch = async () => {
      const q = input.value.trim();
      if (!q) return;
      list.innerHTML = '<div class="empty">搜索中…</div>';
      try {
        const r = await get(`/v1/places/search?kind=venue&q=${encodeURIComponent(q)}&city=${encodeURIComponent(city.value.trim())}`);
        const venues = r.results.filter((x) => x.kind === 'venue');
        list.innerHTML = '';
        if (!venues.length) { list.append(h('div', { class: 'empty' }, '没找到，换个关键词或补个城市')); return; }
        for (const v of venues) {
          list.append(h('div', {
            class: 'poi-result',
            onclick: () => {
              d.venueId = v.id;
              d.venueRef = { id: v.id, name: v.name, lng: v.coord.lng, lat: v.coord.lat, city: v.city, district: v.district };
              d.scene = 'venue';
              applySceneDefaults('venue');
              saveDraft(); closeSheet();
              toast('已选择：' + v.name);
              goStep(3);
            },
          }, h('div', { class: 'n' }, v.name), h('div', { class: 'a' }, v.disambiguation || v.address || '')));
        }
      } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'empty' }, e.message)); }
    };
    input.addEventListener('input', debounce(doSearch, 350));
    city.addEventListener('change', doSearch);
    openSheet('选择地方', h('div', {}, input, city, list));
    input.focus();
  }

  /* ================= 弹层：起点 ================= */
  function openOriginSheet() {
    openSheet('从哪里出发', h('div', {},
      optRow('📡', '使用当前位置', '点击时才申请定位权限', () => { closeSheet(); locateMe(); }),
      optRow('🔍', '搜索 / 地图精确选点', '先搜大致位置，再在地图上点准到具体门', () => { closeSheet(); openPointPicker('origin'); })));
  }

  /* ================= 弹层：时间 ================= */
  function openTimeSheet() {
    const body = h('div', {});
    const seg = h('div', { class: 'seg' },
      segBtn('我有多久', d.timeMode === 'duration', () => { d.timeMode = 'duration'; saveDraft(); refresh(); }),
      segBtn('我要几点前到', d.timeMode === 'arriveBy', () => { d.timeMode = 'arriveBy'; saveDraft(); refresh(); }));
    function refresh() {
      seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('sel', (i === 0) === (d.timeMode === 'duration')));
      body.innerHTML = '';
      if (d.timeMode === 'duration') {
        body.append(h('div', { class: 'field-label' }, '逛多久'),
          h('div', { class: 'chips' }, DURATION_PRESETS.map(([sec, label]) =>
            h('button', { class: 'chip' + (d.durationSec === sec ? ' sel' : ''), onclick: () => { d.durationSec = sec; saveDraft(); refresh(); } }, label)),
            h('label', { class: 'chip' }, '自定义 ',
              h('input', {
                type: 'number', min: 30, max: 480, value: Math.round(d.durationSec / 60),
                style: 'width:58px;border:0;outline:0;background:transparent;font:inherit',
                onchange: (e) => { d.durationSec = Math.max(30, Math.min(480, Number(e.target.value) || 120)) * 60; saveDraft(); },
              }), ' 分钟')));
      } else {
        body.append(h('div', { class: 'field-label' }, '最晚几点到终点'),
          h('input', { class: 'input', type: 'time', value: d.latestEndClock, onchange: (e) => { d.latestEndClock = e.target.value; saveDraft(); } }),
          h('div', { class: 'tl-meta', style: 'margin-top:6px' }, '预算按"现在到截止"计算，含返程与缓冲'));
      }
      // 原生 append 不做空值过滤：先过滤再展开，避免页面出现字面量 "null"
      body.append(...[
        h('div', { class: 'field-label', style: 'margin-top:10px' }, '开始时间'),
        h('div', { class: 'chips' },
          h('button', { class: 'chip' + (d.startMode === 'now' ? ' sel' : ''), onclick: () => { d.startMode = 'now'; d.startAtMs = null; saveDraft(); refresh(); } }, '现在出发'),
          h('button', { class: 'chip' + (d.startMode === 'later' ? ' sel' : ''), onclick: () => { d.startMode = 'later'; saveDraft(); refresh(); } }, '稍后出发')),
        d.startMode === 'later' ? h('input', {
          class: 'input', type: 'datetime-local', style: 'margin-top:8px',
          value: d.startAtMs ? toLocalInput(d.startAtMs) : '',
          onchange: (e) => { d.startAtMs = e.target.value ? new Date(e.target.value).getTime() : null; saveDraft(); },
        }) : null,
      ].filter(Boolean));
    }
    refresh();
    openSheet('时间安排', h('div', {}, seg, body));
  }

  /* ================= 弹层：更多条件 ================= */
  function openPrefSheet() {
    // 结束位置已提升为景区场景第三步的主字段「从哪个门出」，这里不再重复
    const box = h('div', {},
      h('div', { class: 'field-label' }, '预算'),
      h('div', { class: 'chips' },
        h('button', { class: 'chip' + (d.freePreferred ? ' sel' : ''), onclick: () => { d.freePreferred = !d.freePreferred; d.budgetHardZero = false; saveDraft(); openPrefSheet(); } }, '免费优先'),
        h('button', { class: 'chip' + (d.budgetHardZero ? ' sel' : ''), onclick: () => { d.budgetHardZero = !d.budgetHardZero; d.freePreferred = false; saveDraft(); openPrefSheet(); } }, '零门票（硬条件）')),
      h('div', { class: 'field-label', style: 'margin-top:10px' }, '讲解详略'),
      h('div', { class: 'chips' }, [['minimal', '少打扰'], ['normal', '适量'], ['rich', '想了解更多']].map(([v, label]) =>
        h('button', { class: 'chip' + (d.guideStyle === v ? ' sel' : ''), onclick: () => { d.guideStyle = v; saveDraft(); openPrefSheet(); } }, label))),
      h('div', { class: 'field-label', style: 'margin-top:10px' }, '必去 / 避开'),
      h('div', { class: 'chips' },
        d.mustVisit.map((m) => h('span', { class: 'chip' }, '必去 ' + m.name, ' ',
          h('a', { onclick: () => { d.mustVisit = d.mustVisit.filter((x) => x.id !== m.id); saveDraft(); openPrefSheet(); } }, '✕'))),
        d.avoid.map((m) => h('span', { class: 'chip' }, '避开 ' + m.name, ' ',
          h('a', { onclick: () => { d.avoid = d.avoid.filter((x) => x.id !== m.id); saveDraft(); openPrefSheet(); } }, '✕'))),
        h('button', { class: 'chip', onclick: () => { closeSheet(); openSearch('must'); } }, '＋ 必去'),
        h('button', { class: 'chip', onclick: () => { closeSheet(); openSearch('avoid'); } }, '＋ 避开')),
      h('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:12px', onclick: () => { closeSheet(); rerender(); } }, '完成'));
    openSheet('更多条件', box);
  }

  /* ================= 定位 / 搜索 / 地图选点 ================= */
  async function locateMe() {
    if (!navigator.geolocation) { toast('当前环境不支持定位，请搜索或地图选点'); return; }
    toast('正在定位…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const norm = await post('/v1/locations/normalize', {
          lng: pos.coords.longitude, lat: pos.coords.latitude, crs: 'WGS84', source: 'browser', accuracyM: pos.coords.accuracy,
        });
        const rev = await post('/v1/locations/reverse', { lng: norm.point.lng, lat: norm.point.lat });
        d.origin = { lng: norm.point.lng, lat: norm.point.lat, crs: 'GCJ02', label: rev.label || '当前位置', source: 'device', needsReview: norm.needsReview };
        saveDraft(); rerender();
        toast(norm.needsReview ? '已定位，精度较差，建议核对起点' : '已使用当前位置');
      } catch (e) { toast(e.message); }
    }, (err) => {
      toast(err.code === 1 ? '定位权限被拒绝，可搜索地点或在地图上选起点' : '定位失败，请重试或手动选点', 3500);
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 });
  }

  function openSearch(purpose) {
    const input = h('input', { class: 'input', placeholder: purpose === 'origin' ? '搜索起点：地点或场所' : purpose === 'endpoint' ? '搜索终点' : '搜索点位' });
    const list = h('div', {});
    const doSearch = async () => {
      const q = input.value.trim();
      if (!q) return;
      list.innerHTML = '<div class="empty">搜索中…</div>';
      try {
        const r = await get(`/v1/places/search?q=${encodeURIComponent(q)}`);
        list.innerHTML = '';
        if (!r.results.length) { list.append(h('div', { class: 'empty' }, '没有找到匹配地点')); return; }
        for (const item of r.results) {
          list.append(h('div', { class: 'poi-result', onclick: () => pickSearchResult(purpose, item) },
            h('div', { class: 'n' }, item.name),
            h('div', { class: 'a' }, item.disambiguation || item.address || '')));
        }
      } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'empty' }, e.message)); }
    };
    input.addEventListener('input', debounce(doSearch, 320));
    openSheet(purpose === 'origin' ? '搜索起点' : purpose === 'endpoint' ? '搜索终点' : '搜索点位', h('div', {}, input, list));
    input.focus();
  }

  function pickSearchResult(purpose, item) {
    const coord = item.coord || null;
    if (purpose === 'origin') {
      if (coord) d.origin = { lng: coord.lng, lat: coord.lat, crs: 'GCJ02', label: item.name, source: 'search' };
    } else if (purpose === 'endpoint') {
      if (coord) { d.endpointMode = 'fixed'; d.endpointPoint = { lng: coord.lng, lat: coord.lat, crs: 'GCJ02' }; d.endpointLabel = item.name; }
    } else if (purpose === 'must' || purpose === 'avoid') {
      if (item.kind !== 'poi') { toast('请选择具体点位'); return; }
      const arr = purpose === 'must' ? d.mustVisit : d.avoid;
      if (!arr.some((x) => x.id === item.id)) arr.push({ id: item.id, name: item.name });
    }
    saveDraft(); closeSheet(); rerender();
  }

  /* ================= 组合选点：先搜大致位置 → 地图点准到具体门 ================= */
  // 统一入口：演示场所包用 SVG 园区图（含路网/大门，选点更准），其余走高德组合面板
  async function openPointPicker(purpose) {
    const isLive = String(d.venueId || '').startsWith('live:');
    if (d.venueId && !isLive) return openMapPick(purpose);
    return openAmapPicker(purpose);
  }

  async function openMapPick(purpose) {
    const isLive = String(d.venueId || '').startsWith('live:');
    if (isLive || !d.venueId) return openAmapPicker(purpose);
    const pack = await getVenuePack(d.venueId);
    const wrap = h('div', { class: 'map-wrap' });
    openSheet(purpose === 'origin' ? '地图选起点' : '地图选终点',
      h('div', {}, wrap, h('div', { class: 'tl-meta', style: 'margin:6px 0' }, '点击地图选择位置；靠近出入口会自动吸附')));
    const center = pack.venue.center;
    const proj = makeProjector(center);
    const map = new SvgMap(wrap, {
      height: 340,
      onPick: (pt) => {
        const lngLat = xyToLngLat(proj, center, pt);
        const near = nearestNode(pack, pt, proj);
        const snapped = near && near.distanceM < 60;
        if (purpose === 'origin') {
          d.origin = snapped
            ? { lng: near.node.lng, lat: near.node.lat, crs: 'GCJ02', entranceId: near.node.type === 'entrance' ? near.node.id : null, poiId: near.node.type === 'poi' ? near.node.id : null, label: near.node.name, source: 'map_pick' }
            : { lng: lngLat.lng, lat: lngLat.lat, crs: 'GCJ02', entranceId: null, poiId: null, label: '地图所选位置', source: 'map_pick' };
        } else {
          d.endpointMode = 'fixed';
          d.endpointPoint = snapped ? { lng: near.node.lng, lat: near.node.lat, crs: 'GCJ02' } : { lng: lngLat.lng, lat: lngLat.lat, crs: 'GCJ02' };
          d.endpointLabel = snapped ? near.node.name : '地图所选终点';
          // 大门/点位级精度要一路传到规划器，吸附失败必须清掉残留 id
          d.endpointEntranceId = snapped && near.node.type === 'entrance' ? near.node.id : null;
          d.endpointPoiId = snapped && near.node.type === 'poi' ? near.node.id : null;
        }
        saveDraft(); closeSheet(); rerender();
      },
    });
    drawPackBase(map, pack, proj);
  }

  /* ================= 组合选点：先搜大致位置 → 地图点准到具体门 ================= */
  async function openAmapPicker(purpose) {
    if (!state.config.amapJsKey) { toast('未配置高德 JS Key，请先用搜索或定位'); return; }
    const isOrigin = purpose === 'origin';
    const preset = isOrigin
      ? (d.origin ? { lng: d.origin.lng, lat: d.origin.lat, label: d.origin.label, entranceId: d.origin.entranceId || null, poiId: d.origin.poiId || null } : null)
      : (d.endpointPoint ? { lng: d.endpointPoint.lng, lat: d.endpointPoint.lat, label: d.endpointLabel, entranceId: d.endpointEntranceId || null, poiId: d.endpointPoiId || null } : null);

    // 景区模式预取大门清单：直接选门是最可靠的"精确到哪个门"
    let gates = [];
    if (d.venueId) {
      try {
        const pack = await getVenuePack(d.venueId);
        gates = (pack.nodes || []).filter((n) => n.type === 'entrance');
      } catch (e) { /* 拿不到大门清单就退化为纯地图选点 */ }
    }

    const center = preset ? { lng: preset.lng, lat: preset.lat }
      : d.venueRef ? { lng: d.venueRef.lng, lat: d.venueRef.lat }
        : d.origin ? { lng: d.origin.lng, lat: d.origin.lat } : { lng: 104.0656, lat: 30.6595 };

    const searchInput = h('input', { class: 'input', placeholder: '先输入大致位置，如「东门」「地铁站」「酒店」' });
    const resultList = h('div', { style: 'max-height:170px;overflow-y:auto' });
    // 场景快捷词：周边检索不一定返回大门类点位，但文本搜索能搜到「景区名+大门」
    const sugRow = d.venueRef ? h('div', { class: 'chips', style: 'margin-top:6px' },
      ['大门', '停车场', '地铁站'].map((kw) => h('button', {
        class: 'chip',
        onclick: () => { searchInput.value = d.venueRef.name + ' ' + kw; doSearch(); },
      }, '🔍 ' + kw))) : null;
    const gateChips = gates.map((g) => h('button', {
      class: 'chip',
      onclick: () => {
        applyPick({ lng: g.lng, lat: g.lat, label: g.name, entranceId: g.id, poiId: null });
        if (map) map.setZoomAndCenter(16, [g.lng, g.lat]);
      },
    }, '🚪 ' + g.name));
    const gateRow = gates.length ? h('div', { style: 'margin-top:10px' },
      h('div', { class: 'field-label' }, '直达景区大门（导航真正可用）'),
      h('div', { class: 'chips' }, gateChips)) : null;
    const pickLabel = h('div', { class: 'value-row', style: 'margin-top:10px' }, preset ? '已选：' + (preset.label || '地图所选位置') : '在地图上点一下，或先搜索大致位置');
    const confirmBtn = h('button', { class: 'btn btn-primary btn-block', disabled: !preset }, isOrigin ? '确认起点' : '确认终点');
    const wrap = h('div', { class: 'map-wrap', style: 'margin-top:8px' });
    openSheet(isOrigin ? '起点定在哪里？' : '终点定在哪里？',
      h('div', {}, searchInput, sugRow, resultList, wrap, gateRow, pickLabel, confirmBtn));

    let map = null, marker = null, clickSeq = 0;
    let picked = preset ? { ...preset } : null;

    function applyPick(pt) {
      picked = { lng: pt.lng, lat: pt.lat, label: pt.label || '地图所选位置', entranceId: pt.entranceId || null, poiId: pt.poiId || null };
      confirmBtn.disabled = false;
      pickLabel.textContent = '已选：' + picked.label + (picked.entranceId ? ' · 大门精确入口' : '');
      gateChips.forEach((b, i) => b.classList.toggle('sel', !!picked.entranceId && picked.entranceId === gates[i].id));
      if (!map) return;
      if (!marker) {
        // 高德 2.0：构造的覆盖物不会自动上图，必须 map.add
        marker = new AMap.Marker({
          position: [picked.lng, picked.lat], anchor: 'bottom-center',
          content: '<div style="width:16px;height:16px;border-radius:50%;background:#0f6f4f;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.35)"></div>',
        });
        map.add(marker);
      } else marker.setPosition([picked.lng, picked.lat]);
    }
    if (preset) applyPick(preset); // 回显已选（地图未就绪时先更新文字与大门 chips）

    const doSearch = async () => {
      const q = searchInput.value.trim();
      if (!q) { resultList.innerHTML = ''; return; }
      resultList.innerHTML = '<div class="empty">搜索中…</div>';
      try {
        const r = await get(`/v1/places/search?q=${encodeURIComponent(q)}`);
        resultList.innerHTML = '';
        const hits = r.results.filter((x) => x.coord);
        if (!hits.length) { resultList.append(h('div', { class: 'empty' }, '没有找到匹配地点')); return; }
        for (const item of hits) {
          resultList.append(h('div', {
            class: 'poi-result',
            onclick: () => {
              applyPick({ lng: item.coord.lng, lat: item.coord.lat, label: item.name });
              resultList.innerHTML = '';
              if (map) map.setZoomAndCenter(16, [item.coord.lng, item.coord.lat]);
            },
          }, h('div', { class: 'n' }, item.name), h('div', { class: 'a' }, item.disambiguation || item.address || '')));
        }
      } catch (e) { resultList.innerHTML = ''; resultList.append(h('div', { class: 'empty' }, e.message)); }
    };
    searchInput.addEventListener('input', debounce(doSearch, 320));

    try {
      const AMap = await loadAmap(state.config.amapJsKey, state.config.amapJsSecurityCode);
      const div = h('div', {});
      wrap.append(div);
      map = new AMap.Map(div, { zoom: 16, center: [center.lng, center.lat], viewMode: '2D', mapStyle: 'amap://styles/fresh' });
      div.style.height = '300px';
      for (const g of gates) {
        const gm = new AMap.Marker({
          position: [g.lng, g.lat], anchor: 'bottom-center',
          content: `<div style="background:#0f6f4f;color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3)">🚪${g.name}</div>`,
        });
        gm.on('click', () => applyPick({ lng: g.lng, lat: g.lat, label: g.name, entranceId: g.id }));
        map.add(gm);
      }
      if (picked) applyPick(picked); // 地图就绪后补挂已选 marker
      map.on('click', async (e) => {
        const lng = e.lnglat.getLng(), lat = e.lnglat.getLat();
        const seq = ++clickSeq;
        // 靠近大门(<80m)自动吸附：起点/终点钉在门上，园内路网规划与真实导航才对得上
        let hit = null;
        for (const g of gates) {
          const dist = Math.hypot((lng - g.lng) * 95803, (lat - g.lat) * 110940);
          if (dist < 80 && (!hit || dist < hit.dist)) hit = { g, dist };
        }
        if (hit) { applyPick({ lng: hit.g.lng, lat: hit.g.lat, label: hit.g.name, entranceId: hit.g.id }); return; }
        applyPick({ lng, lat, label: '定位中…' });
        try {
          const rev = await post('/v1/locations/reverse', { lng, lat });
          if (seq === clickSeq) applyPick({ lng, lat, label: rev.label || '地图所选位置' });
        } catch (err) {
          if (seq === clickSeq) applyPick({ lng, lat, label: '地图所选位置' });
        }
      });
      cleanupFns.push(() => { try { map.destroy(); } catch (e2) {} });
    } catch (e) { toast('高德底图加载失败，可先用搜索选定大致位置'); }

    confirmBtn.onclick = () => {
      if (!picked) return;
      if (isOrigin) {
        d.origin = { lng: picked.lng, lat: picked.lat, crs: 'GCJ02', label: picked.label, source: 'map_pick', entranceId: picked.entranceId, poiId: picked.poiId };
      } else {
        d.endpointMode = 'fixed';
        d.endpointPoint = { lng: picked.lng, lat: picked.lat, crs: 'GCJ02' };
        d.endpointLabel = picked.label;
        d.endpointEntranceId = picked.entranceId;
        d.endpointPoiId = picked.poiId;
      }
      saveDraft(); closeSheet(); rerender();
    };
  }

  /* ================= 渲染 ================= */
  view.append(
    h('div', { class: 'card' }, stepsBar, d.step === 1 ? step1 : d.step === 2 ? step2 : step3),
    aiBox,
    bottomBar,
  );
  return () => cleanupFns.forEach((f) => { try { f(); } catch (e) {} });

  /* ---------- 局部小组件 ---------- */
  function segBtn(label, sel, onclick) { return h('button', { class: sel ? 'sel' : '', onclick }, label); }
  function optRow(emoji, title, desc, onclick) {
    return h('button', { class: 'opt-row', onclick },
      h('span', { class: 'opt-e' }, emoji),
      h('div', {}, h('div', { class: 'opt-t' }, title), h('div', { class: 'opt-d' }, desc)));
  }
}

/* ================= 模块级工具 ================= */
export function timeLabel(dd) {
  if (dd.timeMode === 'arriveBy') return `${dd.latestEndClock} 前到`;
  const hit = DURATION_PRESETS.find(([s]) => s === dd.durationSec);
  return hit ? hit[1] : `${Math.round(dd.durationSec / 60)} 分钟`;
}
export function endLabel(dd) {
  return dd.endpointMode === 'return_to_origin' ? '回到起点'
    : dd.endpointMode === 'flexible' ? '顺路结束'
      : (dd.endpointLabel || '指定终点');
}
export function buildIntentPayload(d) {
  return {
    form: {
      scene: d.scene === 'auto' ? undefined : d.scene,
      venueId: d.venueId || null, venueRef: d.venueRef || null, objective: d.objective,
      origin: d.origin ? {
        lng: d.origin.lng, lat: d.origin.lat, crs: d.origin.crs || 'GCJ02',
        poiId: d.origin.poiId || null, entranceId: d.origin.entranceId || null,
        label: d.origin.label, source: d.origin.source,
      } : null,
      timeMode: d.timeMode, durationSec: d.durationSec, latestEndClock: d.latestEndClock,
      startMode: d.startMode, startAtMs: d.startAtMs,
      endpointMode: d.endpointMode,
      endpointPoint: d.endpointPoint, endpointLabel: d.endpointLabel,
      endpointEntranceId: d.endpointEntranceId, endpointPoiId: d.endpointPoiId,
      mobility: d.mobility, pace: d.pace, interests: d.interests,
      mustVisitIds: d.mustVisit.map((x) => x.id), avoidPoiIds: d.avoid.map((x) => x.id),
      freePreferred: d.freePreferred, budgetHardZero: d.budgetHardZero, avoidRepeat: d.avoidRepeat,
      stepFreeRequired: d.stepFreeRequired, restPreferred: d.restPreferred, quietPreferred: d.quietPreferred,
      guideStyle: d.guideStyle, needsText: d.stepFew ? '少台阶' : '',
    },
    text: d.text || '',
    timezone: 'Asia/Shanghai',
  };
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function optionLabel(field, op) {
  const map = { mobility: { walk: '按步行', bike: '按骑行' }, mustVisit: { remove: '去掉这个必去点', keep_anyway: '仍保留' } };
  return (map[field] && map[field][op]) || op;
}
function xyToLngLat(proj, origin, pt) {
  const mPerDegLat = 110940;
  const mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return { lng: origin.lng + pt.x / mPerDegLng, lat: origin.lat - pt.y / mPerDegLat };
}
function nearestNode(pack, pt, proj) {
  let best = null, bestD = Infinity;
  for (const n of pack.nodes) {
    const p = proj.toXY(n);
    const dist = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (dist < bestD) { bestD = dist; best = n; }
  }
  return best ? { node: best, distanceM: bestD } : null;
}

export function drawPackBase(map, pack, proj) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const n of pack.nodes) {
    const p = proj.toXY(n);
    bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y); bounds.maxY = Math.max(bounds.maxY, p.y);
  }
  for (const e of pack.edges || []) {
    const a = pack.nodes.find((n) => n.id === e.from);
    const b = pack.nodes.find((n) => n.id === e.to);
    if (!a || !b) continue;
    const pa = proj.toXY(a), pb = proj.toXY(b);
    map.el('line', {
      x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y,
      stroke: e.closed ? '#d97706' : '#b9c8c0', 'stroke-width': e.closed ? 2 : 3,
      'stroke-dasharray': e.closed ? '6 5' : 'none', 'stroke-linecap': 'round', opacity: 0.8,
    });
  }
  for (const n of pack.nodes) {
    const p = proj.toXY(n);
    if (n.type === 'entrance') {
      map.el('rect', { x: p.x - 7, y: p.y - 7, width: 14, height: 14, rx: 3, fill: '#0f6f4f' });
      drawMapLabel(map, p, n.name, -10);
    } else if (n.type === 'poi') {
      map.el('circle', { cx: p.x, cy: p.y, r: 5, fill: '#fff', stroke: '#8aa398', 'stroke-width': 2 });
      drawMapLabel(map, p, n.name, -9);
    }
  }
  map.fit(bounds, 50);
}
export function drawMapLabel(map, p, text, dy, color) {
  // 无框光晕标签：白描边(paint-order:stroke)让文字在任何底图上醒目又不遮挡
  const t = map.el('text', {
    x: p.x, y: p.y + dy, 'font-size': 11.5, fill: color || '#14332a', 'font-weight': 700,
    'text-anchor': 'middle', stroke: '#ffffff', 'stroke-width': 3,
    'paint-order': 'stroke', 'stroke-linejoin': 'round', class: 'am-name',
  });
  t.textContent = text;
}
