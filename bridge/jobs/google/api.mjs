/**
 * The handful of Sheets v4 / Drive v3 REST calls the job agent makes. Plain
 * fetch, no SDK. Ids are validated before they reach a URL; errors carry the
 * HTTP status and Google's error status, never a token or a response body.
 */

import { DRIVE_ID } from '../config.mjs'

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'

const checkId = (id) => {
  if (!DRIVE_ID.test(String(id))) throw Object.assign(new Error('invalid Google file id'), { category: 'GOOGLE_BAD_ID' })
  return id
}
/** Drive query string literal. */
export const qLiteral = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** Fields for a grid read: values, formulas, links and validation, nothing else. */
export const GRID_FIELDS =
  'properties(title),sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(userEnteredValue,formattedValue,hyperlink,dataValidation(condition(type,values(userEnteredValue)),strict)))))'

/**
 * @param {{ accessToken: () => Promise<string>, fetchFn?: typeof fetch }} o
 */
export function createGoogle({ accessToken, fetchFn = fetch }) {
  async function call(url, { method = 'GET', body, raw = false } = {}) {
    const token = await accessToken()
    const res = await fetchFn(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const status = String(err?.error?.status ?? '').slice(0, 40)
      throw Object.assign(new Error(`Google API ${res.status}${status ? ` ${status}` : ''}`), {
        category: res.status === 401 ? 'GOOGLE_REAUTH_REQUIRED' : res.status === 403 ? 'GOOGLE_FORBIDDEN' : res.status === 404 ? 'GOOGLE_NOT_FOUND' : 'GOOGLE_API',
        status: res.status,
      })
    }
    return raw ? res : res.json()
  }

  return {
    // --- Sheets ---
    getSpreadsheet: (id, { grid = true, ranges = [] } = {}) => {
      const q = new URLSearchParams({ includeGridData: String(grid), fields: grid ? GRID_FIELDS : 'properties(title),sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))' })
      for (const r of ranges) q.append('ranges', r)
      return call(`${SHEETS}/${checkId(id)}?${q}`)
    },
    batchUpdate: (id, requests) => call(`${SHEETS}/${checkId(id)}:batchUpdate`, { method: 'POST', body: { requests } }),

    // --- Drive ---
    findSpreadsheetsByName: async (name) => {
      const q = `name = ${qLiteral(name)} and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`
      const r = await call(`${DRIVE}?${new URLSearchParams({ q, fields: 'files(id,name,modifiedTime)', pageSize: '10', spaces: 'drive' })}`)
      return r.files ?? []
    },
    getFile: (id, fields = 'id,name,mimeType,parents,trashed,modifiedTime') => call(`${DRIVE}/${checkId(id)}?${new URLSearchParams({ fields })}`),
    findChild: async (parentId, name, mimeType = 'application/vnd.google-apps.folder') => {
      const q = `${qLiteral(checkId(parentId))} in parents and name = ${qLiteral(name)} and mimeType = ${qLiteral(mimeType)} and trashed = false`
      const r = await call(`${DRIVE}?${new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '5' })}`)
      return r.files?.[0] ?? null
    },
    createFolder: (parentId, name) =>
      call(`${DRIVE}?fields=id,name`, { method: 'POST', body: { name, mimeType: 'application/vnd.google-apps.folder', parents: [checkId(parentId)] } }),
    /** Bytes of a file: Google Docs are exported (PDF by default), other files downloaded. */
    download: async (id, { exportMime = 'application/pdf', maxBytes = 10 * 1024 * 1024 } = {}) => {
      const meta = await call(`${DRIVE}/${checkId(id)}?fields=id,name,mimeType,size`)
      const isDoc = String(meta.mimeType).startsWith('application/vnd.google-apps.')
      const url = isDoc ? `${DRIVE}/${id}/export?${new URLSearchParams({ mimeType: exportMime })}` : `${DRIVE}/${id}?alt=media`
      const res = await call(url, { raw: true })
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw Object.assign(new Error('file too large'), { category: 'FILE_TOO_LARGE' })
      return { name: meta.name, mimeType: isDoc ? exportMime : meta.mimeType, bytes: buf }
    },
  }
}

/** A Drive/Docs file id out of a Google URL, or null. */
export function driveIdFromUrl(url) {
  const m = /\/(?:d|folders)\/([A-Za-z0-9_-]{10,200})/.exec(String(url ?? '')) ?? /[?&]id=([A-Za-z0-9_-]{10,200})/.exec(String(url ?? ''))
  return m ? m[1] : null
}
