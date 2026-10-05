// Edge Function "cleanup-photos": räumt Fotos in Google Drive auf.
//  1) Datenbank-Webhook (DELETE auf messages / direct_messages): löscht das Foto der gelöschten Nachricht sofort.
//     Das gilt auch, wenn die Nachricht aus dem 300er-Ringpuffer fliegt.
//  2) Täglicher Aufruf (pg_cron): löscht alle Dateien im Drive-Ordner, die zu keiner Nachricht mehr gehören
//     (z. B. weil ein Upload klappte, das Senden aber nicht). Sicherheitsnetz für Fall 1.
// Aufruf nur mit dem Header x-cron-secret (Secret CRON_SECRET). Deploy mit --no-verify-jwt.
import { createClient } from 'npm:@supabase/supabase-js@2'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const MIN_AGE_MS = 2 * 60 * 60 * 1000 // frische Uploads (noch ohne Nachricht) in Ruhe lassen
const MAX_DELETES_PER_RUN = 500

let tokenCache: { token: string; exp: number } | null = null

async function driveToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
      refresh_token: Deno.env.get('GOOGLE_REFRESH_TOKEN') ?? '',
      grant_type: 'refresh_token'
    })
  })
  const data = await res.json()
  if (!res.ok || !data.access_token) throw new Error('Google-Anmeldung fehlgeschlagen')
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 }
  return data.access_token
}

async function deleteFile(id: string): Promise<boolean> {
  const token = await driveToken()
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
  return res.ok || res.status === 404 // 404 = war schon weg
}

async function listDriveFiles(): Promise<{ id: string; createdTime: string }[]> {
  const token = await driveToken()
  const folder = Deno.env.get('DRIVE_FOLDER_ID')
  const files: { id: string; createdTime: string }[] = []
  let pageToken = ''
  do {
    const params = new URLSearchParams({
      q: `'${folder}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, createdTime)',
      pageSize: '1000'
    })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await res.json()
    if (!res.ok) throw new Error('Drive-Liste fehlgeschlagen: ' + (data.error?.message || res.status))
    files.push(...(data.files ?? []))
    pageToken = data.nextPageToken ?? ''
  } while (pageToken)
  return files
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET') || !Deno.env.get('CRON_SECRET')) {
    return json({ error: 'Nicht erlaubt' }, 401)
  }

  try {
    let payload: any = {}
    try { payload = await req.json() } catch { /* leerer Body beim täglichen Aufruf */ }

    // Fall 1: Webhook einer gelöschten Nachricht
    if (payload && payload.type === 'DELETE' && payload.old_record) {
      const ids = [payload.old_record.photo_id, payload.old_record.photo_thumb_id].filter(Boolean)
      let deleted = 0
      for (const id of ids) if (await deleteFile(id)) deleted++
      return json({ mode: 'webhook', deleted })
    }

    // Fall 2: täglicher Abgleich
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const referenced = new Set<string>()
    for (const table of ['messages', 'direct_messages']) {
      let from = 0
      while (true) {
        const { data, error } = await admin
          .from(table)
          .select('photo_id, photo_thumb_id')
          .not('photo_id', 'is', null)
          .range(from, from + 999)
        if (error) return json({ error: 'Datenbank-Abfrage fehlgeschlagen: ' + error.message }, 500) // lieber nichts löschen
        for (const row of data ?? []) {
          if (row.photo_id) referenced.add(row.photo_id)
          if (row.photo_thumb_id) referenced.add(row.photo_thumb_id)
        }
        if (!data || data.length < 1000) break
        from += 1000
      }
    }

    const files = await listDriveFiles()
    const now = Date.now()
    const orphans = files.filter(f => !referenced.has(f.id) && now - new Date(f.createdTime).getTime() > MIN_AGE_MS)

    let deleted = 0
    for (const f of orphans.slice(0, MAX_DELETES_PER_RUN)) if (await deleteFile(f.id)) deleted++
    return json({ mode: 'sweep', in_drive: files.length, referenced: referenced.size, orphans: orphans.length, deleted })
  } catch (e) {
    console.error('cleanup-photos:', e)
    return json({ error: e instanceof Error ? e.message : 'Unbekannter Fehler' }, 500)
  }
})