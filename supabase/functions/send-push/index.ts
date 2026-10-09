// @ts-nocheck
// (Die Zeile oben schaltet nur die roten Wellenlinien im Editor aus - der Editor kennt Deno nicht. Das Deployen ist davon unabhängig.)
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

// Eigene Gruppen haben als group_key "grp_<Gruppen-ID>"
const CUSTOM_GROUP = /^grp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

    // Zielgruppe bestimmen: einzelne Person (Direktnachricht), eigene Gruppe oder eine der festen Gruppen
    let recipientIds: string[] = []
    let groupName = ""

    if (record.recipient_id) {
      recipientIds = [record.recipient_id]
    } else if (typeof record.group_key === "string" && record.group_key.startsWith("grp_")) {
      // Eigene Gruppe: nur deren Mitglieder (ohne den Absender)
      if (!CUSTOM_GROUP.test(record.group_key)) {
        return new Response("ungültiger Gruppenschlüssel", { status: 200 })
      }
      const groupId = record.group_key.slice(4)
      const { data: members } = await supabaseAdmin
        .from("chat_group_members")
        .select("user_id")
        .eq("group_id", groupId)
        .neq("user_id", record.sender_id)
      recipientIds = (members || []).map((m) => m.user_id)

      const { data: group } = await supabaseAdmin
        .from("chat_groups")
        .select("name")
        .eq("id", groupId)
        .single()
      groupName = group?.name || ""
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

    // Chat-Schlüssel: "main", "junge", "maedchen", "grp_<id>" oder (Einzelchat) "dm:<Absender>"
    const chatKey = record.group_key || (record.recipient_id ? "dm:" + record.sender_id : "main")

    // Stummgeschaltete Gruppen: wer den Chat in muted_chats hat, bekommt keine Push-Meldung (Einzelchats sind nicht betroffen)
    if (!record.recipient_id && recipientIds.length > 0) {
      const { data: muted, error: mutedError } = await supabaseAdmin
        .from("muted_chats")
        .select("user_id")
        .eq("chat_key", chatKey)
        .in("user_id", recipientIds)
      if (mutedError) {
        console.error("muted_chats konnte nicht gelesen werden:", mutedError) // dann lieber zu viel als zu wenig melden
      } else {
        const mutedIds = new Set((muted || []).map((m) => m.user_id))
        recipientIds = recipientIds.filter((id) => !mutedIds.has(id))
      }
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

    const senderName = sender.display_name || "Neue Nachricht"
    // Fotos und Audios haben oft keinen Text: dann steht stattdessen ein kurzer Hinweis in der Meldung
    const bodyText = (record.text || (record.photo_id ? "📷 Foto" : record.audio_id ? "🎵 Audio" : "")).slice(0, 120)
    const notificationPayload = JSON.stringify({
      title: groupName ? senderName + " · " + groupName : senderName,
      body: bodyText,
      tag: chatKey,
      chatKey, // damit ein Klick auf die Meldung genau diesen Chat öffnet
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