// @ts-nocheck
// Edge Function "request-password-reset": schickt den Link zum Zurücksetzen des Passworts anhand des Benutzernamens.
// Die E-Mail-Adresse wird nur hier auf dem Server nachgeschlagen und nie an den Browser zurückgegeben.
// Antwort ist IMMER dieselbe neutrale OK-Meldung - egal ob es den Benutzernamen gibt oder nicht.
//
// Aufruf: supabase.functions.invoke('request-password-reset', { body: { username, redirectTo } })
// Deploy: npx supabase functions deploy request-password-reset --use-api
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const url = Deno.env.get('SUPABASE_URL')!
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } })

// Erlaubte Ziele des Links in der Mail (Secret ALLOWED_REDIRECTS, kommagetrennt, Standard: die Live-Seite)
const ALLOWED = (Deno.env.get('ALLOWED_REDIRECTS') ?? 'https://myjungschar.github.io/chat/')
  .split(',').map((s) => s.trim()).filter(Boolean)

const hits = new Map<string, number[]>()
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now()
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs)
  list.push(now)
  hits.set(key, list)
  return list.length > max
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Nur POST ist erlaubt.' }, 405)

  try {
    const body = await req.json()
    const typed = String(body?.username ?? '').trim().slice(0, 100)
    let redirectTo = String(body?.redirectTo ?? '')
    if (!ALLOWED.some((a) => redirectTo === a || redirectTo.startsWith(a))) redirectTo = ALLOWED[0]

    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unbekannt'
    if (typed && !limited('ip:' + ip, 10, 10 * 60_000) && !limited('user:' + typed.toLowerCase(), 3, 60 * 60_000)) {
      const lower = typed.toLowerCase()
      let email: string | null = null
      for (const name of lower === typed ? [lower] : [lower, typed]) {
        const { data, error } = await admin.rpc('get_email_by_username', { uname: name })
        if (!error && data) { email = String(data); break }
      }
      if (email) {
        const { error } = await anon.auth.resetPasswordForEmail(email, { redirectTo })
        if (error) console.error('resetPasswordForEmail:', error.message)
      }
    }
  } catch (e) {
    console.error('request-password-reset:', e)
  }
  // Immer dieselbe Antwort
  return json({ ok: true })
})