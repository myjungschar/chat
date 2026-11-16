// @ts-nocheck
// Edge Function "login": meldet jemanden mit Benutzername + Passwort an, OHNE dass der Browser je die E-Mail-Adresse
// zu einem Benutzernamen erfährt. Dadurch lassen sich Benutzernamen nicht mehr erraten/abfragen.
// Antwort bei Erfolg: { access_token, refresh_token } (der Browser setzt damit die Sitzung).
// Antwort bei JEDEM Fehler (Name unbekannt, Passwort falsch, Konto unbestätigt): dieselbe neutrale Meldung.
//
// Deploy: npx supabase functions deploy login --use-api   (JWT-Prüfung kann an bleiben, die App schickt den anon-Key mit)
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const NEUTRAL = 'Benutzername oder Passwort stimmt nicht.'
const url = Deno.env.get('SUPABASE_URL')!
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

// Bremse gegen Durchprobieren: liegt in der Datenbank (Funktion check_rate_limit, siehe rate-limit.sql),
// übersteht also einen Neustart oder mehrere gleichzeitig laufende Instanzen dieser Function.
async function allowed(bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await admin.rpc('check_rate_limit', { p_bucket: bucket, p_max: max, p_window_seconds: windowSeconds })
  if (error) { console.error('check_rate_limit:', error.message); return true } // Datenbank-Problem soll niemanden aussperren
  return data !== false
}

async function emailFor(rawName: string): Promise<string | null> {
  const typed = rawName.trim()
  const lower = typed.toLowerCase()
  for (const name of lower === typed ? [lower] : [lower, typed]) {
    const { data, error } = await admin.rpc('get_email_by_username', { uname: name })
    if (!error && data) return String(data)
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Nur POST ist erlaubt.' }, 405)

  let username = ''
  let password = ''
  try {
    const body = await req.json()
    username = String(body?.username ?? '').trim().slice(0, 100)
    password = String(body?.password ?? '').slice(0, 200)
  } catch {
    return json({ error: NEUTRAL }, 400)
  }
  if (!username || !password) return json({ error: NEUTRAL }, 400)

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unbekannt'
  const ipOk = await allowed('login:ip:' + ip, 20, 10 * 60)
  const userOk = await allowed('login:user:' + username.toLowerCase(), 10, 10 * 60)
  if (!ipOk || !userOk) {
    return json({ error: 'Zu viele Versuche. Bitte warte ein paar Minuten.' }, 429)
  }

  const email = await emailFor(username)
  // Bei unbekanntem Namen trotzdem eine (ins Leere laufende) Anmeldung versuchen, damit die Antwortzeit gleich bleibt
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.signInWithPassword({
    email: email ?? 'kein-konto@invalid.example',
    password
  })

  if (!email || error || !data?.session) return json({ error: NEUTRAL }, 401)

  return json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token })
})