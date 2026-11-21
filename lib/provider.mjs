// CANNBOT provider for magpie: credential discovery, gateway endpoints and
// catalog mapping adapted from dsh-cannbot-connect, Copyright (c) 2026
// gentle-knight, MIT (see LICENSE).
//
// 0.8.0 is a provider of its own:
//
//   * it signs in through CANNBOT's GitCode OAuth itself (authorize URL + SSE
//     callback), so magpie owns the refresh token and renews it (auth.refresh);
//   * the legacy local sign-in and imported JWT + Virtual Key stay available;
//   * output clamping / chain switching are NOT here: they belong to
//     magpie-route-rules (limits/clamp, learned clampOutput).
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  ensureAccessToken,
  refreshSignIn,
  signInError,
  signInResponse,
  tokenState,
} from './signin.mjs'
import { catalogVirtualKey, startAuthorize, userInfo, waitForTokens } from './oauth.mjs'

export const ID = 'cannbot'
export const BASE = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1'
export const MODELS = 'https://cannbot.hicann.cn/cannbot/api/models/personal'
export const LOCAL = 'cannbot-local-session'
const OAUTH_KEY = 'cannbot-oauth'
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh']
const REFRESH_LEAD = 5 * 60 * 1000
const VK_TTL = 60 * 1000
const authError = signInError
const fingerprint = (value) => createHash('sha256').update(value).digest('hex')

export function secureEndpoint(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error('CANNBOT 端点不是有效 URL') }
  if (url.username || url.password || url.search || url.hash) throw new Error('CANNBOT 端点不能含用户信息、查询或片段')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('CANNBOT 端点必须使用 HTTPS（仅回环地址允许 HTTP）')
  }
  return url.href.replace(/\/+$/, '')
}

export function credential(value, label) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) {
    throw authError(`CANNBOT ${label} 缺失或格式无效；请重新登录或导入凭据`)
  }
  return value
}

/** The Virtual Key from opencode's auth.json, with the legacy fallback. */
export async function readVirtualKey({ env = process.env, home = homedir(), read = readFile } = {}) {
  const roots = [
    join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode'),
    join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'),
  ]
  const auths = await Promise.all(roots.map(async (root) => {
    try { return JSON.parse(await read(join(root, 'auth.json'), 'utf8')) } catch { return undefined }
  }))
  let vk = auths.find((a) => typeof a?.cannbot?.key === 'string' && a.cannbot.key)?.cannbot.key
  vk ??= auths.find((a) => typeof a?.['cannbot-cli']?.refresh === 'string' && a['cannbot-cli'].refresh.startsWith('vk-'))?.['cannbot-cli'].refresh
  return credential(vk, 'Virtual Key')
}

/**
 * Resolve an api-mode sign-in: the legacy local binding (a marker key plus an
 * opencode sign-in) or an imported accessToken + Virtual Key.
 *
 * vkFor reads the Virtual Key from the authenticated catalog, used when the
 * account row carries none and opencode's auth.json is absent.
 */
export async function resolveCredentials(auth, localOptions, vkFor = (jwt) => catalogVirtualKey(jwt), fetchImpl) {
  if (auth?.type !== 'api') throw authError('请先登录 CANNBOT')
  if (auth.key === LOCAL && auth.metadata?.method === 'local') {
    const jwt = credential(await ensureAccessToken({ options: localOptions, fetchImpl }), 'accessToken')
    // The login tool stores the key on the account row. An older binding keeps
    // it in auth.json, and a clean machine reads it from the catalog. The
    // fingerprint only guards the legacy binding, where a swapped account
    // would otherwise go unnoticed; with a row-carried key there is nothing
    // to pin, and a VK rotation is not a reason to sign in again.
    let vk = typeof auth.metadata?.vk === 'string' && auth.metadata.vk ? auth.metadata.vk : undefined
    if (vk === undefined) {
      try {
        vk = await readVirtualKey(localOptions)
      } catch {
        vk = await vkFor(jwt)
      }
      if (auth.metadata?.vkFingerprint && fingerprint(vk) !== auth.metadata.vkFingerprint) {
        throw authError('CANNWork 的账号或 Virtual Key 已改变；请重新登录本机登录态')
      }
    }
    return { jwt, vk: credential(vk, 'Virtual Key') }
  }
  if (auth.metadata?.method !== 'paste') throw authError('CANNBOT 需要同时导入 accessToken 和 Virtual Key')
  const jwt = credential(auth.metadata.accessToken, 'accessToken')
  if (tokenState(jwt) === 'expired') {
    throw authError('导入的 accessToken 已过期；请重新导入，或改用 OAuth 登录')
  }
  return { jwt, vk: credential(auth.key, 'Virtual Key') }
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
export function modelRow(row, baseURL = BASE) {
  return {
    id: row.model,
    name: typeof row.title === 'string' && row.title ? row.title : row.model,
    api: { id: row.model, url: baseURL, npm: '@ai-sdk/openai-compatible' },
    limit: { context: positive(row.contextLength, 1048576), output: positive(row.completionOptions?.maxTokens, 131072) },
    reasoning: true,
    tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
    capabilities: {
      reasoning: true, toolcall: true, attachment: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true },
    },
    variants: Object.fromEntries(EFFORTS.map((e) => [e, { reasoningEffort: e }])),
  }
}
export function catalogRows(body, baseURL = BASE) {
  const data = body?.data
  if (body?.success !== true || !data || typeof data !== 'object') {
    throw new Error('CANNBOT 模型目录格式无效')
  }
  // Either list may be absent (a personal-only or builtin-only account).
  const personal = Array.isArray(data.personalModels) ? data.personalModels : []
  const builtin = Array.isArray(data.builtinModels) ? data.builtinModels : []
  const rows = Object.create(null)
  for (const row of [...personal, ...builtin]) {
    if (typeof row?.model !== 'string' || !row.model.trim() || Object.hasOwn(rows, row.model)) continue
    rows[row.model] = modelRow(row, baseURL)
  }
  if (Object.keys(rows).length === 0) throw new Error('CANNBOT 模型目录没有模型')
  return rows
}

