// 结束回顾 / 我的（历史·汇总·偏好）/ 数据后台
import { get, post, put, del } from './api.js';
import { h, toast, openSheet, closeSheet, fmtMin, fmtKm, fmtClock } from './ui.js';
import { state } from './app.js';

/* ================= 结束回顾（§13.1/§13.2） ================= */
export function renderFinish(view, ctx, tripId) {
  const root = h('div', {});
  view.append(root);

  async function boot() {
    const data = await get('/v1/trips/' + tripId);
    const trip = data.trip;
    // finish 接口幂等：直接再取一次 summary
    const fin = await post(`/v1/trips/${tripId}/finish`, { idempotencyKey: 'fin_view_' + tripId });
    const s = fin.summary;
    root.innerHTML = '';
    // 导游视角的回顾：先讲"逛了什么、看到什么"，再列数据
    const highlights = s.visitedHighlights || [];
    // 注意：原生 append 会把 null/undefined 渲染成字面量，统一先过滤
    root.append(...[ 
      h('div', { class: 'card', style: 'text-align:center' },
        h('div', { style: 'font-size:34px' }, trip.status === 'completed' ? '🎉' : '👋'),
        h('h3', {}, trip.status === 'completed' ? '游览小结' : '这次先逛到这儿'),
        h('div', { class: 'tl-meta' }, [s.venueName, s.startedAt ? s.startedAt.slice(5, 16).replace('T', ' ') : ''].filter(Boolean).join(' · '))),
      highlights.length ? h('div', { class: 'card' },
        h('p', { class: 'card-title' }, `这一趟走过的地方（${highlights.length} 处）`),
        ...highlights.map((v, i) => h('div', { class: 'highlight-item' },
          h('div', { class: 'h-name' }, `${i + 1}. ${v.name}`, h('span', { class: 'tag', style: 'margin-left:6px' }, v.at ? v.at.slice(11, 16) : '')),
          v.teaser ? h('div', { class: 'h-teaser' }, v.teaser) : h('div', { class: 'h-teaser' }, '（该点位暂无已核验讲解）'),
          v.note ? h('div', { class: 'h-note' }, '✎ ' + v.note) : null))) : null,
      (s.looseNotes && s.looseNotes.length) ? h('div', { class: 'card' },
        h('p', { class: 'card-title' }, '路上随手记'),
        ...s.looseNotes.map((n) => h('div', { class: 'highlight-item' },
          h('div', { class: 'h-name' }, n.name || '路上'),
          h('div', { class: 'h-note' }, '✎ ' + n.text)))) : null,
      h('div', { class: 'card proc-card' },
        h('p', { class: 'card-title' }, '过程记录'),
        h('div', { class: 'proc-sub' }, `${s.startedAt ? s.startedAt.slice(11, 16) : ''} 出发 → ${s.finishedAt ? s.finishedAt.slice(11, 16) : '—'} 结束 · 计划与实际分开记录`),
        h('div', { class: 'proc-stats' },
          procStat('用时', s.actualDurationSec == null ? '未知' : s.actualDurationSec < 60 ? '<1 分钟' : fmtMin(s.actualDurationSec), s.plannedDurationSec ? `计划约 ${fmtMin(s.plannedDurationSec)}` : ''),
          procStat('到访', `${(s.confirmedVisits || []).length} 站`, s.skippedStops.length ? `跳过 ${s.skippedStops.length} 站` : '全部走到'),
          procStat('途中调整', s.replanCount ? `${s.replanCount} 次` : '无', s.replanCount ? `共 ${s.versionCount} 个路线版本` : ''),
          procStat('规划距离', fmtKm(s.distanceM), '无实际轨迹')),
        h('div', { class: 'proc-block' },
          h('div', { class: 'proc-label' }, `原计划 · ${s.plannedStops.length} 站`),
          h('div', { class: 'proc-chips' }, s.plannedStops.map((name, i) =>
            h('span', { class: 'proc-chip' }, h('i', {}, String(i + 1)), name)))),
        s.skippedStops.length ? h('div', { class: 'proc-block' },
          h('div', { class: 'proc-label' }, `实际 · 跳过 ${s.skippedStops.length} 站`),
          h('div', { class: 'proc-chips' }, s.skippedStops.map((x) =>
            h('span', { class: 'proc-chip skip' }, x.name)))) : null,
        h('div', { class: 'proc-note' },
          h('span', { class: 'proc-note-i' }, 'i'),
          h('span', {}, s.distanceNote)),
        h('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:10px', onclick: () => copySummary(s, highlights) }, '复制小结分享给朋友')),
      buildFeedback(tripId),
      h('div', { class: 'chips', style: 'justify-content:center' },
        h('button', { class: 'chip', onclick: () => { location.hash = '#/me'; } }, '查看历史记录'),
        h('button', { class: 'chip', onclick: () => { location.hash = '#/'; } }, '再规划一条')),
    ].filter(Boolean));
  }

  /** 生成一段可粘贴分享的游览小结（只有确实发生的事，不润色成不存在的内容） */
  function copySummary(s, highlights) {
    const lines = [];
    lines.push(`【${s.venueName || '游览'}小结】`);
    if (highlights.length) {
      lines.push(`走过 ${highlights.length} 处：` + highlights.map((v) => v.name).join('、'));
      const withTeaser = highlights.filter((v) => v.teaser).slice(0, 3);
      for (const v of withTeaser) lines.push(`· ${v.name}：${v.teaser}`);
      const notes = highlights.filter((v) => v.note);
      if (notes.length) lines.push('现场记下：' + notes.map((v) => v.note).join(' / '));
      if ((s.looseNotes || []).length) lines.push('路上随手记：' + s.looseNotes.map((n) => n.text).join(' / '));
    } else {
      lines.push('本次没有确认到访的点位。');
    }
    if (s.actualDurationSec) lines.push(`用时约 ${fmtMin(s.actualDurationSec)}。`);
    if (s.skippedStops.length) lines.push(`跳过：${s.skippedStops.map((x) => x.name).join('、')}。`);
    const text = lines.join('\n');
    const done = () => toast('已复制，粘贴到微信即可分享');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { openSheet('小结文本', h('div', { class: 'guide-block' }, text)); }
    document.body.removeChild(ta);
  }

  function buildFeedback(tid) {
    let rating = 0;
    const reasons = new Set();
    const stars = h('div', { class: 'stars' }, [1, 2, 3, 4, 5].map((n) =>
      h('button', {
        onclick: (e) => {
          rating = n;
          stars.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i < n));
        },
      }, '★')));
    const reasonChips = h('div', { class: 'chips' }, ['太赶', '太累', '内容一般', '讲解有趣', '路线顺'].map((r) =>
      h('button', {
        class: 'chip',
        onclick: (e) => {
          const on = reasons.has(r);
          if (on) reasons.delete(r); else reasons.add(r);
          e.currentTarget.classList.toggle('sel', !on);
        },
      }, r)));
    const card = h('div', { class: 'card' },
      h('p', { class: 'card-title' }, '这条路线合你心意吗？（可跳过，不影响保存记录）'),
      stars,
      h('div', { style: 'margin:8px 0' }, reasonChips),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn btn-primary btn-sm',
          onclick: async () => {
            if (!rating) { toast('点个星星再提交，或直接跳过'); return; }
            try {
              await post('/v1/feedback', { tripId: tid, targetType: 'route', rating, reasons: [...reasons] });
              card.innerHTML = '';
              card.append(
                h('p', { class: 'card-title' }, '已收到你的反馈'),
                h('div', { class: 'tl-meta' }, `评分 ${rating} 星${reasons.size ? ' · ' + [...reasons].join('、') : ''}，会用于改进后续路线。`));
              toast('感谢反馈！');
            } catch (e) { toast(e.message); }
          },
        }, '提交反馈'),
        h('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => {
            card.remove();
            toast('已跳过评价，游览记录已保存');
          },
        }, '跳过')));
    return card;
  }

  boot().catch((e) => root.append(h('div', { class: 'card empty' }, e.message)));
  return () => {};
}

