// Edge Function "get-user-email": gibt die E-Mail-Adresse einer Person zurück - aber NUR an den Admin.
// Die Adresse steht in auth.users und ist für normale Nutzer nicht lesbar; hier wird sie mit dem
// geheimen Schlüssel (service role) geholt, der den Browser nie erreicht.
//
// Deploy: npx supabase functions deploy get-user-email --use-api
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Nur POST erlaubt.' }, 405)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // 1) Wer fragt? Das Zugriffs-Token der Anfrage prüfen
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Nicht angemeldet.' }, 401)
  const { data: caller, error: callerError } = await admin.auth.getUser(token)
  if (callerError || !caller.user) return json({ error: 'Nicht angemeldet.' }, 401)

  // 2) Nur der Admin darf E-Mail-Adressen sehen (Rolle kommt aus der Datenbank, nicht aus dem Browser)
  const { data: profile } = await admin.from('profiles').select('role').eq('id', caller.user.id).single()
  if (!profile || profile.role !== 'admin') return json({ error: 'Nicht erlaubt.' }, 403)

  // 3) Welche Person?
  let userId = ''
  try {
    const body = await req.json()
    userId = String(body?.userId ?? '')
  } catch (_) { /* kein gültiges JSON */ }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return json({ error: 'Ungültige Nutzer-ID.' }, 400)
  }

  const { data, error } = await admin.auth.admin.getUserById(userId)
  if (error || !data.user) return json({ error: 'Nutzer nicht gefunden.' }, 404)

  return json({ email: data.user.email ?? null })
})