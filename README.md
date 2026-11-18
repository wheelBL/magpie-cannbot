# Magpie Cannbot Provider

将 CANNBOT 网关接入 [Magpie](https://github.com/yetone/magpie)，复用 CANNWork 为 OpenCode 维护的本机登录态，或显式导入 **JWT accessToken + Virtual Key**。Provider id：`cannbot`。

这是第三方插件，无运行时 npm 依赖、无安装脚本。安装和模块加载不读取凭据、不联网；用户选择本机登录方式后才会读取相应的 OpenCode 文件。没有安装到用户当前 Magpie 的步骤被自动执行。

0.2.0–0.3.0 曾内置自动路由（规则/性能/图片学习）；**0.4.0 起路由职责外移**——跨成员路由交给 magpie 路由组规则（images/tokens/…，带失败兜底）或 [magpie-route-rules](../magpie-route-rules/README.md) 网关中间件；本插件只保留 provider 本职与 CANNBOT 网关缺陷的防护（输出钳制、实测上限学习、预算切换、有效容量上报）。

## 安装

需要已安装支持 OpenCode provider 插件及 `provider.models` hook 的近期 Magpie（已在 Windows 的 Magpie 0.1.4364 上完成安装、加载与端到端验收）。直接从源码目录安装（原地加载，请将目录放在稳定位置）：

```powershell
magpie plugin add "C:\path\to\magpie-cannbot"
magpie plugin login cannbot
```

**不要把本地 `.tgz` 路径直接传给 Magpie 的 `plugin add`**：CLI 虽返回成功，但宿主把它作为插件文件加载，报 `exports no OpenCode plugin function`。改插件源码后需重启 magpie 应用才重载模块。

## 登录方式一：绑定本机 CANNWork

先在 **运行 Magpie 的同一台机器、同一操作系统用户**下打开 CANNWork 并登录。然后运行 `magpie plugin login cannbot`（或 `magpie plugin login cannbot oauth` 非交互重绑），选择"绑定本机 CANNWork 登录态"。

插件按以下次序查找目录，尊重启动 Magpie 时的 XDG 环境变量：

1. `$XDG_DATA_HOME/opencode`，默认 `~/.local/share/opencode`。
2. `$XDG_CONFIG_HOME/opencode`，默认 `~/.config/opencode`。

JWT：两处 `session.json` 中第一个非空的 `accessToken`。Virtual Key：优先两处 `auth.json` 的 `cannbot.key`；均不存在时接受旧版 `cannbot-cli.refresh`（必须以 `vk-` 开头）。

**每次模型请求和目录请求重新读取文件**，CANNWork 更新 JWT 后下次请求即用新值。Magpie 只保存绑定标记和 VK 指纹；VK 一变（含正常轮换）必须重新绑定。登录态的定时续期由外部脚本负责（见 `~/.config/magpie/cannbot-refresh/`）。

## 登录方式二：导入双凭据

选择"导入 accessToken + Virtual Key"，分别提供 `session.json` 的 accessToken 与 `auth.json` 的 cannbot.key。两值缺一不可，由 Magpie 的插件凭据存储保存。导入模式严格使用当前请求选定的账号，不读本机文件作回退。

## 输出适配（0.4.0，provider 缺陷防护）

CANNBOT 网关广告的输出上限与实际执行的不一致（deepseek-v4.1-flash 广告过 393216/4000、实际执行 ≤4096）。本插件在聊天 loader fetch 里对每个请求：

1. **钳制**：`max_tokens`/`max_completion_tokens` 超过该模型真实上限时收敛（上限 = curated 覆盖值、链成员标注值、目录广告值的最小者；全缺不猜，原样透传）。
2. **链内切换**：请求预算超过主模型可交付量时，沿链选第一个容量足够的成员改写请求体 `model`（保留 reasoning_effort 与其余字段）；无人够用 → 切容量最大成员并收敛。链成员须在最近一次目录中可见。
3. **实测上限学习**：400 写明 `expected a value <= N` → 记录实测上限（压过广告值），方案改变时透明重试一次（绝不重发相同字节）。
4. **有效容量上报**：目录 `limit.output` 替换为可交付预算（自身真实上限与链最大容量的较大者），广告但不可执行的值不流入宿主配置。

切换附加 `x-cannbot-auto-from/-model` 响应头；`magpie usage --csv` 的 served 列显示真实服务模型。

环境变量（启动 magpie 时生效）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CANNBOT_AUTO_MODE` | `switch` | `switch`（钳制+链内切换）/ `clamp`（仅钳制）/ `off`（纯透传） |
| `CANNBOT_AUTO_LIMITS` | `{"deepseek-v4.1-flash":4096}` | JSON：模型（裸 id）→ 真实接受的输出上限 |
| `CANNBOT_AUTO_CHAIN` | `glm-5.3:131072,qwen3.8-max:131072` | 候选链，`model` 或 `model:limit` |
| `CANNBOT_AUTO_REPORT` | `on` | 目录上报有效容量 |

## 上游机制与协议

核验自 [DSH Cannbot 插件源码](https://github.com/gentle-knight/dsh-cannbot-connect/blob/bfb87745eff5fbaa395d03f7b1e1e88e0d589a79/lib/index.js)：

| 用途 | 真实端点 | 鉴权 |
| --- | --- | --- |
| 聊天 | `POST https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions` | `Authorization: Bearer <JWT>`、`x-api-vkey: <VK>`、`api-key: <VK>` |
| 模型目录 | `GET https://cannbot.hicann.cn/cannbot/api/models/personal` | 仅 `Authorization: Bearer <JWT>` |

`auth.loader` 返回自定义 fetch，在请求时替换 SDK 鉴权头；开启适配时请求体（JSON）按上述规则改写，其余情况保留 body；成功响应直接返回原始 Response，不解析或重写 SSE/JSON。只允许向核验端点发 POST；HTTPS 默认；不跟随重定向；错误正文脱敏；取消信号透传；目录请求 15 秒上限。

## 能力及限制

- 声明文本输入/输出、工具调用与推理；提供 `minimal/low/medium/high/max/xhigh` 六档 `reasoningEffort`。
- 不做跨成员路由（图片/长度/性能路由）——那是 magpie 路由组规则或 route-rules 中间件的职责；本层只保证 cannbot 成员的请求不炸、预算不被广告值误导。
- 不实现主动刷新 token、余额查询或自动签到。
- 已通过 22 项 Node 测试（钳制/链切换/学习重试/脱敏/目录上报/透传回退）。

## 离线验证

```powershell
npm test
```

测试使用假 token 与内存文件，不读真实用户目录、不联网。源码与包均无 `preinstall`/`postinstall`。

## 许可与来源

MIT。凭据发现、端点及模型映射机制改编自 gentle-knight 的 [dsh-cannbot-connect](https://github.com/gentle-knight/dsh-cannbot-connect)；原版权及许可保留在 [LICENSE](./LICENSE)，详见 [NOTICE.md](./NOTICE.md)。
