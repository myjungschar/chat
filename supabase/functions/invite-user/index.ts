// Edge Function "invite-user": verschickt eine Einladungs-E-Mail an eine neue Person.
// Aufruf aus der App: supabase.functions.invoke('invite-user', { body: { email } })
//
// WICHTIG: Die Vorlage von Supabase erlaubte hier nur "publishable" | "secret" (also API-Keys im
// apikey-Header). Das Admin-JWT aus der App wurde damit abgewiesen -> 401 -> "non-2xx status code".
// Hier ist es auf auth: "user" umgestellt: Es muss ein gültiges JWT eines angemeldeten Nutzers
// im Authorization-Header kommen, und danach wird zusätzlich geprüft, ob dieser Nutzer Admin ist.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

const json = (body: Record<string, unknown>, status = 200) =>
  Response.json(body, { status });

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Nur POST ist erlaubt." }, 405);
    }

    // 1. Wer ruft auf? (Identität kommt aus dem geprüften JWT, nicht aus dem Request-Body)
    const callerId = ctx.userClaims?.id;
    if (!callerId) {
      return json({ error: "Nicht angemeldet." }, 401);
    }

    // 2. Nur Admins dürfen einladen (Rolle steht in der Tabelle "profiles")
    const { data: caller, error: callerError } = await ctx.supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", callerId)
      .single();

    if (callerError || caller?.role !== "admin") {
      return json({ error: "Nur Admins dürfen Einladungen verschicken." }, 403);
    }

    // 3. E-Mail aus dem Body lesen und prüfen
    let email = "";
    try {
      const body = await req.json();
      email = String(body?.email ?? "").trim().toLowerCase();
    } catch {
      return json({ error: "Ungültige Anfrage." }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "Bitte eine gültige E-Mail-Adresse angeben." }, 400);
    }

    // 4. Wohin soll der Link in der Mail führen? (Secret APP_URL)
    const appUrl = Deno.env.get("APP_URL");
    if (!appUrl) {
      console.error("Secret APP_URL ist nicht gesetzt.");
      return json({ error: "Serverfehler: APP_URL ist nicht gesetzt." }, 500);
    }

    // 5. Einladung verschicken. Das Konto wird dabei angelegt; needs_password markiert, dass die
    //    Person noch ein eigenes Passwort setzen muss (die App sperrt den Chat bis dahin).
    const { error } = await ctx.supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: appUrl,
      data: { needs_password: true },
    });

    if (error) {
      console.error("inviteUserByEmail fehlgeschlagen:", error);
      const message = error.message ?? "Unbekannter Fehler";
      if (/already (been )?registered|already exists/i.test(message)) {
        return json({ error: "Diese E-Mail-Adresse ist bereits registriert." }, 409);
      }
      return json({ error: message }, 400);
    }

    return json({ ok: true });
  }),
};