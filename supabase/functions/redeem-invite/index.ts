// @ts-nocheck
// (Die Zeile oben schaltet nur die roten Wellenlinien im Editor aus - der Editor kennt Deno nicht.)
//
// Supabase Edge Function "redeem-invite"
// Löst den Einladungs-Link der E-Mail ein: ...chat/?invite=<Code>
// Der Code läuft NICHT zeitlich ab. Er gilt, bis die eingeladene Person ihr Passwort gesetzt hat.
// Er besteht aus der E-Mail-Adresse und einer Signatur (HMAC mit dem geheimen Schlüssel INVITE_SECRET), kann also
// nicht erraten oder für andere Adressen gebaut werden. Erzeugt wird er von der Funktion "invite-user".
//
// Ablegen als: supabase/functions/redeem-invite/index.ts
// Deployen mit: npx supabase functions deploy redeem-invite --use-api --no-verify-jwt
// Einmalig nötig: npx supabase secrets set INVITE_SECRET=<langer zufälliger Text>

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

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })
}

const toB64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

function fromB64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

async function sign(secret: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("invite:" + email))
  return toB64Url(new Uint8Array(mac))
}

// Gleicher Vergleich in immer gleicher Zeit, damit man die Signatur nicht Zeichen für Zeichen erraten kann
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return json(405, { error: "Nur POST erlaubt." })

  try {
    const secret = Deno.env.get("INVITE_SECRET")
    if (!secret) return json(500, { error: "Der Server ist noch nicht eingerichtet (INVITE_SECRET fehlt)." })

    const { token } = await req.json()
    if (typeof token !== "string" || token.length > 400 || !token.includes(".")) {
      return json(400, { error: "Der Einladungs-Link ist nicht gültig." })
    }

    const [emailPart, signaturePart] = token.split(".")
    let email = ""
    try {
      email = new TextDecoder().decode(fromB64Url(emailPart)).trim().toLowerCase()
    } catch {
      return json(400, { error: "Der Einladungs-Link ist nicht gültig." })
    }
    if (!email || email.length > 254 || !email.includes("@")) return json(400, { error: "Der Einladungs-Link ist nicht gültig." })

    const expected = await sign(secret, email)
    if (!safeEqual(expected, signaturePart || "")) return json(400, { error: "Der Einladungs-Link ist nicht gültig." })

    // Frischen Anmelde-Code für diese Person erzeugen (nur für den sofortigen Gebrauch)
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email })
    if (error || !data?.user || !data?.properties?.hashed_token) {
      console.error("redeem-invite generateLink:", error)
      return json(400, { error: "Zu dieser Einladung gibt es kein Konto mehr. Bitte fordere eine neue an." })
    }

    // Eingelöst werden darf nur, solange noch kein Passwort gesetzt wurde. Danach: ganz normal anmelden.
    const user = data.user
    const stillInvited = user.user_metadata?.needs_password === true || !user.last_sign_in_at
    if (!stillInvited) return json(410, { error: "Diese Einladung wurde schon benutzt. Melde dich einfach mit deinem Namen und Passwort an." })

    return json(200, { token_hash: data.properties.hashed_token })
  } catch (err) {
    console.error("redeem-invite Fehler:", err)
    return json(500, { error: "Serverfehler." })
  }
})