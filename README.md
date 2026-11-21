# Magpie Cannbot Provider

将 CANNBOT 网关接入 [Magpie](https://github.com/yetone/magpie)。Provider id：`cannbot`。

## 安装

```sh
magpie plugin add /path/to/magpie-cannbot
magpie plugin login cannbot     # 选“登录 CANNBOT（GitCode，自动续期）”
```

改插件源码后需重启 magpie 应用才会重载模块。

## 登录与续期

登录走 CANNBOT 的 GitCode OAuth：

1. `GET /cannbot/api/oauth/authorize?ideType=codearts` → 授权地址 + state；
2. 浏览器完成 GitCode 登录；
3. `GET /cannbot/api/oauth/sse/connect?state=…` 收到 `accessToken / refreshToken`。

在 magpie 的 Providers 页点登录，或 `magpie plugin login cannbot`。成功后 magpie 保存 `{type:'oauth', access, refresh, expires, accountId}`，并在到期前 5 分钟通过插件的 `auth.refresh` 钩子换票（`refreshLead` + `keepAlive`）。

没有 magpie UI/CLI 的环境用终端版（同一条流程，直接写 magpie 的 auth store）：

```sh
node tools/login.mjs          # 打开浏览器；--no-open 只打印地址
node tools/login.mjs --status # 查看当前账号与过期时间
```

终端版写入 `~/.config/magpie/plugin-auth.json`（0600）的 `cannbot` 条目，重启 magpie 生效。

## 模型

`provider.models` 读取 `cannbot/api/models/personal`：personal 行优先、每模型一行，`context`/`output` 取目录值；声明文本输入、工具调用与推理档位：默认 `minimal/low/medium/high/max/xhigh`，`glm-5.3-flash` 为 `low/high/max`。personal/builtin 缺一个也能解析；401/403 视为登录被拒。

Virtual Key 从认证目录读取，按 JWT 缓存 60 秒。

## 请求

- 只向核验过的 `chat/completions` 发 POST，替换 SDK 鉴权头为 `Authorization: Bearer <JWT>`、`x-api-vkey`、`api-key`；
- HTTPS、不跟随重定向、目录请求 15 秒上限；
- 错误正文脱敏；
- 登录过期在本地直接返回 `401` + `X-Magpie-Sign-In: expired`，上游 401 同样标记。

## 上游协议

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

14 项：端点/凭据校验、目录映射与容错、JWT 过期判定、续期请求、OAuth auth method 的 URL/SSE 回调、OAuth 请求签名与 VK 缓存、上游 401 标记、过期登录的快速 401、非 OAuth 账号拒绝、refresh 钩子。

## 许可

MIT。端点与目录映射部分改编自 dsh-cannbot-connect（MIT，见 NOTICE.md）。
