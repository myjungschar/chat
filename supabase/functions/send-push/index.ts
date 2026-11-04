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

// ===== Text für die Meldung aufbereiten =====
// Im Chat werden *fett*, _kursiv_, ~durchgestrichen~, `Code` und "> Zitat" beim Anzeigen formatiert. In der Push-Meldung
// gibt es keine Formatierung, deshalb fallen die Zeichen hier weg (gleiche Regeln wie stripFormatting in script.js).
// Einladungen ("🎉 Einladung: ...") werden als Titel plus Datum gezeigt.
function isFormatBoundary(ch) {
  return ch === undefined || !/[\p{L}\p{N}]/u.test(ch)
}

function parseInlineFormat(text) {
  const MARKS = { "*": "b", "_": "i", "~": "s", "`": "code" }
  const out = []
  let buf = ""
  let i = 0
  const flush = () => { if (buf) { out.push({ type: "text", value: buf }); buf = "" } }

  while (i < text.length) {
    const c = text[i]
    const type = MARKS[c]
    if (type && isFormatBoundary(text[i - 1]) && text[i + 1] !== undefined && !/\s/.test(text[i + 1]) && text[i + 1] !== c) {
      let close = -1
      let j = i + 1
      while (j < text.length) {
        j = text.indexOf(c, j)
        if (j === -1) break
        if (j > i + 1 && !/\s/.test(text[j - 1]) && isFormatBoundary(text[j + 1])) { close = j; break }
        j++
      }
      if (close !== -1) {
        flush()
        const inner = text.slice(i + 1, close)
        out.push(type === "code" ? { type, value: inner } : { type, children: parseInlineFormat(inner) })
        i = close + 1
        continue
      }
    }
    buf += c
    i++
  }
  flush()
  return out
}

function stripFormatting(text) {
  const flat = (nodes) => nodes.map((n) => (n.type === "text" || n.type === "code" ? n.value : flat(n.children))).join("")
  return String(text)
    .replace(/```([\s\S]*?)```/g, (_m, c) => c.trim())
    .split("\n")
    .map((line) => flat(parseInlineFormat(line.replace(/^>\s+/, ""))))
    .join("\n")
}

function pushText(text) {
  const INVITE_HEAD = "🎉 Einladung: "
  const INVITE_WHEN = "📅 Wann: "
  if (text.startsWith(INVITE_HEAD)) {
    const lines = text.split("\n")
    const when = lines[1] && lines[1].startsWith(INVITE_WHEN) ? lines[1].slice(INVITE_WHEN.length).trim() : ""
    return lines[0].trim() + (when ? " · " + when : "")
  }
  return stripFormatting(text)
}

// Schickt die fertige Meldung an alle Geräte (Abos) und räumt abgelaufene/ungültige Abos wieder weg
async function sendToSubscriptions(subs, notificationPayload: string) {
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
}

// Antwort des Admins in der Unterhaltung zu einer Rückmeldung (Tabelle feedback_messages): Meldung nur an die Person,
// der die Rückmeldung gehört. An den Admin selbst gibt es nie eine Push-Meldung.
async function handleFeedbackMessage(record) {
  if (!record || !record.sender_id || !record.feedback_id) {
    return new Response("kein passender Datensatz", { status: 200 })
  }
  const { data: sender } = await supabaseAdmin.from("profiles").select("role").eq("id", record.sender_id).single()
  if (!sender || sender.role !== "admin") {
    return new Response("keine Push-Meldung an den Admin", { status: 200 })
  }
  const { data: feedback } = await supabaseAdmin.from("feedback").select("user_id").eq("id", record.feedback_id).single()
  if (!feedback || !feedback.user_id) {
    return new Response("Rückmeldung nicht gefunden", { status: 200 })
  }
  const { data: subs } = await supabaseAdmin.from("push_subscriptions").select("*").eq("user_id", feedback.user_id)
  if (!subs || subs.length === 0) {
    return new Response("niemand hat Push aktiviert", { status: 200 })
  }

  const key = "feedback:" + record.feedback_id
  // Bewusst ohne createdAt: sonst würde der Service Worker die Meldung als "zugestellt" für einen Chat melden
  const notificationPayload = JSON.stringify({
    title: "Antwort vom Admin",
    body: String(record.text || "").slice(0, 120),
    tag: key,
    chatKey: key,
    url: "./"
  })
  await sendToSubscriptions(subs, notificationPayload)
  return new Response("ok", { status: 200 })
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json()
    const record = payload.record

    if (payload.table === "feedback_messages") {
      return await handleFeedbackMessage(record)
    }

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
      // Namen wie in der Chatliste, damit man in der Meldung sieht, um welche Gruppe es geht
      groupName = record.group_key === "junge" ? "Jungs" : record.group_key === "maedchen" ? "Mädels" : "JungscharChat"
    }

    // Chat-Schlüssel: "main", "junge", "maedchen", "grp_<id>" oder (Einzelchat) "dm:<Absender>"
    const chatKey = record.group_key || (record.recipient_id ? "dm:" + record.sender_id : "main")

    // Stummgeschaltete Chats: wer den Chat in muted_chats hat, bekommt keine Push-Meldung.
    // Bei Gruppen heißt der Schlüssel "main"/"junge"/"maedchen"/"grp_<id>", bei Einzelchats "dm:<Absender>".
    if (recipientIds.length > 0) {
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
    // Dateien (PDF, Word ...) liegen in den Audio-Spalten, erkennbar am audio_mime, der nicht mit "audio/" anfängt
    const fileHint = record.audio_id
      ? (record.audio_mime && !String(record.audio_mime).startsWith("audio/")
          ? (record.audio_mime === "application/pdf" ? "📄 PDF" : "📎 Datei")
          : (/^Sprachnachricht \d{4}-\d{2}-\d{2} \d{2}-\d{2}(\.[a-z0-9]+)?$/i.test(String(record.audio_name || "")) ? "🎤 Sprachnachricht" : "🎵 Audio"))
      : ""
    const bodyText = (record.text ? pushText(record.text) : (record.photo_id ? "📷 Foto" : fileHint)).slice(0, 120)
    const notificationPayload = JSON.stringify({
      title: groupName ? senderName + " · " + groupName : senderName,
      body: bodyText,
      tag: chatKey,
      chatKey, // damit ein Klick auf die Meldung genau diesen Chat öffnet
      createdAt: record.created_at, // damit der Service Worker "zugestellt" für genau diese Nachricht melden kann
      url: "./"
    })

    await sendToSubscriptions(subs, notificationPayload)

    return new Response("ok", { status: 200 })
  } catch (err) {
    console.error("send-push Fehler:", err)
    return new Response("Fehler: " + err, { status: 500 })
  }
})