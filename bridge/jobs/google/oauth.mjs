/**
 * Google OAuth for an installed (desktop) application: loopback redirect on
 * 127.0.0.1, PKCE (S256), offline access for a refresh token.
 *
 * Scopes, and why each is needed (nothing broader):
 *   spreadsheets     read the tracker and write JARVIS's rows/metadata tab.
 *                    (drive.file cannot reach a spreadsheet JARVIS did not
 *                    create, and the tracker already exists.)
 *   drive.readonly   find the tracker by exact name, confirm the master CV
 *                    exists, and download the tailored CV the ChatGPT
 *                    workflow saved, for upload to an application form.
 *   drive.file       create the per-job folders JARVIS itself makes. It can
 *                    write only files it created — never the master CV.
 *
 * The refresh token is stored with Windows DPAPI (dpapi.mjs). Tokens are never
 * logged and never appear in diagnostics; errors carry Google's error CODE only.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { protect, unprotect } from './dpapi.mjs'

export const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
]
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkcePair() {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authUrl({ clientId, redirectUri, challenge, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${AUTH_URL}?${q}`
}

async function tokenRequest(params, fetchFn) {
  const res = await fetchFn(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    // Google's error code only ("invalid_grant"), never the request or response body.
    throw Object.assign(new Error(`Google token request failed: ${String(body.error ?? res.status).slice(0, 40)}`), { category: body.error === 'invalid_grant' ? 'GOOGLE_REAUTH_REQUIRED' : 'GOOGLE_AUTH' })
  }
  return body
}

/**
 * The token file: DPAPI-protected JSON { refresh_token, scope, obtainedAt }.
 * `crypto` is injectable for tests.
 */
export function createTokenStore(file, crypto = { protect, unprotect }) {
  return {
    exists: () => existsSync(file),
    async read() {
      if (!existsSync(file)) return null
      return JSON.parse(await crypto.unprotect(readFileSync(file, 'utf8').trim()))
    },
    async write(record) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, await crypto.protect(JSON.stringify(record)))
    },
    clear: () => rmSync(file, { force: true }),
  }
}

/**
 * Access tokens on demand, cached in memory until shortly before expiry.
 * @param {{ clientId: string|null, clientSecret: string|null, tokens: ReturnType<typeof createTokenStore>, fetchFn?: typeof fetch, now?: () => number }} o
 */
export function createAuth({ clientId, clientSecret, tokens, fetchFn = fetch, now = () => Date.now() }) {
  let access = null
  let expiresAt = 0
  return {
    configured: () => Boolean(clientId && clientSecret),
    authorised: () => tokens.exists(),
    async accessToken() {
      if (access && now() < expiresAt - 60_000) return access
      if (!clientId || !clientSecret) throw Object.assign(new Error('Google OAuth client is not configured'), { category: 'GOOGLE_NOT_CONFIGURED' })
      const rec = await tokens.read()
      if (!rec?.refresh_token) throw Object.assign(new Error('Google account is not authorised yet'), { category: 'GOOGLE_NOT_AUTHORISED' })
      const t = await tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: rec.refresh_token, grant_type: 'refresh_token' }, fetchFn)
      access = t.access_token
      expiresAt = now() + Number(t.expires_in ?? 3600) * 1000
      return access
    },
    /**
     * Interactive consent, for `npm run jobs -- auth` only (never from the
     * bridge). Opens the consent page with `openUrl`, waits on a loopback
     * port for the redirect, exchanges the code, stores the refresh token.
     */
    async authorise({ openUrl, timeoutMs = 5 * 60_000, log = console.log }) {
      if (!clientId || !clientSecret) throw new Error('Set JOBS_GOOGLE_CLIENT_ID and JOBS_GOOGLE_CLIENT_SECRET in .env.local first.')
      const { verifier, challenge } = pkcePair()
      const state = b64url(randomBytes(16))
      const server = createServer()
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      const redirectUri = `http://127.0.0.1:${server.address().port}`
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for Google consent')), timeoutMs)
        server.on('request', (req, res) => {
          const u = new URL(req.url, redirectUri)
          if (u.pathname !== '/') return res.writeHead(404).end()
          const ok = u.searchParams.get('state') === state && u.searchParams.get('code')
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(ok ? '<p>JARVIS is authorised. You can close this tab.</p>' : '<p>Authorisation failed. You can close this tab.</p>')
          clearTimeout(timer)
          if (ok) resolve(u.searchParams.get('code'))
          else reject(new Error(`consent not granted: ${String(u.searchParams.get('error') ?? 'state mismatch').slice(0, 40)}`))
        })
        log('[jobs] opening Google consent in your browser…')
        void openUrl(authUrl({ clientId, redirectUri, challenge, state }))
      }).finally(() => server.close())
      const t = await tokenRequest({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }, fetchFn)
      if (!t.refresh_token) throw new Error('Google did not return a refresh token; remove JARVIS from your Google account permissions and try again.')
      await tokens.write({ refresh_token: t.refresh_token, scope: t.scope, obtainedAt: new Date().toISOString() })
      access = t.access_token
      expiresAt = now() + Number(t.expires_in ?? 3600) * 1000
      return { scope: t.scope }
    },
  }
}
