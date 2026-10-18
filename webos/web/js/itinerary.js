// 城市多日行程规划器：表单 → 确定性规划结果 → 保存为行程单 / 打开已保存行程
import { get, post } from './api.js';
import { h, toast, fmtDateTime } from './ui.js';

const INTERESTS = ['人文', '自然', '建筑', '街区', '美食', '公园湿地', '亲子', '夜景'];
const PACE_TXT = { easy: '轻松（一天 1 处主游）', normal: '适中（1-2 处/天）', active: '紧凑（2-3 处/天）' };
const BUDGET_TXT = { economy: '经济（餐饮约 ¥80/天）', comfort: '舒适（约 ¥150/天）', premium: '品质（约 ¥260/天）' };

export async function renderItinerary(view, ctx, query) {
  // 支持四种进入方式：城市、模板（带骨架）、指定场所（focus）、已保存行程单（order）
  if (query.get('order')) return renderSavedOrder(view, query.get('order'));

  const citiesData = await get('/v1/hub/cities');
  const form = {
    cityId: query.get('city') || 'beijing',
    days: Number(query.get('days')) || 3,
    people: Number(query.get('people')) || 2,
    interests: [], pace: 'normal', budget: 'comfort',
  };
  let templateId = query.get('template') || null;
  const mustVenueIds = [];
  const bannerRows = [];

  if (templateId) {
    try {
      const { template: t } = await get('/v1/hub/templates/' + templateId);
      form.cityId = t.cityId || form.cityId;
      if (t.draft && t.draft.days) form.days = Number(t.draft.days);
      if (t.draft && t.draft.pace) form.pace = t.draft.pace;
      if (t.draft && Array.isArray(t.draft.interests) && t.draft.interests.length) form.interests = [...t.draft.interests];
      const row = bannerRow(`已带入模板《${t.name}》`,
        `${t.cityName || ''} · ${form.days} 天 · ${form.interests.join('、') || '综合'} · 途经 ${(t.stops || []).length} 处，生成时会保证纳入`,
        '不用模板', () => { templateId = null; row.remove(); toast('已取消模板，按当前条件自由排'); });
      bannerRows.push(row);
    } catch (e) { toast('模板加载失败：' + e.message); templateId = null; }
  }
  if (query.get('focus')) {
    try {
      const { venue } = await get('/v1/hub/venues/' + query.get('focus'));
      mustVenueIds.push(venue.id);
      const row = bannerRow(`已指定必去：${venue.name}`,
        '生成时优先纳入；若天数/节奏装不下会明确提示，不会静默丢掉',
        '取消指定', () => { mustVenueIds.length = 0; row.remove(); });
      bannerRows.push(row);
    } catch (e) { toast('场所加载失败：' + e.message); }
  }

  const resultBox = h('div', {});
  resultBoxRef = resultBox;
  view.append(
    ...(bannerRows.length ? [h('div', { class: 'card itin-banner' }, ...bannerRows)] : []),
    h('div', { class: 'card' },
      h('h3', {}, '城市多日行程规划'),
      h('div', { class: 'tl-meta' }, '确定性算法：按评分+兴趣权重选场所，按地理就近串每日动线；票价为参考值（未核验）'),
      h('div', { class: 'field', style: 'margin-top:10px' }, h('label', { class: 'field-label', for: 'it-city' }, '目的地'),
        h('select', { class: 'input', id: 'it-city' },
          ...citiesData.cities.map((c) => h('option', { value: c.id, selected: c.id === form.cityId }, `${c.name}（${c.venueCount} 处场所）`)))),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'it-days' }, '天数'),
        h('select', { class: 'input', id: 'it-days' },
          ...[1, 2, 3, 4, 5, 6, 7].map((n) => h('option', { value: String(n), selected: n === form.days }, `${n} 天`)))),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, '兴趣（不选 = 综合）'),
        h('div', { class: 'chips', id: 'it-interests' },
          ...INTERESTS.map((t) => h('button', {
            class: 'chip' + (form.interests.includes(t) ? ' sel' : ''),
            'aria-pressed': String(form.interests.includes(t)),
            onclick: (e) => {
              e.currentTarget.classList.toggle('sel');
              e.currentTarget.setAttribute('aria-pressed', String(e.currentTarget.classList.contains('sel')));
              if (form.interests.includes(t)) form.interests = form.interests.filter((x) => x !== t);
              else form.interests.push(t);
            },
          }, t)))),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'it-pace' }, '节奏'),
        h('select', { class: 'input', id: 'it-pace' },
          ...Object.keys(PACE_TXT).map((k) => h('option', { value: k, selected: k === form.pace }, PACE_TXT[k])))),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'it-budget' }, '预算档'),
        h('select', { class: 'input', id: 'it-budget' },
          ...Object.keys(BUDGET_TXT).map((k) => h('option', { value: k }, BUDGET_TXT[k])))),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'it-people' }, '人数'),
        h('select', { class: 'input', id: 'it-people' },
          ...[1, 2, 3, 4, 5, 6, 8, 10].map((n) => h('option', { value: String(n), selected: n === form.people }, `${n} 人`)))),
      h('button', { class: 'btn btn-primary btn-lg', onclick: generate }, '生成行程')),
    resultBox,
  );

  async function generate() {
    form.cityId = document.getElementById('it-city').value;
    form.days = Number(document.getElementById('it-days').value);
    form.pace = document.getElementById('it-pace').value;
    form.budget = document.getElementById('it-budget').value;
    form.people = Number(document.getElementById('it-people').value);
    resultBox.innerHTML = '';
    resultBox.append(h('div', { class: 'card empty' }, '正在计算行程…'));
    try {
      const body = { ...form, mustVenueIds };
      if (templateId) body.templateId = templateId;
      const plan = await post('/v1/itineraries/preview', body);
      renderResult(plan);
    } catch (e) {
      resultBox.innerHTML = '';
      resultBox.append(h('div', { class: 'card empty' }, '生成失败：' + e.message));
    }
  }
}

