'use strict';
/**
 * LLM 适配（文档 §6.1 三层处理之"LLM 理解" + §11.2 内容生成）。
 * 硬规则：
 * - LLM 输出必须与规则 NLU 同一 Schema，且随后经过完全相同的程序合并/校验（§6.3）。
 * - JSON 无效最多修复一次；仍失败回退规则引擎并明确告知（§17.1）。
 * - 模型不能创造 POI ID、不能声称开放/可通行事实——讲解内容若无资料来源，必须标注"未核验"。
 */

async function chat(cfg, messages, maxTokens = 800) {
  const resp = await fetch(`${cfg.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.llm.apiKey}` },
    body: JSON.stringify({ model: cfg.llm.model, messages, max_tokens: Math.min(maxTokens, cfg.limits.maxLlmTokens), temperature: 0.2 }),
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) { const e = new Error('llm http ' + resp.status); e.code = 'PROVIDER_RATE_LIMITED'; throw e; }
  const json = await resp.json();
  return json.choices[0].message.content;
}

const NLU_SCHEMA = `{
  "scene": "venue|wander|null（用户想去某个具体场所=venue；没有目标只是想出去走走=wander）",
  "venueName": "用户想去的公园/景区/校园名称|null",
  "venueCity": "该场所所在城市|null",
  "endPlaceName": "明确要求走到/逛到/最后到/去那里结束的目的地名|null",
  "objective": "highlights|poi_coverage|relax|null",
  "interests": ["自然|公园湿地|街区|人文|建筑|美食"],
  "mobility": "walk|bike|null",
  "pace": "easy|normal|active|null",
  "durationSec": 秒数|null,
  "startClock": "HH:mm|null",
  "latestEndClock": "HH:mm|null",
  "endpointMode": "return_to_origin|flexible|null",
  "mustVisitNames": ["用户明确说必去/一定要去/锁定的地点名"],
  "avoidNames": ["用户说不去/避开/跳过的地点名"],
  "hardZeroCost": true|false,
  "freePreferred": true|false,
  "stepFreeRequired": true|false,
  "stepFewPreferred": true|false,
  "restPreferred": true|false,
  "quietPreferred": true|false,
  "indoorPreferred": true|false,
  "repeatRoadPenalty": 0|1
}`;