function procStat(k, v, sub) {
  return h('div', { class: 'proc-stat' },
    h('span', { class: 'proc-stat-k' }, k),
    h('b', {}, v),
    sub ? h('span', { class: 'proc-stat-s' }, sub) : null);
}

/* ================= 我的 ================= */
export function renderMe(view) {
  const root = h('div', {});
  view.append(root);

  async function boot() {
    root.innerHTML = '';
    const [tripsResp, sumResp, prefResp, ordResp] = await Promise.all([
      get('/v1/me/trips'), get('/v1/me/summaries?period=week'), get('/v1/me/preferences'),
      get('/v1/orders?type=itinerary&status=planned'),
    ]);

    /* 本周汇总 */
    root.append(h('div', { class: 'card' },
      h('p', { class: 'card-title' }, '本周回顾'),
      h('div', { class: 'rc-stats' },
        h('span', {}, `完成 ${sumResp.completedTrips} 次`),
        h('span', {}, `提前结束 ${sumResp.endedEarlyTrips} 次`),
        h('span', {}, `确认到访 ${sumResp.confirmedVisitCount} 站`),
        h('span', {}, `不同地点 ${sumResp.distinctPlaceCount} 个`),
        h('span', {}, `规划距离合计 ${fmtKm(sumResp.knownDistanceM)}`)),
      h('div', { class: 'tl-meta', style: 'margin-top:6px;color:var(--warn)' }, sumResp.dataCompleteness.note)));

    /* 偏好（§13.3/§13.5：可查看、修改、关闭） */
    const p = prefResp.preferences;
    const INTERESTS = ['自然', '公园湿地', '街区', '人文', '建筑', '美食'];
    const prefCard = h('div', { class: 'card' },
      h('p', { class: 'card-title' }, '个性化偏好'),
      h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('span', { style: 'font-size:14px' }, '启用个性化'),
        h('button', {
          class: 'chip' + (p.enabled ? ' sel' : ''), style: 'flex:none',
          onclick: async () => { await put('/v1/me/preferences', { enabled: !p.enabled }); boot(); },
        }, p.enabled ? '已开启' : '已关闭')),
      h('div', { class: 'field-label' }, '兴趣（显式设置优先于系统推断）'),
      h('div', { class: 'chips' }, INTERESTS.map((t) =>
        h('button', {
          class: 'chip' + ((p.interests || []).includes(t) ? ' sel' : ''),
          onclick: async () => {
            const cur = new Set(p.interests || []);
            if (cur.has(t)) cur.delete(t); else cur.add(t);
            await put('/v1/me/preferences', { interests: [...cur] });
            boot();
          },
        }, t))),
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '默认强度'),
      h('div', { class: 'chips' }, [['easy', '轻松'], ['normal', '适中'], ['active', '多走走']].map(([v, name]) =>
        h('button', {
          class: 'chip' + (p.pace === v ? ' sel' : ''),
          onclick: async () => { await put('/v1/me/preferences', { pace: v }); boot(); },
        }, name))),
      h('div', { class: 'tl-meta', style: 'margin-top:8px' }, prefResp.note));
    root.append(prefCard);

    /* 行程单（保存的多日行程，与"历史行程"分开） */
    const savedItins = (ordResp.orders || []).filter((o) => o.type === 'itinerary');
    const itinCard = h('div', { class: 'card' }, h('p', { class: 'card-title' }, '我的行程单'));
    if (!savedItins.length) {
      itinCard.append(h('div', { class: 'empty' }, '还没有保存的行程，去发现页排一个吧'));
    }
    for (const o of savedItins) {
      itinCard.append(h('div', { class: 'poi-result' },
        h('div', { class: 'n' }, `${o.title} `, h('span', { class: 'tag' }, '行程单')),
        h('div', { class: 'a' }, `${o.days} 天 · ${o.people} 人` + (o.totalEstimateCny ? ` · 预估 ¥${o.totalEstimateCny}` : '') + ` · 保存于 ${(o.createdAt || '').slice(0, 10)}`),
        h('div', { class: 'tl-actions' },
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { location.hash = '#/itinerary?city=' + o.cityId; } }, '再排一次'),
          h('button', {
            class: 'btn btn-danger btn-sm',
            onclick: () => {
              openSheet('删除这份行程单？', h('div', {},
                h('p', {}, `「${o.title}」将从你的记录中移除。`),
                h('button', {
                  class: 'btn btn-danger btn-block',
                  onclick: async () => { await post(`/v1/orders/${o.id}/cancel`, { reason: '用户删除' }); closeSheet(); toast('已删除'); boot(); },
                }, '确认删除'),
                h('button', { class: 'btn btn-ghost btn-block', onclick: closeSheet }, '取消')));
            },
          }, '删除'))));
    }
    root.append(itinCard);

    /* 历史记录 */
    const listCard = h('div', { class: 'card' }, h('p', { class: 'card-title' }, '历史行程'));
    if (!tripsResp.trips.length) {
      listCard.append(h('div', { class: 'empty' }, '还没有游览记录，去规划第一条路线吧'));
    }
    for (const t of tripsResp.trips) {
      const s = t.summary;
      listCard.append(h('div', { class: 'poi-result' },
        h('div', { class: 'n' },
          `${(t.startedAt || '').slice(5, 16).replace('T', ' ')} · ${t.venueName || s?.venueName || '游览'} `,
          t.status === 'completed' ? h('span', { class: 'tag' }, '完成') : t.status === 'ended_early' ? h('span', { class: 'tag warn' }, '提前结束') : h('span', { class: 'tag lock' }, '进行中')),
        s ? h('div', { class: 'a' }, `到访 ${s.confirmedVisits.length} 站 · 规划距离 ${fmtKm(s.distanceM || 0)}`) : null,
        h('div', { class: 'tl-actions' },
          t.status === 'active' || t.status === 'paused'
            ? h('button', { class: 'btn btn-primary btn-sm', onclick: () => { location.hash = '#/trip/' + t.id; } }, '继续游览')
            : h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { location.hash = '#/finish/' + t.id; } }, '查看回顾'),
          h('button', {
            class: 'btn btn-danger btn-sm',
            onclick: () => {
              openSheet('删除这条记录？', h('div', {},
                h('p', {}, '将同时清理关联的反馈与偏好证据；共享的公共讲解不受影响（§13.5）'),
                h('button', {
                  class: 'btn btn-danger btn-block',
                  onclick: async () => { await del('/v1/me/trips/' + t.id); closeSheet(); toast('已删除'); boot(); },
                }, '确认删除'),
                h('button', { class: 'btn btn-ghost btn-block', onclick: closeSheet }, '取消')));
            },
          }, '删除'))));
    }
    root.append(listCard);
  }

  boot().catch((e) => root.append(h('div', { class: 'card empty' }, e.message)));
  return () => {};
}

