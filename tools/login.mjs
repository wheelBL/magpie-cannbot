#!/usr/bin/env node
/**
 * Sign in to CANNBOT from the terminal and put the OAuth sign-in in magpie's
 * auth store, so `magpie` renews it through auth.refresh.
 *
 *   node tools/login.mjs            open the GitCode page and wait for it
 *   node tools/login.mjs --no-open  print the URL (remote/headless)
 *   node tools/login.mjs --status   show the stored account
 *
 * Writes ~/.config/magpie/plugin-auth.json (0600):
 *   {"cannbot": {"type":"oauth", "access":…, "refresh":…, "expires":…, "accountId":…}}
 * Restart magpie afterwards.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { jwtClaims, jwtExpiry, startAuthorize, waitForTokens } from '../lib/oauth.mjs'

const args = new Set(process.argv.slice(2))
const authPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie', 'plugin-auth.json')

function readAuth() {
  try {
    return JSON.parse(readFileSync(authPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    // Never replace a store that exists but can't be read: that would drop
    // every other provider's account.
    throw new Error(`${authPath} 解析失败：${error?.message ?? error}`)
  }
}

function writeAuth(all) {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
  const tmp = `${authPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
  renameSync(tmp, authPath)
}

function openBrowser(url) {
  const [command, argv] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command, argv, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

function status() {
  const entry = readAuth().cannbot
  if (entry === undefined) {
    console.log('magpie 里没有 cannbot 账号；运行 node tools/login.mjs 登录。')
    return
  }
  const expires = Number(entry.expires)
  console.log(`账号:     ${entry.accountId ?? '?'} (${entry.type ?? '?'})`)
  console.log(`access:   ${Number.isFinite(expires) ? `expires ${new Date(expires).toISOString()}` : 'no expiry'}`)
  console.log(`refresh:  ${entry.refresh ? 'yes' : 'no'}`)
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    console.log('usage: node tools/login.mjs [--no-open] [--status]')
    return
  }
  if (args.has('--status')) {
    status()
    return
  }

  const { authorizeUrl, state } = await startAuthorize()
  console.log('请在浏览器里完成 GitCode 登录：')
  console.log(`  ${authorizeUrl}`)
  if (!args.has('--no-open') && !openBrowser(authorizeUrl)) {
    console.log('（打不开浏览器，请手动复制上面的地址）')
  }
  console.log('等待授权回调…')

  const tokens = await waitForTokens(state)
  const claims = jwtClaims(tokens.accessToken) ?? {}
  const accountId = claims.username ?? claims.email ?? 'cannbot'

  const all = readAuth()
  all.cannbot = {
    type: 'oauth',
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: jwtExpiry(tokens.accessToken) ?? Date.now() + tokens.expiresIn * 1000,
    accountId,
  }
  writeAuth(all)

  console.log(`\n登录成功：${accountId}${claims.email ? ` <${claims.email}>` : ''}`)
  console.log(`已写入 ${authPath}（type=oauth，magpie 会自动续期）`)
  console.log('重启 magpie 后生效。')
}

await main()
