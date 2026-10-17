'use strict';
/**
 * 入口：静态资源 + API + SSE + 任务 Runner。
 * 运行：node server/index.js（零依赖，Node >= 18）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ROOT, loadConfig } = require('./config');
const { createStore } = require('./store');
const { loadPacks } = require('./providers');
const { ContentHub } = require('./content');
const { Market } = require('./market');
const { ensureAdminToken } = require('./admin');
const { SseHub } = require('./sse');
const { JobRunner } = require('./jobs');
const { Api } = require('./api');
const { ApiError, readJson, readBody, traceId } = require('./util');

const cfg = loadConfig();
const store = createStore(ROOT);
const packs = loadPacks(ROOT);
const content = new ContentHub();
const market = new Market({ store, content });
const sseHub = new SseHub();
const runner = new JobRunner({ store, cfg, packs, sseHub });
const api = new Api({ store, cfg, packs, sseHub, runner, content, market });
runner.start();

// 管理后台令牌：环境变量 > config.json admin.token > 首次启动生成并写入 data/admin-token.txt
const adminAuth = ensureAdminToken(ROOT, cfg.admin);
cfg.adminToken = adminAuth.token;

const WEB_DIR = path.join(ROOT, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function authenticate(req, url) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  // 浏览器 EventSource 无法设置 Authorization；仅任务事件端点接受查询凭证。
  const eventStream = req.method === 'GET' && /^\/v1\/jobs\/[^/]+\/events$/.test(url.pathname)
    && (req.headers.accept || '').includes('text/event-stream');
  const credential = m ? m[1] : eventStream ? url.searchParams.get('token') : null;
  if (!credential) return null;
  const sess = store.findOne('sessions', (s) => s.token === credential && !s.revokedAt);
  if (!sess) return null;
  return store.byId('users', sess.userId);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  try {
    if (pathname.startsWith('/v1/')) {
      const matched = api.match(req.method, pathname);
      if (!matched) throw new ApiError('NOT_FOUND', '接口不存在', { status: 404 });
      const { route, params } = matched;
      if (route.auth) {
        const user = authenticate(req, u);
        if (!user) {
          // 明确告知客户端应重建会话：客户端据此自动换新凭证并重试，不会卡在报错上
          throw new ApiError('UNAUTHORIZED', '会话已失效，请重新建立会话', {
            status: 401, details: { reason: 'session_missing_or_revoked', action: 'renew_session' },
          });
        }
        req.user = user;
      }
      const query = Object.fromEntries(u.searchParams.entries());
      // SSE 端点由处理器自行接管响应
      if (req.method === 'GET' && (req.headers.accept || '').includes('text/event-stream')) {
        const out = await route.handler(req, params, query, {}, res);
        if (out !== null && out !== undefined) sendJson(res, 200, out);
        return;
      }
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        body = (req.headers['content-type'] || '').includes('application/json') ? await readJson(req) : await readBody(req).then((b) => ({ _raw: b.toString('utf8') }));
      }
      const out = await route.handler(req, params, query, body, res);
      if (out === null || out === undefined) return; // SSE 已接管
      const status = out && out.status === 202 ? 202 : 200;
      sendJson(res, status, out);
      return;
    }

    // 静态资源 + SPA 回退
    let filePath = path.normalize(path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname));
    if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(WEB_DIR, 'index.html');
    }
    const ext = path.extname(filePath);
    // 无构建步骤：静态文件必须"每次校验"，否则部署新版本后浏览器会继续用旧的 JS/CSS。
    // 配 ETag/Last-Modified 走 304，既保证拿到新代码，又不重复传输未变的文件。
    const stat = fs.statSync(filePath);
    const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
    const lastModified = stat.mtime.toUTCString();
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    const notModified = inm ? inm === etag
      : (ims ? new Date(ims).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000 : false);
    if (notModified) {
      res.writeHead(304, { etag, 'last-modified': lastModified, 'cache-control': 'no-cache' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache', etag, 'last-modified': lastModified, 'content-length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    const err = e instanceof ApiError ? e : new ApiError('INTERNAL', '服务器内部错误', { status: 500 });
    if (!(e instanceof ApiError)) console.error('[api] unexpected:', e);
    sendJson(res, err.status || 500, {
      code: err.code, message: err.message, retryable: !!err.retryable,
      traceId: traceId(), details: err.details || {},
    });
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[smart-tour] 端口 ${cfg.port} 已被占用（多半是上次的实例没关）。`);
    console.error(`  Windows 下可执行: netstat -ano | findstr :${cfg.port}  找到 PID，再 taskkill /PID <PID> /F`);
    console.error(`  或改用其他端口启动: PORT=${cfg.port + 1} node server/index.js`);
    process.exit(1);
  }
  throw err;
});

server.listen(cfg.port, () => {
  console.log(`[smart-tour] 漫游有解（多约束动态游览路线规划智能体）已启动: http://localhost:${cfg.port}`);
  console.log(`[smart-tour] 导游平台: 内容库 ${content.getMeta().counts.cities} 城 / ${content.getMeta().counts.venues} 场所 / ${content.getMeta().counts.narrations} 条讲解（library_v1，未实地核验）`);
  console.log(`[smart-tour] 管理后台: http://localhost:${cfg.port}/admin.html （令牌来源: ${adminAuth.source}${adminAuth.source === 'generated-file' ? '，已写入 data/admin-token.txt' : ''}）`);
  if (adminAuth.source === 'generated-file' || adminAuth.source === 'ephemeral') {
    console.log(`[smart-tour] 管理令牌: ${adminAuth.token}`);
  }
  console.log(`[smart-tour] 模式: ${cfg.demoMode ? '未配置地图 Key（实时路线规划不可用；讲解/行程/市场不依赖 Key）' : '真实数据'}`);
  console.log(`[smart-tour] Providers: map=${cfg.providers.map} llm=${cfg.providers.llm} asr=${cfg.providers.asr} tts=${cfg.providers.tts}`);
});
