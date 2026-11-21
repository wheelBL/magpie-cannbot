// CANNBOT provider for magpie: GitCode OAuth sign-in, renewed by magpie,
// with the Virtual Key read from the authenticated catalog. Endpoints and
// catalog mapping adapted from dsh-cannbot-connect, Copyright (c) 2026
// gentle-knight, MIT (see LICENSE).
import { catalogVirtualKey, credential, refreshSignIn, signInError, startAuthorize, tokenState, userInfo, waitForTokens } from './oauth.mjs'

export const ID = 'cannbot'
export const BASE = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1'
export const MODELS = 'https://cannbot.hicann.cn/cannbot/api/models/personal'
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh']
const REFRESH_LEAD = 5 * 60 * 1000
const VK_TTL = 60 * 1000

/** The lapsed sign-in as a 401 the gateway marks the account from. */
export function signInResponse(error) {
  return new Response(
    JSON.stringify({
      error: { message: error?.message ?? String(error), type: 'invalid_request_error', code: 'cannbot_sign_in_expired' },
    }),
    { status: 401, headers: { 'content-type': 'application/json', 'x-magpie-sign-in': 'expired' } },
  )
}

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
  const rows = Object.create(null)
  for (const row of [
    ...(Array.isArray(data.personalModels) ? data.personalModels : []),
    ...(Array.isArray(data.builtinModels) ? data.builtinModels : []),
  ]) {
    if (typeof row?.model !== 'string' || !row.model.trim() || Object.hasOwn(rows, row.model)) continue
    rows[row.model] = modelRow(row, baseURL)
  }
  if (Object.keys(rows).length === 0) throw new Error('CANNBOT 模型目录没有模型')
  return rows
}

function combinedSignal(signal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
}

export function createPlugin({ fetchImpl = globalThis.fetch, baseURL = BASE, modelsURL = MODELS } = {}) {
  baseURL = secureEndpoint(baseURL)
  modelsURL = secureEndpoint(modelsURL)
  const chatURL = `${baseURL}/chat/completions`
  // The catalog is where the Virtual Key comes from; one read a minute is
  // enough and keeps a request from adding a second round trip.
  let vkCache = { jwt: '', vk: '', at: 0 }
  const vkFor = async (jwt) => {
    const now = Date.now()
    if (vkCache.jwt === jwt && vkCache.vk && now - vkCache.at < VK_TTL) return vkCache.vk
    const vk = await catalogVirtualKey(jwt, { fetchImpl })
    vkCache = { jwt, vk, at: now }
    return vk
  }
  const credentialsFor = async (auth) => {
    if (auth?.type !== 'oauth') throw signInError('请先登录 CANNBOT')
    const jwt = credential(auth.access, 'accessToken')
    if (tokenState(jwt) === 'expired') throw signInError('CANNBOT 登录已过期；magpie 会尝试续期，失败请重新登录')
    return { jwt, vk: credential(await vkFor(jwt), 'Virtual Key') }
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
      // magpie renews OAuth sign-ins before they lapse, through this hook.
      refreshLead: REFRESH_LEAD,
      keepAlive: true,
      async refresh(auth) {
        if (typeof auth?.refresh !== 'string' || auth.refresh === '') {
          throw signInError('CANNBOT 登录缺少 refreshToken；请重新登录')
        }
        const tokens = await refreshSignIn(auth.refresh, { fetchImpl })
        return { refresh: tokens.refreshToken, access: tokens.accessToken, expires: tokens.expires }
      },
      methods: [
        {
          type: 'oauth', label: '登录 CANNBOT（GitCode，自动续期）',
          async authorize(_inputs, { signal } = {}) {
            try {
              const { authorizeUrl, state } = await startAuthorize({ fetchImpl })
              const tokens = waitForTokens(state, { fetchImpl, timeoutMs: 10 * 60 * 1000, signal })
              // The user may cancel: the callback reports it, nothing else should.
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
                    // Warm the VK cache; a catalog hiccup must not lose the sign-in.
                    await vkFor(granted.accessToken).catch(() => {})
                    return {
                      type: 'success',
                      key: `cannbot-oauth-${accountId}`,
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
        const { jwt } = await credentialsFor(auth)
        let res
        try { res = await modelsResponse(jwt, signal) } catch {
          if (signal?.aborted) throw new Error('CANNBOT 模型目录请求已取消')
          return provider.models
        }
        if (res.status === 401 || res.status === 403) throw signInError(`CANNBOT 拒绝了登录凭据（HTTP ${res.status}）；请重新登录`)
        if (!res.ok) return provider.models
        let body
        try { body = await res.json() } catch { throw new Error('CANNBOT 模型目录不是有效 JSON') }
        return catalogRows(body, baseURL)
      },
    },
  }
}
