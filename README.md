# Magpie Cannbot Provider

将 CANNBOT 网关接入 [Magpie](https://github.com/yetone/magpie)。Provider id：`cannbot`。

0.8.0 起本插件是一个**独立**的 CANNBOT provider：

- **自带 GitCode OAuth 登录**：既可以在 magpie 里直接 `magpie plugin login cannbot`（插件给出授权地址、SSE 等回调），也可以用 `node tools/login.mjs` 在终端完成。refreshToken 归 magpie，到期前自动续期——**不需要 VS Code 扩展，也不需要外部刷新脚本**。
- **移除了输出钳制 / 链内切换 / 上限学习**——那是 [magpie-route-rules](../magpie-route-rules/README.md) 的职责（`limits` + `clamp`，以及从 `expected a value <= N` 学习 `clampOutput`）。本插件不改写请求体。

## 安装

```sh
magpie plugin add /path/to/magpie-cannbot
magpie plugin login cannbot     # 选“登录 CANNBOT（GitCode，自动续期）”
```

改插件源码后需重启 magpie 应用才会重载模块。

## 登录方式一：GitCode OAuth（推荐）

插件把 CANNBOT 网页面板用的同一套 OAuth 注册成了 magpie 的登录方式：

1. `GET /cannbot/api/oauth/authorize?ideType=codearts` → GitCode 授权地址 + state；
2. 浏览器完成 GitCode 登录；
3. `GET /cannbot/api/oauth/sse/connect?state=…` 收到 `accessToken / refreshToken`。

在 magpie 的 Providers 页点登录，或 `magpie plugin login cannbot` 即可。sign-in 成功后 magpie 保存 `access/refresh/expires`，并在到期前 5 分钟通过插件的 `auth.refresh` 钩子自动换票；插件还会从认证目录读取 Virtual Key 并缓存 60 秒。**不需要 opencode 的 `auth.json`。**

没有 magpie UI/CLI 的环境用终端版（同一条 OAuth 流程，直接写凭据）：

```sh
node tools/login.mjs          # 打开浏览器；--no-open 只打印地址
node tools/login.mjs --status # 查看当前存了什么
```

终端版写入：

- `~/.config/magpie/cannbot-signin.json`：refreshToken（0600），插件续期用；
- `~/.local/share/opencode/session.json`：accessToken（兼容其它工具读取）；
- `~/.config/magpie/plugin-auth.json`：magpie 的 cannbot 账号行（含 Virtual Key）。

写完重启 magpie 生效。

### 登录态怎么续

- **magpie OAuth 账号**：magpie 在 `expires` 前 5 分钟调用 `auth.refresh`，插件用 refreshToken 换新票并交回；请求路径不再自己刷新。
- **终端版/旧的本机绑定**：插件在每次请求前检查 `exp`；5 分钟内到期或已过期时优先用 `cannbot-signin.json` 的 refreshToken，`session.json` 被删也能重建。
- 两者都失败或没有 refreshToken：返回 `401` + `X-Magpie-Sign-In: expired`（毫秒级，magpie 标记账号），错误正文说明要重新登录什么。

> 老版本“从 VS Code 扩展借 token”的读取路径仅作兼容兜底：没有 `cannbot-signin.json` 时才读 VS Code 的 `state.vscdb`，且只在 VS Code 关闭时刷新。正常登录不需要它。

## 登录方式二：绑定本机 CANNWork（兼容）

选择“绑定本机 CANNWork 登录态”时，插件读 opencode 的 `session.json`（JWT）与 `auth.json`（Virtual Key，或用认证目录）。没有 opencode 登录的干净机器请用上面的 OAuth；这条路径保留给已有 CANNWork 环境的用户。

## 登录方式三：导入 accessToken + Virtual Key

适合临时/受限环境。导入的 accessToken 约 24 小时过期，**本插件不会也不能替你续期**（没有 refreshToken）；到期后返回明确错误，需要重新导入。

## 模型

`provider.models` 读取目录 `cannbot/api/models/personal`，personal 行优先、每个模型一行；`context`/`output` 取目录值；声明文本输入、工具调用、六档推理（`minimal/low/medium/high/max/xhigh`）。personal/builtin 两个列表缺一个也能解析。

目录只读一次成功后缓存给宿主；401/403 视为登录被拒并标记账号。

## 能力及限制

- 文本输入/输出、工具调用、推理档位。
- **不做**输出钳制、链内切换、上限学习、跨成员路由：输出上限请用 magpie-route-rules 的 `limits`/`clamp`（例如 `{"limits":{"cannbot/deepseek-v4.1-flash":4096}}`），跨成员路由用 magpie 路由组。
- 目录请求 15 秒上限；只向核验过的 chat/completions 发 POST，HTTPS，不跟随重定向，错误正文脱敏。

## 上游机制与协议

| 用途 | 真实端点 | 鉴权 |
| --- | --- | --- |
| 聊天 | `POST https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions` | `Authorization: Bearer <JWT>`、`x-api-vkey: <VK>`、`api-key: <VK>` |
| 模型目录 | `GET https://cannbot.hicann.cn/cannbot/api/models/personal` | 仅 `Authorization: Bearer <JWT>` |
| 授权 | `GET /cannbot/api/oauth/authorize?ideType=codearts` | — |
| 登录回调 | `GET /cannbot/api/oauth/sse/connect?state=…` | SSE |
| 续期 | `POST https://cannbot.hicann.cn/cannbot/api/oauth/refresh` | `{refreshToken, ideType}` |

## 开发与测试

```sh
node --test test/*.test.mjs
```

21 项测试：端点/凭据校验、目录映射与容错、JWT 过期判定、自持 refreshToken 的写入/优先级/原子写、`session.json` 重建、VS Code 打开时不耗 token、导入模式过期拒绝、loader 凭据改写与快速 401、上游 401 标记、models 目录与拒绝、OAuth 授权解析、SSE 心跳/分片/错误事件、OAuth auth method 的回调、账号行 VK、目录 VK 缓存、干净机器上的本机登录。

## 许可

MIT。凭据发现、端点与目录映射部分改编自 dsh-cannbot-connect（MIT，见 NOTICE.md）。
