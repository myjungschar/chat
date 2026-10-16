// Supabase Edge Function "invite-user"
// Liegt als supabase/functions/invite-user/index.ts, daneben die Datei deno.json (dort steht, woher @supabase/supabase-js kommt).
//
// Ablauf (die E-Mail geht erst raus, wenn Geschlecht, Name und Benutzername sicher gespeichert sind):
//  1. Prüft, dass der Aufrufer angemeldet UND Admin ist.
//  2. Verlangt ein Geschlecht ("junge" oder "maedchen") - ohne wird gar nichts gemacht. Dazu kommen der Benutzername
//     zum Anmelden (klein, z. B. vorname.nachname; ohne Angabe: alles vor dem @) und der Name im Chat (display_name;
//     ohne Angabe: aus dem Benutzernamen gebaut). Beide dürfen noch nicht vergeben sein.
//  3. Legt das Konto an, OHNE eine E-Mail zu senden. Name und Benutzername stehen auch in den Nutzerdaten,
//     damit die E-Mail-Vorlage sie anzeigen kann (".Data.display_name", ".Data.username").
//  4. Speichert Geschlecht, Name und Benutzername im Profil (mehrere Versuche, weil das Profil gerade erst entsteht)
//     und prüft sie durch Nachlesen. Klappt das nicht: Konto wieder löschen, KEINE E-Mail.
//  4b. Prüft mit der Datenbankfunktion get_email_by_username, dass man sich mit diesem Benutzernamen wirklich anmelden
//     kann (sie muss die E-Mail-Adresse dieser Person liefern). Sonst: Konto wieder löschen, KEINE E-Mail.
//  5. Erst jetzt wird die Einladungs-E-Mail gesendet. Scheitert das, wird das Konto wieder gelöscht.
//
// Einladungs-Link ohne Ablaufzeit: Ist das Secret INVITE_SECRET gesetzt, bekommt jede Einladung einen Code
// (E-Mail-Adresse + Signatur) als "invite_token" in die Nutzerdaten. Die E-Mail-Vorlage baut daraus den Link
// ...chat/?invite=<Code>, den die Funktion "redeem-invite" einlöst, solange noch kein Passwort gesetzt wurde.
// Ohne das Secret läuft alles wie bisher mit dem normalen Link (der nach der eingestellten Zeit abläuft).

import { createClient } from '@supabase/supabase-js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Wohin der Link in der E-Mail führt (muss in Supabase unter Authentication -> URL Configuration erlaubt sein)
const REDIRECT_URL = 'https://myjungschar.github.io/chat/'

