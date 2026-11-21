# 来源与改编

本项目的 Cannbot 端点、鉴权头、模型目录映射及 HTTPS/禁止重定向策略，依据并改编自：

- [gentle-knight/dsh-cannbot-connect](https://github.com/gentle-knight/dsh-cannbot-connect)
- 原始发布地址：[GitCode](https://gitcode.com/gentle-knight/dsh-cannbot-connect)
- 核验版本：`bfb87745eff5fbaa395d03f7b1e1e88e0d589a79`
- 主要源码：[`lib/index.js`](https://github.com/gentle-knight/dsh-cannbot-connect/blob/bfb87745eff5fbaa395d03f7b1e1e88e0d589a79/lib/index.js)
- 原作者：Copyright (c) 2026 gentle-knight，MIT License。

本项目使用 Magpie/OpenCode provider hooks，独立实现 OAuth 登录、请求签名与透明 fetch，不依赖 DSH 运行时。MIT 授权全文及原版权声明保留在 LICENSE。

接口参考（联网核验）：

- [Magpie provider 所有权与宿主契约](https://github.com/yetone/magpie/blob/main/docs/subsystems/provider-plugins.md)
- [Magpie 插件用户文档](https://usemagpie.ai/docs/plugins)
- [社区 provider 编写规范](https://github.com/magpie-community/plugins#writing-a-package)
- [Agnes Code provider 示例](https://github.com/magpie-community/plugins/blob/main/packages/agnes-code/index.mjs)
- [River provider 示例](https://github.com/magpie-community/plugins/blob/main/packages/river/index.mjs)

上述项目均非 Cannbot 官方 API 承诺。本项目没有修改上游账号状态，也没有从未公开的猜测构造刷新接口。
