修复自然语言时间窗与终点未落实、途中指令回复和实际动作不一致、重排从旧起点出发，以及移动端路线展示问题。所有调整仍通过提议确认生效。

基线：GitHub 的 commits API 查询 `8d887ae` 返回 422（No commit found），因此按任务回退要求，从 `deploy/agent-route-optimization-20261017` 的 `d3c8dfeb55332901fc6fe3d206bb75e5ef2559aa` 创建 `gpt/live-test-nlu-ui`。该基线提交说明标注“合并 8d887ae”。

**改动和验收**

| 任务 | 现状 → 改法 | 验收证据 |
| --- | --- | --- |
| T1 | 时间窗丢失开始时刻 → 规则和 LLM Schema 保留 `startClock`，显式表单优先；已过开始时刻按现在计算并保留截止；短时长与截止取紧 | `nlu-cases.js` 的 15 条 T1 用例通过；固定 10/18 09:00 的时钟，确认条包含 `10/18 14:00 出发`、`3 小时`；模型 HTTP 桩也覆盖 |
| T2 | A→B 被当作场所/顺路结束 → 提取 `endPlaceName`，A→B 识别为 wander；按起点城市/venueCity 搜索并选 15 km 内最近坐标，失败进入 unresolved | 8 条 T2 用例通过；断言 endpoint.mode=fixed、确认条“终点：宽窄巷子”、显式表单终点优先和搜索失败追问 |
| T3 | 室内偏好丢失，重复路段文案过强 → 写入 indoorPreferred，确认条按 strictNoRepeat / repeatRoadPenalty 显示 | 7 条 T3 用例通过；下雨/室内为主/不想晒、LLM 字段和三种确认条组合均覆盖 |
| T4 | 品类诉求只承诺、不产生动作 → 规则兜底和模型提示补齐品类；用 resolvePackGraph 的真实候选解析并选下一站附近点位；无可执行动作时清除执行承诺 | 7 条 T4 用例通过；咖啡=replan/stop_add_requested/真实poiId，累了=replan/fatigue_reported/null，跳过下一站=replan/stop_skipped/下一站poiId；模型误回none、无候选、否定句也覆盖 |
| T5 | 缺当前位置就退回旧起点 → 按最后 arrive_confirm 恢复入口节点，支持同计划历史版本和弱网旧事件；无法映射时要求确认位置 | `live-api-cases.js` 的 5 条 T5 用例通过；完整 HTTP 流程断言重排 payload.currentNodeId 为到访点入口 |
| T6 | 反向复用路段缺 steps → 新增 GET /v1/legs/steps；50 m 网格、方向隔离、30 分钟缓存；按用户 60 次/分钟限流，沿用 walkingRoute 全局限速门 | 2 条 API 用例覆盖缓存、反向、过期、失败和限流；浏览器补取成功/失败均只请求 1 次；另选道路偏离原路径时保留几何导引 |
| T7 | 浮条留白不足、近邻编号与终点互盖 → 监听浮条实际高度，合并近邻编号与末站/终点，SVG 标记固定像素大小，仅当前站显示名称 | SVG 和 AMap 桩渲染断言通过；390×844 截图 4 组前后对照；浮条高 105px，内容 padding-bottom 从 90px 变为 122px；最后内容底边在浮条上方 |
| T8 | 重复规划并发、排队无反馈 → API 层复用同用户同类活跃规划任务；异类并发明确返回 409 防止订阅错结果；SSE/轮询返回 queuePosition/phase | 3 条 API 用例通过；浏览器 SSE 和轮询、展开与收起状态均显示“前面还有 2 个任务 · 正在检索候选” |

**文件和函数**

| 文件 | 函数/范围 |
| --- | --- |
| `server/domain.js` | ruleNLU、resolveTimes、normalizeIntent、confirmChips |
| `server/llm.js` | NLU_SCHEMA、llmNLU、parseCommand；新增 ruleCommand |
| `server/api.js` | normalizeIntentApi、aiCommand、replanTrip、createPlan、editPlan、getJob、jobEvents；新增 legSteps、activePlanningJob、reusePlanningJob、jobProgress |
| `web/js/home.js`、`app.js` | 显式时间选择标志与 buildIntentPayload，保留已有草稿时长 |
| `web/js/plan.js`、`api.js` | 动态底部留白、SSE/轮询进度显示 |
| `web/js/routeview.js`、`ui.js` | stopMarkerGroups、renderSvgRoute、AmapRouteMap.renderRoute、SvgMap.pin |
| `web/js/trip.js` | 当前段缺失 steps 的单次补取、失败回退与切页清理 |
| `web/css/app.css` | 规划页按浮条实际高度留白 |
| `scripts/*` | NLU/API/地图回归、隔离演示 HTTP 服务与流程、Playwright 截图和浏览器验收、证据文件 |