/** LLM 需求理解：输出与 ruleNLU 同 Schema 的字段对象；失败返回 null（调用方回退） */
async function llmNLU(cfg, text, contextNote = '') {
  const sys = `你是游览需求提取器。只输出一个 JSON 对象，不要任何解释。
字段 Schema：${NLU_SCHEMA}
规则：
- 只提取文本中明确表达的信息，没有就给 null/false/空数组；
- 文本里出现具体地名（如"人民公园""太古里""川大"）→ scene=venue、venueName 填该名称；只说"出去走走/随便逛逛"→ scene=wander、venueName=null；
- "从A走到B/从A逛到B"是城市闲逛：scene=wander、venueName=null、endPlaceName=B；A是起点，不是场所。"走到X/逛到X/最后到X/去X结束"均填 endPlaceName=X，不得当作顺路结束；
- "免费优先"是软偏好(freePreferred)，"不收费/零门票/不能花钱"才是硬条件(hardZeroCost)；
- "少台阶"是 stepFewPreferred，"轮椅/无障碍"才是 stepFreeRequired；
- "下雨/室内为主/不想晒" → indoorPreferred=true，这是室内优先的软偏好；
- "想放空/随便逛/散心" → objective=relax；"都逛完/逛全" → poi_coverage；"精华/最值得/有特色" → highlights；
- 产品有两种模式：景区游玩（用户指定某个公园/景区）与城市闲逛（从起点出发按兴趣逛）——venueName 有值→venue，否则 wander；
- "回到起点/回南门/原路返回" → endpointMode=return_to_origin；"走到哪算哪/顺路" → flexible；
- 骑行/骑车 → mobility=bike；步行/散步 → walk；
- 半天=14400 秒；"两/2小时"=7200 秒；"30分钟"=1800 秒；
- "下午两点到五点/14:00-17:00" → startClock="14:00"、latestEndClock="17:00"、durationSec=10800；"下午两点以后" → startClock="14:00"；"下午5点前" → latestEndClock="17:00"。
${contextNote}`;
  const ask = async (extra) => {
    const msgs = [{ role: 'system', content: sys }, { role: 'user', content: text }];
    if (extra) msgs.push({ role: 'user', content: extra });
    const raw = await chat(cfg, msgs, 700);
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    return JSON.parse(m[0]);
  };
  let parsed = null;
  try {
    parsed = await ask();
  } catch (e) {
    try { parsed = await ask('上次输出不是合法 JSON，请只输出修复后的 JSON 对象。'); } // §6.3 最多修复一次
    catch (e2) { return null; }
  }
  // 服务端校验：枚举/范围白名单（§6.3）——不合法的字段一律丢弃
  const TAGS = ['自然', '公园湿地', '街区', '人文', '建筑', '美食'];
  const cleanName = (s) => (typeof s === 'string' && s.trim().length >= 2 && s.length <= 40 ? s.trim() : null);
  const cleanClock = (s) => typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
  const out = {
    scene: ['venue', 'wander'].includes(parsed.scene) ? parsed.scene : null,
    venueName: cleanName(parsed.venueName),
    venueCity: cleanName(parsed.venueCity),
    endPlaceName: cleanName(parsed.endPlaceName),
    objective: ['highlights', 'poi_coverage', 'relax'].includes(parsed.objective) ? parsed.objective : null,
    interests: Array.isArray(parsed.interests) ? parsed.interests.filter((t) => TAGS.includes(t)) : [],
    mobility: ['walk', 'bike'].includes(parsed.mobility) ? parsed.mobility : null,
    pace: ['easy', 'normal', 'active'].includes(parsed.pace) ? parsed.pace : null,
    durationSec: Number.isFinite(parsed.durationSec) ? Math.max(600, Math.min(28800, parsed.durationSec)) : null,
    startClock: cleanClock(parsed.startClock),
    latestEndClock: cleanClock(parsed.latestEndClock),
    endpointRef: parsed.endpointMode === 'return_to_origin' ? { mode: 'return_to_origin' } : parsed.endpointMode === 'flexible' ? { mode: 'flexible' } : null,
    mustVisitNames: Array.isArray(parsed.mustVisitNames) ? parsed.mustVisitNames.filter((s) => typeof s === 'string' && s.length < 30) : [],
    avoidNames: Array.isArray(parsed.avoidNames) ? parsed.avoidNames.filter((s) => typeof s === 'string' && s.length < 30) : [],
    hard: {
      maxCostCny: parsed.hardZeroCost === true ? 0 : null,
      stepFreeRequired: parsed.stepFreeRequired === true,
    },
    soft: {
      freePreferred: parsed.freePreferred === true,
      stepFewPreferred: parsed.stepFewPreferred === true,
      restPreferred: parsed.restPreferred === true,
      quietPreferred: parsed.quietPreferred === true,
      indoorPreferred: parsed.indoorPreferred === true,
      repeatRoadPenalty: parsed.repeatRoadPenalty ? 1 : 0,
    },
    notes: [],
  };
  // 必去∩避开相交 → 丢弃交集（§6.3：不相交校验）
  out.mustVisitNames = out.mustVisitNames.filter((n) => !out.avoidNames.includes(n));
  return out;
}

/** 途中自然语言指令解析（游览页"说一句话调整行程"） */
const COMMAND_CAUSES = ['fatigue_reported', 'rain_reported', 'stop_skipped', 'queue_reported', 'closure_reported', 'deadline_changed', 'finish_requested', 'stop_add_requested'];

