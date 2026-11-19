// Edge Function "view-once-open": liefert ein Einmalansicht-Foto GENAU EINMAL pro Person aus und sorgt
// dafür, dass die Datei in Google Drive wirklich gelöscht wird, sobald alle, die sie sehen dürfen (außer
// dem Absender), sie einmal gesehen haben.
//
// Aufruf: POST { table: "messages" | "direct_messages", id: <Nachrichten-ID> } mit dem Zugriffs-Token der Person.
// Antwort:
//  - Erfolg (erste Ansicht dieser Person, oder der Absender selbst): die Bild-Bytes direkt (Content-Type image/jpeg).
//  - { status: "already_viewed" }: diese Person hat es schon einmal gesehen - kein Bild mehr.
//  - { status: "gone" }: die Datei ist schon gelöscht (alle nötigen Personen haben es gesehen).
//  - { error: "..." }: ungültige Anfrage, nicht angemeldet oder kein Zugriff.
//
// Rechte wie bei "get-photo": Hauptgruppe alle, Jungs/Mädchen nur die jeweilige Gruppe, eigene Gruppen nur
// deren Mitglieder, Einzelchat nur die zwei. Der Admin darf keine Einmalansicht-Fotos öffnen (er liest keine Chats).
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const fail = (error: string, status: number) => json({ error }, status)

const CUSTOM_GROUP = /^grp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TABLES = ['messages', 'direct_messages'] as const
type TableName = typeof TABLES[number]

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

async function deleteDriveFile(id: string): Promise<void> {
  const token = await driveToken()
  await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => { /* nicht schlimm, die tägliche Aufräum-Function räumt Reste später weg */ })
}

async function fetchDrivePhoto(id: string): Promise<ArrayBuffer> {
  const token = await driveToken()
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) { const e = new Error('Datei nicht in Drive gefunden'); (e as any).status = res.status === 404 ? 404 : 502; throw e }
  return await res.arrayBuffer()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail('Nur POST erlaubt', 405)

  try {
    let table: TableName
    let id: number
    try {
      const body = await req.json()
      if (!TABLES.includes(body?.table)) return fail('Ungültige Anfrage', 400)
      table = body.table
      id = Number(body?.id)
      if (!Number.isInteger(id) || id <= 0) return fail('Ungültige Anfrage', 400)
    } catch {
      return fail('Ungültige Anfrage', 400)
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
    const { data: userData, error: userError } = await admin.auth.getUser(jwt)
    if (userError || !userData.user) return fail('Nicht angemeldet', 401)
    const userId = userData.user.id

    const { data: profile } = await admin
      .from('profiles')
      .select('role, gender, is_blocked, active')
      .eq('id', userId)
      .single()
    if (!profile || profile.is_blocked) return fail('Zugang gesperrt', 403)
    if (profile.role === 'admin') return fail('Kein Zugriff', 403) // der Admin liest keine Chats

    const cols = table === 'direct_messages'
      ? 'id, sender_id, recipient_id, photo_id, photo_thumb_id, view_once, view_once_done'
      : 'id, sender_id, group_key, photo_id, photo_thumb_id, view_once, view_once_done'
    const { data: msg, error: msgError } = await admin.from(table).select(cols).eq('id', id).maybeSingle()
    if (msgError) return fail('Datenbank-Fehler: ' + msgError.message, 500)
    if (!msg) return fail('Nachricht nicht gefunden', 404)
    if (!msg.view_once) return fail('Das ist kein Einmalansicht-Foto.', 400)

    // ----- Zugriff prüfen (wie get-photo) -----
    const isSender = msg.sender_id === userId
    let authorized = isSender
    if (!authorized) {
      if (table === 'direct_messages') {
        authorized = msg.recipient_id === userId
      } else {
        const key = msg.group_key
        if (key === null || key === profile.gender) {
          authorized = true
        } else if (typeof key === 'string' && CUSTOM_GROUP.test(key)) {
          const { data: member } = await admin
            .from('chat_group_members')
            .select('user_id')
            .eq('group_id', key.slice(4))
            .eq('user_id', userId)
            .maybeSingle()
          if (member) authorized = true
        }
      }
    }
    if (!authorized) return fail('Kein Zugriff', 403)

    if (msg.view_once_done || !msg.photo_id) return json({ status: 'gone' })

    // Der Absender kann sein eigenes Foto normal anschauen (verbraucht keine Ansicht), solange es nicht gelöscht ist.
    if (isSender) {
      const bytes = await fetchDrivePhoto(msg.photo_id)
      return new Response(bytes, {
        headers: { ...cors, 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      })
    }

    // ----- Ansicht eintragen (genau einmal pro Person) -----
    const { error: insertError } = await admin
      .from('view_once_views')
      .insert({ message_table: table, message_id: id, viewer_id: userId })

    if (insertError) {
      // Eindeutigkeits-Verletzung = diese Person hat schon einmal gesehen (auch bei doppeltem Antippen)
      if (insertError.code === '23505') return json({ status: 'already_viewed' })
      return fail('Datenbank-Fehler: ' + insertError.message, 500)
    }

    // ----- Wer muss dieses Foto noch sehen, bevor es gelöscht werden darf? -----
    let requiredIds: string[] = []
    if (table === 'direct_messages') {
      requiredIds = [msg.recipient_id]
    } else {
      const key = msg.group_key
      let profileQuery = admin.from('profiles').select('id').eq('is_blocked', false).eq('active', true).neq('role', 'admin').neq('id', msg.sender_id)
      if (key === 'junge' || key === 'maedchen') profileQuery = profileQuery.eq('gender', key)
      if (typeof key === 'string' && CUSTOM_GROUP.test(key)) {
        const { data: members } = await admin.from('chat_group_members').select('user_id').eq('group_id', key.slice(4))
        const memberIds = (members ?? []).map((m: any) => m.user_id)
        if (memberIds.length === 0) requiredIds = []
        else {
          const { data: rows } = await admin.from('profiles').select('id').in('id', memberIds)
            .eq('is_blocked', false).eq('active', true).neq('role', 'admin').neq('id', msg.sender_id)
          requiredIds = (rows ?? []).map((r: any) => r.id)
        }
      } else {
        const { data: rows } = await profileQuery
        requiredIds = (rows ?? []).map((r: any) => r.id)
      }
    }

    let viewedCount = 0
    if (requiredIds.length > 0) {
      const { count } = await admin
        .from('view_once_views')
        .select('viewer_id', { count: 'exact', head: true })
        .eq('message_table', table)
        .eq('message_id', id)
        .in('viewer_id', requiredIds)
      viewedCount = count ?? 0
    }

    const allSeen = requiredIds.length === 0 || viewedCount >= requiredIds.length

    if (allSeen) {
      // Alle nötigen Personen haben es gesehen: Bytes erst holen, dann die Datei wirklich löschen.
      const bytes = await fetchDrivePhoto(msg.photo_id)
      await deleteDriveFile(msg.photo_id)
      if (msg.photo_thumb_id && msg.photo_thumb_id !== msg.photo_id) await deleteDriveFile(msg.photo_thumb_id)
      await admin.from(table).update({ photo_id: null, photo_thumb_id: null, view_once_done: true }).eq('id', id)
      return new Response(bytes, {
        headers: { ...cors, 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      })
    }

    const bytes = await fetchDrivePhoto(msg.photo_id)
    return new Response(bytes, {
      headers: { ...cors, 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    })
  } catch (e) {
    console.error('view-once-open:', e)
    const status = (e as any)?.status === 404 ? 404 : 500
    return fail(e instanceof Error ? e.message : 'Unbekannter Fehler', status)
  }
})