// Edge Function "delete-user": löscht ein Nutzerkonto endgültig. Nur für Admins.
// Aufruf aus der App: supabase.functions.invoke('delete-user', { body: { userId } })
//
// Wie bei "invite-user": auth: "user" verlangt das JWT des angemeldeten Nutzers,
// danach wird zusätzlich geprüft, ob dieser Nutzer in "profiles" die Rolle "admin" hat.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

const json = (body: Record<string, unknown>, status = 200) =>
  Response.json(body, { status });

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Nur POST ist erlaubt." }, 405);
    }

    // 1. Wer ruft auf? (Identität aus dem geprüften JWT)
    const callerId = ctx.userClaims?.id;
    if (!callerId) {
      return json({ error: "Nicht angemeldet." }, 401);
    }

    // 2. Nur Admins dürfen löschen
    const { data: caller, error: callerError } = await ctx.supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", callerId)
      .single();

    if (callerError || caller?.role !== "admin") {
      return json({ error: "Nur Admins dürfen Nutzer löschen." }, 403);
    }

    // 3. Wer soll gelöscht werden?
    let userId = "";
    try {
      const body = await req.json();
      userId = String(body?.userId ?? "").trim();
    } catch {
      return json({ error: "Ungültige Anfrage." }, 400);
    }
    if (!/^[0-9a-f-]{36}$/i.test(userId)) {
      return json({ error: "Ungültige Nutzer-ID." }, 400);
    }

    // 4. Sicherheitsnetz: den eigenen Admin-Account kann man nicht löschen
    if (userId === callerId) {
      return json({ error: "Du kannst dich nicht selbst löschen." }, 400);
    }

    // 5. Konto löschen
    const { error } = await ctx.supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) {
      console.error("deleteUser fehlgeschlagen:", error);
      return json({ error: error.message ?? "Löschen fehlgeschlagen." }, 400);
    }

    return json({ ok: true });
  }),
};