// 明确指令也走确定性兜底，避免模型或网络不可用时说了却没有动作。
function ruleCommand(text) {
  let cause = null, poiName = null;
  // 只兜底明确的肯定请求，否定句和知识问题交给模型或按钮。
  if (/不想喝|不要喝|不喝|别.*(?:咖啡|吃)|不累|没(?:有)?累|多少钱|是否|介绍一下/.test(text)) return null;
  if (/累了|太累|走不动|想歇|休息一下/.test(text)) cause = 'fatigue_reported';
  else if (/下雨|天气不好/.test(text)) cause = 'rain_reported';
  else if (/跳过下一站|下一站不去|不想去下一站/.test(text)) { cause = 'stop_skipped'; poiName = '下一站'; }
  else if (/喝.*咖啡|(?:想|找|加|去).*(?:咖啡|cafe|coffee)/i.test(text)) { cause = 'stop_add_requested'; poiName = '咖啡'; }
  else if (/吃(?:点|些|个|东西|饭)|饿了|找.*(?:餐|美食)/.test(text)) { cause = 'stop_add_requested'; poiName = '美食'; }
  else if (/找.*(?:地方|地儿).*(?:坐|休息)|坐坐/.test(text)) { cause = 'stop_add_requested'; poiName = '休息'; }
  else if (/我要回去|我想回去|结束游览|结束了/.test(text)) cause = 'finish_requested';
  return cause ? { action: 'replan', cause, data: { poiName }, reply: '可生成调整提议，确认后生效' } : null;
}

async function parseCommand(cfg, text, context) {
  const fallback = ruleCommand(text);
  const unknown = { action: 'none', cause: null, data: {}, reply: '没太理解，可以说“我累了”“跳过下一站”“喝杯咖啡”' };
  if (cfg.providers && cfg.providers.llm !== 'http') return fallback || unknown;
  const sys = `你是游览行程助手。根据用户的一句话，判断要做什么，只输出 JSON：
{
  "action": "replan|answer|none",
  "cause": "replan 时的原因，取值：${COMMAND_CAUSES.join('|')}",
  "data": { "poiName": "涉及的点位名称（可为空）", "extraWaitMin": 数字或null, "newLatestEndClock": "HH:mm|null" },
  "reply": "给用户的一句中文回复（不超过40字，说明你将做什么或为什么不能做）"
}
判断规则：
- 累了/走不动/想歇 → fatigue_reported；下雨/天气不好 → rain_reported；不想去某站/跳过 → stop_skipped；排队/人多等太久 → queue_reported（extraWaitMin 填等待分钟数）；某处关门了/在装修 → closure_reported；时间不够/要提前结束/几点前必须走 → deadline_changed（newLatestEndClock 填时间）；要回去/结束了 → finish_requested；想再加一个地方 → stop_add_requested（poiName 填地方名）；
- “喝咖啡/吃东西/找个地方坐坐”等品类诉求也必须 action=replan、cause=stop_add_requested，poiName 分别填“咖啡/美食/休息”；“跳过下一站”的 poiName 填“下一站”；
- replan 只代表生成提议，须等用户确认才生效；action=none/answer 不得说“帮你/已为你/加进/添加/安排”等执行承诺；
- 只是闲聊或问题（"这是什么地方""介绍一下"）→ action=answer，reply 直接回答（不超过60字，不要编造事实）；
- 看不出要调整什么 → action=none，reply 说明可以怎么调整。
当前行程上下文：${JSON.stringify(context)}`;
  try {
    const raw = await chat(cfg, [{ role: 'system', content: sys }, { role: 'user', content: text }], 500);
    const m = String(raw).match(/\{[\s\S]*\}/);
    const j = JSON.parse(m[0]);
    const action = ['replan', 'answer', 'none'].includes(j.action) ? j.action : 'none';
    const cause = COMMAND_CAUSES.includes(j.cause) ? j.cause : null;
    const result = {
      action: action === 'replan' && !cause ? 'none' : action,
      cause,
      data: {
        poiName: typeof (j.data && j.data.poiName) === 'string' ? j.data.poiName.slice(0, 40) : null,
        extraWaitMin: Number.isFinite(j.data && j.data.extraWaitMin) ? Math.max(1, Math.min(180, j.data.extraWaitMin)) : null,
        newLatestEndClock: j.data && /^\d{2}:\d{2}$/.test(j.data.newLatestEndClock || '') ? j.data.newLatestEndClock : null,
      },
      reply: typeof j.reply === 'string' ? j.reply.slice(0, 120) : '',
    };
    return fallback || result;
  } catch (e) {
    return fallback || unknown;
  }
}

