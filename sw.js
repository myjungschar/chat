// Service Worker für Push-Benachrichtigungen. Läuft im Hintergrund, auch wenn die Seite (der Tab)
// gar nicht offen ist - dafür ist ein Service Worker überhaupt erst nötig, eine normale Webseite
// kann das nicht.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// Zugestellt: Kommt eine Push-Nachricht auf diesem Gerät an, meldet der Service Worker das der Datenbank (die Absender sehen dann
// die grauen Doppel-Häkchen), auch wenn die App gar nicht offen ist. Der Service Worker kennt die Anmeldung der Seite nicht,
// deshalb weist er sich mit seiner eigenen Push-Adresse aus (die Funktion push_delivered schlägt damit die Person nach).
// Der Schlüssel unten ist der öffentliche anon-Schlüssel, derselbe wie in script.js.
const SUPABASE_URL = 'https://qawjgxikppiumpptchow.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhd2pneGlrcHBpdW1wcHRjaG93Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwMDc0NDYsImV4cCI6MjEwNTU4MzQ0Nn0.CIhHOS2Zznk9pYbWWTrcqO2A-QWbSSGAJC7TY0UQgTs'

async function reportDelivered(chatKey, createdAt) {
  try {
    if (!chatKey || !createdAt) return
    const sub = await self.registration.pushManager.getSubscription()
    if (!sub) return
    await fetch(SUPABASE_URL + '/rest/v1/rpc/push_delivered', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ p_endpoint: sub.endpoint, p_chat_key: chatKey, p_at: createdAt }),
      keepalive: true
    })
  } catch (e) {
    // Nicht schlimm: dann gilt die Nachricht erst als zugestellt, wenn die App sie selbst holt
  }
}

// Trifft eine Push-Nachricht vom Server ein: die kleine System-Benachrichtigung anzeigen
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    data = { title: 'JungscharChat', body: event.data ? event.data.text() : 'Neue Nachricht' }
  }

  const title = data.title || 'JungscharChat'
  const options = {
    body: data.body || '',
    // Passt diese beiden Pfade ggf. an, falls eure Icons anders heißen/liegen (siehe manifest.json)
    icon: data.icon || 'favicon.svg',
    badge: data.badge || 'favicon.svg',
    tag: data.tag || 'jungschar-chat', // gleicher Chat -> ersetzt die vorherige Meldung statt zu stapeln
    renotify: true,
    data: { url: data.url || './', chatKey: data.chatKey || data.chat_key || null }
  }

  event.waitUntil((async () => {
    const delivered = reportDelivered(options.data.chatKey, data.createdAt || data.created_at)

    // Ist die App gerade offen UND im Vordergrund (Fenster aktiv), kommt kein Banner - stattdessen sagt der
    // Service Worker der Seite, dass sie einen kurzen Ton abspielen soll. Ist die App zu, im Hintergrund oder
    // ein anderes Fenster aktiv, kommt wie gewohnt das Banner.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const active = windows.filter((c) => c.visibilityState === 'visible' && c.focused)
    if (active.length > 0) {
      active.forEach((c) => c.postMessage({ type: 'push-sound', tag: options.tag }))
      await delivered
      return
    }
    await self.registration.showNotification(title, options)
    await delivered
  })())
})

// Klick auf die Benachrichtigung: die Seite in den Vordergrund holen und ihr sagen, welcher Chat geöffnet werden
// soll (Nachricht "push-open"). Ist die App ganz zu, wird sie mit ?push=1 (und &chat=...) neu gestartet.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const info = event.notification.data || {}
  const url = info.url || './'
  const chatKey = info.chatKey || null

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ type: 'push-open', chatKey, url })
          return client.focus()
        }
      }
      if (self.clients.openWindow) {
        const target = new URL(url, self.registration.scope)
        target.searchParams.set('push', '1')
        if (chatKey) target.searchParams.set('chat', chatKey)
        return self.clients.openWindow(target.href)
      }
    })
  )
})