const toB64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// Einladungs-Code: <E-Mail-Adresse, base64url>.<HMAC-Signatur>. Muss genau so gebaut werden wie in "redeem-invite".
async function makeInviteToken(email: string): Promise<string> {
  const secret = Deno.env.get('INVITE_SECRET')
  if (!secret) return ''
  const normalized = email.trim().toLowerCase()
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('invite:' + normalized))
  return toB64Url(new TextEncoder().encode(normalized)) + '.' + toB64Url(new Uint8Array(mac))
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// "timo.ebert" -> "Timo Ebert" (nur als Vorschlag, wenn kein Name angegeben wurde)
function nameFromUsername(username: string): string {
  return username
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// Zeichen, die bei ilike (Groß-/Kleinschreibung egal) Platzhalter wären, werden entschärft
const escapeLike = (text: string) => text.replace(/[\%_]/g, '\\$&')

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
    const body = await req.json()
    const { email, gender, vip } = body
    if (typeof email !== 'string' || !email.includes('@')) {
      return json({ error: 'Bitte eine gültige E-Mail-Adresse angeben.' }, 400)
    }
    if (gender !== 'junge' && gender !== 'maedchen') {
      return json({ error: 'Das Geschlecht fehlt (Junge oder Mädchen).' }, 400)
    }

    // Benutzername zum Anmelden: klein geschrieben, ohne Leerzeichen und ohne @. Ohne Angabe: alles vor dem @ der E-Mail.
    const username = (typeof body.username === 'string' && body.username.trim() ? body.username : email.split('@')[0]).trim().toLowerCase()
    if (username.length < 2 || username.length > 40 || /\s/.test(username) || username.includes('@')) {
      return json({ error: 'Der Benutzername ist ungültig (2 bis 40 Zeichen, keine Leerzeichen, kein @).' }, 400)
    }
    // Name im Chat: frei wählbar. Ohne Angabe wird er aus dem Benutzernamen gebaut.
    const displayName = (typeof body.display_name === 'string' && body.display_name.trim() ? body.display_name.trim() : nameFromUsername(username)).slice(0, 60)
    if (displayName.length < 1) {
      return json({ error: 'Der Name fehlt.' }, 400)
    }

    // Beides darf noch niemand haben
    const { data: sameUsername } = await admin.from('profiles').select('id').eq('username', username).limit(1)
    if (sameUsername && sameUsername.length > 0) return json({ error: 'Diesen Benutzernamen gibt es schon.' }, 400)
    const { data: sameName } = await admin.from('profiles').select('id').ilike('display_name', escapeLike(displayName)).limit(1)
    if (sameName && sameName.length > 0) return json({ error: 'Diesen Namen gibt es schon.' }, 400)

    // 3. Konto anlegen, noch ohne E-Mail
    //    needs_password: bis zum ersten eigenen Passwort bleibt die Person im Passwort-Fenster.
    //    invite_token: steht später in der E-Mail-Vorlage (".Data.invite_token") und läuft nicht ab.
    const inviteToken = await makeInviteToken(email)
    const userData: Record<string, unknown> = { gender, needs_password: true, display_name: displayName, username }
    if (inviteToken) userData.invite_token = inviteToken
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: email.trim(),
      email_confirm: false,
      user_metadata: userData,
    })
    if (createError || !created?.user) {
      return json({ error: createError?.message ?? 'Konto konnte nicht angelegt werden.' }, 400)
    }
    const userId = created.user.id

    // 4. Geschlecht, Name und Benutzername im Profil speichern und durch Nachlesen prüfen
    //    (das Profil wird meist per Trigger angelegt, das kann einen Moment dauern)
    let genderSaved = false
    let genderProblem = 'Das Profil wurde nicht gefunden.'
    for (let attempt = 0; attempt < 6 && !genderSaved; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500))

      const { data: updated, error: updateError } = await admin
        .from('profiles')
        .update({ gender, display_name: displayName, username })
        .eq('id', userId)
        .select('id')
      if (updateError) {
        genderProblem = updateError.message
        continue
      }
      if (!updated || updated.length === 0) {
        // Kein Profil vorhanden: selbst anlegen
        const { error: insertError } = await admin.from('profiles').insert({ id: userId, gender, display_name: displayName, username })
        if (insertError) {
          genderProblem = insertError.message
          continue
        }
      }

      const { data: check } = await admin.from('profiles').select('gender, display_name, username').eq('id', userId).maybeSingle()
      if (check?.gender === gender && check?.display_name === displayName && check?.username === username) genderSaved = true
      else genderProblem = 'Geschlecht, Name oder Benutzername wurden nicht richtig gespeichert.'
    }

    if (!genderSaved) {
      await admin.auth.admin.deleteUser(userId)
      return json({ error: 'Geschlecht, Name oder Benutzername konnten nicht gespeichert werden, es wurde keine E-Mail gesendet (' + genderProblem + ')' }, 500)
    }

    // 4b. Kann man sich mit diesem Benutzernamen wirklich anmelden? Die Anmeldung fragt get_email_by_username ab;
    //     sie muss die E-Mail-Adresse dieser Person liefern (die E-Mail im Profil kann einen Moment später da sein).
    let loginOk = false
    let loginProblem = 'keine Antwort'
    for (let attempt = 0; attempt < 6 && !loginOk; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500))
      const { data: found, error: lookupError } = await admin.rpc('get_email_by_username', { uname: username })
      if (lookupError) {
        loginProblem = lookupError.message
        continue
      }
      if (typeof found === 'string' && found.trim().toLowerCase() === email.trim().toLowerCase()) loginOk = true
      else loginProblem = 'Antwort der Datenbank: ' + JSON.stringify(found)
    }
    if (!loginOk) {
      await admin.auth.admin.deleteUser(userId)
      return json({ error: 'Mit dem Benutzernamen "' + username + '" könnte man sich nicht anmelden, es wurde keine E-Mail gesendet (' + loginProblem + ')' }, 500)
    }

    // 5. Jetzt erst die Einladungs-E-Mail senden
    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email.trim(), {
      data: userData,
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

    return json({ userId, genderSaved: true, usernameSaved: true, displayNameSaved: true, username, displayName, vipSaved })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})