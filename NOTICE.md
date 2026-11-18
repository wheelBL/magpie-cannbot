# 来源与改编

本项目的 Cannbot 端点、凭据目录查找、旧版 VK 回退规则、模型目录映射及 HTTPS/禁止重定向策略，依据并改编自：

- [gentle-knight/dsh-cannbot-connect](https://github.com/gentle-knight/dsh-cannbot-connect)
- 原始发布地址：[GitCode](https://gitcode.com/gentle-knight/dsh-cannbot-connect)
- 核验版本：`bfb87745eff5fbaa395d03f7b1e1e88e0d589a79`
- 主要源码：[`lib/index.js`](https://github.com/gentle-knight/dsh-cannbot-connect/blob/bfb87745eff5fbaa395d03f7b1e1e88e0d589a79/lib/index.js)
- 原作者：Copyright (c) 2026 gentle-knight，MIT License。

本项目使用 Magpie/OpenCode provider hooks，独立实现鉴权适配、账号绑定、动态模型 hook 与透明 fetch，不依赖 DSH 运行时。MIT 授权全文及原版权声明保留在 LICENSE。

接口参考（联网核验）：

- [Magpie provider 所有权与宿主契约](https://github.com/yetone/magpie/blob/main/docs/subsystems/provider-plugins.md)
- [Magpie 插件用户文档](https://usemagpie.ai/docs/plugins)
- [社区 provider 编写规范](https://github.com/magpie-community/plugins#writing-a-package)
- [Agnes Code provider 示例](https://github.com/magpie-community/plugins/blob/main/packages/agnes-code/index.mjs)
- [River provider 示例](https://github.com/magpie-community/plugins/blob/main/packages/river/index.mjs)

上述项目均非 Cannbot 官方 API 承诺。本项目没有修改上游账号状态，也没有从未公开的猜测构造刷新接口。

## 0.2.0 追加

- lib/auto.mjs（自动输出适配：钳制、切换链、有效容量上报）及 lib/provider.mjs 中对应的 loader fetch 请求体改写与目录上报逻辑，为本项目原创扩展，不改编自上游。

## 0.3.0 追加

- lib/auto.mjs 扩展：逐请求感知路由（images/input/output 规则、实测吞吐率与时延的性能路由带迟滞）、图片能力学习（406 负学习/带图成功正学习，TTL 6h）、统计持久化；lib/provider.mjs 对应的 tee 旁路观察与 406/400 学习重试，均为本项目原创扩展。

## 0.4.0 变更

- 按用户决策拆分：路由规则/性能路由/图片学习移出本插件，独立为 magpie-route-rules 网关中间件；本插件回归 provider 本职 + CANNBOT 网关缺陷防护（钳制、实测上限学习、链内预算切换、有效容量上报）。
