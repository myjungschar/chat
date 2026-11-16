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

// Bremse gegen Durchprobieren: liegt in der Datenbank (Funktion check_rate_limit, siehe rate-limit.sql).
async function allowed(bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await admin.rpc('check_rate_limit', { p_bucket: bucket, p_max: max, p_window_seconds: windowSeconds })
  if (error) { console.error('check_rate_limit:', error.message); return true }
  return data !== false
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
    const ipOk = typed ? await allowed('reset:ip:' + ip, 10, 10 * 60) : false
    const userOk = typed ? await allowed('reset:user:' + typed.toLowerCase(), 3, 60 * 60) : false
    if (typed && ipOk && userOk) {
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