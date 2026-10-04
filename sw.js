// Service Worker für Push-Benachrichtigungen. Läuft im Hintergrund, auch wenn die Seite (der Tab)
// gar nicht offen ist - dafür ist ein Service Worker überhaupt erst nötig, eine normale Webseite
// kann das nicht.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

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
    data: { url: data.url || './' }
  }

  event.waitUntil((async () => {
    // Ist die App gerade offen UND im Vordergrund (Fenster aktiv), kommt kein Banner - stattdessen sagt der
    // Service Worker der Seite, dass sie einen kurzen Ton abspielen soll. Ist die App zu, im Hintergrund oder
    // ein anderes Fenster aktiv, kommt wie gewohnt das Banner.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const active = windows.filter((c) => c.visibilityState === 'visible' && c.focused)
    if (active.length > 0) {
      active.forEach((c) => c.postMessage({ type: 'push-sound', tag: options.tag }))
      return
    }
    await self.registration.showNotification(title, options)
  })())
})

// Klick auf die Benachrichtigung: die Seite in den Vordergrund holen (oder neu öffnen)
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || './'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
    })
  )
})