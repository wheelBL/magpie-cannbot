// CANNBOT sign-in lifetime: keep this computer's CANNWork JWT usable without
// the VS Code extension that writes it.
//
// The JWT lives in opencode's session.json and lasts about a day. The CANNBOT
// VS Code extension is what writes it there, and it keeps its own refresh
// token in VS Code's globalState. This module:
//
//   * reads the JWT and its exp before every request;
//   * while valid, uses it as-is;
//   * within five minutes of expiry (or already lapsed) refreshes it:
//       - from magpie's own copy (written by tools/login.mjs or an OAuth
//         sign-in), which makes VS Code unnecessary, or
//       - from the extension's store, but only while VS Code is closed — with
//         VS Code open the extension owns the refresh.
//
// A token CANNBOT has lapsed is answered as the vendor would answer it: 401
// with X-Magpie-Sign-In: expired, so magpie marks the account and the request
// fails in milliseconds instead of magpie retrying a thrown fetch for ~33s.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const REFRESH_URL = 'https://cannbot.hicann.cn/cannbot/api/oauth/refresh'
const REFRESH_SKEW_MS = 5 * 60_000
/** The key the CANNBOT VS Code extension keeps its sessions under in globalState. */
const VSCODE_STATE_KEY = 'CANN-PUB.cannbot-toolkit'
/** magpie's own copy of the refresh token, once it owns the sign-in (0600). */
export const OWN_AUTH_FILE = 'cannbot-signin.json'

export const signInError = (message) => Object.assign(new Error(message), { signIn: 'expired' })

/** The lapsed sign-in as a 401 the gateway marks the account from. */
export function signInResponse(error) {
  return new Response(
    JSON.stringify({
      error: {
        message: error?.message ?? String(error),
        type: 'invalid_request_error',
        code: 'cannbot_sign_in_expired',
      },
    }),
    { status: 401, headers: { 'content-type': 'application/json', 'x-magpie-sign-in': 'expired' } },
  )
}

/**
 * Write a small credential file whole: a temp file beside it, then rename, so
 * a concurrent reader (VS Code, another magpie host) never sees half a JSON.
 */
export function writeFileAtomic(path, data, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, data, { mode })
  try {
    chmodSync(tmp, mode)
  } catch {
    // The create mode already made it so.
  }
  renameSync(tmp, path)
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** A JWT's claims, or undefined when the string isn't one. Never logs the token. */
export function jwtClaims(jwt) {
  const part = typeof jwt === 'string' ? jwt.split('.')[1] : undefined
  if (part === undefined) return undefined
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

/** When the JWT stops being accepted, in epoch milliseconds, or undefined. */
export function jwtExpiry(jwt) {
  const claims = jwtClaims(jwt)
  return typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined
}

/** What the JWT says about the account, for magpie's account row. */
export function accountOf(jwt) {
  const claims = jwtClaims(jwt)
  if (claims === undefined) return {}
  return {
    accountId: typeof claims.userId === 'string' && claims.userId !== '' ? claims.userId : typeof claims.sub === 'string' ? claims.sub : 'cannwork',
    email: typeof claims.email === 'string' ? claims.email : undefined,
    username: typeof claims.username === 'string' ? claims.username : undefined,
  }
}

/** 'valid' | 'expiring' (inside the refresh margin) | 'expired' | 'unknown'. */
export function tokenState(jwt, now = Date.now()) {
  const exp = jwtExpiry(jwt)
  if (exp === undefined) return 'unknown'
  if (exp <= now) return 'expired'
  return exp - now <= REFRESH_SKEW_MS ? 'expiring' : 'valid'
}

/** The opencode dirs CANNWork and the CANNBOT extension write, data dir first. */
export function opencodeRoots({ env = process.env, home = homedir() } = {}) {
  return [
    join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode'),
    join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'),
  ]
}

/** CANNWork's sign-in file, or undefined when it is missing. */
export function readSessionFile(options = {}) {
  for (const root of opencodeRoots(options)) {
    const path = join(root, 'session.json')
    const session = readJson(path)
    if (typeof session?.accessToken === 'string' && session.accessToken !== '') return { session, path }
  }
  return undefined
}

export function readSession(options = {}) {
  return readSessionFile(options)?.session
}

/** magpie's config folder, where its own sign-in copy lives. */
export function configDir({ env = process.env, home = homedir() } = {}) {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'magpie')
}

export function ownAuthPath(options = {}) {
  return join(configDir(options), OWN_AUTH_FILE)
}

/** Where a refreshed access token goes when session.json itself is gone. */
export function defaultSessionPath(options = {}) {
  return join(opencodeRoots(options)[0], 'session.json')
}

