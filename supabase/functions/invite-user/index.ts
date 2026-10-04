// Supabase Edge Function "invite-user"
// Liegt als supabase/functions/invite-user/index.ts, daneben die Datei deno.json (dort steht, woher @supabase/supabase-js kommt).
//
// Ablauf (die E-Mail geht erst raus, wenn das Geschlecht sicher gespeichert ist):
//  1. Prüft, dass der Aufrufer angemeldet UND Admin ist.
//  2. Verlangt ein Geschlecht ("junge" oder "maedchen") - ohne wird gar nichts gemacht.
//  3. Legt das Konto an, OHNE eine E-Mail zu senden.
//  4. Speichert das Geschlecht im Profil (mehrere Versuche, weil das Profil gerade erst entsteht)
//     und prüft es durch Nachlesen. Klappt das nicht: Konto wieder löschen, KEINE E-Mail.
//  5. Erst jetzt wird die Einladungs-E-Mail gesendet. Scheitert das, wird das Konto wieder gelöscht.

import { createClient } from '@supabase/supabase-js'

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
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // 1. Wer ruft auf? Muss ein angemeldeter Admin sein.
    //    Das Token aus dem Header wird ausdrücklich an getUser() übergeben (in Edge Functions gibt es keine gespeicherte Sitzung).
    const admin = createClient(url, serviceKey)
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: { user } } = await admin.auth.getUser(token)
    if (!user) return json({ error: 'Nicht angemeldet.' }, 401)

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

    // 3. Konto anlegen, noch ohne E-Mail
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: email.trim(),
      email_confirm: false,
      user_metadata: { gender },
    })
    if (createError || !created?.user) {
      return json({ error: createError?.message ?? 'Konto konnte nicht angelegt werden.' }, 400)
    }
    const userId = created.user.id

    // 4. Geschlecht im Profil speichern und durch Nachlesen prüfen
    //    (das Profil wird meist per Trigger angelegt, das kann einen Moment dauern)
    let genderSaved = false
    let genderProblem = 'Das Profil wurde nicht gefunden.'
    for (let attempt = 0; attempt < 6 && !genderSaved; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500))

      const { data: updated, error: updateError } = await admin
        .from('profiles')
        .update({ gender })
        .eq('id', userId)
        .select('id')
      if (updateError) {
        genderProblem = updateError.message
        continue
      }
      if (!updated || updated.length === 0) {
        // Kein Profil vorhanden: selbst anlegen
        const { error: insertError } = await admin.from('profiles').insert({ id: userId, gender })
        if (insertError) {
          genderProblem = insertError.message
          continue
        }
      }

      const { data: check } = await admin.from('profiles').select('gender').eq('id', userId).maybeSingle()
      if (check?.gender === gender) genderSaved = true
      else genderProblem = 'Das gespeicherte Geschlecht stimmt nicht.'
    }

    if (!genderSaved) {
      await admin.auth.admin.deleteUser(userId)
      return json({ error: 'Geschlecht konnte nicht gespeichert werden, es wurde keine E-Mail gesendet (' + genderProblem + ')' }, 500)
    }

    // 5. Jetzt erst die Einladungs-E-Mail senden
    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email.trim(), {
      data: { gender },
      redirectTo: REDIRECT_URL,
    })
    if (inviteError) {
      await admin.auth.admin.deleteUser(userId)
      return json({ error: 'E-Mail konnte nicht gesendet werden: ' + inviteError.message }, 400)
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