let resultBoxRef = null;
function bannerRow(title, sub, actionLabel, onAction) {
  return h('div', { class: 'ib-row' },
    h('div', { class: 'ib-main' },
      h('div', { class: 'ib-title' }, title),
      h('div', { class: 'tl-meta' }, sub)),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: onAction }, actionLabel));
}

/** 已保存的行程单：直接渲染保存时的结果，保证与保存那刻逐日一致 */
async function renderSavedOrder(view, orderId) {
  const box = h('div', {});
  view.append(box);
  box.append(h('div', { class: 'card empty' }, '正在打开行程单…'));
  try {
    const { order } = await get('/v1/orders/' + orderId);
    const snap = order.snapshot || null;
    box.innerHTML = '';
    if (!snap || !Array.isArray(snap.dayList)) {
      box.append(h('div', { class: 'card' },
        h('h3', {}, order.title || '行程单'),
        h('div', { class: 'tl-meta' }, '这份行程单保存于旧版本，未包含完整行程明细；可点「按这份重排」重新生成。'),
        h('button', {
          class: 'btn btn-primary btn-block',
          onclick: () => { location.hash = `#/itinerary?city=${order.cityId}&days=${order.days}&people=${order.people}`; },
        }, '按这份重排')));
      return;
    }
    const plan = {
      cityName: snap.cityName, days: snap.days, pace: snap.pace, budget: snap.budget,
      people: snap.people, totals: snap.totals || { tickets: 0, meals: 0, transport: 0, total: order.totalEstimateCny || 0 },
      itinerary: snap.dayList, notices: snap.notices || [],
    };
    const reopen = () => {
      const qs = [`city=${order.cityId}`, `days=${order.days}`, `people=${order.people}`];
      if (snap.pace) qs.push(`pace=${snap.pace}`);
      location.hash = '#/itinerary?' + qs.join('&');
    };
    box.append(h('div', { class: 'card itin-hero' },
      h('h3', { style: 'margin:0' }, `${order.title} `, h('span', { class: 'tag' }, '已保存')),
      h('div', { class: 'tl-meta' }, `保存于 ${fmtDateTime(order.createdAt)}${snap.generatedAt ? ` · 生成于 ${fmtDateTime(snap.generatedAt)}` : ''}`),
      h('div', { class: 'tl-meta' }, `${PACE_TXT[plan.pace] || '适中'} · ${plan.people} 人 · 人均预估 ¥${Math.round((plan.totals.total || 0) / Math.max(1, plan.people))} / 总预估 ¥${plan.totals.total || 0}`),
      h('div', { class: 'tl-actions' },
        h('button', { class: 'btn btn-primary btn-sm', onclick: reopen }, '按这份重排'),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { location.hash = '#/me'; } }, '返回我的'))),
      ...dayCards(plan),
      h('div', { class: 'card' },
        h('p', { class: 'card-title' }, '说明'),
        ...plan.notices.map((n) => h('div', { class: 'warn-line' }, 'ℹ ' + n)),
        h('div', { class: 'tl-meta', style: 'margin-top:6px' }, '以上为保存当时的行程快照；内容库或算法更新不会改动已保存结果。')));
  } catch (e) {
    box.innerHTML = '';
    box.append(h('div', { class: 'card empty' }, '打开失败：' + e.message));
  }
}

