# Magpie Cannbot Provider

将 CANNBOT 网关接入 [Magpie](https://github.com/yetone/magpie)。Provider id：`cannbot`。

插件只做两件事：**用 CANNBOT 自己的 GitCode OAuth 登录并让 magpie 续期**，以及把请求正确签给网关。输出钳制/链内切换/上限学习不在这里——那是 [magpie-route-rules](../magpie-route-rules/README.md) 的职责。

## 安装

```sh
magpie plugin add /path/to/magpie-cannbot
magpie plugin login cannbot     # 选“登录 CANNBOT（GitCode，自动续期）”
```

改源码后需重启 magpie 应用才会重载模块。

## 登录（GitCode OAuth）

插件把 CANNBOT 网页面板用的同一套 OAuth 注册成 magpie 的登录方式：

1. `GET /cannbot/api/oauth/authorize?ideType=codearts` → GitCode 授权地址 + state；
2. 浏览器完成 GitCode 登录；
3. `GET /cannbot/api/oauth/sse/connect?state=…` 收到 `accessToken / refreshToken`。

在 magpie 的 Providers 页点登录，或 `magpie plugin login cannbot`。成功后 magpie 保存 `{type:'oauth', access, refresh, expires, accountId}`，并在 `expires` 前 5 分钟通过插件的 `auth.refresh` 钩子自动换票（`keepAlive` 打开）。Virtual Key 从认证目录读取，按 JWT 缓存 60 秒。

没有 magpie UI/CLI 的环境用终端版（同一条流程，直接写 magpie 的 auth store）：

```sh
node tools/login.mjs          # 打开浏览器；--no-open 只打印地址
node tools/login.mjs --status # 查看当前账号与过期时间
```

终端版写入 `~/.config/magpie/plugin-auth.json`（0600）的 `cannbot` 条目，重启 magpie 生效。

## 登录（导入凭据）

`导入 accessToken + Virtual Key` 适合临时环境。accessToken 约 24 小时过期，插件**不能**替你续期（没有 refreshToken）；到期后返回明确错误，需要重新导入。

## 模型

`provider.models` 读取 `cannbot/api/models/personal`：personal 行优先、每模型一行，`context`/`output` 取目录值；声明文本输入、工具调用、六档推理（`minimal/low/medium/high/max/xhigh`）。personal/builtin 缺一个也能解析。401/403 视为登录被拒。

## 能力及限制

- 文本输入/输出、工具调用、推理档位。
- **不做**输出钳制、链内切换、上限学习、跨成员路由：输出上限用 route-rules 的 `limits`/`clamp`（例如 `{"limits":{"cannbot/deepseek-v4.1-flash":4096}}`），跨成员路由用 magpie 路由组。
- 目录请求 15 秒上限；只向核验过的 chat/completions 发 POST，HTTPS，不跟随重定向；错误正文脱敏；上游 401 标 `X-Magpie-Sign-In: expired`。

## 上游机制与协议

| 用途 | 端点 | 鉴权 |
| --- | --- | --- |
| 聊天 | `POST https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions` | `Authorization: Bearer <JWT>`、`x-api-vkey: <VK>`、`api-key: <VK>` |
| 模型目录 | `GET https://cannbot.hicann.cn/cannbot/api/models/personal` | 仅 JWT |
| 授权 | `GET /cannbot/api/oauth/authorize?ideType=codearts` | — |
| 回调 | `GET /cannbot/api/oauth/sse/connect?state=…` | SSE |
| 续期 | `POST /cannbot/api/oauth/refresh` | `{refreshToken, ideType}` |

## 开发与测试

```sh
node --test test/*.test.mjs
```

10 项：端点/凭据校验、目录映射与容错、JWT 过期判定、续期请求、OAuth auth method 的 URL/SSE 回调、OAuth 请求签名与 VK 缓存、上游 401 标记、过期登录的快速 401、导入模式、refresh 钩子。

## 许可

MIT。端点与目录映射部分改编自 dsh-cannbot-connect（MIT，见 NOTICE.md）。
