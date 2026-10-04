// Supabase Edge Function "invite-user"
// Einfügen unter: Supabase -> Edge Functions -> invite-user -> Code (bestehenden Code ersetzen) -> Deploy.
//
// Ablauf:
//  1. Prüft, dass der Aufrufer angemeldet UND Admin ist.
//  2. Verlangt ein Geschlecht ("junge" oder "maedchen") - ohne wird gar nichts gesendet.
//  3. Lädt die Person ein (E-Mail geht raus).
//  4. Speichert das Geschlecht (und auf Wunsch die besonderen Rechte) im Profil.
//     Klappt das Geschlecht nicht, wird das neue Konto sofort wieder entfernt,
//     damit es nie eine Person ohne Geschlecht gibt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Wohin der Link in der E-Mail führt (muss in Supabase unter Authentication -> URL Configuration erlaubt sein)
const REDIRECT_URL = 'https://myjungschar.github.io/chat/'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // 1. Wer ruft auf? Muss ein angemeldeter Admin sein.
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: { user } } = await caller.auth.getUser()
    if (!user) return json({ error: 'Nicht angemeldet.' }, 401)

    const admin = createClient(url, serviceKey)
    const { data: me } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()
    if (!me || me.role !== 'admin') return json({ error: 'Nur Admins dürfen Nutzer einladen.' }, 403)

    // 2. Eingaben prüfen
    const { email, gender, vip } = await req.json()
    if (typeof email !== 'string' || !email.includes('@')) {
      return json({ error: 'Bitte eine gültige E-Mail-Adresse angeben.' }, 400)
    }
    if (gender !== 'junge' && gender !== 'maedchen') {
      return json({ error: 'Das Geschlecht fehlt (Junge oder Mädchen).' }, 400)
    }

    // 3. Einladen
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email.trim(), {
      data: { gender },
      redirectTo: REDIRECT_URL,
    })
    if (inviteError || !invited?.user) {
      return json({ error: inviteError?.message ?? 'Einladung fehlgeschlagen.' }, 400)
    }
    const userId = invited.user.id

    // 4. Geschlecht im Profil speichern (Profil wird meist per Trigger angelegt; sonst legen wir es an)
    let genderSaved = false
    let genderProblem = ''
    for (let attempt = 0; attempt < 5 && !genderSaved; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500))
      const { data: updated, error: updateError } = await admin
        .from('profiles')
        .update({ gender })
        .eq('id', userId)
        .select('id')
      if (updateError) {
        genderProblem = updateError.message
      } else if (updated && updated.length > 0) {
        genderSaved = true
      } else {
        const { error: insertError } = await admin.from('profiles').insert({ id: userId, gender })
        if (insertError) genderProblem = insertError.message
        else genderSaved = true
      }
    }

    if (!genderSaved) {
      // Rückgängig machen: lieber keine Person als eine ohne Geschlecht
      await admin.auth.admin.deleteUser(userId)
      return json({ error: 'Geschlecht konnte nicht gespeichert werden, Einladung zurückgenommen: ' + genderProblem }, 500)
    }

    // Besondere Rechte (optional)
    let vipSaved = false
    if (vip === true) {
      const { error: vipError } = await admin.from('vip_users').insert({ user_id: userId })
      vipSaved = !vipError
    }

    return json({ userId, genderSaved: true, vipSaved })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})