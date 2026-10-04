// Supabase Edge Function "send-push"
// Wird über einen Database Webhook aufgerufen, sobald eine neue Zeile in "messages" oder
// "direct_messages" eingefügt wird, und verschickt dafür echte Web-Push-Benachrichtigungen -
// auch an Geräte, bei denen die Seite gerade gar nicht offen ist.
//
// Einrichtung: siehe die Anleitung, die Levi dazu bekommen hat.

import webpush from "npm:web-push@3.6.7"
import { createClient } from "npm:@supabase/supabase-js@2"

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
)

webpush.setVapidDetails(
  "mailto:" + (Deno.env.get("VAPID_CONTACT_EMAIL") || "admin@example.com"),
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!
)

Deno.serve(async (req) => {
  try {
    const payload = await req.json()
    const record = payload.record

    if (!record || !record.sender_id) {
      return new Response("kein passender Datensatz", { status: 200 })
    }

    // Admin-Nachrichten lösen laut Vorgabe nie eine Push-Benachrichtigung aus
    const { data: sender } = await supabaseAdmin
      .from("profiles")
      .select("display_name, role")
      .eq("id", record.sender_id)
      .single()

    if (!sender || sender.role === "admin") {
      return new Response("Admin-Nachricht - keine Push-Meldung", { status: 200 })
    }

    // Zielgruppe bestimmen: einzelne Person (Direktnachricht) oder eine ganze Gruppe
    let recipientIds: string[] = []

    if (record.recipient_id) {
      recipientIds = [record.recipient_id]
    } else {
      let query = supabaseAdmin
        .from("profiles")
        .select("id")
        .neq("id", record.sender_id)
        .neq("role", "admin")

      if (record.group_key) query = query.eq("gender", record.group_key) // "junge" oder "maedchen"
      const { data: members } = await query
      recipientIds = (members || []).map((m) => m.id)
    }

    if (recipientIds.length === 0) {
      return new Response("keine Empfänger", { status: 200 })
    }

    const { data: subs } = await supabaseAdmin
      .from("push_subscriptions")
      .select("*")
      .in("user_id", recipientIds)

    if (!subs || subs.length === 0) {
      return new Response("niemand hat Push aktiviert", { status: 200 })
    }

    const chatKey = record.group_key || (record.recipient_id ? "dm:" + record.sender_id : "main")
    const bodyText = (record.text || "").slice(0, 120)
    const notificationPayload = JSON.stringify({
      title: sender.display_name || "Neue Nachricht",
      body: bodyText,
      tag: chatKey,
      url: "./"
    })

    // urgency "high": Android/Samsung stellt die Nachricht sofort zu, auch wenn das Handy ruht (Energiesparen/Doze).
    // Ohne diese Angabe wird eine Push-Nachricht oft erst nach Minuten ausgeliefert.
    // TTL: so lange hält der Push-Dienst die Nachricht für ein gerade ausgeschaltetes/offline Handy bereit (1 Stunde).
    // timeout: ein hängender Empfänger bremst die anderen nicht ewig aus.
    const pushOptions = { urgency: "high" as const, TTL: 3600, timeout: 10000 }

    const results = await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          notificationPayload,
          pushOptions
        )
      )
    )

    // Abgelaufene/ungültige Abos (Gerät abgemeldet, Browser deinstalliert, ...) wieder entfernen
    await Promise.all(
      results.map((result, i) => {
        if (result.status === "rejected") {
          const statusCode = result.reason?.statusCode
          if (statusCode === 404 || statusCode === 410) {
            return supabaseAdmin.from("push_subscriptions").delete().eq("endpoint", subs[i].endpoint)
          }
        }
        return Promise.resolve()
      })
    )

    return new Response("ok", { status: 200 })
  } catch (err) {
    console.error("send-push Fehler:", err)
    return new Response("Fehler: " + err, { status: 500 })
  }
})