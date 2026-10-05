// Edge Function "get-photo": liefert ein Foto aus Google Drive aus - aber nur, wenn die Person den Chat sehen darf.
// Aufruf: GET ...?id=<Drive-ID> mit dem Zugriffs-Token der Person.
// Regeln wie bei den Chats: Hauptgruppe alle, Jungs/Mädchen nur die jeweilige Gruppe, Einzelchat nur die zwei (Admin liest mit).
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
}
const fail = (error: string, status: number) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'GET') return fail('Nur GET erlaubt', 405)

  try {
    const id = new URL(req.url).searchParams.get('id') ?? ''
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) return fail('Ungültige ID', 400)

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
    const { data: userData, error: userError } = await admin.auth.getUser(jwt)
    if (userError || !userData.user) return fail('Nicht angemeldet', 401)
    const userId = userData.user.id

    const { data: profile } = await admin
      .from('profiles')
      .select('role, gender, is_blocked')
      .eq('id', userId)
      .single()
    if (!profile || profile.is_blocked) return fail('Zugang gesperrt', 403)
    const isAdmin = profile.role === 'admin'

    // Zu welcher Nachricht gehört das Bild? Daraus ergibt sich, wer es sehen darf.
    const filter = `photo_id.eq.${id},photo_thumb_id.eq.${id}` // id ist oben auf sichere Zeichen geprüft
    let allowed = false
    let found = false

    const { data: groupRows } = await admin.from('messages').select('group_key').or(filter).limit(1)
    if (groupRows && groupRows.length > 0) {
      found = true
      const key = groupRows[0].group_key
      allowed = isAdmin || key === null || key === profile.gender
    } else {
      const { data: dmRows } = await admin.from('direct_messages').select('sender_id, recipient_id').or(filter).limit(1)
      if (dmRows && dmRows.length > 0) {
        found = true
        allowed = isAdmin || dmRows[0].sender_id === userId || dmRows[0].recipient_id === userId
      }
    }

    if (!found) return fail('Foto nicht gefunden', 404)
    if (!allowed) return fail('Kein Zugriff', 403)

    const token = await driveToken()
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok || !res.body) return fail('Foto nicht in Drive gefunden', res.status === 404 ? 404 : 502)

    return new Response(res.body, {
      headers: {
        ...cors,
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=31536000, immutable'
      }
    })
  } catch (e) {
    console.error('get-photo:', e)
    return fail(e instanceof Error ? e.message : 'Unbekannter Fehler', 500)
  }
})