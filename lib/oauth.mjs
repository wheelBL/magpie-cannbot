// CANNBOT's OAuth sign-in.
//
// The flow is the one the CANNBOT web panel uses:
//
//   1. GET  /cannbot/api/oauth/authorize?ideType=codearts
//      → { authorizeUrl, state }   (GitCode OAuth with PKCE, handled upstream)
//   2. the user opens authorizeUrl and signs in at GitCode
//   3. GET  /cannbot/api/oauth/sse/connect?state=<state>
//      → text/event-stream; `event: success` carries
//        { accessToken, refreshToken, expiresIn }
//
// ideType=codearts selects the web callback path (tokens published on the SSE
// channel); ideType=vscode redirects to a vscode:// URI only an extension can
// receive.
export const APP = 'https://cannbot.hicann.cn/cannbot'
export const AUTHORIZE = `${APP}/api/oauth/authorize`
export const SSE = `${APP}/api/oauth/sse/connect`
export const MODELS_URL = 'https://cannbot.hicann.cn/cannbot/api/models/personal'
export const REFRESH_URL = `${APP}/api/oauth/refresh`

/** An error that tells magpie the account needs a new sign-in. */
export const signInError = (message) => Object.assign(new Error(message), { signIn: 'expired' })

/** A header-safe credential. */
export function credential(value, label) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) {
    throw signInError(`CANNBOT ${label} 缺失或格式无效；请重新登录`)
  }
  return value
}

/** A JWT's claims and expiry; undefined when the string isn't a JWT. */
export function jwtClaims(jwt) {
  const part = typeof jwt === 'string' ? jwt.split('.')[1] : undefined
  if (part === undefined) return undefined
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

export function jwtExpiry(jwt) {
  const claims = jwtClaims(jwt)
  return typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined
}

/** 'valid' | 'expiring' (inside five minutes) | 'expired' | 'unknown'. */
export function tokenState(jwt, now = Date.now()) {
  const exp = jwtExpiry(jwt)
  if (exp === undefined) return 'unknown'
  if (exp <= now) return 'expired'
  return exp - now <= 5 * 60_000 ? 'expiring' : 'valid'
}

/** Trade a refresh token for a fresh access token. */
export async function refreshSignIn(refreshToken, { fetchImpl = fetch, ideType = 'codearts' } = {}) {
  const res = await fetchImpl(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, ideType }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const message = `CANNBOT 续期接口返回 HTTP ${res.status}`
    throw [400, 401, 403].includes(res.status) ? signInError(message) : new Error(message)
  }
  let body
  try { body = await res.json() } catch { throw new Error('CANNBOT 续期接口返回的不是 JSON') }
  const data = body?.data ?? body
  if (typeof data?.accessToken !== 'string' || data.accessToken === '') {
    throw new Error('CANNBOT 续期接口没有返回 accessToken')
  }
  const expiresIn = Number(data?.expiresIn)
  return {
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : refreshToken,
    expires: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Date.now() + 24 * 60 * 60 * 1000,
  }
}

const json = async (res, what) => {
  if (!res.ok) throw new Error(`${what} 返回 HTTP ${res.status}`)
  try {
    return await res.json()
  } catch {
    throw new Error(`${what} 返回的不是 JSON`)
  }
}

/** Ask CANNBOT for a GitCode authorize URL, keyed by state. */
export async function startAuthorize({ fetchImpl = fetch, ideType = 'codearts' } = {}) {
  const res = await fetchImpl(`${AUTHORIZE}?ideType=${encodeURIComponent(ideType)}`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  const data = await json(res, 'CANNBOT 授权接口')
  if (typeof data?.authorizeUrl !== 'string' || data.authorizeUrl === '' || typeof data?.state !== 'string' || data.state === '') {
    throw new Error('CANNBOT 授权响应缺少 authorizeUrl 或 state')
  }
  return { authorizeUrl: data.authorizeUrl, state: data.state }
}

/** Parse the SSE body until `event: success` (or `event: error`). */
export function parseSseChunk(state) {
  let buffer = ''
  return (chunk) => {
    buffer += chunk.replace(/\r\n/g, '\n')
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const lines = block.split('\n')
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
      if (event !== 'success' && event !== 'error') continue
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (event === 'error') {
        let message = data
        try { message = JSON.parse(data)?.message ?? data } catch { /* raw text */ }
        throw new Error(`CANNBOT 登录失败：${message || '未知错误'}`)
      }
      let tokens
      try { tokens = JSON.parse(data) } catch {
        throw new Error('CANNBOT 登录回调不是 JSON')
      }
      if (typeof tokens?.accessToken !== 'string' || tokens.accessToken === '') {
        throw new Error('CANNBOT 登录回调没有 accessToken')
      }
      return {
        state,
        accessToken: tokens.accessToken,
        refreshToken: typeof tokens.refreshToken === 'string' ? tokens.refreshToken : '',
        expiresIn: Number(tokens.expiresIn) > 0 ? Number(tokens.expiresIn) : 3600,
      }
    }
    return undefined
  }
}

/** Wait on the state's SSE channel for the tokens the browser login produces. */
export async function waitForTokens(state, { fetchImpl = fetch, timeoutMs = 10 * 60 * 1000, signal } = {}) {
  const timer = new AbortController()
  const timeout = setTimeout(() => timer.abort(new Error('登录超时：浏览器里没有完成 GitCode 登录')), Math.max(1000, timeoutMs))
  const combined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal
  try {
    const res = await fetchImpl(`${SSE}?state=${encodeURIComponent(state)}`, {
      headers: { accept: 'text/event-stream' },
      redirect: 'error',
      signal: combined,
    })
    if (!res.ok || !res.body) throw new Error(`CANNBOT 登录回调返回 HTTP ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const feed = parseSseChunk(state)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const tokens = feed(decoder.decode(value, { stream: true }))
        if (tokens !== undefined) return tokens
      }
      throw new Error('CANNBOT 登录回调连接已关闭，未收到结果')
    } finally {
      // The token event leaves the stream open; close the socket.
      await reader.cancel().catch(() => {})
    }
  } catch (error) {
    if (timer.signal.aborted) throw new Error('登录超时：浏览器里没有完成 GitCode 登录')
    if (signal?.aborted) throw new Error('登录已取消')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/** The account's Virtual Key from the authenticated catalog (one shared today). */
export async function catalogVirtualKey(accessToken, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(MODELS_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`CANNBOT 模型目录返回 HTTP ${res.status}`)
  let body
  try { body = await res.json() } catch { throw new Error('CANNBOT 模型目录不是 JSON') }
  const rows = [...(body?.data?.personalModels ?? []), ...(body?.data?.builtinModels ?? [])]
  const key = rows.find((row) => typeof row?.apiKey === 'string' && row.apiKey)?.apiKey
  if (typeof key !== 'string' || key === '') throw new Error('CANNBOT 模型目录没有 Virtual Key')
  return key
}
