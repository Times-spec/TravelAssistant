'use strict';
// 隔离的内存演示服务：不读取 config.json、不生成管理令牌、不写产品数据。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHarness } = require('./live-test-support');
const { ContentHub } = require('../server/content');
const { Market } = require('../server/market');
const { SseHub } = require('../server/sse');
const { readJson, ApiError } = require('../server/util');
const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
async function startServer({ port = 0, assetRef = null, harness = null } = {}) {
  const { api, ctx } = harness || createHarness();
  ctx.cfg.demoMode = true; ctx.cfg.setupRequired = false; ctx.cfg.amap = {};
  ctx.content = new ContentHub(); ctx.market = new Market({ store: ctx.store, content: ctx.content });
  ctx.sseHub = new SseHub(); ctx.runner.ctx.sseHub = ctx.sseHub;
  ctx.runner.start();
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/__test/fixtures') return send(200, ctx.testFixtures || {});
      if (url.pathname.startsWith('/v1/')) {
        const matched = api.match(req.method, url.pathname);
        if (!matched) throw new ApiError('NOT_FOUND', '接口不存在', { status: 404 });
        if (matched.route.auth) {
          const credential = (req.headers.authorization || '').replace(/^Bearer\s+/, '') || url.searchParams.get('token');
          const session = ctx.store.findOne('sessions', (s) => s.token === credential && !s.revokedAt);
          if (!session) throw new ApiError('UNAUTHORIZED', '会话不存在', { status: 401 });
          req.user = ctx.store.byId('users', session.userId);
        }
        const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
        const result = await matched.route.handler(req, matched.params, Object.fromEntries(url.searchParams), body, res);
        if (result != null) send(result.status === 202 ? 202 : 200, result);
        return;
      }
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\//, '');
      const file = path.resolve(ROOT, 'web', relative);
      if (!file.startsWith(path.resolve(ROOT, 'web') + path.sep)) return send(404, {});
      let data;
      if (assetRef && /^(?:js\/|css\/|index\.html$)/.test(relative)) {
        data = execFileSync('git', ['show', `${assetRef}:webos/web/${relative}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      } else data = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(data);
    } catch (e) { send(e.status || 500, { code: e.code || 'INTERNAL', message: e.message }); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  return { api, ctx, server, base: `http://127.0.0.1:${address.port}`, close: async () => {
    clearInterval(ctx.runner._timer); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  } };
}
if (require.main === module) startServer({ port: Number(process.env.PORT || 8191), assetRef: process.env.ASSET_REF || null }).then((s) => console.log(`Demo fixture server: ${s.base}`));
module.exports = { startServer };
