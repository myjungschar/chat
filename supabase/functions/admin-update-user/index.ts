// @ts-nocheck
// (Die Zeile oben schaltet nur die roten Wellenlinien im Editor aus - der Editor kennt Deno nicht. Das Deployen ist davon unabhängig.)
// Supabase Edge Function "admin-update-user"
// Ändert die E-Mail-Adresse einer Person (steht in auth.users, nur mit Service-Schlüssel änderbar).
// Nur der Admin darf das: der Aufrufer wird über sein Token geprüft und muss in "profiles" die Rolle "admin" haben.
//
// Ablegen als: supabase/functions/admin-update-user/index.ts
// Deployen mit: npx supabase functions deploy admin-update-user --use-api

import { createClient } from "npm:@supabase/supabase-js@2"

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  })
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return json(405, { error: "Nur POST erlaubt." })

  try {
    // Wer ruft auf? Token prüfen und nachsehen, ob die Person Admin ist
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
    if (!token) return json(401, { error: "Nicht angemeldet." })
    const { data: auth, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !auth?.user) return json(401, { error: "Nicht angemeldet." })

    const { data: caller } = await supabaseAdmin.from("profiles").select("role").eq("id", auth.user.id).single()
    if (!caller || caller.role !== "admin") return json(403, { error: "Nur der Admin darf das." })

    const { userId, email } = await req.json()
    if (typeof userId !== "string" || !UUID.test(userId)) return json(400, { error: "Ungültige Nutzer-ID." })
    const newEmail = typeof email === "string" ? email.trim().toLowerCase() : ""
    if (!EMAIL.test(newEmail) || newEmail.length > 254) return json(400, { error: "Ungültige E-Mail-Adresse." })

    // email_confirm: die neue Adresse gilt sofort, es wird keine Bestätigungs-Mail verschickt
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { email: newEmail, email_confirm: true })
    if (error) {
      const taken = /already|registered|exists|duplicate/i.test(error.message)
      return json(taken ? 409 : 400, { error: taken ? "Diese E-Mail-Adresse wird schon verwendet." : error.message })
    }
    return json(200, { ok: true, email: newEmail })
  } catch (err) {
    console.error("admin-update-user Fehler:", err)
    return json(500, { error: "Serverfehler: " + err })
  }
})