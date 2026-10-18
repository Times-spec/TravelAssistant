本目录保存 2026-10-18 线上实测修复的移动端验收证据。PNG 均为 Playwright 在 390×844 视口的截图。`before-*` 使用 d3c8dfe 的前端资源，`after-*` 使用本分支资源；截图场所为明确标注的演示场所。

- `*-plan-bottom.png`：求解器实际生成的条件性方案，底部操作条与内容留白。
- `*-map-overlap.png`、`*-last-endpoint.png`：隔离的展示夹具，仅对路线副本制造同坐标输入，以验证编号合并。不是高德真实地点或实际规划质量的证明。
- `*-trip.png`：真实演示规划路线的游览页，验证配色、本段/全程切换和定位按钮保留。
- `browser-report.json`：截图流程、底部边界测量和控制台/HTTP 错误计数。
- `browser-extra-report.json`：缺失 steps 的成功/失败单次补取、定位点击，以及 SSE/轮询排队文案。供应商结果与排队由 Playwright 拦截提供，定位使用模拟坐标。
- `demo-flow-report.json`：无 Key 的完整 HTTP 流程逐次请求与状态；不记录会话凭证。

复现 API/规则/渲染验收不需额外依赖：

```sh
node scripts/nlu-cases.js
node scripts/live-api-cases.js
node scripts/route-ui-cases.js
node scripts/live-demo-flow.js
node scripts/live-demo-flow.js --record
```

复现浏览器截图（在 webos/，Playwright CLI 只用 npx 临时调用）：

```sh
node scripts/live-browser-fixtures.js
```

服务就绪后，在另一个终端运行：

```sh
npx --yes --package @playwright/cli playwright-cli -s=travel-live open http://127.0.0.1:8191
npx --yes --package @playwright/cli playwright-cli -s=travel-live resize 390 844
npx --yes --package @playwright/cli playwright-cli -s=travel-live run-code --filename scripts/live-browser-bootstrap.js
npx --yes --package @playwright/cli playwright-cli -s=travel-live snapshot
npx --yes --package @playwright/cli playwright-cli -s=travel-live run-code --filename scripts/live-browser-capture.js
npx --yes --package @playwright/cli playwright-cli -s=travel-live run-code --filename scripts/live-browser-extra.js
```

测试服务仅绑定 127.0.0.1，使用独立内存 Store，不读取 config.json，不生成管理令牌。完整 HTTP 流程提前结束的状态为原契约的 ended_early，不能据此声称所有站点均已到访。