**验收命令**

在 `webos/` 运行，全部通过：

```sh
npm test
npm run test:planner-constraints
npm run test:planner-ordering
npm run test:planner-endpoint
node scripts/nlu-cases.js
node scripts/live-api-cases.js
node scripts/route-ui-cases.js
node scripts/live-demo-flow.js
```

主验收 24 项、NLU 37 条、API 10 条全部通过。演示场所真实规划 7 站，完成“规划 → 开始 → 到达 → 我累了 → 接受提议 → 结束”；所有 HTTP 请求均为 2xx，逐次记录在 `scripts/evidence/demo-flow-report.json`（轮询次数随运行耗时变化）。提前结束按原契约记为 ended_early，没有伪装成全部站点已逛完。

浏览器两组验收均为 0 console/pageerror、0 HTTP 失败；保留原配色，并验证本段/全程切换与定位按钮点击。结构化结果在 `scripts/evidence/browser-report.json`、`browser-extra-report.json`。

**390×844 前后对照**

“修复前”只使用 `d3c8dfe` 的前端资源；服务端与“修复后”共用隔离的演示数据。条件性方案由原求解器真实生成。重叠和终点图使用明确的展示夹具，在路线副本中制造同坐标输入，仅验证绘制行为，不作为真实规划效果证明。

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 规划页底部 | ![修复前规划页底部](https://github.com/Times-spec/TravelAssistant/blob/gpt/live-test-nlu-ui/webos/scripts/evidence/before-plan-bottom.png?raw=true) | ![修复后规划页底部](https://github.com/Times-spec/TravelAssistant/blob/gpt/live-test-nlu-ui/webos/scripts/evidence/after-plan-bottom.png?raw=true) |
| 地图重叠编号 | ![修复前编号重叠](https://github.com/Times-spec/TravelAssistant/blob/gpt/live-test-nlu-ui/webos/scripts/evidence/before-map-overlap.png?raw=true) | ![修复后合并编号](https://github.com/Times-spec/TravelAssistant/blob/gpt/live-test-nlu-ui/webos/scripts/evidence/after-map-overlap.png?raw=true) |
| 末站与终点重合 | ![修复前终点被遮挡](https://github.com/Times-spec/TravelAssistant/blob/gpt/live-test-nlu-ui/webos/scripts/evidence/before-last-endpoint.png?raw=true) | ![修复后合并末站终点](https://github.com/Times-spec/TravelAssistant/blob/gpt/live-test-nlu-ui/webos/scripts/evidence/after-last-endpoint.png?raw=true) |
| 游览页 | ![修复前游览页](https://github.com/Times-spec/TravelAssistant/blob/gpt/live-test-nlu-ui/webos/scripts/evidence/before-trip.png?raw=true) | ![修复后游览页](https://github.com/Times-spec/TravelAssistant/blob/gpt/live-test-nlu-ui/webos/scripts/evidence/after-trip.png?raw=true) |

**已知限制**

- LLM、高德 HTTP 和 AMap 覆盖物使用确定性桩验证；没有用真实 Key 调用线上供应商。手机截图使用原演示 SVG 底图，定位点击使用浏览器模拟坐标。
- 时间窗目前解释为规划起点时区的当日钟点，支持跨午夜；没有新增“明天/下周”等日期 NLU。已结束的当日时间窗报明确错误。
- 咖啡候选按任务要求允许回退到“美食”标签，回复展示实际候选名称；具体商品、营业时间、门票和讲解资料的核验状态沿用原数据。
- 导航补取若与既有路线偏离超过 50m，保留原折线的几何导引，不用另一条道路的步骤替换既有路线。
- queuePosition 是排在当前条目前的 queued/running 任务数量；worker 调度仍使用现有机制，不提供等待时长预测。

**与 fix/live-test-p0 的潜在冲突 / 待协调**

文件交叉为空：`server/amap.js`、`live_venue.js`、`planner.js`、`jobs.js` 与基线完全一致，没有新增导出或修改原函数。只使用已有 walkingRoute/textSearch/amapGet/resolvePackGraph 接口，以及规划端已读取的 indoorPreferred 字段。

远端核对时尚未出现 `fix/live-test-p0`，因此此处“为空”是按已约定文件分工与当前 diff 核实，没有声称做过该分支的试合并。待协调无阻塞项。没有新增 npm 依赖，没有修改 config.json/.env/CI/CD，没有提交 Key。
