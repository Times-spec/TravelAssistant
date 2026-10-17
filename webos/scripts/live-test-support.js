'use strict';
const path = require('node:path');
const { Api } = require('../server/api');
const { JobRunner } = require('../server/jobs');
const { loadPacks } = require('../server/providers');
function createHarness(overrides = {}) {
  const tables = new Map();
  const rows = (name) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name); };
  const store = {
    find: (name, predicate) => rows(name).filter(predicate),
    findOne: (name, predicate) => rows(name).find(predicate) || null,
    byId: (name, id) => rows(name).find((r) => r.id === id) || null,
    insert: (name, row) => { rows(name).push(row); return row; },
    insertUnique: (name, row, key) => rows(name).some((r) => key(r) === key(row)) ? null : store.insert(name, row),
    update: (name, id, patch) => { const row = store.byId(name, id); if (row) Object.assign(row, typeof patch === 'function' ? patch(row) : patch); return row; },
  };
  const cfg = { providers: { llm: 'rules', map: 'demo', tts: 'unavailable' }, limits: { maxLlmTokens: 1000, maxWallTimeSec: 90 }, ...overrides };
  const ctx = { store, cfg, packs: loadPacks(path.join(__dirname, '..')), sseHub: { publish() {}, subscribe: () => () => {} } };
  ctx.runner = new JobRunner(ctx);
  const api = new Api(ctx);
  return { api, ctx, req: { user: { id: 'test-user' }, headers: {} } };
}
module.exports = { createHarness };
