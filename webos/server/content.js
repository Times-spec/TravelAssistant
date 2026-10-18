'use strict';
/**
 * 内容中心（导游平台的目的地/讲解/攻略库）。
 * 数据来源：data/content/*.json（自有内容库 v1，标注 library_v1 = 公开资料整理、未实地核验）。
 * 设计要点：
 *  - 内容库与高德真实数据分轨：内容库不依赖任何 Key，随包分发，可离线浏览；
 *    现场实时路线规划仍走既有 amap/live_venue 管线，两者在场所详情页汇合。
 *  - 只读加载 + 内存索引；管理后台的写操作走 saveToFile 原子替换。
 *  - 诚实边界：所有输出带 reviewStatus，票价/时间未核验字段原样透传，不做"看起来很确定"的修饰。
 */
const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, '..', 'data', 'content');

function loadJson(name) {
  const file = path.join(CONTENT_DIR, name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

class ContentHub {
  constructor() {
    this.meta = { loadedAt: new Date().toISOString() };
    this.cities = [];
    this.venues = [];
    this.narrations = [];
    this.articles = [];
    this.templates = [];
    this.reload();
  }

  reload() {
    const cities = loadJson('cities.json');
    const venues = loadJson('venues.json');
    const narrations = loadJson('narrations.json');
    const articles = loadJson('articles.json');
    const templates = loadJson('route_templates.json');
    this.cities = cities.cities;
    this.venues = venues.venues;
    this.narrations = narrations.narrations;
    this.articles = articles.articles;
    this.templates = (templates.templates || []).map((t) => ({ ...t, heat: t.heat ?? t.heatInit ?? 0 }));
    this._templateMeta = templates;
    this.meta = {
      loadedAt: new Date().toISOString(),
      reviewStatus: venues.reviewStatus || 'library_v1',
      reviewNote: venues.reviewNote || '',
      counts: {
        cities: this.cities.length, venues: this.venues.length,
        narrations: this.narrations.length, articles: this.articles.length,
        templates: this.templates.length,
      },
    };
    // 索引
    this._cityById = new Map(this.cities.map((c) => [c.id, c]));
    this._venueById = new Map(this.venues.map((v) => [v.id, v]));
    this._narrById = new Map(this.narrations.map((n) => [n.id, n]));
    this._venuesByCity = new Map();
    for (const v of this.venues) {
      if (!this._venuesByCity.has(v.cityId)) this._venuesByCity.set(v.cityId, []);
      this._venuesByCity.get(v.cityId).push(v);
    }
    this._articlesByCity = new Map();
    for (const a of this.articles) {
      if (!a.cityId) continue;
      if (!this._articlesByCity.has(a.cityId)) this._articlesByCity.set(a.cityId, []);
      this._articlesByCity.get(a.cityId).push(a);
    }
  }

  getMeta() { return { ...this.meta }; }

  listCities() {
    return this.cities.map((c) => ({
      ...c,
      venueCount: (this._venuesByCity.get(c.id) || []).length,
      articleCount: (this._articlesByCity.get(c.id) || []).length,
    }));
  }

  getCity(id) {
    const city = this._cityById.get(id);
    if (!city) return null;
    return {
      ...city,
      venues: (this._venuesByCity.get(id) || []).map((v) => this.venueCard(v)),
      articles: this._articlesByCity.get(id) || [],
    };
  }

  venueCard(v) {
    return {
      id: v.id, cityId: v.cityId, name: v.name, kind: v.kind, level: v.level,
      tags: v.tags, rating: v.rating, heat: v.heat, summary: v.summary,
      highlights: v.highlights, suggestedHours: v.suggestedHours, size: v.size,
      ticket: v.ticket, openHours: v.openHours, bestSeason: v.bestSeason,
      worldHeritage: !!v.worldHeritage, crowd: v.crowd || null,
      coord: v.coord, coordNote: '内容库近似坐标（GCJ02），仅供行程示意',
      narrCount: v.pois.filter((p) => p.n).length,
    };
  }

  listVenues({ cityId, tag, q, limit } = {}) {
    let list = this.venues;
    if (cityId) list = list.filter((v) => v.cityId === cityId);
    if (tag) list = list.filter((v) => (v.tags || []).includes(tag));
    if (q) {
      const query = q.trim();
      list = list.filter((v) => v.name.includes(query)
        || (v.summary || '').includes(query)
        || (v.tags || []).some((t) => t.includes(query))
        || (v.pois || []).some((p) => p.name.includes(query)));
    }
    list = [...list].sort((a, b) => (b.heat || 0) - (a.heat || 0));
    if (limit) list = list.slice(0, Number(limit));
    return list.map((v) => this.venueCard(v));
  }

  getVenue(id) {
    const v = this._venueById.get(id);
    if (!v) return null;
    const city = this._cityById.get(v.cityId);
    return {
      ...this.venueCard(v),
      pois: v.pois.map((p, i) => ({
        idx: i, name: p.name, type: p.type || '看点', brief: p.brief || '',
        mustSee: !!p.mustSee, narrationId: p.n || null,
      })),
      narrations: (v.pois || []).filter((p) => p.n).map((p) => p.n)
        .concat([`n_intro_${id.replace('v_', '')}`])
        .filter((nid) => this._narrById.has(nid)),
      city: city ? { id: city.id, name: city.name } : null,
      food: city ? city.food : [],
    };
  }

  getNarration(id) {
    return this._narrById.get(id) || null;
  }

  /** 讲解（三层结构）：venue 级开场用 n_intro_ 前缀，点位讲解直接取 */
  narrationForVenue(venueId, poiIdx) {
    const v = this._venueById.get(venueId);
    if (!v) return null;
    if (poiIdx === null || poiIdx === undefined || poiIdx === 'intro') {
      return this._narrById.get(`n_intro_${venueId.replace('v_', '')}`) || null;
    }
    const poi = v.pois[Number(poiIdx)];
    if (!poi || !poi.n) return null;
    return this._narrById.get(poi.n) || null;
  }

  listArticles({ cityId, tag, limit } = {}) {
    let list = this.articles;
    if (cityId) list = list.filter((a) => a.cityId === cityId);
    if (tag) list = list.filter((a) => (a.tags || []).includes(tag));
    if (limit) list = list.slice(0, Number(limit));
    return list.map(({ body, ...card }) => card);
  }

  getArticle(id) {
    return this.articles.find((a) => a.id === id) || null;
  }

  /* ==================== 路线模板库（发现页生态位：灵感 + 固化大众路线） ==================== */

  templateCard(t) {
    const city = this._cityById.get(t.cityId);
    const venue = t.venueId ? this._venueById.get(t.venueId) : null;
    return {
      id: t.id, name: t.name, cityId: t.cityId, cityName: city ? city.name : (t.cityId || ''),
      scene: t.scene, venueId: t.venueId || null, venueName: venue ? venue.name : null, durationSec: t.durationSec,
      themeTags: t.themeTags || [], summary: t.summary,
      // 途经点名称让"这条路线具体去哪"一眼可见（详情页仍给每站 brief）
      stopNames: (t.stops || []).map((s) => s.name).slice(0, 6),
      stopCount: (t.stops || []).length, heat: t.heat || 0, blurb: t.blurb || '',
    };
  }

  listTemplates({ tag, cityId, limit } = {}) {
    let list = this.templates;
    if (cityId) list = list.filter((t) => t.cityId === cityId);
    if (tag) list = list.filter((t) => (t.themeTags || []).includes(tag));
    list = [...list].sort((a, b) => (b.heat || 0) - (a.heat || 0));
    if (limit) list = list.slice(0, Number(limit));
    return list.map((t) => this.templateCard(t));
  }

  getTemplate(id) {
    const t = this.templates.find((x) => x.id === id);
    if (!t) return null;
    const city = this._cityById.get(t.cityId);
    return { ...this.templateCard(t), stops: t.stops || [], draft: t.draft || {}, reviewNote: (this._templateMeta && this._templateMeta.reviewNote) || '' };
  }

  /** 热度+1（编辑初始值 + 真实使用计数），原子写回数据文件 */
  bumpTemplateHeat(id) {
    const t = this.templates.find((x) => x.id === id);
    if (!t) return null;
    t.heat = (t.heat || 0) + 1;
    const tmp = path.join(CONTENT_DIR, 'route_templates.json.tmp');
    const data = {
      version: (this._templateMeta && this._templateMeta.version) || '1.0.0',
      reviewStatus: (this._templateMeta && this._templateMeta.reviewStatus) || 'library_v1',
      reviewNote: (this._templateMeta && this._templateMeta.reviewNote) || '',
      templates: this.templates,
    };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(CONTENT_DIR, 'route_templates.json'));
    return t;
  }

  /** 全局搜索：城市/场所/攻略 三路检索 */
  search(q, limit = 8) {
    const query = (q || '').trim();
    if (!query) return { cities: [], venues: [], articles: [] };
    const cities = this.cities.filter((c) => c.name.includes(query)
      || (c.tags || []).some((t) => t.includes(query)) || (c.summary || '').includes(query))
      .slice(0, 4).map((c) => ({ id: c.id, name: c.name, slogan: c.slogan, tags: c.tags }));
    const venues = this.listVenues({ q: query, limit }).slice(0, limit)
      .map((v) => ({ id: v.id, name: v.name, cityId: v.cityId, kind: v.kind, level: v.level, rating: v.rating }));
    const articles = this.articles.filter((a) => a.title.includes(query)
      || (a.summary || '').includes(query)).slice(0, limit)
      .map((a) => ({ id: a.id, title: a.title, summary: a.summary, readMin: a.readMin }));
    return { cities, venues, articles };
  }

  /** 管理后台：保存内容文件（原子替换） */
  saveCollection(name) {
    const files = { cities: 'cities.json', venues: 'venues.json', narrations: 'narrations.json', articles: 'articles.json' };
    const file = files[name];
    if (!file) throw new Error('未知内容集合: ' + name);
    const tmp = path.join(CONTENT_DIR, file + '.tmp');
    const data = {
      version: '1.0.0',
      reviewStatus: 'library_v1',
      reviewNote: '内容库 v1：依据公开资料整理，未实地核验；票价、开放时间等以现场公示为准',
    };
    if (name === 'cities') data.cities = this.cities;
    else if (name === 'venues') data.venues = this.venues;
    else if (name === 'narrations') data.narrations = this.narrations;
    else if (name === 'articles') data.articles = this.articles;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(CONTENT_DIR, file));
  }

  upsert(name, row) {
    const lists = { cities: this.cities, venues: this.venues, narrations: this.narrations, articles: this.articles };
    const list = lists[name];
    if (!list) throw new Error('未知内容集合: ' + name);
    const i = list.findIndex((x) => x.id === row.id);
    if (i >= 0) list[i] = row; else list.push(row);
    this.saveCollection(name);
    this.reload();
    return row;
  }

  remove(name, id) {
    const lists = { cities: this.cities, venues: this.venues, narrations: this.narrations, articles: this.articles };
    const list = lists[name];
    if (!list) throw new Error('未知内容集合: ' + name);
    const before = list.length;
    this[name] = list.filter((x) => x.id !== id);
    if (this[name].length === before) return false;
    this.saveCollection(name);
    this.reload();
    return true;
  }
}

module.exports = { ContentHub };