function combinedSignal(signal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
}

export function createPlugin({ fetchImpl = globalThis.fetch, localOptions, baseURL = BASE, modelsURL = MODELS, readAuth: readAuthImpl } = {}) {
  baseURL = secureEndpoint(baseURL)
  modelsURL = secureEndpoint(modelsURL)
  const chatURL = `${baseURL}/chat/completions`
  // The catalog is the only place the Virtual Key comes from once OAuth owns
  // the sign-in; one read a minute is enough and keeps a request from adding
  // a second round trip.
  let vkCache = { jwt: '', vk: '', at: 0 }
  const vkFor = async (jwt) => {
    const now = Date.now()
    if (vkCache.jwt === jwt && vkCache.vk && now - vkCache.at < VK_TTL) return vkCache.vk
    const vk = await catalogVirtualKey(jwt, { fetchImpl })
    vkCache = { jwt, vk, at: now }
    return vk
  }
  const credentialsFor = async (auth) => {
    if (auth?.type === 'oauth') {
      const jwt = credential(auth.access, 'accessToken')
      return { jwt, vk: credential(await vkFor(jwt), 'Virtual Key') }
    }
    return (readAuthImpl ?? ((value) => resolveCredentials(value, localOptions, vkFor, fetchImpl)))(auth)
  }
  const modelsResponse = (jwt, signal) => fetchImpl(modelsURL, {
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/json' },
    redirect: 'error', signal: combinedSignal(signal),
  })
  return {
    async config(config) {
      config.provider ??= {}
      config.provider[ID] ??= {
        name: 'CANNBOT', npm: '@ai-sdk/openai-compatible', api: baseURL,
        // A known upstream bootstrap, not a promise of account access.
        models: { 'deepseek-v4.1-flash': modelRow({ model: 'deepseek-v4.1-flash' }, baseURL) },
      }
    },
    auth: {
      provider: ID,
      // OAuth sign-ins are renewed by magpie before they lapse, through the
      // refresh hook below; nothing else has to run.
      refreshLead: REFRESH_LEAD,
      keepAlive: true,
      async refresh(auth) {
        const token = typeof auth?.refresh === 'string' ? auth.refresh : ''
        if (!token) throw signInError('CANNBOT 登录缺少 refreshToken；请重新登录')
        const tokens = await refreshSignIn(token, { fetchImpl })
        return {
          refresh: tokens.refreshToken,
          access: tokens.accessToken,
          expires: tokens.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
        }
      },
      methods: [
        {
          type: 'oauth', label: '登录 CANNBOT（GitCode，自动续期）',
          async authorize() {
            try {
              const { authorizeUrl, state } = await startAuthorize({ fetchImpl })
              const tokens = waitForTokens(state, { fetchImpl, timeoutMs: 10 * 60 * 1000 })
              // The user may never finish (or cancel): that rejection is the
              // callback's to report, not an unhandled one here.
              tokens.catch(() => {})
              return {
                url: authorizeUrl,
                method: 'auto',
                instructions: '在浏览器完成 GitCode 登录后，回到 magpie 完成登录。',
                callback: async () => {
                  try {
                    const granted = await tokens
                    const account = await userInfo(granted.accessToken, { fetchImpl }).catch(() => ({}))
                    const accountId = account?.username ?? account?.login ?? account?.email ?? 'cannbot'
                    // Warm the VK cache; a catalog hiccup must not lose the
                    // sign-in, the first request reads it again.
                    await vkFor(granted.accessToken).catch(() => {})
                    return {
                      type: 'success',
                      key: OAUTH_KEY,
                      access: granted.accessToken,
                      refresh: granted.refreshToken,
                      expires: Date.now() + granted.expiresIn * 1000,
                      accountId,
                    }
                  } catch (error) {
                    return { type: 'failed', error: error?.message ?? String(error) }
                  }
                },
              }
            } catch (error) {
              return { type: 'failed', error: error?.message ?? String(error) }
            }
          },
        },
        {
          type: 'oauth', label: '绑定本机 CANNWork 登录态（兼容旧方式）',
          async authorize() {
            try {
              // A clean machine has no opencode auth.json: the JWT comes from
              // magpie's own store, and the Virtual Key from the catalog.
              const jwt = credential(await ensureAccessToken({ fetchImpl, options: localOptions }), 'accessToken')
              let vk
              try {
                vk = await readVirtualKey(localOptions)
              } catch {
                vk = await vkFor(jwt)
              }
              const pin = fingerprint(vk)
              return {
                url: '', method: 'auto',
                instructions: '已找到本机登录态；JWT 到期前本插件会自动续期。',
                callback: async () => ({
                  type: 'success', key: LOCAL, accountId: `CANNWork 本机 ${pin.slice(0, 8)}`,
                  metadata: { method: 'local', vk, vkFingerprint: pin },
                }),
              }
            } catch (error) {
              return { type: 'failed', error: error?.message ?? String(error) }
            }
          },
        },
        {
          type: 'api', label: '导入 accessToken + Virtual Key',
          prompts: [
            { type: 'password', key: 'accessToken', message: 'CANNWork session.json 的 accessToken' },
            { type: 'password', key: 'virtualKey', message: 'CANNBOT auth.json 的 cannbot.key（Virtual Key）' },
          ],
          async authorize(inputs) {
            try {
              const jwt = credential(inputs?.accessToken?.trim(), 'accessToken')
              const vk = credential(inputs?.virtualKey?.trim(), 'Virtual Key')
              return { type: 'success', key: vk, accountId: `导入 ${fingerprint(vk).slice(0, 8)}`, metadata: { method: 'paste', accessToken: jwt } }
            } catch (error) { return { type: 'failed', error: error.message } }
          },
        },
      ],
      async loader(getAuth) {
        return {
          baseURL, apiKey: 'cannbot-managed-by-plugin',
          async fetch(input, init) {
            const req = new Request(input, { ...init, duplex: 'half' })
            if (req.url !== chatURL || req.method !== 'POST') throw new Error('CANNBOT 只允许向已核验的 chat/completions 端点发送请求')
            let creds
            try {
              creds = await credentialsFor(await getAuth())
            } catch (error) {
              // A lapsed sign-in is the vendor turning the request away: answer
              // it as the vendor would, marked so magpie marks the account,
              // rather than throwing — a thrown fetch is a 502 magpie retries
              // for half a minute.
              if (error?.signIn === 'expired') return signInResponse(error)
              throw error
            }
            const { jwt, vk } = creds
            const headers = new Headers(req.headers)
            // Replace caller/SDK credentials and remove credentials for other protocols.
            for (const name of ['authorization', 'api-key', 'x-api-vkey', 'x-api-key', 'cookie', 'proxy-authorization']) headers.delete(name)
            headers.set('authorization', `Bearer ${jwt}`)
            headers.set('x-api-vkey', vk)
            headers.set('api-key', vk)
            const res = await fetchImpl(chatURL, {
              method: 'POST', headers, body: req.body,
              signal: req.signal, redirect: 'error',
            })
            if (res.status < 400) return res
            // Never include provider-echoed secrets in an error returned to clients.
            let text = await res.text().catch(() => '')
            for (const secret of [jwt, vk]) text = text.split(secret).join('[redacted]')
            const outHeaders = new Headers(res.headers)
            outHeaders.delete('content-length')
            outHeaders.delete('content-encoding')
            // A 401 is the vendor refusing this sign-in, whatever its exp said:
            // mark it so magpie asks for a sign-in instead of a bare error.
            if (res.status === 401) outHeaders.set('x-magpie-sign-in', 'expired')
            return new Response(text, { status: res.status, statusText: res.statusText, headers: outHeaders })
          },
        }
      },
    },
    provider: {
      id: ID,
      async models(provider, { auth, signal } = {}) {
        if (!auth) return provider.models
        if (auth.type === 'oauth' && tokenState(auth.access) === 'expired') {
          throw signInError('CANNBOT 登录已过期；magpie 会尝试续期，失败请重新登录')
        }
        const { jwt } = await credentialsFor(auth)
        let res
        try { res = await modelsResponse(jwt, signal) } catch {
          if (signal?.aborted) throw new Error('CANNBOT 模型目录请求已取消')
          return provider.models
        }
        if (res.status === 401 || res.status === 403) throw authError(`CANNBOT 拒绝了登录凭据（HTTP ${res.status}）；请重新登录或导入凭据`)
        if (!res.ok) return provider.models
        let body
        try { body = await res.json() } catch { throw new Error('CANNBOT 模型目录不是有效 JSON') }
        return catalogRows(body, baseURL)
      },
    },
  }
}

// Kept for callers that imported them from here before 0.8.0.
export { ensureAccessToken, signInError, signInResponse, tokenState }