/** magpie's own refresh token, when it has taken the sign-in over. */
export function readOwnAuth(options = {}) {
  const value = readJson(ownAuthPath(options))
  if (typeof value?.refreshToken !== 'string' || value.refreshToken === '') return undefined
  return value
}

/** Keep the refresh token in magpie's own 0600 file. */
export function writeOwnAuth(tokens, extra = {}, options = {}) {
  const path = ownAuthPath(options)
  const value = { ...extra, refreshToken: tokens.refreshToken, updatedAt: new Date().toISOString() }
  writeFileAtomic(path, JSON.stringify(value, null, 2), 0o600)
  return path
}

/** Where the VS Code family keeps globalState, this platform's paths. */
export function vscodeStatePaths({ env = process.env, home = homedir() } = {}) {
  const apps = ['Code', 'Code - Insiders', 'VSCodium', 'CodeArts']
  if (process.platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support')
    return apps.map((app) => join(base, app, 'User', 'globalStorage', 'state.vscdb'))
  }
  if (process.platform === 'win32') {
    const base = env.APPDATA || join(home, 'AppData', 'Roaming')
    return apps.map((app) => join(base, app, 'User', 'globalStorage', 'state.vscdb'))
  }
  const base = env.XDG_CONFIG_HOME || join(home, '.config')
  return apps.map((app) => join(base, app, 'User', 'globalStorage', 'state.vscdb'))
}

/**
 * Whether a VS Code window is open. `undefined` when it can't be told, which
 * callers treat as open: the extension owns the sign-in then.
 */
export function vscodeRunning() {
  if (process.platform === 'win32') return undefined
  const result = spawnSync('pgrep', ['-f', 'Visual Studio Code|Code - Insiders|VSCodium|CodeArts'], { encoding: 'utf8' })
  if (result.error !== undefined || result.status === null) return undefined
  if (result.status === 1) return false
  if (result.status === 0) return true
  return undefined
}

/** VS Code's globalState database, on either runtime's own SQLite. */
async function openStateDb(path) {
  try {
    const { Database } = await import('bun:sqlite')
    const db = new Database(path)
    return {
      get: (sql, ...args) => db.query(sql).get(...args),
      run: (sql, ...args) => db.query(sql).run(...args),
      close: () => db.close(),
    }
  } catch {
    // not Bun: try Node's built-in
  }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    return {
      get: (sql, ...args) => db.prepare(sql).get(...args),
      run: (sql, ...args) => db.prepare(sql).run(...args),
      close: () => db.close(),
    }
  } catch {
    return undefined
  }
}

/** The extension's stored sign-in: its refresh token, and the JSON to write back. */
export async function readVscodeAuth(options = {}) {
  for (const path of vscodeStatePaths(options)) {
    if (!existsSync(path)) continue
    const db = await openStateDb(path)
    if (db === undefined) return undefined
    try {
      const row = db.get('SELECT value FROM ItemTable WHERE key = ?', VSCODE_STATE_KEY)
      if (typeof row?.value !== 'string') continue
      const value = JSON.parse(row.value)
      const sessions = Array.isArray(value?.['cannwork.sessions']) ? value['cannwork.sessions'] : []
      const index = sessions.findIndex((entry) => typeof entry?.refreshToken === 'string' && entry.refreshToken !== '')
      if (index < 0) continue
      return { path, value, index, session: sessions[index] }
    } catch {
      // A store that can't be read is no store: try the next one.
    } finally {
      db.close()
    }
  }
  return undefined
}

/** Write the pair back so the extension and magpie hold one sign-in. */
export async function writeVscodeAuth(auth, tokens) {
  const db = await openStateDb(auth.path)
  if (db === undefined) throw new Error('VS Code 的状态库打不开')
  try {
    const value = structuredClone(auth.value)
    const sessions = value['cannwork.sessions']
    sessions[auth.index] = {
      ...(sessions[auth.index] ?? {}),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
    }
    const result = db.run('UPDATE ItemTable SET value = ? WHERE key = ?', JSON.stringify(value), VSCODE_STATE_KEY)
    if (result?.changes === 0) throw new Error('VS Code 的登录记录没有更新')
  } finally {
    db.close()
  }
}

export const ideTypeOf = (path) => (/codearts/i.test(path) ? 'codearts' : 'vscode')

/** Trade a refresh token for a fresh access token. */
export async function refreshSignIn(refreshToken, { fetchImpl = fetch, ideType = 'vscode' } = {}) {
  const res = await fetchImpl(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, ideType }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`CANNBOT 续期接口返回 HTTP ${res.status}`)
  const body = await res.json()
  const data = body?.data ?? body
  if (typeof data?.accessToken !== 'string' || data.accessToken === '') {
    throw new Error('CANNBOT 续期接口没有返回 accessToken')
  }
  const expiresIn = Number(data?.expiresIn)
  return {
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
  }
}