function dayCards(plan) {
  return (plan.itinerary || []).map((d) => h('div', { class: 'card itin-day' },
    h('div', { class: 'itin-day-head' },
      h('span', { class: 'itin-day-num' }, `D${d.day}`),
      h('b', {}, d.theme || '自由活动')),
    ...d.slots.map((s) => h('div', { class: 'itin-slot' },
      h('div', { class: 'itin-slot-tag' }, s.slot),
      h('div', { class: 'itin-slot-body' },
        h('div', { class: 'itin-slot-name' },
          s.name,
          h('span', { class: 'tag' }, s.kind),
          s.level ? h('span', { class: 'tag' }, s.level) : null,
          h('span', { class: 'tag', style: 'background:#eef3f0' }, `约 ${s.suggestedHours}h`),
          h('button', { class: 'btn btn-ghost btn-sm', style: 'margin-left:auto', onclick: () => { location.hash = '#/venue/' + s.venueId; } }, '详情')),
        h('div', { class: 'itin-pois' }, ...(s.pois || []).map((p) => h('div', { class: 'itin-poi' },
          p.mustSee ? h('span', { class: 'tag', style: 'background:var(--warn-bg);color:var(--warn)' }, '必看') : h('span', { class: 'tag' }, '看点'),
          ' ', p.name, p.brief ? ` — ${p.brief}` : ''))),
        h('div', { class: 'tl-meta' }, `门票：${s.ticket.referencePriceCny === 0 ? '免费' : s.ticket.referencePriceCny ? `约 ¥${s.ticket.referencePriceCny}/人` : '未知'}${s.ticket.known ? '' : '（未核验）'}${s.ticket.note ? ' · ' + s.ticket.note : ''}`)))),
    d.transferTips && d.transferTips.length ? h('div', { class: 'itin-transfer' }, ...d.transferTips.map((t) => h('div', {}, '🚶 ' + t))) : null,
    h('div', { class: 'itin-day-budget' }, `当日预估 ¥${d.budgetCny.total}（门票 ¥${d.budgetCny.tickets} · 餐饮 ¥${d.budgetCny.meals} · 交通 ¥${d.budgetCny.transport}）`)));
}

function renderResult(plan) {
  const resultBox = resultBoxRef;
  if (!resultBox) return;
  resultBox.innerHTML = '';
  let saving = false;
  resultBox.append(
    h('div', { class: 'card itin-hero' },
      h('h3', { style: 'margin:0' }, `${plan.cityName} · ${plan.days} 日行程`),
      plan.template ? h('div', { class: 'tl-meta' }, `按模板《${plan.template.name}》生成；途经点已优先纳入`) : null,
      h('div', { class: 'tl-meta' }, `${PACE_TXT[plan.pace]} · ${plan.people} 人 · 人均预估 ¥${Math.round(plan.totals.total / plan.people)} / 总预估 ¥${plan.totals.total}`),
      h('div', { class: 'itin-total' },
        h('div', {}, '门票参考 ', h('b', {}, `¥${plan.totals.tickets}`)),
        h('div', {}, '餐饮 ', h('b', {}, `¥${plan.totals.meals}`)),
        h('div', {}, '市内交通 ', h('b', {}, `¥${plan.totals.transport}`))),
      h('div', { class: 'tl-actions' },
        h('button', {
          class: 'btn btn-primary btn-sm',
          'data-role': 'save',
          onclick: async (e) => {
            if (saving) return; // 防连点：重复提交会被幂等键拦下，这里也不发第二次请求
            saving = true;
            e.currentTarget.disabled = true;
            try {
              const r = await post('/v1/orders', {
                type: 'itinerary', cityId: plan.cityId, people: plan.people, itinerary: plan,
                idempotencyKey: `itin_${plan.cityId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              });
              toast('已保存到「我的行程单」', 2500);
              location.hash = '#/itinerary?order=' + r.order.id;
            } catch (err) {
              toast(err.message, 3000);
              saving = false;
              e.currentTarget.disabled = false;
            }
          },
        }, '保存为行程单'))),
    ...dayCards(plan),
    h('div', { class: 'card' },
      h('p', { class: 'card-title' }, '诚实边界'),
      ...plan.notices.map((n) => h('div', { class: 'warn-line' }, 'ℹ ' + n))),
  );
  resultBox.scrollIntoView({ behavior: 'smooth' });
}
