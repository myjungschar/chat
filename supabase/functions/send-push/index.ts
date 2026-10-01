// Supabase Edge Function "invite-user"
// Wird von der App aufgerufen, wenn ein Admin unter "Nutzer verwalten" → "Neuen Nutzer hinzufügen"
// eine E-Mail-Adresse einträgt. Legt das Konto an und verschickt die Einladungs-Mail
// (das in Supabase hinterlegte "Invite user"-Template, über euer eigenes SMTP verschickt).
//
// Die Person landet über den Link in der Mail wieder auf APP_URL, dort erkennt script.js
// automatisch den Einladungs-Modus und zeigt "Neues Passwort setzen" mit ihrem Namen an.

import { createClient } from "npm:@supabase/supabase-js@2"

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
)

Deno.serve(async (req) => {
  try {
    // Nur eingeloggte Admins dürfen das - die aufrufende Person über ihr eigenes Token prüfen
    const authHeader = req.headers.get("Authorization") || ""
    const jwt = authHeader.replace("Bearer ", "")
    const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(jwt)
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Nicht angemeldet." }), { status: 401 })
    }

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()

    if (!profile || profile.role !== "admin") {
      return new Response(JSON.stringify({ error: "Nur der Admin darf Nutzer einladen." }), { status: 403 })
    }

    const { email } = await req.json()
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return new Response(JSON.stringify({ error: "Ungültige E-Mail-Adresse." }), { status: 400 })
    }

    const redirectTo = Deno.env.get("APP_URL") // z.B. https://levi.github.io/jungschar-chat/

    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo
    })

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 })
    }

    return new Response(JSON.stringify({ ok: true, userId: data.user.id }), { status: 200 })
  } catch (err) {
    console.error("invite-user Fehler:", err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