/** Write session.json, keeping whatever else it held. */
export function saveSession(path, accessToken) {
  const previous = readJson(path)
  const next = previous !== null && typeof previous === 'object' ? previous : {}
  next.accessToken = accessToken
  writeFileAtomic(path, JSON.stringify(next), 0o600)
}

export function signInLapsed(jwt, detail) {
  const exp = jwtExpiry(jwt)
  const when = exp === undefined ? '' : `（已于 ${new Date(exp).toISOString()} 过期）`
  const hint = '请重新登录 CANNBOT（VS Code 的 CANNBOT 面板会写 ~/.local/share/opencode/session.json），或重新导入凭据后再试。'
  return signInError(`CANNWork 登录态已失效${when}。${hint}${detail ? ` ${detail}` : ''}`)
}

/**
 * Refresh an expired sign-in from whichever store owns it.
 *
 * magpie's own file wins: once it exists the plugin keeps the refresh chain, so
 * the VS Code extension can be removed. Until then the extension owns it: while
 * VS Code is open the plugin leaves the token alone, and with it closed the
 * refresh token is spent here and the pair is written back to both stores.
 */
export async function refreshOnce(
  current,
  { now = Date.now(), fetchImpl = fetch, running = vscodeRunning, auth = readVscodeAuth, write = writeVscodeAuth, save = saveSession, options = {} } = {},
) {
  const own = readOwnAuth(options)
  if (own !== undefined) {
    let tokens
    try {
      tokens = await refreshSignIn(own.refreshToken, { fetchImpl, ideType: own.ideType ?? 'vscode' })
    } catch (error) {
      throw signInLapsed(current.session.accessToken, `续期失败：${error?.message ?? error}。`)
    }
    writeOwnAuth(tokens, own, options)
    save(current.path, tokens.accessToken)
    return refreshedSession(now, tokens.accessToken, options)
  }

  if (running() === true) {
    throw signInLapsed(current.session.accessToken, 'VS Code 正在运行：请打开它的 CANNBOT 面板让扩展刷新登录态。')
  }
  const stored = await auth(options)
  if (stored === undefined) {
    throw signInLapsed(current.session.accessToken, 'VS Code 的存储里没有 refreshToken。')
  }
  let tokens
  try {
    tokens = await refreshSignIn(stored.session.refreshToken, { fetchImpl, ideType: ideTypeOf(stored.path) })
  } catch (error) {
    throw signInLapsed(current.session.accessToken, `续期失败：${error?.message ?? error}。`)
  }
  try {
    await write(stored, tokens)
  } catch (error) {
    // The old refresh token is spent either way: keep the new access token
    // usable and say what to redo, rather than fail a request that can go.
    console.error(`[cannbot] 轮换后的登录态没能写回 VS Code：${error?.message ?? error}`)
  }
  save(current.path, tokens.accessToken)
  return refreshedSession(now, tokens.accessToken, options)
}

function refreshedSession(now, fallbackToken, options) {
  const next = readSession(options)
  if (next === undefined || tokenState(next.accessToken, now) === 'expired') {
    throw signInLapsed(fallbackToken, '续期得到的登录态不可用。')
  }
  return next
}

/** One at a time: concurrent requests share a single refresh. */
let refreshing

/**
 * The access token to sign with: the live one while it is valid, a refreshed
 * one once it lapses. With magpie's own refresh token, a deleted session.json
 * is recreated.
 */
export async function ensureAccessToken({ now = Date.now(), fetchImpl = fetch, refresh = refreshOnce, options = {} } = {}) {
  const file = readSessionFile(options)
  const token = file?.session.accessToken
  const own = readOwnAuth(options)
  if (token === undefined && own === undefined) {
    throw signInError('没有找到 CANNWork 登录态：请先在 CANNBOT 面板登录或导入凭据。')
  }
  if (token !== undefined) {
    const state = tokenState(token, now)
    if (state === 'valid' || state === 'unknown') return token
  }
  const target = file ?? { session: { accessToken: '' }, path: defaultSessionPath(options) }
  if (refreshing !== undefined) {
    const next = await refreshing
    return next.accessToken
  }
  const stillUsable = () =>
    token !== undefined && token !== '' && tokenState(token, Date.now()) !== 'expired'
  refreshing = refresh(target, { now, fetchImpl, options })
    .catch((error) => {
      // A sign-in that still has minutes is used while it has them; once it
      // has lapsed the caller is told what to redo.
      if (stillUsable()) return { accessToken: token }
      throw error
    })
    .finally(() => {
      refreshing = undefined
    })
  const next = await refreshing
  return next.accessToken
}