/* ================= 数据后台（§7.2 轻量运营视图） ================= */
export function renderAdmin(view) {
  const root = h('div', {});
  view.append(root);

  async function boot() {
    root.innerHTML = '';
    const fixtures = state.venues.filter((v) => v.fixture);
    root.append(h('div', { class: 'card' },
      h('p', { class: 'card-title' }, '场所数据来源'),
      h('div', { class: 'tl-meta' },
        '面向用户的场所（公园/景区/校园）与路线由高德实时检索提供，覆盖分母与未知项在路线卡上明示；'),
      h('div', { class: 'tl-meta', style: 'margin-top:4px' },
        '已核验场所包（含步道台阶、开放窗口、事实来源）属于需要实地采集的数据资产，可通过本页查看其结构与审核状态。')));
    for (const v of fixtures) {
      const pack = await get('/v1/venues/' + v.id);
      const card = h('div', { class: 'card' },
        h('h3', {}, `${v.name} `, h('span', { class: 'badge badge-alt' }, v.packVersion),
          v.fixture ? h('span', { class: 'badge badge-conditional' }, '测试夹具') : null),
        h('div', { class: 'tl-meta', style: 'margin-bottom:8px' }, `${v.nameNote} · ${v.coverageScope.scopeLabel} · 时区 ${v.timezone}`),
        h('details', {},
          h('summary', { style: 'cursor:pointer;color:var(--green)' }, `点位（${pack.pois.length}）`),
          h('table', { class: 'table' },
            h('tr', {}, h('th', {}, '名称'), h('th', {}, '标签'), h('th', {}, '开放窗口'), h('th', {}, '费用'), h('th', {}, '状态')),
            pack.pois.map((p) => h('tr', {},
              h('td', {}, p.name),
              h('td', {}, p.tags.join('、') + (p.indoor ? ' · 室内' : '')),
              h('td', { class: 'mono' }, (p.openWindows || []).map((w) => w.join('-')).join(' ')),
              h('td', {}, p.ticketKnown ? (p.ticketCny > 0 ? `¥${p.ticketCny}` : '免费') : '未知'),
              h('td', {}, p.closedToday ? h('span', { style: 'color:var(--danger)' }, p.closedReason || '关闭') : '开放'))))),
        h('details', {},
          h('summary', { style: 'cursor:pointer;color:var(--green)' }, `步道路段（${pack.edges.length}）`),
          h('table', { class: 'table' },
            h('tr', {}, h('th', {}, '路段'), h('th', {}, '长度'), h('th', {}, '台阶'), h('th', {}, '骑行'), h('th', {}, '状态')),
            pack.edges.map((e) => h('tr', {},
              h('td', { class: 'mono' }, `${e.from} ↔ ${e.to}`),
              h('td', {}, e.lengthM + 'm'),
              h('td', {}, e.stepsKnown ? (e.steps > 0 ? e.steps + ' 级' : '无') : h('span', { style: 'color:var(--warn)' }, '未知')),
              h('td', {}, e.bikeAllowed ? '允许' : '禁止'),
              h('td', {}, e.closed ? h('span', { style: 'color:var(--danger)' }, e.closedReason || '封闭') : '通行'))))),
        h('details', {},
          h('summary', { style: 'cursor:pointer;color:var(--green)' }, `事实来源与审核（${pack.evidence.length}）`),
          h('table', { class: 'table' },
            h('tr', {}, h('th', {}, '来源'), h('th', {}, '生效/失效'), h('th', {}, '审核')),
            pack.evidence.map((e) => h('tr', {},
              h('td', {}, e.sourceTitle, e.note ? h('div', { class: 'tl-meta' }, e.note) : null),
              h('td', { class: 'mono' }, `${e.effectiveFrom || '-'} → ${e.expiresAt || '长期'}`),
              h('td', {}, e.reviewStatus === 'reviewed' ? '✅ 已审核' : '⏳ 待审核'))))));
      root.append(card);
    }
    root.append(h('div', { class: 'tl-meta', style: 'text-align:center' },
      '轻量运营视图（文档 §7.2）：维护场所边界/入口、POI、步道路段、营业时间与事实来源。标记为「测试夹具」的数据仅供内部验证。'));
  }

  boot().catch((e) => root.append(h('div', { class: 'card empty' }, e.message)));
  return () => {};
}
