'use strict';
/**
 * REST API（文档 §16.1 合约）+ 统一错误格式 + ownerId 校验 + 幂等。
 * SSE 事件流在 /v1/jobs/{id}/events（Accept: text/event-stream），也支持 ?afterSeq= 轮询补偿。
 */
const { id, token, nowIso, ApiError, E } = require('./util');
const { normalizeCoordinate, haversineM } = require('./geo');
const { normalizeIntent, confirmChips, ruleNLU } = require('./domain');
const { searchPlaces, reverseGeocode, buildGuideContent } = require('./providers');
const { createJob, routeSummary } = require('./jobs');
const { writeSseHead } = require('./sse');
const tk = require('./timekit');

class Api {
  constructor(ctx) {
    this.ctx = ctx; // {store, cfg, packs, sseHub, runner}
    this.routes = [];
    this.legStepCache = new Map();
    this.legStepRates = new Map();
    const R = (method, pattern, handler, opts = {}) => {
      const keys = [];
      const rx = new RegExp('^' + pattern.replace(/\{(\w+)\}/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
      this.routes.push({ method, rx, keys, handler, auth: opts.auth !== false, raw: !!opts.raw });
    };

    R('GET', '/v1/config', this.getConfig.bind(this), { auth: false });
    R('POST', '/v1/sessions/guest', this.guestSession.bind(this), { auth: false });
    R('GET', '/v1/venues', this.listVenues.bind(this));
    R('GET', '/v1/venues/{id}', this.getVenue.bind(this));
    R('GET', '/v1/places/search', this.searchPlaces.bind(this));
    R('GET', '/v1/legs/steps', this.legSteps.bind(this));
    R('GET', '/v1/places/nearby-venues', this.nearbyVenues.bind(this));
    R('POST', '/v1/ai/ask', this.aiAsk.bind(this));
    R('POST', '/v1/locations/normalize', this.normalizeLocation.bind(this));
    R('POST', '/v1/locations/reverse', this.reverseLocation.bind(this));
    R('POST', '/v1/intents/normalize', this.normalizeIntentApi.bind(this));
    R('POST', '/v1/ai/command', this.aiCommand.bind(this));
    R('POST', '/v1/plans', this.createPlan.bind(this));
    R('GET', '/v1/plans/{id}', this.getPlan.bind(this));
    R('POST', '/v1/plans/{id}/edits', this.editPlan.bind(this));
    R('GET', '/v1/jobs/{id}', this.getJob.bind(this));
    R('GET', '/v1/jobs/{id}/events', this.jobEvents.bind(this));
    R('POST', '/v1/jobs/{id}/cancel', this.cancelJob.bind(this));
    R('GET', '/v1/guides/{poiId}', this.getGuide.bind(this));
    R('POST', '/v1/guides/{id}/audio', this.guideAudio.bind(this));
    R('POST', '/v1/speech/transcriptions', this.transcribe.bind(this));
    R('POST', '/v1/trips', this.startTrip.bind(this));
    R('GET', '/v1/trips/{id}', this.getTrip.bind(this));
    R('POST', '/v1/trips/{id}/events', this.tripEvent.bind(this));
    R('POST', '/v1/trips/{id}/replans', this.replanTrip.bind(this));
    R('POST', '/v1/trips/{id}/replans/{proposalId}/accept', this.acceptReplan.bind(this));
    R('POST', '/v1/trips/{id}/finish', this.finishTrip.bind(this));
    R('POST', '/v1/feedback', this.feedback.bind(this));
    R('GET', '/v1/me/trips', this.myTrips.bind(this));
    R('GET', '/v1/me/summaries', this.mySummaries.bind(this));
    R('GET', '/v1/me/preferences', this.getPreferences.bind(this));
    R('PUT', '/v1/me/preferences', this.putPreferences.bind(this));
    R('DELETE', '/v1/me/trips/{id}', this.deleteTrip.bind(this));

    /* ---------- 导游平台：内容中心 / 城市行程 / 导游市场 / 订单 ---------- */
    R('GET', '/v1/hub/meta', this.hubMeta.bind(this));
    R('GET', '/v1/hub/highlights', this.hubHighlights.bind(this));
    R('GET', '/v1/hub/search', this.hubSearch.bind(this));
    R('GET', '/v1/hub/cities', this.hubCities.bind(this));
    R('GET', '/v1/hub/cities/{id}', this.hubCity.bind(this));
    R('GET', '/v1/hub/venues', this.hubVenues.bind(this));
    R('GET', '/v1/hub/venues/{id}', this.hubVenue.bind(this));
    R('GET', '/v1/hub/narrations/{id}', this.hubNarration.bind(this));
    R('GET', '/v1/hub/articles', this.hubArticles.bind(this));
    R('GET', '/v1/hub/articles/{id}', this.hubArticle.bind(this));
    R('GET', '/v1/hub/templates', this.hubTemplates.bind(this));
    R('GET', '/v1/hub/templates/{id}', this.hubTemplate.bind(this));
    R('POST', '/v1/hub/templates/{id}/use', this.hubTemplateUse.bind(this));
    R('POST', '/v1/itineraries/preview', this.itineraryPreview.bind(this));
    R('POST', '/v1/orders', this.createOrder.bind(this));
    R('GET', '/v1/orders', this.listOrders.bind(this));
    R('GET', '/v1/orders/{id}', this.getOrder.bind(this));
    R('POST', '/v1/orders/{id}/cancel', this.cancelOrder.bind(this));

    /* ---------- 管理后台（自带令牌鉴权） ---------- */
    const { registerAdminRoutes } = require('./admin');
    registerAdminRoutes(R, this, this.ctx);
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.rx);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => {
          try { params[k] = decodeURIComponent(m[i + 1]); }
          catch (e) { params[k] = m[i + 1]; } // 畸形编码按原文处理，不因 URI 解码失败整体 500
        });
        return { route: r, params };
      }
    }
    return null;
  }

  /* ---------- 基础 ---------- */
  async legSteps(req, _p, query) {
    const parsePoint = (value) => {
      const parts = String(value || '').split(',');
      if (parts.length !== 2 || parts.some((p) => !p.trim())) throw E.badRequest('请提供from/to的经纬度');
      const [lng, lat] = parts.map(Number);
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) throw E.badRequest('经纬度无效');
      return { lng, lat };
    };
    const from = parsePoint(query.from), to = parsePoint(query.to);
    const now = Date.now();
    const owner = req.user.id;
    for (const [key, rate] of this.legStepRates) if (now - rate.since >= 60000) this.legStepRates.delete(key);
    const rate = this.legStepRates.get(owner) || { since: now, count: 0 };
    if (rate.count >= 60) throw new ApiError('RATE_LIMITED', '导航步骤请求过于频繁，请稍后再试', { status: 429, retryable: true });
    rate.count++; this.legStepRates.set(owner, rate);
    const cell = (p) => {
      const row = Math.round(p.lat * 110940 / 50);
      const lat = row * 50 / 110940;
      return `${Math.round(p.lng * 111320 * Math.cos(lat * Math.PI / 180) / 50)},${row}`;
    };
    const key = `${cell(from)}>${cell(to)}`;
    for (const [k, entry] of this.legStepCache) if (entry.expiresAt <= now) this.legStepCache.delete(k);
    const cached = this.legStepCache.get(key);
    if (cached) return { ...await cached.promise, cached: true };
    if (this.ctx.cfg.providers.map !== 'amap') return { steps: [], available: false, cached: false };
    const entry = { expiresAt: now + 30 * 60000 };
    entry.promise = (async () => {
      try {
        // walkingRoute 自带高德全局限速门；本接口再按用户限制请求次数。
        const route = await require('./amap').walkingRoute(this.ctx.cfg, from, to);
        return { steps: route.steps || [], geometry: route.geometry, distanceM: route.distanceM, provider: route.provider, available: !!route.steps?.length };
      } catch (_) {
        if (this.legStepCache.get(key) === entry) this.legStepCache.delete(key);
        return { steps: [], available: false };
      }
    })();
    if (this.legStepCache.size >= 512) this.legStepCache.delete(this.legStepCache.keys().next().value);
    this.legStepCache.set(key, entry);
    return { ...await entry.promise, cached: false };
  }

  async getConfig() {
    const { cfg } = this.ctx;
    return {
      demoMode: cfg.demoMode,          // 兼容字段：true 表示未配置地图服务
      setupRequired: !!cfg.setupRequired,
      setupHint: cfg.setupHint || null,
      providers: cfg.providers,
      amapJsKey: cfg.amap.jsKey || null, // JS Key 与安全密钥本就设计为浏览器端可见（§5.5）；服务端 Key 绝不下发
      amapJsSecurityCode: cfg.amap.jsSecurityCode || null,
      limits: cfg.limits,
    };
  }

  async guestSession(req) {
    const { store } = this.ctx;
    const user = { id: id('usr'), kind: 'guest', timezone: 'Asia/Shanghai', createdAt: nowIso() };
    store.insert('users', user);
    const sess = { id: id('ses'), userId: user.id, token: token(), createdAt: nowIso(), revokedAt: null };
    store.insert('sessions', sess);
    store.insert('consents', { id: id('cst'), userId: user.id, scope: 'trip_history_local', version: 1, grantedAt: nowIso(), revokedAt: null });
    return { userId: user.id, sessionToken: sess.token, kind: 'guest' };
  }

  async listVenues(req) {
    // 说明：/v1/venues 只返回"自有/已核验场所包"（当前为测试夹具），
    // 产品中的"逛这里"场所来自 /v1/places/search 的高德真实搜索结果（id 形如 live:<poiId>）。
    return {
      venues: this.ctx.packs.map((p) => ({
        id: p.venue.id, name: p.venue.name, nameNote: p.venue.nameNote, city: p.venue.city,
        timezone: p.venue.timezone, packVersion: p.venue.packVersion, fixture: true,
        coverageScope: p.venue.coverageScope, poiCount: p.pois.length,
        entrances: p.venue.entrances.map((e) => {
          const n = p._nodeById.get(e);
          return { id: e, name: n.name, coord: { lng: n.lng, lat: n.lat, crs: 'GCJ02' }, status: n.status };
        }),
      })),
      note: '以上为内部测试夹具数据；面向用户的场所由高德实时检索提供',
    };
  }

  async getVenue(req, p, query) {
    // 真实场所：live:<amapPoiId>，需要 name/coord 参数（来自搜索结果），结果按 10 分钟缓存
    if (String(p.id).startsWith('live:')) {
      if (this.ctx.cfg.providers.map !== 'amap') throw new ApiError('PROVIDER_NOT_CONFIGURED', '未配置高德 Key', { status: 503 });
      const venueRef = {
        id: p.id, name: query.name || '所选场所',
        coord: { lng: Number(query.lng), lat: Number(query.lat) },
        city: query.city || '', district: query.district || '',
      };
      if (!Number.isFinite(venueRef.coord.lng) || !Number.isFinite(venueRef.coord.lat)) {
        throw E.badRequest('真实场所需要提供 lng/lat 参数', { field: 'lng' });
      }
      const { resolveVenue } = require('./live_venue');
      const r = await resolveVenue(this.ctx.cfg, venueRef);
      return {
        venue: {
          id: venueRef.id, name: venueRef.name, city: venueRef.city,
          timezone: 'Asia/Shanghai', packVersion: 'amap-live', live: true,
          coverageScope: { kind: 'poi', scopeLabel: `高德在园内检索到的 ${r.pois.length} 个点位（非园区完整清单）` },
          center: { lng: r.center.lng, lat: r.center.lat, crs: 'GCJ02' },
          entrances: r.entrances.map((e) => e.id),
          nameNote: `真实场所（高德数据）· ${venueRef.district || venueRef.city || ''}`,
        },
        nodes: [
          ...r.entrances.map((e) => ({ id: e.id, name: e.shortName, type: 'entrance', lng: e.lng, lat: e.lat, status: 'open' })),
          ...r.pois.filter((x) => !x.isEntrance).map((x) => ({ id: x.id, name: x.shortName, type: 'poi', lng: x.lng, lat: x.lat, status: 'open' })),
        ],
        edges: [], // 真实场所的路段按需向高德实时请求，不做静态存储（许可要求）
        pois: r.pois.map((x) => ({
          id: x.id, name: x.shortName, tags: x.tags, indoor: x.tags.includes('美食'),
          dwellSec: x.dwellSec, openWindows: null, closedToday: false, closedReason: null,
          ticketCny: null, ticketKnown: false, hoursEvidenceIds: ['ev_amap_live'],
          address: x.address, isEntrance: x.isEntrance, guideReady: false,
        })),
        evidence: [{
          id: 'ev_amap_live', sourceTitle: '高德地图 Web 服务实时查询', sourceUrl: 'https://restapi.amap.com',
          retrievedAt: new Date().toISOString(), effectiveFrom: null, expiresAt: null,
          license: '高德平台数据（按许可展示，不持久化）', reviewStatus: 'provider',
        }],
        live: true,
      };
    }
    const pack = this.ctx.packs.find((x) => x.venue.id === p.id);
    if (!pack) throw E.notFound('场所不存在');
    // 轻量运营视图（§7.2）：边界/入口/POI/路段/营业时间/事实来源/审核状态
    return {
      venue: pack.venue,
      nodes: pack.nodes,
      edges: pack.edges,
      pois: pack.pois.map((poi) => ({
        id: poi.id, name: poi.name, tags: poi.tags, indoor: poi.indoor,
        dwellSec: poi.dwellSec, openWindows: poi.openWindows, closedToday: !!poi.closedToday,
        closedReason: poi.closedReason || null, ticketCny: poi.ticketCny, ticketKnown: poi.ticketKnown,
        hoursEvidenceIds: poi.hoursEvidenceIds,
        guideReady: !!poi.guide,
      })),
      evidence: pack.evidence,
      fixture: true,
    };
  }

  /** 附近可逛的场所：支持"先选地方"的发现入口（导游软件的第一步是帮用户挑地方） */
  async nearbyVenues(req, _p, query) {
    if (this.ctx.cfg.providers.map !== 'amap') throw new ApiError('PROVIDER_NOT_CONFIGURED', '未配置高德 Key', { status: 503 });
    const lng = Number(query.lng), lat = Number(query.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw E.badRequest('需要 lng/lat 参数', { field: 'lng' });
    const { searchVenuesAround } = require('./live_venue');
    try {
      const list = await searchVenuesAround(this.ctx.cfg, { lng, lat }, Number(query.radius) || 3000);
      return { results: list.slice(0, 12), provider: 'amap' };
    } catch (e) {
      throw new ApiError('PROVIDER_ERROR', '附近场所检索失败：' + e.message, { status: 502, retryable: true });
    }
  }

  /**
   * 现场问答（导游模式）：只用该点位"已核验讲解内容"回答，资料没有就明说。
   * 这是导游软件与"语音助手"的分界线——不编造是硬约束。
   */
  async aiAsk(req, _p, _q, body) {
    const { store, cfg } = this.ctx;
    const question = (body.question || '').trim();
    if (!question) throw E.badRequest('请输入想问的问题');
    const poiId = body.poiId;
    if (!poiId) throw E.badRequest('缺少点位', { field: 'poiId' });

    // 定位讲解内容：优先当前行程的讲解，其次同一用户的任意该点位讲解
    let guide = null;
    if (body.tripId) {
      const trip = store.findOne('trips', (t) => t.id === body.tripId && t.ownerId === req.user.id);
      if (trip) guide = store.findOne('guide_contents', (g) => g.planId === trip.planId && g.poiId === poiId);
    }
    if (!guide && body.planId) guide = store.findOne('guide_contents', (g) => g.planId === body.planId && g.poiId === poiId);
    if (!guide) guide = store.findOne('guide_contents', (g) => g.poiId === poiId);

    if (!guide) {
      return {
        hasMaterial: false,
        answer: '这个点位还没有已核验的讲解资料，我不能凭空介绍。可以先看现场标识牌，或换一个有讲解的点位问我。',
        sources: [],
      };
    }
    if (cfg.providers.llm !== 'http') {
      return {
        hasMaterial: true, insufficient: false, llmUnavailable: true,
        answer: '（未配置 AI 服务）先把讲解内容读给你：' + (guide.summary || ''),
        sources: guide.sources || [],
      };
    }
    const { answerWithMaterial } = require('./llm');
    const poiName = (guide.poiName || body.poiName || '这个点位');
    const r = await answerWithMaterial(cfg, { ...guide, poiName }, question);
    return {
      hasMaterial: true,
      insufficient: !!r.insufficient,
      answer: r.answer,
      usedClaims: (r.used || []).map((i) => (guide.claims || [])[i - 1]).filter(Boolean),
      sources: guide.sources || [],
      unverified: !!guide.unverified,
      notice: guide.unverified
        ? '本点位讲解为 AI 生成、未经资料核验，回答仅供参考'
        : '回答仅依据该点位的已核验讲解资料',
    };
  }

  async searchPlaces(req, _p, query) {
    const q = (query.q || '').trim();
    // 真实模式：场所搜索（公园/景区/校园）+ 点位搜索，全部来自高德
    if (this.ctx.cfg.providers.map === 'amap' && q) {
      const { textSearch } = require('./amap');
      const { searchVenues } = require('./live_venue');
      const wantVenue = query.kind === 'venue';
      try {
        const venues = await searchVenues(this.ctx.cfg, q, query.city || '');
        const pois = wantVenue ? [] : await textSearch(this.ctx.cfg, q, query.city || '');
        const local = wantVenue ? { results: [] } : searchPlaces(this.ctx.packs, q, query.venueId || null);
        for (const r of local.results) r.fixture = true;
        return {
          results: [...venues, ...local.results, ...pois].slice(0, 20),
          provider: 'amap',
        };
      } catch (e) { /* 高德失败时降级为自有场所包 */ }
    }
    return searchPlaces(this.ctx.packs, q, query.venueId || null);
  }

  async normalizeLocation(req, _p, _q, body) {
    try {
      // 真实模式：WGS84→GCJ02 用高德官方转换服务（仅适配器入口一次转换，§5.4）；失败回退本地近似算法
      if (this.ctx.cfg.providers.map === 'amap' && body.crs === 'WGS84') {
        try {
          const { convertCoord } = require('./amap');
          const g = await convertCoord(this.ctx.cfg, body.lng, body.lat);
          return {
            ok: true,
            point: { lng: g.lng, lat: g.lat, crs: 'GCJ02', converted: true, approximate: false, source: body.source || 'unknown', provider: 'amap' },
            needsReview: typeof body.accuracyM === 'number' && body.accuracyM > 80,
            note: '已在适配器入口通过高德坐标转换服务完成一次 WGS84→GCJ02 转换',
          };
        } catch (e) { /* 回退本地算法 */ }
      }
      const point = normalizeCoordinate({ lng: body.lng, lat: body.lat, crs: body.crs, source: body.source });
      return {
        ok: true, point,
        needsReview: typeof body.accuracyM === 'number' && body.accuracyM > 80, // §5.2 初值 80m
        note: point.converted ? '已在适配器入口完成一次 WGS84→GCJ02 转换（本地近似算法）' : '坐标未转换',
      };
    } catch (e) {
      throw new ApiError(e.code || 'CRS_UNSUPPORTED', e.message, { retryable: false });
    }
  }

  async reverseLocation(req, _p, _q, body) {
    // 真实模式：高德逆地理；失败不应使已获得的坐标失效（§5.1-6），回退场所包就近标注
    if (this.ctx.cfg.providers.map === 'amap') {
      try {
        const { regeo } = require('./amap');
        return await regeo(this.ctx.cfg, { lng: body.lng, lat: body.lat });
      } catch (e) { /* 回退 */ }
    }
    return reverseGeocode(this.ctx.packs, { lng: body.lng, lat: body.lat });
  }

  /* ---------- 需求与计划 ---------- */
  async normalizeIntentApi(req, _p, _q, body) {
    const { store, cfg } = this.ctx;
    const profile = store.findOne('preferences', (x) => x.userId === req.user.id && x.enabled);
    const form = Object.assign({}, body.form || {});
    const text = (body.text || '').trim();

    // 第一层：LLM 理解自然语言（失败/无效回退规则引擎，绝不阻塞表单规划 §17.1）
    let preParsed = null;
    if (text && cfg.providers.llm === 'http') {
      try {
        const { llmNLU } = require('./llm');
        preParsed = await llmNLU(cfg, text);
      } catch (e) { preParsed = null; }
    }

    const rules = ruleNLU(text);
    // 明确的 A→B 句式纠正模型把起点识别成场所的情况；表单场景仍优先。
    if (preParsed && rules.scene === 'wander' && rules.endPlaceName) {
      preParsed = { ...preParsed, scene: 'wander', venueName: null, endPlaceName: rules.endPlaceName };
    }
    const parsed = preParsed || rules;
    if (!['venue', 'wander'].includes(form.scene)) form.scene = parsed.scene || 'wander';

    let unresolvedEndpoint = null;
    const endPlaceName = parsed.endPlaceName || rules.endPlaceName;
    const endpointExplicit = form.endpointTouched || (form.endpointMode === 'fixed' && form.endpointPoint);
    if (endPlaceName && !endpointExplicit && form.origin) {
      let pick = null;
      try {
        let city = form.origin.city || form.city || parsed.venueCity || (form.venueRef && form.venueRef.city) || '';
        if (cfg.providers.map === 'amap') {
          const { textSearch, amapGet } = require('./amap');
          if (!city) {
            const geo = await amapGet(cfg, '/v3/geocode/regeo', { location: `${form.origin.lng},${form.origin.lat}`, extensions: 'base' });
            const address = geo.regeocode && geo.regeocode.addressComponent || {};
            city = typeof address.city === 'string' && address.city || address.province || '';
          }
          const results = await textSearch(cfg, endPlaceName, city);
          pick = results.filter((p) => p.coord && Number.isFinite(p.coord.lng) && Number.isFinite(p.coord.lat))
            .map((p) => ({ place: p, distance: haversineM(form.origin, p.coord) }))
            .filter((p) => p.distance <= 15000).sort((a, b) => a.distance - b.distance)[0]?.place;
        } else {
          // 演示模式只用已有场所数据，不捏造地名/POI ID。
          pick = searchPlaces(this.ctx.packs, endPlaceName, form.venueId).results
            .filter((p) => p.coord && haversineM(form.origin, p.coord) <= 15000)
            .sort((a, b) => haversineM(form.origin, a.coord) - haversineM(form.origin, b.coord))[0];
        }
      } catch (_) { /* 失败明确追问，不能退成顺路结束 */ }
      if (pick) {
        form.endpointMode = 'fixed'; form.endpointPoint = pick.coord; form.endpointLabel = pick.name;
        form.endpointEntranceId = pick.kind === 'entrance' ? pick.id : null;
      } else {
        unresolvedEndpoint = { field: 'endpoint', question: `起点15公里内没有找到「${endPlaceName}」，请搜索并确认终点位置。`, reason: '目的地未能解析到可确认的近邻地点' };
      }
    }

    // 场所自动识别：一句"想去人民公园"即可直接成路线（§4.2 场所搜索的 AI 路径）
    const autoResolved = { ambiguous: null, resolved: null };
    if (form.scene === 'venue' && !form.venueId && preParsed && preParsed.venueName && cfg.providers.map === 'amap') {
      try {
        const { searchVenues } = require('./live_venue');
        let found = await searchVenues(cfg, preParsed.venueName, form.city || preParsed.venueCity || '');
        if (found.length) {
          const sameName = found.filter((x) => x.name === found[0].name);
          let pick = sameName[0];
          // 同名消歧：优先按城市过滤 → 再按用户起点就近 → 仍无法区分才追问（§4.4 同名场所）
          if (sameName.length > 1) {
            const city = (form.city || preParsed.venueCity || '').replace(/市$/, '');
            const byCity = city ? sameName.filter((x) => (x.city || '').includes(city)) : [];
            if (byCity.length === 1) {
              pick = byCity[0];
            } else if (form.origin && Number.isFinite(form.origin.lng)) {
              const o = { lng: form.origin.lng, lat: form.origin.lat };
              const near = sameName.map((x) => ({
                x, d: Math.hypot((x.coord.lng - o.lng) * 95803, (x.coord.lat - o.lat) * 110940),
              })).sort((a, b) => a.d - b.d);
              // 最近的明显更近（相差 5km 以上）→ 直接采用；否则说明确实分不清
              if (near.length === 1 || near[1].d - near[0].d > 5000) pick = near[0].x;
            }
          }
          form.venueId = pick.id;
          form.venueRef = { id: pick.id, name: pick.name, lng: pick.coord.lng, lat: pick.coord.lat, city: pick.city, district: pick.district };
          autoResolved.resolved = pick;
          // 仍有多个同名且无法用城市/距离区分 → 交给用户确认
          const unresolvedSameName = sameName.filter((x) =>
            x.id !== pick.id && (!form.origin || Math.abs(
              Math.hypot((x.coord.lng - form.origin.lng) * 95803, (x.coord.lat - form.origin.lat) * 110940)
              - Math.hypot((pick.coord.lng - form.origin.lng) * 95803, (pick.coord.lat - form.origin.lat) * 110940)) < 5000));
          if (unresolvedSameName.length) {
            autoResolved.ambiguous = [pick, ...unresolvedSameName].map((x) => ({
              id: x.id, label: `${x.name}（${x.city || ''}${x.district || ''}）`,
            }));
          }
        }
      } catch (e) { /* 检索失败则退回让用户手动选 */ }
    }

    // 真实场所：取轻量包做实体消歧（"必去/避开"里的地名 → 点位 ID）
    let venuePack = null;
    if (String(form.venueId || '').startsWith('live:') && form.venueRef && cfg.providers.map === 'amap') {
      try {
        const { lightPackForResolve } = require('./live_venue');
        venuePack = await lightPackForResolve(cfg, form.venueRef);
      } catch (e) { /* 消歧失败不阻塞 */ }
    }

    const intent = normalizeIntent({
      form, text, timezone: body.timezone || 'Asia/Shanghai',
      profile: profile ? { interests: profile.interests, pace: profile.pace } : null,
      venuePack,
    }, this.ctx.packs, preParsed);
    if (unresolvedEndpoint) intent.unresolved.push(unresolvedEndpoint);
    else if (endPlaceName && !endpointExplicit && intent.endpoint.mode === 'fixed') intent.fieldEvidence.endpoint = { source: 'text', rawSpan: endPlaceName };

    if (autoResolved.resolved) intent.autoResolvedVenue = autoResolved.resolved.name;
    if (autoResolved.ambiguous) {
      intent.unresolved.push({
        field: 'venueId',
        question: `找到多个同名场所（${autoResolved.ambiguous.map((x) => x.label).join('、')}），当前按第一个规划，需要换成另一个吗？`,
        reason: '同名场所分属不同城市/片区',
        options: autoResolved.ambiguous.map((x) => x.id),
        optionLabels: autoResolved.ambiguous.map((x) => x.label),
      });
    }

    // 起点距场所较远时：自动把规划起点改到场所入口，并把"接近段"明确告知（§4.3 不暗中忽略往返交通）
    const notices = [];
    if (intent.scene === 'venue' && intent.venueRef && intent.origin && intent.origin.point) {
      const vc = { lng: intent.venueRef.lng, lat: intent.venueRef.lat };
      const approachM = Math.round(Math.hypot(
        (intent.origin.point.lng - vc.lng) * 95803,
        (intent.origin.point.lat - vc.lat) * 110940));
      // 已精确到门/点位（entranceId/poiId）的起点是用户显式选定的，即使离中心 >1km（大型景区）也不改锚
      if (approachM > 1000 && !intent.origin.entranceId && !intent.origin.poiId) {
        const fromLabel = intent.origin.label || '原起点';
        intent.originApproach = { fromLabel, distanceM: approachM, fromPoint: intent.origin.point };
        intent.origin = {
          point: { lng: vc.lng, lat: vc.lat, crs: 'GCJ02' },
          poiId: null, entranceId: null,
          label: `${intent.venueRef.name}（入口）`,
        };
        notices.push({
          code: 'ORIGIN_REANCHORED',
          message: `起点距「${intent.venueRef.name}」约 ${(approachM / 1000).toFixed(1)}km，已把游览起点改到场所入口；这段接近路程不计入游览时长`,
        });
      }
    }
    intent.notices = notices;

    // 同一用户同场景同场所 → revision 递增（§6.2）
    const prev = store.find('intents', (x) => x.ownerId === req.user.id && x.scene === intent.scene && x.venueId === intent.venueId);
    // 闲逛场景：起点不在测试片区附近 → 走高德真实周边管线
    if (intent.scene === 'wander' && cfg.providers.map === 'amap') {
      const block = this.ctx.packs.find((p) => p.venue.id === 'block_binhe');
      const dc = block ? Math.hypot(
        (intent.origin.point.lng - block.venue.center.lng) * 95803,
        (intent.origin.point.lat - block.venue.center.lat) * 110940) : Infinity;
      if (dc > 1200) intent.venueId = 'area_amap';
    }
    intent.revision = prev.length ? Math.max(...prev.map((x) => x.revision)) + 1 : 1;
    intent.ownerId = req.user.id;
    intent.id = intent.intentId; // store 主键
    store.insert('intents', intent);
    return { intentId: intent.intentId, revision: intent.revision, intent, chips: confirmChips(intent), unresolved: intent.unresolved, notices };
  }

  /** AI 指令：游览页"说一句话调整行程"（自然语言 → 结构化调整动作） */
  async aiCommand(req, _p, _q, body) {
    const { store, cfg } = this.ctx;
    const text = (body.text || '').trim();
    if (!text) throw E.badRequest('请输入一句话');
    const trip = body.tripId ? store.findOne('trips', (t) => t.id === body.tripId && t.ownerId === req.user.id) : null;
    let context = {};
    let route = null;
    let nextStop = null;
    if (trip) {
      route = store.byId('route_versions', trip.activeRouteVersionId);
      const visited = store.find('trip_events', (e) => e.tripId === trip.id && e.type === 'arrive_confirm').map((e) => e.data.poiId);
      const skipped = store.find('trip_events', (e) => e.tripId === trip.id && e.type === 'stop_skipped').map((e) => e.data.poiId);
      const remaining = route ? route.stops.filter((s) => !visited.includes(s.poiId) && !skipped.includes(s.poiId)) : [];
      const next = remaining[0];
      nextStop = next || null;
      context = {
        venue: trip.venueName || null,
        nextStop: next ? next.name : null,
        remaining: remaining.map((s) => s.name),
        locked: remaining.filter((s) => s.locked).map((s) => s.name),
        endLabel: route ? route.endLabel : null,
        plannedEnd: route && route.endArrivalAt ? route.endArrivalAt.slice(11, 16) : null,
      };
    }
    const { parseCommand } = require('./llm');
    const parsed = await parseCommand(cfg, text, context);

    // 模型只给名字；最终动作必须有真实行程与点位支持。
    const resolved = { poiId: null, poiName: parsed.data.poiName || null };
    const matchName = (name, candidate) => name && candidate && (candidate.includes(name) || name.includes(candidate));
    if (parsed.action === 'replan' && (!trip || !route || !['active', 'paused'].includes(trip.status))) {
      parsed.action = 'none'; parsed.reply = '请先开始一条游览路线，再提出调整需求';
    }
    if (parsed.action === 'replan') {
      let hit = null;
      if (parsed.cause === 'stop_add_requested') {
        // 与规划使用同一候选包，避免只支持 live 场所、却漏掉城市闲逛与演示包。
        try {
          const plan = store.byId('plans', trip.planId);
          const intent = store.byId('intents', plan.intentId);
          const { pack } = await this.ctx.runner.resolvePackGraph(intent);
          const inRoute = new Set(route.stops.map((s) => s.poiId));
          const excluded = new Set(intent.hard && intent.hard.avoidPoiIds || []);
          const candidates = pack.pois.filter((p) => !inRoute.has(p.id) && !excluded.has(p.id) && p.status !== 'closed');
          const name = parsed.data.poiName || '';
          let matches = candidates.filter((p) => matchName(name, p.name) || matchName(name, p.shortName));
          if (!matches.length) {
            if (/咖啡|cafe|coffee/i.test(name)) matches = candidates.filter((p) => /咖啡|cafe|coffee/i.test(p.name) || (p.tags || []).includes('美食'));
            else if (/吃|美食|餐|饭/.test(name)) matches = candidates.filter((p) => (p.tags || []).includes('美食'));
            else if (/坐|休息|歇/.test(name)) matches = candidates.filter((p) => /茶|咖啡|休息|驿站|长椅|cafe|coffee/i.test(p.name) || p.restArea === true);
          }
          const target = nextStop && nextStop.coord ? { lng: nextStop.coord[0], lat: nextStop.coord[1] } : intent.origin.point;
          const pointOf = (p) => p.coord && !Array.isArray(p.coord) ? p.coord : (pack.nodes || []).find((n) => n.id === p.entranceNode);
          hit = matches.map((p) => ({ poi: p, point: pointOf(p) })).filter((p) => p.point && Number.isFinite(p.point.lng) && Number.isFinite(p.point.lat))
            .sort((a, b) => haversineM(target, a.point) - haversineM(target, b.point))[0]?.poi;
          if (hit) { resolved.poiId = hit.id; resolved.poiName = hit.name; }
        } catch (_) { /* 无候选就如实说明，不作执行承诺 */ }
      } else if (['stop_skipped', 'closure_reported', 'queue_reported'].includes(parsed.cause)) {
        const name = parsed.data.poiName;
        hit = !name || /^(?:下一站|下个点|下一个地方)$/.test(name) ? nextStop
          : route.stops.find((s) => matchName(name, s.name));
        if (hit) { resolved.poiId = hit.poiId; resolved.poiName = hit.name; }
      }
      if (['stop_skipped', 'closure_reported', 'stop_add_requested'].includes(parsed.cause) && !resolved.poiId) {
        parsed.action = 'none'; parsed.reply = `当前候选中没有找到「${resolved.poiName || '目标点位'}」，请用按钮选择地点`;
      } else {
        const replies = {
          stop_add_requested: `找到「${resolved.poiName}」，可生成加站提议，确认后生效`,
          stop_skipped: `可生成跳过「${resolved.poiName}」的提议，确认后生效`,
          fatigue_reported: '可生成轻松节奏的调整提议，确认后生效',
          rain_reported: '可生成优先室内的调整提议，确认后生效',
        };
        parsed.reply = replies[parsed.cause] || '可生成调整提议，确认后生效';
      }
    }
    if (parsed.action !== 'replan' && /帮你|已为你|加进|添加|安排/.test(parsed.reply || '')) parsed.reply = '当前没有可执行的调整，请说明具体需求或用按钮选择';
    return {
      action: parsed.action, cause: parsed.action === 'replan' ? parsed.cause : null,
      data: {
        poiId: parsed.action === 'replan' ? resolved.poiId : null,
        extraWaitMin: parsed.data.extraWaitMin,
        newLatestEndClock: parsed.data.newLatestEndClock,
      },
      reply: parsed.reply,
      context,
    };
  }

  async createPlan(req, _p, _q, body) {
    const { store } = this.ctx;
    // 幂等（§16.1：POST /v1/plans 携带幂等键）
    if (body.idempotencyKey) {
      const dup = store.findOne('idempotency_keys', (k) => k.key === body.idempotencyKey && k.userId === req.user.id);
      if (dup) return { status: 202, planId: dup.result.planId, jobId: dup.result.jobId, idempotentReplay: true };
    }
    const intent = store.findOne('intents', (x) => x.intentId === body.intentId && x.ownerId === req.user.id);
    if (!intent) throw E.notFound('需求不存在或不属于当前会话');
    if (body.revision !== intent.revision) {
      throw E.conflict('INTENT_REVISION_CONFLICT', '需求已更新，请基于最新版本提交', { latestRevision: intent.revision });
    }
    const plan = {
      id: id('pln'), ownerId: req.user.id, intentId: intent.intentId, intentRevision: intent.revision,
      venueId: intent.venueId, venueRef: intent.venueRef || null, scene: intent.scene,
      status: 'queued', routeIds: [], altRouteIds: [], mainRouteId: null, conflict: null, createdAt: nowIso(),
    };
    store.insert('plans', plan);
    const job = createJob(store, { type: 'plan.generate', ownerId: req.user.id, planId: plan.id, requestRevision: intent.revision });
    store.update('plans', plan.id, { currentJobId: job.id });
    if (body.idempotencyKey) {
      store.insert('idempotency_keys', { id: id('idem'), key: body.idempotencyKey, userId: req.user.id, result: { planId: plan.id, jobId: job.id }, createdAt: nowIso() });
    }
    return { status: 202, planId: plan.id, jobId: job.id };
  }

  async getPlan(req, p) {
    const { store } = this.ctx;
    const plan = store.findOne('plans', (x) => x.id === p.id && x.ownerId === req.user.id);
    if (!plan) throw E.notFound('计划不存在');
    const versions = store.find('route_versions', (r) => r.planId === plan.id)
      .sort((a, b) => a.version - b.version)
      .map((r) => ({ ...r, summary: routeSummary(r) }));
    const guides = store.find('guide_contents', (g) => g.planId === plan.id)
      .map((g) => ({ poiId: g.poiId, routeId: g.routeId, contentVersion: g.contentVersion, audioStatus: g.audioStatus }));
    return { plan, versions, guides, demo: this.ctx.cfg.demoMode };
  }

  async editPlan(req, p, _q, body) {
    const { store } = this.ctx;
    const plan = store.findOne('plans', (x) => x.id === p.id && x.ownerId === req.user.id);
    if (!plan) throw E.notFound('计划不存在');
    const base = store.byId('route_versions', body.baseRouteId);
    if (!base || base.planId !== plan.id) throw E.badRequest('基准路线版本无效', { field: 'baseRouteId' });
    const job = createJob(store, {
      type: 'plan.edit', ownerId: req.user.id, planId: plan.id,
      payload: { baseRouteId: base.routeId, edits: body.edits || {} },
      requestRevision: plan.intentRevision,
    });
    return { status: 202, jobId: job.id };
  }

  /* ---------- 任务与事件 ---------- */
  async getJob(req, p) {
    const { store } = this.ctx;
    const job = store.findOne('jobs', (j) => j.id === p.id && j.ownerId === req.user.id);
    if (!job) throw E.notFound('任务不存在');
    const lastSeq = store.find('job_events', (e) => e.jobId === job.id).reduce((m, e) => Math.max(m, e.seq), 0);
    return { job: { ...job, payload: undefined }, lastSeq, retryable: job.status === 'failed' };
  }

  async jobEvents(req, p, query, _body, res) {
    const { store, sseHub } = this.ctx;
    const job = store.findOne('jobs', (j) => j.id === p.id && j.ownerId === req.user.id);
    if (!job) throw E.notFound('任务不存在');
    const afterSeq = Number(query.afterSeq || 0);
    const events = store.find('job_events', (e) => e.jobId === job.id && e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
    const wantsSse = (req.headers.accept || '').includes('text/event-stream') && !query.poll;
    if (!wantsSse) return { events, jobStatus: job.status, lastSeq: events.reduce((m, e) => Math.max(m, e.seq), afterSeq) };
    // SSE：先补偿缺失事件，再挂接实时流（§9.3）
    writeSseHead(res);
    for (const e of events) res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const unsub = sseHub.subscribe(job.id, res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
    req.on('close', () => { clearInterval(ping); unsub(); });
    return null; // 已接管响应
  }

  async cancelJob(req, p) {
    const { store } = this.ctx;
    const job = store.findOne('jobs', (j) => j.id === p.id && j.ownerId === req.user.id);
    if (!job) throw E.notFound('任务不存在');
    // 请求取消：保留已完成结果，Worker 在阶段边界停止（§9.3）
    store.update('jobs', job.id, { cancelRequested: true, status: job.status === 'completed' ? 'completed' : 'cancelled', updatedAt: nowIso() });
    return { ok: true, status: store.byId('jobs', job.id).status };
  }

  /* ---------- 讲解与语音 ---------- */
  async getGuide(req, p, query) {
    const { store, cfg } = this.ctx;
    let content = null;
    if (query.planId) {
      content = store.findOne('guide_contents', (g) => g.planId === query.planId && g.poiId === p.poiId);
    }
    if (!content) {
      // 回退：直接从场所包构建（已验证的短介绍优先保留，§11.2）
      for (const pack of this.ctx.packs) {
        if (pack._poiById.has(p.poiId)) {
          const c = buildGuideContent(pack, p.poiId, cfg.providers.tts === 'http');
          if (c) content = { id: null, ...c };
          break;
        }
      }
    }
    if (!content) throw E.notFound('讲解内容暂缺');
    return content;
  }

  async guideAudio(req, p) {
    if (this.ctx.cfg.providers.tts !== 'http') {
      throw new ApiError('TTS_UNAVAILABLE', '演示模式未配置 TTS 服务：前端可回退为文本阅读或浏览器语音（已标注演示）', { status: 501, retryable: false });
    }
    throw new ApiError('TTS_NOT_IMPLEMENTED', '真实 TTS 适配器尚未联调', { status: 501, retryable: false });
  }

  async transcribe(req) {
    // 文档 §11.3：录音上传 ASR；演示模式未配置 → 明确错误码，前端回退可编辑文本（§20.3）
    if (this.ctx.cfg.providers.asr !== 'http') {
      throw new ApiError('SPEECH_UNAVAILABLE', '演示模式未配置语音识别服务，请使用文本输入（手机键盘语音输入也可用）', { status: 501, retryable: false });
    }
    throw new ApiError('SPEECH_NOT_IMPLEMENTED', '真实 ASR 适配器尚未联调', { status: 501, retryable: false });
  }

  /* ---------- 游览执行 ---------- */
  async startTrip(req, _p, _q, body) {
    const { store } = this.ctx;
    const route = store.byId('route_versions', body.routeVersionId);
    if (!route) throw E.notFound('路线版本不存在');
    const planRow = store.findOne('plans', (x) => x.id === route.planId && x.ownerId === req.user.id);
    if (!planRow) throw E.forbidden();
    if (route.status === 'infeasible') throw E.badRequest('不可行方案不能开始游览', { code: 'NO_FEASIBLE_ROUTE' });

    // 开始前再校验（§10.4）：以真实开始时刻重排时间，仅提示受影响部分
    const intent = store.byId('intents', planRow.intentId);
    const runner = this.ctx.runner;
    const { pack, graph } = await runner.resolvePackGraph(intent);
    const { scheduleRoute } = require('./planner');
    const nowMs = Date.now();
    const freshIntent = {
      ...intent, startAtMs: nowMs, startAt: tk.msToZoned(nowMs, intent.timezone).iso,
      budgetSec: Math.max(0, Math.floor((intent.latestEndAtMs - nowMs) / 1000)),
    };
    const nodeSeq = route.stops.map((s) => s.entranceNodeId);
    const sch = scheduleRoute(pack, freshIntent, graph, nodeSeq, { startNodeId: route.startNodeId, endNodeId: route.endNodeId });
    const shiftWarnings = [];
    let adjusted = null;
    if (sch.ok) {
      const driftMin = Math.abs(sch.endArrivalMs - new Date(route.endArrivalAt).getTime()) / 60000;
      if (driftMin > 3) {
        shiftWarnings.push(`距规划已过去一段时间，按当前时间重排：预计 ${tk.msToZoned(sch.endArrivalMs, intent.timezone).hhmm} 到达终点`);
        adjusted = sch;
      }
    } else {
      shiftWarnings.push('部分站点的时间窗口已变化，行程可能受影响，建议回到路线页调整');
    }
    if (sch.ok && sch.endArrivalMs > intent.latestEndAtMs) {
      shiftWarnings.push('按当前时间出发将无法在截止前完成，建议先重排行程');
    }

    const trip = {
      id: id('trp'), ownerId: req.user.id, planId: planRow.id, intentId: intent.intentId,
      activeRouteVersionId: route.routeId, startedAt: nowIso(), startedAtMs: nowMs,
      pausedAt: null, finishedAt: null, status: 'active',
      currentStopIndex: 0, adjustedTimeline: adjusted ? timelineOf(adjusted, intent.timezone) : null,
      createdAt: nowIso(),
    };
    store.insert('trips', trip);
    store.insert('trip_events', { id: id('tev'), eventId: body.eventId || id('ev'), tripId: trip.id, type: 'trip_started', data: { routeVersionId: route.routeId }, occurredAt: nowIso(), receivedAt: nowIso(), routeVersion: route.version, confirmType: 'system' });
    return { trip, warnings: shiftWarnings };
  }

  async getTrip(req, p) {
    const { store } = this.ctx;
    const trip = store.findOne('trips', (t) => t.id === p.id && t.ownerId === req.user.id);
    if (!trip) throw E.notFound('行程不存在');
    const route = store.byId('route_versions', trip.activeRouteVersionId);
    const events = store.find('trip_events', (e) => e.tripId === trip.id);
    return { trip, route: route ? { ...route, summary: routeSummary(route) } : null, events };
  }

  async tripEvent(req, p, _q, body) {
    const { store } = this.ctx;
    const trip = store.findOne('trips', (t) => t.id === p.id && t.ownerId === req.user.id);
    if (!trip) throw E.notFound('行程不存在');
    if (trip.status !== 'active') throw E.badRequest('行程已结束，不能追加事件');
    // 幂等去重（§15.3：trip_events(event_id) 唯一；弱网重传只记一条 §19.1）
    if (body.eventId) {
      const dup = store.findOne('trip_events', (e) => e.tripId === trip.id && e.eventId === body.eventId);
      if (dup) return { ok: true, deduplicated: true, eventId: body.eventId };
    }
    const route = store.byId('route_versions', trip.activeRouteVersionId);
    const evt = {
      id: id('tev'), eventId: body.eventId || id('ev'), tripId: trip.id,
      type: body.type, data: body.data || {},
      occurredAt: body.occurredAt || nowIso(), receivedAt: nowIso(),
      routeVersion: route ? route.version : null,
      confirmType: body.confirmType || 'manual', // 手动确认为高可信；定位推断带 inferred 标记（§11.5）
    };
    store.insert('trip_events', evt);

    if (body.type === 'arrive_confirm' && route) {
      const idx = route.stops.findIndex((s) => s.poiId === body.data.poiId);
      if (idx >= 0 && idx >= trip.currentStopIndex) {
        store.update('trips', trip.id, { currentStopIndex: Math.min(idx + 1, route.stops.length) });
      }
    }
    if (body.type === 'trip_paused') store.update('trips', trip.id, { status: 'paused', pausedAt: nowIso() });
    if (body.type === 'trip_resumed') store.update('trips', trip.id, { status: 'active', pausedAt: null });
    return { ok: true, eventId: evt.eventId, trip: store.byId('trips', trip.id) };
  }

  async replanTrip(req, p, _q, body) {
    const { store } = this.ctx;
    const trip = store.findOne('trips', (t) => t.id === p.id && t.ownerId === req.user.id);
    if (!trip) throw E.notFound('行程不存在');
    if (trip.status !== 'active' && trip.status !== 'paused') throw E.badRequest('行程已结束');
    const base = store.byId('route_versions', body.baseRouteId || trip.activeRouteVersionId);
    if (!base) throw E.badRequest('基准版本无效');

    // 锁定必去点的跳过需先解锁提示（§12.1）
    if (body.cause === 'stop_skipped' && body.data && body.data.poiId) {
      const stop = base.stops.find((s) => s.poiId === body.data.poiId);
      if (stop && stop.locked && !body.data.confirmedUnlock) {
        throw E.conflict('LOCKED_STOP_SKIP', `「${stop.name}」是你锁定的必去点，确认放弃该锁定吗？`, { needConfirm: 'unlock_then_skip', poiId: stop.poiId });
      }
    }
    let currentNodeId = body.currentNodeId || null;
    if (!currentNodeId) {
      const arrivals = store.find('trip_events', (e) => e.tripId === trip.id && e.type === 'arrive_confirm');
      // 先按发生时间，时间相同或缺失时按入库顺序；弱网补传旧事件不应让位置倒退。
      const last = arrivals.map((event, index) => ({ event, index }))
        .sort((a, b) => (Date.parse(b.event.occurredAt || b.event.receivedAt) || 0) - (Date.parse(a.event.occurredAt || a.event.receivedAt) || 0) || b.index - a.index)[0]?.event;
      const poiId = last && last.data && last.data.poiId;
      // 接受过提议后，新路线可能不再包含已到访站，因此也查同一计划的历史版本。
      const stop = poiId && (base.stops.find((s) => s.poiId === poiId)
        || store.find('route_versions', (r) => r.planId === trip.planId).slice().reverse()
          .flatMap((r) => r.stops || []).find((s) => s.poiId === poiId));
      currentNodeId = stop && stop.entranceNodeId || base.startNodeId;
    }
    const job = createJob(store, {
      type: 'trip.replan', ownerId: req.user.id, planId: trip.planId, tripId: trip.id,
      payload: { baseRouteId: base.routeId, cause: body.cause, data: body.data || {}, currentNodeId },
    });
    return { status: 202, jobId: job.id };
  }

  async acceptReplan(req, p, _q, body) {
    const { store } = this.ctx;
    const trip = store.findOne('trips', (t) => t.id === p.id && t.ownerId === req.user.id);
    if (!trip) throw E.notFound('行程不存在');
    const proposal = store.byId('route_versions', p.proposalId);
    if (!proposal || !proposal.isProposal) throw E.notFound('提议不存在或已失效');
    // 事务内比较基准版本（§12.3-3/4）：不一致返回 409
    if (trip.activeRouteVersionId !== body.baseVersionId) {
      throw E.conflict('ROUTE_VERSION_CONFLICT', '当前路线版本已变化，请刷新后重试', { currentRouteVersionId: trip.activeRouteVersionId });
    }
    store.update('trips', trip.id, { activeRouteVersionId: proposal.routeId });
    store.insert('trip_events', {
      id: id('tev'), eventId: body.idempotencyKey || id('ev'), tripId: trip.id, type: 'version_switched',
      data: { from: body.baseVersionId, to: proposal.routeId, cause: proposal.proposalCause },
      occurredAt: nowIso(), receivedAt: nowIso(), routeVersion: proposal.version, confirmType: 'user_confirmed',
    });
    // 已完成事实不回写旧版本（§12.2）；提议被接受后其余提议自然失效（版本不匹配 409）
    return { ok: true, trip: store.byId('trips', trip.id), route: proposal };
  }

  async finishTrip(req, p, _q, body) {
    const { store } = this.ctx;
    const trip = store.findOne('trips', (t) => t.id === p.id && t.ownerId === req.user.id);
    if (!trip) throw E.notFound('行程不存在');
    if (trip.status === 'completed' || trip.status === 'ended_early') {
      return { trip, summary: this.buildTripSummary(trip) }; // 幂等
    }
    const events = store.find('trip_events', (e) => e.tripId === trip.id);
    const allDone = this.allStopsResolved(trip, events);
    store.update('trips', trip.id, {
      status: allDone ? 'completed' : 'ended_early',
      finishedAt: body.finishedAt || nowIso(),
    });
    const fresh = store.byId('trips', trip.id);
    store.insert('trip_events', { id: id('tev'), eventId: (body && body.idempotencyKey) || id('ev'), tripId: trip.id, type: 'trip_finished', data: { status: fresh.status }, occurredAt: nowIso(), receivedAt: nowIso(), routeVersion: null, confirmType: 'user_confirmed' });
    return { trip: fresh, summary: this.buildTripSummary(fresh) };
  }

  allStopsResolved(trip, events) {
    const route = this.ctx.store.byId('route_versions', trip.activeRouteVersionId);
    if (!route) return false;
    const resolved = new Set();
    for (const e of events) {
      if (e.type === 'arrive_confirm') resolved.add(e.data.poiId);
      if (e.type === 'stop_skipped') resolved.add(e.data.poiId);
    }
    return route.stops.every((s) => resolved.has(s.poiId));
  }

  buildTripSummary(trip) {
    const { store } = this.ctx;
    const plan = store.byId('plans', trip.planId);
    const initialRoute = store.find('route_versions', (r) => r.planId === trip.planId).sort((a, b) => a.version - b.version)[0];
    const activeRoute = store.byId('route_versions', trip.activeRouteVersionId);
    const events = store.find('trip_events', (e) => e.tripId === trip.id);
    const visited = events.filter((e) => e.type === 'arrive_confirm').map((e) => ({ poiId: e.data.poiId, confirmType: e.confirmType, at: e.occurredAt }));
    const skipped = events.filter((e) => e.type === 'stop_skipped').map((e) => ({ poiId: e.data.poiId, reason: e.data.reason || null }));
    const poiName = (pid) => {
      for (const pack of this.ctx.packs) { const p = pack._poiById.get(pid); if (p) return p.name; }
      return pid;
    };
    const durationSec = trip.finishedAt ? Math.round((new Date(trip.finishedAt) - new Date(trip.startedAt)) / 1000) : null;
    return {
      tripId: trip.id,
      status: trip.status,
      startedAt: trip.startedAt,
      finishedAt: trip.finishedAt,
      actualDurationSec: durationSec,
      plannedStops: initialRoute ? initialRoute.stops.map((s) => s.name) : [],
      finalStops: activeRoute ? activeRoute.stops.map((s) => s.name) : [],
      confirmedVisits: visited.map((v) => ({ ...v, name: poiName(v.poiId) })),
      skippedStops: skipped.map((s) => ({ ...s, name: poiName(s.poiId) })),
      // §13.2：无连续轨迹 → 显示"规划距离"，不补造实际距离
      distanceM: activeRoute ? activeRoute.totals.distanceM : null,
      distanceKind: 'planned',
      distanceNote: '未开启连续轨迹采集，此处为规划距离，不代表实际行走距离',
      versionCount: store.find('route_versions', (r) => r.planId === trip.planId).length,
      replanCount: events.filter((e) => e.type === 'version_switched').length,
      plannedDurationSec: activeRoute ? activeRoute.totals.totalSec : null,
      dataCompleteness: { continuousTrack: false, note: '未采集连续轨迹（用户未授权或 Web 前台限制）' },
      // 在路上写的、但没对应到访点的笔记也不丢（单独一栏"路上随手记"）
      looseNotes: events
        .filter((e) => e.type === 'note' && e.data && !visited.some((v) => v.poiId === e.data.poiId))
        .map((e) => ({ poiId: e.data.poiId, name: poiName(e.data.poiId), at: e.occurredAt, text: String(e.data.text || '').slice(0, 200) })),
      // 导游视角的回顾：每个到访点的看点摘录 + 现场笔记（把"路程统计"变成"游览记忆"）
      visitedHighlights: visited.map((v) => {
        const g = store.findOne('guide_contents', (x) => x.planId === trip.planId && x.poiId === v.poiId);
        const note = events.filter((e) => e.type === 'note' && e.data && e.data.poiId === v.poiId).slice(-1)[0];
        return {
          poiId: v.poiId,
          name: poiName(v.poiId),
          at: v.at,
          teaser: g ? (g.summary || g.shortScript || '').slice(0, 80) : null,
          guideReady: !!g,
          note: note ? String(note.data.text || '').slice(0, 200) : null,
        };
      }),
      demo: this.ctx.cfg.demoMode,
      venueName: (() => {
        const intent = plan && store.byId('intents', plan.intentId);
        if (!intent) return null;
        if (intent.venueId === 'area_amap') return '周边片区（高德实时数据）';
        if (intent.venueRef && intent.venueRef.name) return intent.venueRef.name;
        const pk = this.ctx.packs.find((x) => x.venue.id === intent.venueId);
        return pk ? pk.venue.name : null;
      })(),
    };
  }

  /* ---------- 反馈 / 历史 / 汇总 / 偏好 ---------- */
  async feedback(req, _p, _q, body) {
    const { store } = this.ctx;
    if (body.tripId) {
      const trip = store.findOne('trips', (t) => t.id === body.tripId && t.ownerId === req.user.id);
      if (!trip) throw E.notFound('行程不存在');
    }
    // 分字段：路线合理性 / 地点喜好 / 讲解准确性 分开（§13.1）
    const fb = {
      id: id('fbk'), userId: req.user.id, tripId: body.tripId || null,
      targetType: body.targetType || 'route', targetId: body.targetId || null,
      rating: body.rating ?? null, reasons: body.reasons || [], text: body.text || '',
      context: body.context || null, createdAt: nowIso(),
    };
    store.insert('feedback', fb);
    // §13.3：显式喜欢/不喜欢权重大于停留推断；情境（下雨等）记录为原因，不改长期权重
    const contextualReasons = ['weather_rain', 'too_tired', 'time_short', 'companion'];
    const hasContextOnly = fb.reasons.length && fb.reasons.every((r) => contextualReasons.includes(r));
    if (fb.rating && fb.targetType === 'poi' && !hasContextOnly) {
      store.insert('preference_evidence', {
        id: id('pfe'), userId: req.user.id, kind: 'explicit', targetTag: null, targetPoiId: fb.targetId,
        weight: fb.rating >= 4 ? 0.1 : fb.rating <= 2 ? -0.1 : 0,
        sourceFeedbackId: fb.id, context: fb.context, expiresAt: null, createdAt: nowIso(),
      });
    }
    return { ok: true, feedbackId: fb.id, learned: !hasContextOnly && fb.targetType === 'poi' && fb.rating != null };
  }

  async myTrips(req, _p, query) {
    const { store } = this.ctx;
    const trips = store.find('trips', (t) => t.ownerId === req.user.id)
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
      .slice(0, Number(query.limit || 50));
    return {
      trips: trips.map((t) => ({
        id: t.id, status: t.status, startedAt: t.startedAt, finishedAt: t.finishedAt,
        summary: t.finishedAt ? this.buildTripSummary(t) : null,
        venueName: t.finishedAt ? this.buildTripSummary(t).venueName : null,
      })),
    };
  }

  async mySummaries(req, _p, query) {
    const { store } = this.ctx;
    const period = query.period || 'week';
    const tz = query.timezone || 'Asia/Shanghai';
    const now = Date.now();
    const spanMs = period === 'year' ? 365 * 86400000 : period === 'month' ? 30 * 86400000 : 7 * 86400000;
    const trips = store.find('trips', (t) => t.ownerId === req.user.id && t.finishedAt && now - new Date(t.finishedAt).getTime() < spanMs);
    const events = store.find('trip_events', (e) => trips.some((t) => t.id === e.tripId));
    const confirmed = events.filter((e) => e.type === 'arrive_confirm');
    const distinctPois = new Set(confirmed.map((e) => e.data.poiId));
    let knownDistanceM = 0, actualSec = 0;
    for (const t of trips) {
      const s = this.buildTripSummary(t);
      knownDistanceM += s.distanceM || 0;
      if (s.actualDurationSec) actualSec += s.actualDurationSec;
    }
    return {
      period, timezone: tz, aggregationVersion: 'agg-1.0',
      computedAt: nowIso(),
      completedTrips: trips.filter((t) => t.status === 'completed').length,
      endedEarlyTrips: trips.filter((t) => t.status === 'ended_early').length,
      confirmedVisitCount: confirmed.length,
      distinctPlaceCount: distinctPois.size,
      actualDurationSec: actualSec,
      knownDistanceM,
      distanceKind: 'planned',
      dataCompleteness: { continuousTrack: false, note: '距离为规划距离合计；未采集连续轨迹，不展示伪造的实际距离（§13.2）' },
      narrative: null, // §13.4：数值先行，LLM 润色在真实模式接入
    };
  }

  async getPreferences(req) {
    const { store } = this.ctx;
    const pref = store.findOne('preferences', (x) => x.userId === req.user.id);
    const evidence = store.find('preference_evidence', (x) => x.userId === req.user.id);
    return {
      preferences: pref || { userId: req.user.id, enabled: true, interests: [], pace: null, guideStyle: 'normal' },
      evidenceCount: evidence.length,
      note: '偏好画像可查看、修改或关闭；关闭个性化不影响保留自用历史（§13.5）',
    };
  }

  async putPreferences(req, _p, _q, body) {
    const { store } = this.ctx;
    const existing = store.findOne('preferences', (x) => x.userId === req.user.id);
    const patch = {
      enabled: body.enabled !== false,
      interests: Array.isArray(body.interests) ? body.interests : (existing ? existing.interests : []),
      pace: body.pace || (existing ? existing.pace : null),
      guideStyle: body.guideStyle || (existing ? existing.guideStyle : 'normal'),
      updatedAt: nowIso(),
    };
    if (existing) store.update('preferences', existing.id, patch);
    else store.insert('preferences', { id: id('prf'), userId: req.user.id, createdAt: nowIso(), ...patch });
    return { ok: true, preferences: store.findOne('preferences', (x) => x.userId === req.user.id) };
  }

  async deleteTrip(req, p) {
    const { store } = this.ctx;
    const trip = store.findOne('trips', (t) => t.id === p.id && t.ownerId === req.user.id);
    if (!trip) throw E.notFound('行程不存在');
    // §13.5：删除行程同时清理关联画像证据与个人附件；共享公共讲解不误删
    store.removeWhere('trip_events', (e) => e.tripId === trip.id);
    const fbIds = store.find('feedback', (f) => f.tripId === trip.id).map((f) => f.id);
    store.removeWhere('feedback', (f) => f.tripId === trip.id);
    store.removeWhere('preference_evidence', (e) => fbIds.includes(e.sourceFeedbackId));
    store.removeWhere('trips', (t) => t.id === trip.id);
    return { ok: true, deleted: { tripId: trip.id, feedbackRemoved: fbIds.length }, note: '汇总数据按重算口径在下一次查询时自动更新' };
  }

  /* ==================== 导游平台：内容中心 ==================== */
  /** 内容库统一输出 reviewStatus：前端据此展示"内容库 v1（公开资料整理，未实地核验）"标注 */
  async hubMeta() {
    return { meta: this.ctx.content.getMeta(), reviewStatus: 'library_v1' };
  }

  async hubHighlights() {
    const content = this.ctx.content;
    return {
      cities: content.listCities().slice(0, 6),
      venues: content.listVenues({ limit: 8 }),
      articles: content.listArticles({ limit: 4 }),
      meta: content.getMeta(),
      reviewStatus: 'library_v1',
    };
  }

  async hubSearch(req, _p, query) {
    if (!query.q) throw E.badRequest('请输入搜索词', { field: 'q' });
    return this.ctx.content.search(query.q, Math.min(10, Number(query.limit) || 6));
  }

  async hubCities() {
    return { cities: this.ctx.content.listCities(), reviewStatus: 'library_v1' };
  }

  async hubCity(req, p) {
    const city = this.ctx.content.getCity(p.id);
    if (!city) throw E.notFound('城市不存在');
    return { city, reviewStatus: 'library_v1' };
  }

  async hubVenues(req, _p, query) {
    return { venues: this.ctx.content.listVenues(query), reviewStatus: 'library_v1' };
  }

  async hubVenue(req, p) {
    const venue = this.ctx.content.getVenue(p.id);
    if (!venue) throw E.notFound('场所不存在');
    return { venue, reviewStatus: 'library_v1' };
  }

  async hubNarration(req, p) {
    const narration = this.ctx.content.getNarration(p.id);
    if (!narration) throw E.notFound('讲解不存在');
    return { narration };
  }

  async hubArticles(req, _p, query) {
    return { articles: this.ctx.content.listArticles(query), reviewStatus: 'library_v1' };
  }

  async hubArticle(req, p) {
    const article = this.ctx.content.getArticle(p.id);
    if (!article) throw E.notFound('文章不存在');
    return { article };
  }

  /* ==================== 路线模板库（发现页） ==================== */
  async hubTemplates(req, _p, query) {
    return { templates: this.ctx.content.listTemplates(query), reviewStatus: 'library_v1' };
  }

  async hubTemplate(req, p) {
    const template = this.ctx.content.getTemplate(p.id);
    if (!template) throw E.notFound('模板不存在');
    return { template, reviewStatus: 'library_v1' };
  }

  async hubTemplateUse(req, p) {
    const template = this.ctx.content.bumpTemplateHeat(p.id);
    if (!template) throw E.notFound('模板不存在');
    return { ok: true, heat: template.heat, note: '热度已 +1（真实使用计数）' };
  }

  /* ==================== 城市多日行程（确定性规划） ==================== */
  async itineraryPreview(req, _p, _q, body) {
    const { planItinerary } = require('./itinerary');
    return planItinerary(this.ctx.content, body || {});
  }

  /* ==================== 行程单（保存的多日行程；产品与交易解耦，无支付） ==================== */
  async createOrder(req, _p, _q, body) {
    const { market } = this.ctx;
    // 轻量幂等：同用户同幂等键直接返回已有行程单
    if (body.idempotencyKey) {
      const dup = this.ctx.store.findOne('orders', (o) => o.ownerId === req.user.id
        && o.idempotencyKey === body.idempotencyKey);
      if (dup) return { order: dup, idempotentReplay: true };
    }
    if (body.type !== 'itinerary') throw E.badRequest('仅支持保存行程单（type=itinerary）', { field: 'type' });
    const order = market.createItineraryOrder(req.user.id, body);
    if (body.idempotencyKey) {
      this.ctx.store.update('orders', order.id, { idempotencyKey: body.idempotencyKey });
      order.idempotencyKey = body.idempotencyKey;
    }
    return { order };
  }

  async listOrders(req, _p, query) {
    return { orders: this.ctx.market.listOrders(req.user.id, query) };
  }

  async getOrder(req, p) {
    return { order: this.ctx.market.getOrder(req.user.id, p.id) };
  }

  async cancelOrder(req, p, _q, body) {
    return { order: this.ctx.market.cancel(req.user.id, p.id, body && body.reason) };
  }
}

function timelineOf(sch, tz) {
  return sch.stops.map((s) => ({
    nodeId: s.nodeId,
    arrivalAt: tk.msToZoned(s.arrivalMs, tz).iso,
    visitStartAt: tk.msToZoned(s.visitStartMs, tz).iso,
    departureAt: tk.msToZoned(s.departureMs, tz).iso,
  }));
}

module.exports = { Api };
