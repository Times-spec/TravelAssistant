'use strict';
/**
 * 配置加载与 Provider 模式判定。
 * 规则（文档 §5.5 / §20.3）：缺少真实 Key 时进入【明确标注的演示模式】，
 * 不得将模拟数据宣称为已接通真实地图/模型服务。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadConfig() {
  const cfgPath = path.join(ROOT, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      console.error('[config] config.json 解析失败，使用默认配置:', e.message);
    }
  }
  const cfg = {
    port: Number(process.env.PORT || fileCfg.port || 8080),
    routePlanningMode: process.env.ROUTE_PLANNING_MODE || fileCfg.routePlanningMode || 'agent',
    amap: {
      jsKey: process.env.AMAP_JS_KEY || (fileCfg.amap && fileCfg.amap.jsKey) || '',
      jsSecurityCode: process.env.AMAP_JS_SECRET || (fileCfg.amap && fileCfg.amap.jsSecurityCode) || '',
      webServiceKey: process.env.AMAP_WS_KEY || (fileCfg.amap && fileCfg.amap.webServiceKey) || '',
    },
    llm: {
      baseUrl: process.env.LLM_BASE_URL || (fileCfg.llm && fileCfg.llm.baseUrl) || '',
      apiKey: process.env.LLM_API_KEY || (fileCfg.llm && fileCfg.llm.apiKey) || '',
      model: process.env.LLM_MODEL || (fileCfg.llm && fileCfg.llm.model) || '',
    },
    // 智能体编排内核（提名→核实→评审→反思修复→解释）开关与参数，见 server/agent_kernel.js DEFAULTS；
    // 环境变量 AGENT_KERNEL=off 可一键关闭（回到纯规则候选 + 单次求解）
    agent: Object.assign({}, fileCfg.agent || {},
      process.env.AGENT_KERNEL ? { enabled: !/^(0|off|false|no)$/i.test(process.env.AGENT_KERNEL) } : {}),
    asr: fileCfg.asr || {},
    tts: fileCfg.tts || {},
    admin: fileCfg.admin || {},
    limits: Object.assign({
      maxPoiCandidates: 24,
      maxRoutingCalls: 110, // 13 候选 + 起点 = 14 节点两两 91 对；候选数由 maxCandidatesForQuota 反推，配额永远抓得满整张矩阵
      maxLlmTokens: 4000,
      maxWallTimeSec: 90,   // 首次构建真实场所矩阵要顺序抓几十对步行路由（全局限速门约 360ms/次），之后走 10 分钟矩阵缓存
    }, fileCfg.limits || {}),
  };
  // Provider 模式判定：Key 齐备才算真实模式，否则演示模式（前端必须标注）
  cfg.providers = {
    map: cfg.amap.webServiceKey ? 'amap' : 'demo',
    llm: (cfg.llm.baseUrl && cfg.llm.apiKey) ? 'http' : 'rules',
    asr: cfg.asr.baseUrl && cfg.asr.apiKey ? 'http' : 'unavailable',
    tts: cfg.tts.baseUrl && cfg.tts.apiKey ? 'http' : 'unavailable',
  };
  cfg.demoMode = cfg.providers.map === 'demo';
  // 未配置高德 Key 时不再是"演示模式"，而是"未配置"：产品不再提供虚构数据作为替代路径
  cfg.setupRequired = cfg.providers.map === 'demo';
  cfg.setupHint = cfg.setupRequired
    ? '未配置高德地图服务：请在 config.json 填写 amap.webServiceKey（服务端）与 amap.jsKey/安全密钥，或设置环境变量 AMAP_WS_KEY / AMAP_JS_KEY / AMAP_JS_SECRET 后重启服务'
    : null;
  return cfg;
}

module.exports = { ROOT, loadConfig };
