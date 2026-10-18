'use strict';
/**
 * 行程单存储（保存的多日城市行程）。
 * 诚实边界：仅保存用户生成的行程快照，不涉及任何交易/支付；
 * 删除即取消（cancelled），数据保留供"我的"页历史查看。
 */
const { id, nowIso, E } = require('./util');

class Market {
  constructor(ctx) {
    this.ctx = ctx; // {store, content}
  }

  createItineraryOrder(userId, body) {
    const { content, store } = this.ctx;
    const city = content.getCity(body.cityId);
    if (!city) throw E.notFound('城市不存在');
    const snapshot = body.itinerary;
    const dayList = Array.isArray(snapshot && snapshot.itinerary) ? snapshot.itinerary : (Array.isArray(snapshot && snapshot.days) ? snapshot.days : null);
    if (!dayList || !dayList.length) {
      throw E.badRequest('缺少行程数据（itinerary.itinerary 数组）', { field: 'itinerary' });
    }
    const order = {
      id: id('ord'), type: 'itinerary', ownerId: userId,
      cityId: city.id, cityName: city.name,
      days: Number(snapshot.days) || dayList.length, people: Number(body.people) || 2,
      budget: snapshot.budget || 'comfort',
      totalEstimateCny: snapshot.totals ? snapshot.totals.total : null,
      title: `${city.name} ${Number(snapshot.days) || dayList.length} 日行程`,
      status: 'planned',
      payment: null,
      // 保存当时的完整结果：重新打开行程单必须与保存时逐日一致（内容库或算法更新不得改变已保存结果）
      snapshot: {
        cityId: city.id, cityName: city.name,
        days: Number(snapshot.days) || dayList.length,
        people: Number(body.people) || Number(snapshot.people) || 2,
        pace: snapshot.pace || null,
        budget: snapshot.budget || null,
        interests: Array.isArray(snapshot.interests) ? snapshot.interests : [],
        dayList,
        totals: snapshot.totals || null,
        notices: Array.isArray(snapshot.notices) ? snapshot.notices : [],
        template: snapshot.template || null,
        algorithm: snapshot.algorithm || null,
        generatedAt: snapshot.generatedAt || null,
      },
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    store.insert('orders', order);
    return order;
  }

  getOrder(userId, orderId) {
    const order = this.ctx.store.findOne('orders', (o) => o.id === orderId && o.ownerId === userId);
    if (!order) throw E.notFound('行程单不存在');
    return order;
  }

  listOrders(userId, { type, status } = {}) {
    let list = this.ctx.store.find('orders', (o) => o.ownerId === userId);
    if (type) list = list.filter((o) => o.type === type);
    if (status) list = list.filter((o) => o.status === status);
    return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  cancel(userId, orderId, reason) {
    const { store } = this.ctx;
    const order = this.getOrder(userId, orderId);
    if (!['planned'].includes(order.status)) {
      throw E.conflict('ORDER_STATE_CONFLICT', `当前状态 ${order.status} 不可删除`);
    }
    store.update('orders', order.id, {
      status: 'cancelled',
      cancelledReason: String(reason || '用户删除').slice(0, 100),
      updatedAt: nowIso(),
    });
    return store.byId('orders', order.id);
  }
}

module.exports = { Market };