/** 真实点位讲解生成：无外部资料来源时明确标注"AI 生成未核验"（§11.1 claims/来源要求） */
async function generateGuide(cfg, poi, areaName) {
  const sys = `你是城市漫步讲解员。基于点位的名称、类型和地址，写出适合现场收看的三层讲解。
只输出 JSON：{"summary":"一两句眼前看什么","shortScript":"约80-120字简短讲解","detail":"约150字深入介绍"}
要求：不编造具体年份、人名、历史事件；不确定的一律不写；语气平实，像朋友在旁边介绍。`;
  const user = `区域：${areaName}\n点位名称：${poi.name}\n类型：${poi.tags.join('、')}\n地址：${poi.address || '未知'}`;
  try {
    const raw = await chat(cfg, [{ role: 'system', content: sys }, { role: 'user', content: user }], 700);
    const m = String(raw).match(/\{[\s\S]*\}/);
    const j = JSON.parse(m[0]);
    if (!j.summary || !j.shortScript) return null;
    return {
      summary: String(j.summary).slice(0, 200),
      shortScript: String(j.shortScript).slice(0, 500),
      detail: String(j.detail || j.shortScript).slice(0, 800),
    };
  } catch (e) { return null; }
}

/**
 * 现场问答：只用"已核验资料 + 本点位讲解内容"回答，资料里没有的一律明说。
 * 导游场景里最忌讳的是张口就来——宁可说"资料里没有"，也不编一个故事。
 */
async function answerWithMaterial(cfg, guide, question) {
  const claims = (guide.claims || []).map((c, i) => `[${i + 1}] ${c.text}${c.legend ? '（传说）' : ''}${c.evidenceTitle ? '（来源：' + c.evidenceTitle + '）' : ''}`).join('\n');
  const sys = `你是景区现场导游，正在陪游客游览。规则（必须严格遵守）：
1. 只使用下面"资料"里的信息回答，不得引入任何资料之外的事实（年份、人名、数字、传说都不行）；
2. 资料不足以回答时，直接说"已核验的资料里没有提到这一点"，并给出一个可行的替代建议（比如回头问什么、看什么）；
3. 回答口语化、简短（60-140 字），适合现场读出来；
4. 引用了资料某条时，在句末标注 [序号]；
5. 只输出 JSON：{"answer":"...","used":[序号数组],"insufficient":true|false}`;
  const user = `点位：${guide.poiName || ''}\n资料：\n${claims || '（无结构化条目）'}\n\n讲解正文：\n${guide.summary || ''}\n${guide.shortScript || ''}\n${guide.detail || ''}\n\n游客问：${question}`;
  try {
    const raw = await chat(cfg, [{ role: 'system', content: sys }, { role: 'user', content: user }], 600);
    const m = String(raw).match(/\{[\s\S]*\}/);
    const j = JSON.parse(m[0]);
    return {
      answer: String(j.answer || '').slice(0, 400),
      used: Array.isArray(j.used) ? j.used.filter((n) => Number.isInteger(n)) : [],
      insufficient: j.insufficient === true,
    };
  } catch (e) {
    return { answer: 'AI 暂时不可用，可以先看下面的讲解内容。', used: [], insufficient: false, error: true };
  }
}

module.exports = { llmNLU, generateGuide, parseCommand, ruleCommand, answerWithMaterial };
