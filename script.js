// 1. Supabase Client initialisieren
const SUPABASE_URL = 'https://qawjgxikppiumpptchow.supabase.co' // Aus Settings -> API
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhd2pneGlrcHBpdW1wcHRjaG93Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwMDc0NDYsImV4cCI6MjEwNTU4MzQ0Nn0.CIhHOS2Zznk9pYbWWTrcqO2A-QWbSSGAJC7TY0UQgTs'     // Aus Settings -> API

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)

// --- Zustand der App ---
let currentUser = null      // Auth-User (id, email)
let currentProfile = null   // Zeile aus "profiles" (display_name, role, is_blocked)
let profileCache = {}       // id -> display_name, für Realtime-Nachrichten und die Chatliste
let chatChannel = null      // Realtime-Channel für die aktuell geöffnete Ansicht
let recoveryMode = false    // true, solange ein "Passwort vergessen"-Link verarbeitet wird
// true, wenn die Seite gerade über einen Einladungs-Link geöffnet wurde (neuer Nutzer, erster Login).
// Muss VOR dem ersten await abgefragt werden, weil Supabase "type=invite" danach aus der Adresszeile entfernt.
let inviteMode = window.location.hash.includes('type=invite')
let groupPreviews = {}      // 'main'/'junge'/'maedchen' -> letzte Nachricht, für die Chatliste
let dmPreviews = {}         // andere Nutzer-ID -> letzte Nachricht, für die Chatliste
let readMarks = {}          // chat_key -> Zeitpunkt der letzten eigenen Lesemarkierung
let unreadCounts = {}        // chat_key -> Anzahl ungelesener Nachrichten, für die Chatliste
// Häkchen/Nachrichten-Info (braucht die Tabelle delivery_marks in Supabase). Erst auf true stellen,
// wenn das SQL dafür ausgeführt wurde - bis dahin ist alles davon ausgeschaltet.
const READ_RECEIPTS_ENABLED = true

let peerMarks = {}          // user_id -> { readAt, deliveredAt } der anderen Teilnehmer im offenen Chat, für die Häkchen
let peerChannel = null      // Realtime: Lese-/Zustellmarkierungen der anderen im offenen Chat
let inboxChannel = null     // Realtime: neue Nachrichten, solange man eingeloggt ist (für "zugestellt")
let deliveredReported = {}  // chat_key -> ms der neuesten Nachricht, für die "zugestellt" schon gemeldet wurde
let deliveredPending = {}   // chat_key -> { ms, iso }, wartet auf das gebündelte Absenden
let deliveredTimer = null
let pollsMap = {}           // poll_id -> Umfrage samt Stimmen, für den gerade offenen Chat
let pollsChannel = null     // Realtime: neue Umfragen und Stimmen im offenen Chat
let messagesById = {}       // id -> ganze Nachricht, für die Antwort-Zitate
let lastMessageDateKey = null // Tag der zuletzt gezeichneten Nachricht, für die Datums-Trenner
let selectMode = false          // true, solange mehrere Nachrichten zum Löschen ausgewählt werden
let selectedMessageIds = new Set() // IDs (als Text) der gerade ausgewählten Nachrichten
let reactionMap = {}        // message_id -> { up, down, mine }, für den gerade offenen Chat

// Welcher Chat ist gerade offen: die Gruppe oder ein Einzelchat mit einer bestimmten Person
let currentRoom = { type: 'group' }

function isAdmin() {
  return currentProfile && currentProfile.role === 'admin'
}

// Kleine, feste Farbpalette für Avatare, damit jeder Nutzer immer dieselbe Farbe bekommt
const AVATAR_COLORS = ['#5b8def', '#3fb98c', '#e2a33d', '#e2665f', '#9d6fe0', '#3fb0c9', '#d16fa8']

function avatarColor(id) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

// Initialen für das Profilbild: Anfangsbuchstabe von Vor- UND Nachname ("Levi Betke" -> "LB").
// Bei nur einem Namen bleibt es bei einem Buchstaben. Trenner: Leerzeichen, Punkt, Unterstrich, Bindestrich.
function initialsOf(name) {
  const parts = (name || '?').trim().split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = Array.from(parts[0])[0]
  if (parts.length === 1) return first.toUpperCase()
  const last = Array.from(parts[parts.length - 1])[0]
  return (first + last).toUpperCase()
}

// Eigenes Pop-up statt der Browser-Meldung, z. B. zum Bestätigen einer Löschung
let confirmModalCallback = null

function showConfirmModal(text, onConfirm) {
  confirmModalCallback = onConfirm
  document.getElementById('confirm-modal-text').textContent = text
  document.getElementById('confirm-modal').style.display = 'flex'
}

function confirmModalYes() {
  document.getElementById('confirm-modal').style.display = 'none'
  const callback = confirmModalCallback
  confirmModalCallback = null
  if (callback) callback()
}

function confirmModalNo() {
  document.getElementById('confirm-modal').style.display = 'none'
  confirmModalCallback = null
}

// Dunkler/heller Modus, gespeichert im Browser (nur auf diesem Gerät)
function applyStoredTheme() {
  const stored = localStorage.getItem('theme')
  const isLight = stored === 'light'
  document.body.classList.toggle('light-theme', isLight)
  syncThemeSwitches(!isLight)
}

function toggleDarkMode() {
  const toggle = document.getElementById('dark-mode-toggle')
  setTheme(toggle.checked)
}

// Der Schalter oben rechts auf dem Login-Bildschirm - derselbe wie in den Einstellungen, nur
// ohne dass man sich dafür erst einloggen und dorthin navigieren muss
function setTheme(wantsDark) {
  document.body.classList.toggle('light-theme', !wantsDark)
  localStorage.setItem('theme', wantsDark ? 'dark' : 'light')
  syncThemeSwitches(wantsDark)
}

// Hält beide Schalter (Login-Bildschirm + Einstellungen) auf demselben Stand
function syncThemeSwitches(wantsDark) {
  const settingsToggle = document.getElementById('dark-mode-toggle')
  const loginToggle = document.getElementById('theme-switch-input')
  if (settingsToggle) settingsToggle.checked = wantsDark
  if (loginToggle) loginToggle.checked = wantsDark
}

// "Wer wir sind" zeigt/versteckt die eigene Karte "Über uns" direkt unter der Login-Karte
function toggleAboutInline() {
  const aboutCard = document.getElementById('about-card')
  if (aboutCard) aboutCard.classList.toggle('open')
}

applyStoredTheme()

// 2. Start: gespeicherte Session prüfen (Auto-Login nach Neuladen),
//    oder erkennen, dass gerade ein "Passwort vergessen"-Link geöffnet wurde
async function init() {
  supabaseClient.auth.onAuthStateChange((event, session) => {
    // Im Callback keine Supabase-Aufrufe mit await (kann die Auth-Library blockieren)
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true
      showPasswordReset()
    } else if (event === 'SIGNED_IN' && inviteMode) {
      const inviteUserId = session.user.id
      setTimeout(() => showInviteSetup(inviteUserId), 0)
    } else if (event === 'SIGNED_OUT' && !recoveryMode && !inviteMode) {
      setTimeout(showLogin, 0)
    }
  })

  // Abgelaufener oder schon benutzter Link: Supabase hängt den Fehler an die Adresse (#error=...&error_code=otp_expired)
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const linkError = hashParams.get('error_code') || hashParams.get('error')

  const { data: { session } } = await supabaseClient.auth.getSession()
  if (recoveryMode || inviteMode) return // die Weiche oben zeigt bereits den passenden Bildschirm

  if (linkError) history.replaceState(null, '', window.location.pathname + window.location.search)

  if (session) {
    await enterApp(session.user)
  } else {
    showLogin()
  }

  if (linkError) {
    showToast('Der Link ist abgelaufen oder wurde schon benutzt. Bitte lass dir einen neuen Link schicken.')
  }
}

// ===== Bildschirme: Handy = ein Bildschirm nach dem anderen, PC = zwei Spalten =====
// Am PC (ab 900px Breite) bleibt links immer die Chatliste bzw. Einstellungen sichtbar
// und rechts steht der geöffnete Chat. Login-Bildschirme bleiben immer einspaltig.
const desktopQuery = window.matchMedia('(min-width: 900px)')
const AUTH_SCREENS = ['login-bereich', 'forgot-bereich', 'reset-bereich']
const LEFT_SCREENS = ['list-bereich', 'settings-bereich', 'users-bereich', 'admin-contacts-bereich']
// Rechts: Chat oder die Unterseiten der Einstellungen (am Handy sind das eigene volle Seiten)
const RIGHT_SCREENS = ['conversation-bereich', 'email-change-bereich', 'password-change-bereich', 'devices-bereich', 'user-detail-bereich', 'new-user-bereich']

function isSplitView() {
  return document.body.classList.contains('split-view')
}

function isConversationVisible() {
  return document.getElementById('conversation-bereich').style.display !== 'none'
}

function isRightVisible() {
  return RIGHT_SCREENS.some(id => document.getElementById(id).style.display !== 'none')
}

function isListVisible() {
  return document.getElementById('list-bereich').style.display !== 'none'
}

function showScreen(id) {
  const split = desktopQuery.matches && !AUTH_SCREENS.includes(id)
  document.body.classList.toggle('split-view', split)
  // Login/Passwort-Bildschirme bleiben immer eine kleine Karte in der Mitte, auch am Handy,
  // und nur dort zeigt sich die kleine Leiste oben rechts (Hell/Dunkel, "Wer sind wir")
  document.body.classList.toggle('auth-screen', AUTH_SCREENS.includes(id))
  // "Wer wir sind" gehört nur zum Login selbst - verlässt man den Bildschirm, ist die Karte wirklich weg,
  // nicht nur unsichtbar im Hintergrund
  if (id !== 'login-bereich') {
    const aboutCard = document.getElementById('about-card')
    if (aboutCard) aboutCard.classList.remove('open')
  }

  if (split) {
    // Nur die eigene Seite austauschen, die andere bleibt stehen
    AUTH_SCREENS.forEach(s => { document.getElementById(s).style.display = 'none' })
    const side = LEFT_SCREENS.includes(id) ? LEFT_SCREENS : RIGHT_SCREENS
    side.forEach(s => { document.getElementById(s).style.display = 'none' })
  } else {
    hideAllScreens()
  }

  // Immer flex-Spalte (auch am Handy) - das lässt Liste bzw. Nachrichtenverlauf über die volle Höhe scrollen
  document.getElementById(id).style.display = 'flex'
  document.body.classList.toggle('chat-open', isRightVisible())
}

// Fenster wird über/unter die 900px-Grenze gezogen: Ansicht passend neu aufbauen
function onLayoutChange() {
  if (!currentUser) return // Login-Ansichten sind immer einspaltig

  const rightOpen = RIGHT_SCREENS.find(id => document.getElementById(id).style.display !== 'none')
  const leftOpen = LEFT_SCREENS.find(id => document.getElementById(id).style.display !== 'none')

  if (desktopQuery.matches) {
    // Handy -> PC: Liste links dazuholen, falls vorher nur der Chat zu sehen war
    showScreen(leftOpen || 'list-bereich')
    if (!leftOpen) renderChatList()
    if (rightOpen) showScreen(rightOpen)
  } else {
    // PC -> Handy: nur eins von beidem behalten, und zwar den offenen Chat
    showScreen(rightOpen || leftOpen || 'list-bereich')
  }
  markActiveListItem()
}

// Ältere Browser (z. B. Safari vor 14) kennen nur addListener
if (desktopQuery.addEventListener) desktopQuery.addEventListener('change', onLayoutChange)
else if (desktopQuery.addListener) desktopQuery.addListener(onLayoutChange)

function hideAllScreens() {
  document.getElementById('login-bereich').style.display = 'none'
  document.getElementById('forgot-bereich').style.display = 'none'
  document.getElementById('reset-bereich').style.display = 'none'
  document.getElementById('list-bereich').style.display = 'none'
  document.getElementById('settings-bereich').style.display = 'none'
  document.getElementById('email-change-bereich').style.display = 'none'
  document.getElementById('password-change-bereich').style.display = 'none'
  document.getElementById('devices-bereich').style.display = 'none'
  document.getElementById('admin-contacts-bereich').style.display = 'none'
  document.getElementById('users-bereich').style.display = 'none'
  document.getElementById('user-detail-bereich').style.display = 'none'
  document.getElementById('new-user-bereich').style.display = 'none'
  document.getElementById('conversation-bereich').style.display = 'none'
  document.body.classList.remove('chat-open')
}

// Login-Ansicht anzeigen und alles Nutzerbezogene aufräumen
function showLogin() {
  stopListening()
  stopListListening()
  stopInboxChannel()
  stopPresence()
  clearTimeout(deliveredTimer)
  deliveredTimer = null
  deliveredReported = {}
  deliveredPending = {}
  currentUser = null
  currentProfile = null
  profileCache = {}
  currentRoom = { type: 'group' }
  latestSeenAt = null
  unreadCounts = {}
  peerMarks = {}
  pollsMap = {}

  const aboutCard = document.getElementById('about-card')
  if (aboutCard) aboutCard.classList.remove('open')
  document.getElementById('username').value = ''
  document.getElementById('password').value = ''
  refreshPasswordToggles()
  showScreen('login-bereich')
}

function showPasswordReset() {
  document.getElementById('reset-heading').textContent = 'Neues Passwort setzen'
  document.getElementById('reset-subtext').textContent = 'Bitte vergib ein neues Passwort, bevor es weitergeht.'
  showScreen('reset-bereich')
}

// Einladungs-Link geöffnet: derselbe Bildschirm wie "Passwort vergessen", nur mit Namen der Person
// und eigenem Hinweistext - und man kommt erst weiter, wenn ein neues Passwort gesetzt wurde.
async function showInviteSetup(userId) {
  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('display_name')
    .eq('id', userId)
    .single()

  const name = profile?.display_name
  document.getElementById('reset-heading').textContent = name ? `Willkommen, ${name}!` : 'Willkommen!'
  document.getElementById('reset-subtext').textContent =
    'Du wurdest eingeladen. Vergib zuerst ein eigenes Passwort, bevor es weitergeht.'
  showScreen('reset-bereich')
}

// Chatliste anzeigen (Startbildschirm nach dem Login): lädt Profil + Nutzerliste
async function enterApp(user) {
  // Eingeladene Person, die noch kein eigenes Passwort gesetzt hat: nicht in den Chat - auch nicht nach
  // einem Neuladen der Seite (dann ist der Link aus der Adresszeile schon weg, die Sitzung aber noch da).
  if (user.user_metadata && user.user_metadata.needs_password === true) {
    await showInviteSetup(user.id)
    return
  }

  const { data: profile, error } = await supabaseClient
    .from('profiles')
    .select('id, display_name, role, is_blocked, gender')
    .eq('id', user.id)
    .single()

  if (error || !profile) {
    showToast('Dein Profil konnte nicht geladen werden.')
    await supabaseClient.auth.signOut()
    showLogin()
    return
  }

  if (profile.is_blocked) {
    showToast('Dein Zugang wurde gesperrt. Bitte wende dich an die Leitung.')
    await supabaseClient.auth.signOut()
    showLogin()
    return
  }

  currentUser = user
  currentProfile = profile

  document.getElementById('user-display-name').innerText =
    profile.display_name || (user.email ? user.email.split('@')[0] : 'Nutzer')

  stopListening()
  hideAllScreens()
  showScreen('list-bereich')
  document.getElementById('chat-list').innerHTML = '<p class="chat-empty">Lädt …</p>'

  await loadProfileCache()
  await renderChatList()
  listenForListUpdates()
  startInboxChannel()

  if (isAdmin()) {
    // Der Admin bekommt nie Benachrichtigungen: Push-Abo dieses Geräts kündigen, Zahl auf dem App-Symbol entfernen
    teardownPushSubscription()
    updateAppBadge(0)
  } else {
    initPushForDevice()
  }
  startPresence()
}

// Letzte Nachricht je Chat laden, für die Vorschau in der Liste
async function loadChatPreviews() {
  // Alles erst lokal aufbauen und am Ende in einem Rutsch übernehmen: Laufen zwei Ladevorgänge
  // gleichzeitig (z. B. zwei Nachrichten kurz hintereinander), würden sich die Zähler sonst doppelt addieren.
  const me = currentUser.id
  const newGroupPreviews = {}
  const newDmPreviews = {}
  const newUnread = {}
  const newMarks = {}
  const newestFromOthers = {} // chat_key -> created_at der neuesten Nachricht von jemand anderem

  const { data: markRows } = await supabaseClient
    .from('read_marks')
    .select('chat_key, last_read_at')
    .eq('user_id', me)

  ;(markRows || []).forEach(m => { newMarks[m.chat_key] = new Date(m.last_read_at) })

  function countIfUnread(key, row) {
    if (row.sender_id === me) return
    const lastRead = newMarks[key]
    if (!lastRead || new Date(row.created_at) > lastRead) {
      newUnread[key] = (newUnread[key] || 0) + 1
    }
  }

  const { data: groupRows } = await supabaseClient
    .from('messages')
    .select('text, created_at, group_key, sender_id')
    .order('created_at', { ascending: false })
    .limit(300)

  if (groupRows) {
    groupRows.forEach(row => {
      const key = row.group_key || 'main'
      if (!newGroupPreviews[key]) newGroupPreviews[key] = row
      countIfUnread(key, row)
      if (row.sender_id !== me && !newestFromOthers[key]) newestFromOthers[key] = row.created_at
    })
  }

  const { data: dmRows } = await supabaseClient
    .from('direct_messages')
    .select('text, created_at, sender_id, recipient_id')
    .order('created_at', { ascending: false })
    .limit(400)

  if (dmRows) {
    dmRows.forEach(row => {
      const other = row.sender_id === me ? row.recipient_id : row.sender_id
      if (!newDmPreviews[other]) newDmPreviews[other] = row
      // Der Admin sieht alle Einzelchats nur zum Mitlesen - das sind nicht seine eigenen, also kein Zähler
      if (!isAdmin()) countIfUnread('dm:' + other, row)
      if (row.sender_id !== me && row.recipient_id === me && !newestFromOthers['dm:' + other]) {
        newestFromOthers['dm:' + other] = row.created_at
      }
    })
  }

  // Alles, was hier angekommen ist, gilt als zugestellt (die Absender sehen dann die grauen Doppel-Häkchen)
  Object.entries(newestFromOthers).forEach(([key, createdAt]) => queueDelivered(key, createdAt))

  groupPreviews = newGroupPreviews
  dmPreviews = newDmPreviews
  unreadCounts = newUnread
  readMarks = newMarks
  updateAppBadge(Object.values(unreadCounts).reduce((sum, n) => sum + n, 0))
}

// ===== Zustellung: "diese Nachricht ist auf dem Gerät des Empfängers angekommen" =====
// Wird gemeldet, sobald die App eine Nachricht bekommt (live) oder beim Laden der Chatliste nachholt.
// Der Admin ist nur Zuschauer und meldet nichts.
function queueDelivered(key, createdAt) {
  if (!READ_RECEIPTS_ENABLED || !currentUser || isAdmin() || !createdAt) return
  const ms = new Date(createdAt).getTime()
  if (ms <= (deliveredReported[key] || 0)) return
  if (deliveredPending[key] && deliveredPending[key].ms >= ms) return

  deliveredPending[key] = { ms: ms, iso: createdAt }
  // Kurz sammeln, damit mehrere Nachrichten hintereinander nur einen Schreibvorgang auslösen
  if (!deliveredTimer) deliveredTimer = setTimeout(flushDelivered, 400)
}

async function flushDelivered() {
  deliveredTimer = null
  const batch = deliveredPending
  deliveredPending = {}
  if (!currentUser) return

  const rows = Object.entries(batch).map(([key, v]) => ({
    user_id: currentUser.id,
    chat_key: key,
    delivered_at: v.iso
  }))
  if (rows.length === 0) return

  const { error } = await supabaseClient.from('delivery_marks').upsert(rows)
  if (error) {
    console.error('Zustellung konnte nicht gemeldet werden:', error)
    return
  }
  rows.forEach(r => { deliveredReported[r.chat_key] = new Date(r.delivered_at).getTime() })
}

// Läuft, solange man eingeloggt ist (egal welcher Bildschirm offen ist) und meldet neue Nachrichten als zugestellt
function startInboxChannel() {
  stopInboxChannel()
  if (!READ_RECEIPTS_ENABLED || !currentUser || isAdmin()) return
  const me = currentUser.id

  inboxChannel = supabaseClient
    .channel('inbox:' + me)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const row = payload.new
      if (row.sender_id === me) return
      queueDelivered(row.group_key || 'main', row.created_at)
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages' }, (payload) => {
      const row = payload.new
      if (row.recipient_id !== me) return
      queueDelivered('dm:' + row.sender_id, row.created_at)
    })
    .subscribe()
}

function stopInboxChannel() {
  if (inboxChannel) {
    supabaseClient.removeChannel(inboxChannel)
    inboxChannel = null
  }
}

// Kommt die App aus dem Hintergrund zurück (am PC: Tab/Fenster wieder sichtbar), könnte etwas verpasst worden sein
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !currentUser || isAdmin()) return
  if (isListVisible()) renderChatList()
  else if (READ_RECEIPTS_ENABLED) loadChatPreviews() // Zustellung nachholen
  // Ein offener Chat: was inzwischen angekommen ist, gilt jetzt als gelesen
  if (isConversationVisible()) markCurrentRoomRead()
})

// Welchen Schlüssel ein Chat für die Lesemarkierung hat (kein Schlüssel = wird nicht mitgezählt,
// z. B. wenn der Admin sich fremde Einzelchats nur ansieht)
function chatKeyForRoom(room) {
  if (room.type === 'dm') return 'dm:' + room.userId
  if (room.type === 'group') return room.groupKey || 'main'
  return null
}

// Zeitpunkt (Serverzeit) der neuesten Nachricht, die im gerade offenen Chat angezeigt wurde.
// Damit wird die Lesemarkierung gesetzt - nicht mit der Uhr des Handys, die falsch gehen kann.
let latestSeenAt = null

function noteSeenMessage(msg) {
  if (!msg.created_at) return
  if (!latestSeenAt || new Date(msg.created_at) > new Date(latestSeenAt)) {
    latestSeenAt = msg.created_at
  }
}

// Merkt sich, dass der gerade offene Chat bis zur neuesten gesehenen Nachricht gelesen wurde
async function markCurrentRoomRead() {
  const key = chatKeyForRoom(currentRoom)
  if (!key || !latestSeenAt || !currentUser) return

  const { error } = await supabaseClient.from('read_marks').upsert({
    user_id: currentUser.id,
    chat_key: key,
    last_read_at: latestSeenAt
  })
  if (error) console.error('Lesemarkierung konnte nicht gespeichert werden:', error)
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text
}

// Baut den Inhalt eines Listeneintrags: Avatar, Name, Vorschau-Text, Uhrzeit, Ungelesen-Zähler
function chatListItemHTML(avatarHTML, name, preview, unreadCount) {
  const previewText = preview ? truncate(preview.text, 34) : 'Noch keine Nachrichten'
  const timeText = preview ? formatChatListTime(preview.created_at) : 'Keine Nachrichten'
  const badge = unreadCount > 0
    ? `<span class="unread-badge">${unreadCount}</span>`
    : ''
  return `
    ${avatarHTML}
    <div class="chat-list-text">
      <div class="chat-list-name">${escapeHTML(name)}</div>
      <div class="chat-list-preview">${escapeHTML(previewText)}</div>
    </div>
    <div class="chat-list-time-badge">
      <div class="chat-list-time">${timeText}</div>
      ${badge}
    </div>
  `
}

// Welcher Reiter über der Chatliste gerade ausgewählt ist ("alle", "gruppen", "junge", "maedchen")
let activeChatTab = 'alle'

// Chatliste zusammenbauen: Gruppe angeheftet, danach alle anderen Nutzer
let chatListRenderId = 0

async function renderChatList() {
  const myRenderId = ++chatListRenderId
  await loadChatPreviews()
  // Zwischenzeitlich ausgeloggt oder schon ein neuerer Ladevorgang gestartet? Dann nichts mehr zeichnen
  if (!currentUser || myRenderId !== chatListRenderId) return

  const list = document.getElementById('chat-list')
  list.innerHTML = ''

  const groupItem = document.createElement('li')
  groupItem.className = 'chat-list-item pinned'
  groupItem.innerHTML = chatListItemHTML(
    '<div class="chat-list-avatar group-avatar">📌</div>',
    'JungscharChat',
    groupPreviews['main'],
    unreadFor('main')
  )
  groupItem.dataset.chatKey = 'main'
  groupItem.dataset.tabs = 'alle gruppen'
  groupItem.dataset.name = 'JungscharChat'
  groupItem.addEventListener('click', openGroupChat)
  list.appendChild(groupItem)

  if (isAdmin() || currentProfile.gender === 'junge') {
    const item = document.createElement('li')
    item.className = 'chat-list-item pinned'
    item.innerHTML = chatListItemHTML(
      '<div class="chat-list-avatar group-avatar">👦</div>',
      'Jungs',
      groupPreviews['junge'],
      unreadFor('junge')
    )
    item.dataset.chatKey = 'junge'
    item.dataset.tabs = 'alle gruppen' // die Gruppe selbst gehört nur unter "Gruppen", die passenden Einzelchats tragen "junge" schon eigenständig
    item.dataset.name = 'Jungs'
    item.addEventListener('click', () => openGenderGroup('junge', 'Jungs'))
    list.appendChild(item)
  }

  if (isAdmin() || currentProfile.gender === 'maedchen') {
    const item = document.createElement('li')
    item.className = 'chat-list-item pinned'
    item.innerHTML = chatListItemHTML(
      '<div class="chat-list-avatar group-avatar">👧</div>',
      'Mädels',
      groupPreviews['maedchen'],
      unreadFor('maedchen')
    )
    item.dataset.chatKey = 'maedchen'
    item.dataset.tabs = 'alle gruppen' // die Gruppe selbst gehört nur unter "Gruppen", die passenden Einzelchats tragen "maedchen" schon eigenständig
    item.dataset.name = 'Mädels'
    item.addEventListener('click', () => openGenderGroup('maedchen', 'Mädels'))
    list.appendChild(item)
  }

  const others = Object.entries(profileCache)
    .filter(([id, info]) => id !== currentUser.id && info.role !== 'admin' && info.active !== false)
    .sort((a, b) => {
      const timeA = dmPreviews[a[0]] ? new Date(dmPreviews[a[0]].created_at).getTime() : 0
      const timeB = dmPreviews[b[0]] ? new Date(dmPreviews[b[0]].created_at).getTime() : 0
      if (timeA !== timeB) return timeB - timeA
      return (a[1].name || '').localeCompare(b[1].name || '')
    })

  others.forEach(([id, info]) => {
    const name = info.name
    const item = document.createElement('li')
    item.className = 'chat-list-item'
    item.innerHTML = chatListItemHTML(
      `<div class="chat-list-avatar" style="background:${avatarColor(id)}">${initialsOf(name)}</div>`,
      name || 'Ohne Namen',
      dmPreviews[id],
      unreadFor('dm:' + id)
    )
    item.dataset.chatKey = 'dm:' + id
    item.dataset.tabs = 'alle' + (info.gender ? ' ' + info.gender : '')
    item.dataset.name = name || ''
    item.addEventListener('click', () => {
      if (isAdmin()) openAdminContactsFor(id, name)
      else openDirectChat(id, name)
    })
    list.appendChild(item)
  })

  if (others.length === 0) {
    const hint = document.createElement('p')
    hint.className = 'chat-empty'
    hint.textContent = 'Noch keine anderen Mitglieder da.'
    list.appendChild(hint)
  }

  renderChatTabs()
  applyChatTabFilter()

  markActiveListItem()
}

// Ungelesen-Zähler für die Liste. Der Chat, der am PC gerade rechts offen ist, zeigt keinen.
function unreadFor(key) {
  if (isSplitView() && isConversationVisible() && key === chatKeyForRoom(currentRoom)) return 0
  return unreadCounts[key]
}

// Alle 4 Reiter sind immer für jeden da, egal ob Junge, Mädchen oder Admin - sie sind ja nur ein Filter
// auf das, was ohnehin in der Liste steht, keine eigene Berechtigung.
function renderChatTabs() {
  document.querySelectorAll('.chat-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === activeChatTab)
  })
}

// Chateinträge passend zum gewählten Reiter UND zur Suchleiste ein-/ausblenden
function applyChatTabFilter() {
  const searchEl = document.getElementById('chat-search')
  const query = searchEl ? searchEl.value.trim().toLowerCase() : ''
  let visibleCount = 0

  document.querySelectorAll('#chat-list .chat-list-item').forEach(li => {
    const tabs = (li.dataset.tabs || 'alle').split(' ')
    const matchesTab = tabs.includes(activeChatTab)
    const matchesSearch = !query || (li.dataset.name || '').toLowerCase().includes(query)
    const show = matchesTab && matchesSearch
    li.style.display = show ? '' : 'none'
    if (show) visibleCount++
  })

  const hint = document.querySelector('#chat-list .chat-empty')
  if (hint) hint.style.display = (activeChatTab === 'alle' && !query) ? '' : 'none'

  // Nichts zu sehen: entweder weil der Reiter für die Person nichts hat, oder weil die Suche nichts findet
  let emptyTabHint = document.getElementById('chat-tab-empty-hint')
  if (visibleCount === 0 && !(hint && activeChatTab === 'alle' && !query)) {
    if (!emptyTabHint) {
      emptyTabHint = document.createElement('p')
      emptyTabHint.id = 'chat-tab-empty-hint'
      emptyTabHint.className = 'chat-empty'
      document.getElementById('chat-list').appendChild(emptyTabHint)
    }
    emptyTabHint.textContent = query ? 'Nichts gefunden.' : 'Hier gibt es für dich nichts zu sehen.'
  } else if (emptyTabHint) {
    emptyTabHint.remove()
  }
}

document.querySelectorAll('.chat-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    activeChatTab = btn.dataset.tab
    renderChatTabs()
    applyChatTabFilter()
  })
})

// Am PC den Eintrag des offenen Chats in der Liste hervorheben
function markActiveListItem() {
  const openKey = (isSplitView() && isConversationVisible()) ? chatKeyForRoom(currentRoom) : null
  document.querySelectorAll('#chat-list .chat-list-item').forEach(li => {
    const active = !!openKey && li.dataset.chatKey === openKey
    li.classList.toggle('active', active)
    if (active) {
      const badge = li.querySelector('.unread-badge')
      if (badge) badge.remove()
    }
  })
}

// Nötig, weil die Namen in der Chatliste per innerHTML gesetzt werden
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g,
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  )
}

// Vor dem Wechsel den bisherigen Chat noch als gelesen markieren (am PC wechselt man direkt von Chat zu Chat)
function switchRoom(room) {
  markCurrentRoomRead()
  currentRoom = room
}

function openGroupChat() {
  switchRoom({ type: 'group', groupKey: null })
  openConversation('JungscharChat')
}

function openGenderGroup(groupKey, title) {
  switchRoom({ type: 'group', groupKey: groupKey })
  openConversation(title)
}

function openDirectChat(userId, name) {
  switchRoom({ type: 'dm', userId: userId, name: name || 'Ohne Namen' })
  openConversation(name || 'Ohne Namen')
}

// Admin: Liste der Einzelchat-Partner einer bestimmten Person laden (rein lesend)
async function openAdminContactsFor(userId, name) {
  if (!desktopQuery.matches) stopListening() // am PC bleibt der Chat rechts offen
  document.getElementById('admin-contacts-title').textContent = name || 'Ohne Namen'
  showScreen('admin-contacts-bereich')

  const list = document.getElementById('admin-contacts-list')
  list.innerHTML = '<p class="chat-empty">Lädt …</p>'

  const { data: rows, error } = await supabaseClient
    .from('direct_messages')
    .select('sender_id, recipient_id, text, created_at')
    .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
    .order('created_at', { ascending: false })

  list.innerHTML = ''

  if (error) {
    list.textContent = 'Fehler beim Laden: ' + error.message
    return
  }

  // Pro Gesprächspartner nur die jeweils neueste Nachricht merken
  // (rows ist schon neu -> alt sortiert, also zählt der erste Treffer)
  const partners = {}
  rows.forEach(r => {
    const partnerId = r.sender_id === userId ? r.recipient_id : r.sender_id
    if (!partners[partnerId]) partners[partnerId] = r
  })

  const entries = Object.entries(partners)

  if (entries.length === 0) {
    list.innerHTML = '<p class="chat-empty">Noch keine Einzelchats.</p>'
    return
  }

  entries.forEach(([partnerId, preview]) => {
    const partnerName = (profileCache[partnerId] && profileCache[partnerId].name) || 'Unbekannt'
    const item = document.createElement('li')
    item.className = 'chat-list-item'
    item.innerHTML = chatListItemHTML(
      `<div class="chat-list-avatar" style="background:${avatarColor(partnerId)}">${initialsOf(partnerName)}</div>`,
      partnerName,
      preview
    )
    item.addEventListener('click', () => openAdminDmView(userId, partnerId, name, partnerName))
    list.appendChild(item)
  })
}

// Admin: den Einzelchat zwischen zwei anderen Personen rein lesend öffnen
function openAdminDmView(userA, userB, nameA, nameB) {
  switchRoom({ type: 'dm-view', userA: userA, userB: userB })
  openConversation(nameA + ' ↔ ' + nameB)
}

async function openConversation(title) {
  document.getElementById('conversation-title').textContent = title
  updateOnlineIndicator()
  showScreen('conversation-bereich')
  cancelEditingMessage()
  cancelReplyingTo()

  // Admins lesen überall mit, schreiben aber nirgends
  document.querySelector('.chat-input-area').style.display = isAdmin() ? 'none' : 'flex'

  latestSeenAt = null
  peerMarks = {}
  markActiveListItem() // am PC: den geöffneten Chat links hervorheben
  await loadMessages()
  listenForNewMessages()
  startPollListening()
  // Am PC bleibt die Liste sichtbar: Ungelesen-Zähler dort nach dem Markieren auffrischen
  markCurrentRoomRead().then(() => { if (isSplitView()) renderChatList() })
  loadPeerMarks() // Häkchen (Einzelchat und Gruppe), muss nicht abgewartet werden
  if (desktopQuery.matches && !isAdmin()) document.getElementById('message-input').focus()
}

// Am PC: geöffnete Einstellungs-Unterseiten rechts wieder schließen (ein offener Chat bleibt stehen)
function closeSettingsPanels() {
  RIGHT_SCREENS.filter(id => id !== 'conversation-bereich').forEach(id => {
    document.getElementById(id).style.display = 'none'
  })
  document.body.classList.toggle('chat-open', isRightVisible())
}

// Zurück zur Chatliste (wird vom Zurück-Pfeil im HTML als showList() aufgerufen)
function showList() {
  // Am Handy verlässt man dabei den Chat; am PC bleibt er rechts einfach offen
  if (!desktopQuery.matches) stopListening()
  showScreen('list-bereich')
  closeSettingsPanels()
  // Erst den Chat als gelesen markieren, dann die Liste laden - sonst zählt sie Nachrichten,
  // die man gerade im offenen Chat gesehen hat, noch als ungelesen
  markCurrentRoomRead().then(() => renderChatList()) // Namen und Vorschauen könnten sich zwischenzeitlich geändert haben
}

// Benutzername -> E-Mail über die Datenbankfunktion. Groß-/Kleinschreibung ist egal
// ("Levi.Betke" funktioniert genauso wie "levi.betke"): erst klein geschrieben, zur Sicherheit danach wie getippt.
async function lookupEmailByUsername(rawName) {
  const typed = rawName.trim()
  const lower = typed.toLowerCase()
  let result = await supabaseClient.rpc('get_email_by_username', { uname: lower })
  if ((result.error || !result.data) && typed !== lower) {
    result = await supabaseClient.rpc('get_email_by_username', { uname: typed })
  }
  return result
}

// 3. Einloggen
async function login() {
  const username = document.getElementById('username').value.trim()
  const password = document.getElementById('password').value

  if (!username || !password) {
    showToast('Bitte Benutzername und Passwort eingeben!')
    return
  }

  const loginBtn = document.getElementById('login-btn')
  loginBtn.disabled = true

  // Benutzername -> hinterlegte E-Mail-Adresse (über eine Datenbankfunktion,
  // damit im Frontend nicht einfach alle E-Mails abgefragt werden können)
  const { data: email, error: lookupError } = await lookupEmailByUsername(username)

  if (lookupError || !email) {
    loginBtn.disabled = false
    showToast('Nutzername nicht gefunden.')
    return
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: email,
    password: password
  })

  loginBtn.disabled = false

  if (error) {
    if (error.message.includes('Email not confirmed')) {
      showToast('Das Konto wurde noch nicht bestätigt.')
    } else {
      showToast('Falsches Passwort.')
    }
    return
  }

  await enterApp(data.user)
}

function showForgotScreen() {
  showScreen('forgot-bereich')
}

// 4. Namen aller Profile einmal laden (für die Chatliste und für Realtime-Nachrichten ohne Join)
async function loadProfileCache() {
  // '*' statt Spaltenliste: so läuft die App auch dann, wenn die Spalte "active" noch nicht existiert
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('*')

  if (error) {
    console.error('Fehler beim Laden der Profile:', error)
    return
  }

  profileCache = {}
  data.forEach(p => {
    // active = false: eingeladen, aber Einladung noch nicht angenommen / noch kein Passwort gesetzt
    profileCache[p.id] = { name: p.display_name, role: p.role, blocked: !!p.is_blocked, gender: p.gender, active: p.active !== false }
  })
}

async function fetchProfileName(userId) {
  const { data } = await supabaseClient
    .from('profiles')
    .select('display_name, role, is_blocked, gender')
    .eq('id', userId)
    .single()

  if (data) {
    profileCache[userId] = { name: data.display_name, role: data.role, blocked: !!data.is_blocked, gender: data.gender }
  }
}

// Ob gerade ein Einzelchat offen ist - entweder der eigene, oder (Admin) der fremd eingesehene
function isDmRoom() {
  return currentRoom.type === 'dm' || currentRoom.type === 'dm-view'
}

// Name der Tabelle, je nachdem ob gerade die Gruppe oder ein Einzelchat offen ist
function currentTable() {
  return isDmRoom() ? 'direct_messages' : 'messages'
}

// Wessen Sicht gerade eingenommen wird: normalerweise man selbst, beim Admin-Einblick
// in einen fremden Einzelchat die Person, auf die der Admin geklickt hat
function perspectiveUserId() {
  return currentRoom.type === 'dm-view' ? currentRoom.userA : currentUser.id
}

// 5. Nachrichten aus der Datenbank laden
async function loadMessages() {
  let query = supabaseClient
    .from(currentTable())
    .select('*, profiles!sender_id(display_name)')
    .order('created_at', { ascending: true })

  if (currentRoom.type === 'dm') {
    const me = currentUser.id
    const other = currentRoom.userId
    query = query.or(
      `and(sender_id.eq.${me},recipient_id.eq.${other}),and(sender_id.eq.${other},recipient_id.eq.${me})`
    )
  } else if (currentRoom.type === 'dm-view') {
    const a = currentRoom.userA
    const b = currentRoom.userB
    query = query.or(
      `and(sender_id.eq.${a},recipient_id.eq.${b}),and(sender_id.eq.${b},recipient_id.eq.${a})`
    )
  } else if (currentRoom.groupKey) {
    query = query.eq('group_key', currentRoom.groupKey)
  } else {
    query = query.is('group_key', null)
  }

  const { data: messages, error } = await query

  if (error) {
    console.error('Fehler beim Laden:', error)
    return
  }

  exitSelectMode()
  const chatBox = document.getElementById('chat-box')
  chatBox.innerHTML = ''

  messagesById = {}
  lastMessageDateKey = null
  reactionMap = messages.length ? await loadReactionsFor(messages.map(m => m.id)) : {}
  messages.forEach(msg => renderMessage(msg))
  await loadPollsForRoom() // fügt sich zeitlich passend zwischen die Nachrichten ein

  if (chatBox.children.length === 0) showEmptyHint()
  applyEmojiImages(chatBox)
  chatBox.scrollTop = chatBox.scrollHeight
}

// ===== Umfragen =====
// Umfragen liegen in einer eigenen Tabelle (nicht bei den Nachrichten) und werden beim Laden
// und live per Realtime dazwischengemischt - einsortiert nach ihrem Erstellungszeitpunkt.

// Unter welchem Schlüssel eine Umfrage in diesem Chat gespeichert wird/wurde
function pollChatKey(room) {
  if (room.type === 'group') return room.groupKey || 'main'
  if (room.type === 'dm') return 'dm:' + [currentUser.id, room.userId].sort().join(':')
  if (room.type === 'dm-view') return 'dm:' + [room.userA, room.userB].sort().join(':')
  return null
}

// Umfragen erstellen/abstimmen darf man in eigenen Chats, aber nicht im rein lesenden Admin-Drilldown
function canUsePolls() {
  return !isAdmin() && (currentRoom.type === 'group' || currentRoom.type === 'dm')
}

async function loadPollsForRoom() {
  pollsMap = {}
  const key = pollChatKey(currentRoom)
  if (!key) return

  const { data: polls, error } = await supabaseClient
    .from('polls')
    .select('*')
    .eq('chat_key', key)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Umfragen konnten nicht geladen werden:', error)
    return
  }
  if (!polls || polls.length === 0) return

  const { data: votes } = await supabaseClient
    .from('poll_votes')
    .select('poll_id, option_index, user_id')
    .in('poll_id', polls.map(p => p.id))

  polls.forEach(p => { pollsMap[p.id] = { ...p, votesByOption: {} } })
  ;(votes || []).forEach(v => {
    const poll = pollsMap[v.poll_id]
    if (!poll) return
    if (!poll.votesByOption[v.option_index]) poll.votesByOption[v.option_index] = []
    poll.votesByOption[v.option_index].push(v.user_id)
  })

  polls.forEach(p => insertPollRow(pollsMap[p.id]))
}

// Baut die Umfrage-Karte und setzt sie zeitlich richtig zwischen die vorhandenen Nachrichten
function insertPollRow(poll) {
  const chatBox = document.getElementById('chat-box')
  if (chatBox.querySelector(`[data-poll-id="${poll.id}"]`)) return

  const isOwn = poll.created_by === perspectiveUserId()
  const row = document.createElement('div')
  row.className = 'msg-row poll-row ' + (isOwn ? 'own' : 'other')
  row.dataset.pollId = poll.id
  row.dataset.createdAt = poll.created_at
  buildPollCard(row, poll)

  const createdAt = new Date(poll.created_at)
  const sibling = Array.from(chatBox.children).find(el => new Date(el.dataset.createdAt) > createdAt)
  if (sibling) chatBox.insertBefore(row, sibling)
  else chatBox.appendChild(row)

  applyEmojiImages(row)
}

// Der Inhalt einer Umfrage-Karte: Frage, Optionen mit Balken, Fußzeile
function buildPollCard(row, poll) {
  row.innerHTML = ''
  const isOwn = poll.created_by === perspectiveUserId()
  const authorName = (profileCache[poll.created_by] && profileCache[poll.created_by].name) || 'Jemand'
  const totalVoters = new Set(Object.values(poll.votesByOption).flat()).size
  const myVotes = new Set(
    Object.entries(poll.votesByOption)
      .filter(([, ids]) => ids.includes(currentUser.id))
      .map(([idx]) => Number(idx))
  )

  if (!isOwn) {
    const avatar = document.createElement('div')
    avatar.className = 'msg-avatar'
    avatar.style.background = avatarColor(poll.created_by)
    avatar.textContent = initialsOf(authorName)
    row.appendChild(avatar)
  }

  const msgElement = document.createElement('div')
  msgElement.className = 'msg poll-msg ' + (isOwn ? 'own' : 'other')

  if (!isOwn && currentRoom.type === 'group') {
    const meta = document.createElement('div')
    meta.className = 'msg-meta'
    const authorEl = document.createElement('span')
    authorEl.className = 'msg-author'
    authorEl.textContent = authorName
    meta.appendChild(authorEl)
    msgElement.appendChild(meta)
  }

  const label = document.createElement('p')
  label.className = 'poll-label'
  label.textContent = 'Umfrage'
  msgElement.appendChild(label)

  const question = document.createElement('p')
  question.className = 'poll-question'
  question.textContent = poll.question
  msgElement.appendChild(question)

  // Führende Option(en) werden dezent hervorgehoben, sobald überhaupt abgestimmt wurde
  const maxCount = Math.max(0, ...poll.options.map((_, idx) => (poll.votesByOption[idx] || []).length))

  poll.options.forEach((optionText, idx) => {
    const count = (poll.votesByOption[idx] || []).length
    const pct = totalVoters > 0 ? Math.round((count / totalVoters) * 100) : 0
    const mine = myVotes.has(idx)
    const leading = totalVoters > 0 && count === maxCount && count > 0

    const opt = document.createElement('button')
    opt.type = 'button'
    opt.className = 'poll-option' + (mine ? ' mine' : '') + (leading ? ' leading' : '')
    opt.disabled = !canUsePolls()

    const fill = document.createElement('div')
    fill.className = 'poll-option-fill'
    fill.style.width = pct + '%'
    opt.appendChild(fill)

    const check = document.createElement('span')
    check.className = 'poll-option-check'
    check.textContent = '✓'
    opt.appendChild(check)

    const optLabel = document.createElement('span')
    optLabel.className = 'poll-option-label'
    optLabel.textContent = optionText
    opt.appendChild(optLabel)

    const stat = document.createElement('span')
    stat.className = 'poll-option-stat'
    stat.textContent = count > 0 ? pct + '% · ' + count : ''
    opt.appendChild(stat)

    opt.addEventListener('click', () => votePoll(poll.id, idx))
    // Rechtsklick (PC) oder langes Tippen (Handy) auf eine Option zeigt, wer sie gewählt hat
    attachPollOptionVoters(opt, optionText, () => poll.votesByOption[idx] || [])

    msgElement.appendChild(opt)
  })

  attachPollMenuTriggers(msgElement, poll)

  const foot = document.createElement('p')
  foot.className = 'poll-foot'
  const parts = []
  parts.push(totalVoters === 0 ? 'Noch keine Stimme' : totalVoters === 1 ? '1 Stimme' : totalVoters + ' Stimmen')
  if (poll.allow_multiple) parts.push('Mehrfachauswahl')
  const foot1 = document.createElement('span')
  foot1.textContent = parts.join(' · ')
  foot.appendChild(foot1)
  if (myVotes.size > 0) {
    const done = document.createElement('span')
    done.className = 'poll-foot-voted'
    done.textContent = '✓ Du hast abgestimmt'
    foot.appendChild(done)
  }
  msgElement.appendChild(foot)

  // Fußzeile wie bei einer normalen Nachricht: Uhrzeit, bei eigenen Umfragen zusätzlich Häkchen
  const footer = document.createElement('div')
  footer.className = 'msg-footer poll-footer'
  const timeEl = document.createElement('span')
  timeEl.className = 'msg-time'
  timeEl.textContent = formatTimeOnly(poll.created_at)
  footer.appendChild(timeEl)

  const canInfo = READ_RECEIPTS_ENABLED && isOwn && !isAdmin() && (currentRoom.type === 'group' || currentRoom.type === 'dm')
  if (canInfo) {
    const ticksEl = document.createElement('button')
    ticksEl.type = 'button'
    ticksEl.className = 'msg-ticks sent'
    ticksEl.addEventListener('click', (e) => {
      e.stopPropagation()
      openMessageInfo(poll.created_at)
    })
    footer.appendChild(ticksEl)
    row.classList.add('has-ticks')
  }
  msgElement.appendChild(footer)

  row.appendChild(msgElement)
  if (canInfo) updateTicks(row)
}

// Rechtsklick (PC) oder langes Tippen (Handy) auf eine Umfrage-Option: zeigt, wer sie gewählt hat
function attachPollOptionVoters(optBtn, optionText, getVoterIds) {
  let longPressFired = false
  let pressTimer = null

  optBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    openPollVotersModal(optionText, getVoterIds())
  })

  optBtn.addEventListener('touchstart', () => {
    longPressFired = false
    pressTimer = setTimeout(() => {
      longPressFired = true
      openPollVotersModal(optionText, getVoterIds())
    }, 450)
  }, { passive: true })

  ;['touchmove', 'touchend', 'touchcancel'].forEach(evt => {
    optBtn.addEventListener(evt, () => clearTimeout(pressTimer))
  })

  // Nach einem langen Tippen soll der Klick (der auf Touch-Geräten danach noch kommt) nicht
  // zusätzlich noch eine Stimme abgeben
  optBtn.addEventListener('click', (e) => {
    if (longPressFired) { e.stopImmediatePropagation(); e.preventDefault(); longPressFired = false }
  }, true)
}

// Rechtsklick/langes Tippen irgendwo auf der Umfrage (außer auf einer einzelnen Option) öffnet
// ein Menü. Antworten, Reagieren und Bearbeiten gibt es bei Umfragen (noch) nicht - dafür bräuchte
// es zusätzliche Spalten/Tabellen in Supabase. Löschen geht schon: eigene Umfrage oder als Admin.
function attachPollMenuTriggers(msgElement, poll) {
  function isExcluded(target) {
    return target.closest('.poll-option')
  }

  msgElement.addEventListener('contextmenu', (e) => {
    if (selectMode) { e.preventDefault(); return }
    if (isExcluded(e.target)) return
    e.preventDefault()
    openPollMenu(msgElement, poll)
  })

  let pressTimer = null
  msgElement.addEventListener('touchstart', (e) => {
    if (selectMode || isExcluded(e.target)) return
    pressTimer = setTimeout(() => {
      pressTimer = null
      openPollMenu(msgElement, poll)
    }, 450)
  }, { passive: true })

  ;['touchmove', 'touchend', 'touchcancel'].forEach(evt => {
    msgElement.addEventListener(evt, () => clearTimeout(pressTimer))
  })
}

function openPollMenu(anchorEl, poll) {
  closeMessageMenu()

  const isOwn = poll.created_by === currentUser.id
  const canDelete = isOwn || isAdmin()
  if (!isOwn && !canDelete) return // (noch) nichts, was man hier tun könnte

  const menu = document.createElement('div')
  menu.className = 'msg-menu'
  menu.addEventListener('click', (e) => e.stopPropagation())

  if (isOwn) {
    const editItem = document.createElement('button')
    editItem.className = 'msg-menu-item'
    editItem.textContent = 'Umfrage bearbeiten'
    editItem.addEventListener('click', () => {
      closeMessageMenu()
      openPollModal(poll)
    })
    menu.appendChild(editItem)
  }

  const delItem = document.createElement('button')
  delItem.className = 'msg-menu-item danger'
  delItem.textContent = 'Umfrage löschen'
  delItem.addEventListener('click', () => {
    closeMessageMenu()
    deletePoll(poll.id)
  })
  menu.appendChild(delItem)

  document.body.appendChild(menu)
  positionFloatingMenu(menu, anchorEl)
  openMenuEl = menu
}

function deletePoll(pollId) {
  showConfirmModal('Diese Umfrage wirklich löschen?', async () => {
    const { data, error } = await supabaseClient
      .from('polls')
      .delete()
      .eq('id', pollId)
      .select()

    if (error) {
      showToast('Löschen fehlgeschlagen: ' + error.message)
    } else if (!data || data.length === 0) {
      showToast('Löschen nicht erlaubt.')
    } else {
      delete pollsMap[pollId]
      const el = document.querySelector(`#chat-box [data-poll-id="${pollId}"]`)
      if (el) el.remove()
      cleanupDateSeparators()
    }
  })
}

function refreshPollCard(pollId) {
  const row = document.querySelector(`#chat-box [data-poll-id="${pollId}"]`)
  const poll = pollsMap[pollId]
  if (row && poll) { buildPollCard(row, poll); applyEmojiImages(row) }
}

async function votePoll(pollId, optionIndex) {
  if (!canUsePolls()) return
  const poll = pollsMap[pollId]
  if (!poll) return

  const me = currentUser.id
  const myCurrent = Object.entries(poll.votesByOption)
    .filter(([, ids]) => ids.includes(me))
    .map(([idx]) => Number(idx))
  const alreadyVoted = myCurrent.includes(optionIndex)

  // Erst die Oberfläche anpassen, damit es sich sofort reagiert anfühlt
  if (!poll.allow_multiple) {
    myCurrent.forEach(idx => {
      poll.votesByOption[idx] = (poll.votesByOption[idx] || []).filter(id => id !== me)
    })
  }
  if (alreadyVoted && (poll.allow_multiple || myCurrent.length === 1)) {
    poll.votesByOption[optionIndex] = (poll.votesByOption[optionIndex] || []).filter(id => id !== me)
  } else {
    if (!poll.votesByOption[optionIndex]) poll.votesByOption[optionIndex] = []
    if (!poll.votesByOption[optionIndex].includes(me)) poll.votesByOption[optionIndex].push(me)
  }
  refreshPollCard(pollId)

  // Dann in der Datenbank nachziehen: bei Einfachauswahl erst die alten Stimmen entfernen
  if (!poll.allow_multiple) {
    await supabaseClient.from('poll_votes').delete().eq('poll_id', pollId).eq('user_id', me)
  }
  if (!(alreadyVoted && (poll.allow_multiple || myCurrent.length === 1))) {
    const { error } = await supabaseClient
      .from('poll_votes')
      .insert([{ poll_id: pollId, user_id: me, option_index: optionIndex }])
    if (error) console.error('Stimme konnte nicht gespeichert werden:', error)
  } else if (poll.allow_multiple) {
    await supabaseClient.from('poll_votes').delete()
      .eq('poll_id', pollId).eq('user_id', me).eq('option_index', optionIndex)
  }
}

function openPollVotersModal(optionText, userIds) {
  document.getElementById('poll-voters-title').textContent = 'Stimmen für „' + optionText + '"'
  const list = document.getElementById('poll-voters-list')
  list.innerHTML = ''

  if (userIds.length === 0) {
    const hint = document.createElement('li')
    hint.className = 'info-empty'
    hint.textContent = 'Noch niemand hat diese Option gewählt.'
    list.appendChild(hint)
  }

  userIds
    .map(id => ({ id, name: (profileCache[id] && profileCache[id].name) || 'Unbekannt' }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(person => {
      const item = document.createElement('li')
      item.className = 'info-item'
      const avatar = document.createElement('div')
      avatar.className = 'info-avatar'
      avatar.style.background = avatarColor(person.id)
      avatar.textContent = initialsOf(person.name)
      const name = document.createElement('span')
      name.textContent = person.name
      item.appendChild(avatar)
      item.appendChild(name)
      list.appendChild(item)
    })

  document.getElementById('poll-voters-modal').style.display = 'flex'
}

function closePollVotersModal() {
  document.getElementById('poll-voters-modal').style.display = 'none'
}

// Neue Umfragen und Stimmen im offenen Chat live mithören
function startPollListening() {
  stopPollListening()
  const key = pollChatKey(currentRoom)
  if (!key) return

  pollsChannel = supabaseClient
    .channel('polls:' + key)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'polls', filter: 'chat_key=eq.' + key },
      (payload) => {
        const poll = { ...payload.new, votesByOption: {} }
        pollsMap[poll.id] = poll
        insertPollRow(poll)
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'poll_votes' }, (payload) => {
      const row = payload.new || payload.old
      if (!row || !pollsMap[row.poll_id]) return
      const poll = pollsMap[row.poll_id]
      const idx = row.option_index

      if (payload.eventType === 'DELETE') {
        poll.votesByOption[idx] = (poll.votesByOption[idx] || []).filter(id => id !== row.user_id)
      } else {
        if (!poll.votesByOption[idx]) poll.votesByOption[idx] = []
        if (!poll.votesByOption[idx].includes(row.user_id)) poll.votesByOption[idx].push(row.user_id)
      }
      refreshPollCard(row.poll_id)
    })
    .subscribe()
}

function stopPollListening() {
  if (pollsChannel) {
    supabaseClient.removeChannel(pollsChannel)
    pollsChannel = null
  }
}

// ----- Umfrage erstellen/bearbeiten (Pop-up) -----
let pollOptionCount = 0
let editingPollId = null // null = neue Umfrage, sonst die id der gerade bearbeiteten

function openPollModal(pollToEdit) {
  editingPollId = pollToEdit ? pollToEdit.id : null

  document.getElementById('poll-modal-title').textContent = pollToEdit ? 'Umfrage bearbeiten' : 'Umfrage erstellen'
  document.getElementById('poll-submit-btn').textContent = pollToEdit ? 'Speichern' : 'Erstellen'
  document.getElementById('poll-question').value = pollToEdit ? pollToEdit.question : ''
  document.getElementById('poll-multiple').checked = pollToEdit ? !!pollToEdit.allow_multiple : false
  document.getElementById('poll-error').style.display = 'none'
  document.getElementById('poll-options').innerHTML = ''
  pollOptionCount = 0

  if (pollToEdit && pollToEdit.options.length > 0) {
    pollToEdit.options.forEach(text => addPollOption(text))
  } else {
    addPollOption()
    addPollOption()
  }

  document.getElementById('poll-modal').style.display = 'flex'
  applyEmojiImages(document.getElementById('poll-modal'))
}

function closePollModal() {
  document.getElementById('poll-modal').style.display = 'none'
  editingPollId = null
}

function addPollOption(prefillText) {
  const container = document.getElementById('poll-options')
  if (container.children.length >= 10) return

  pollOptionCount++
  const group = document.createElement('div')
  group.className = 'input-group poll-option-input'

  const number = document.createElement('span')
  number.className = 'poll-option-number'
  number.textContent = pollOptionCount
  group.appendChild(number)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Option ' + pollOptionCount
  input.maxLength = 100
  if (prefillText) input.value = prefillText

  group.appendChild(input)

  if (container.children.length >= 2) {
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'poll-option-remove'
    removeBtn.textContent = '✕'
    removeBtn.setAttribute('aria-label', 'Option entfernen')
    removeBtn.addEventListener('click', () => group.remove())
    group.appendChild(removeBtn)
  }

  container.appendChild(group)
}

async function submitPoll() {
  const errorEl = document.getElementById('poll-error')
  errorEl.style.display = 'none'

  const question = document.getElementById('poll-question').value.trim()
  const options = Array.from(document.querySelectorAll('#poll-options input'))
    .map(i => i.value.trim())
    .filter(Boolean)

  if (!question) { errorEl.textContent = 'Bitte eine Frage eingeben.'; errorEl.style.display = 'block'; return }
  if (options.length < 2) { errorEl.textContent = 'Mindestens 2 Optionen ausfüllen.'; errorEl.style.display = 'block'; return }

  if (editingPollId) {
    // Beim Bearbeiten: weniger Optionen als vorher = bisherige Stimmen auf den weggefallenen
    // Plätzen würden auf die falsche, neue Option zeigen - deshalb werden Stimmen dann zurückgesetzt.
    const existing = pollsMap[editingPollId]
    const votesStillValid = existing && options.length >= existing.options.length
      && existing.options.every((opt, i) => opt === options[i])

    const update = {
      question,
      options,
      allow_multiple: document.getElementById('poll-multiple').checked
    }

    const { data: updated, error } = await supabaseClient
      .from('polls')
      .update(update)
      .eq('id', editingPollId)
      .select()
      .single()

    if (error) {
      errorEl.textContent = 'Konnte nicht gespeichert werden. Bitte nochmal versuchen.'
      errorEl.style.display = 'block'
      return
    }

    closePollModal()
    const votesByOption = votesStillValid ? (existing.votesByOption || {}) : {}
    if (!votesStillValid) {
      await supabaseClient.from('poll_votes').delete().eq('poll_id', editingPollId)
    }
    pollsMap[updated.id] = { ...updated, votesByOption }
    refreshPollCard(updated.id)
    return
  }

  const key = pollChatKey(currentRoom)
  const row = {
    chat_key: key,
    question: question,
    options: options,
    allow_multiple: document.getElementById('poll-multiple').checked,
    created_by: currentUser.id
  }

  const { data: inserted, error } = await supabaseClient.from('polls').insert([row]).select().single()

  if (error) {
    console.error('Umfrage konnte nicht erstellt werden:', error)
    errorEl.textContent = 'Konnte nicht erstellt werden. Bitte nochmal versuchen.'
    errorEl.style.display = 'block'
    return
  }

  closePollModal()
  pollsMap[inserted.id] = { ...inserted, votesByOption: {} }
  insertPollRow(pollsMap[inserted.id])
  document.getElementById('chat-box').scrollTop = document.getElementById('chat-box').scrollHeight
}

// ----- "+"-Menü neben dem Eingabefeld (aktuell nur die Umfrage; Fotos folgen später) -----
let openAttachMenuEl = null

function closeAttachMenu() {
  if (openAttachMenuEl) { openAttachMenuEl.remove(); openAttachMenuEl = null }
}

function toggleAttachMenu(anchorBtn, evt) {
  if (evt) evt.stopPropagation() // sonst schließt der Klick das Menü über den globalen Listener sofort wieder
  if (openAttachMenuEl) { closeAttachMenu(); return }
  closeTextEmojiPicker()

  const menu = document.createElement('div')
  menu.className = 'msg-menu attach-menu'
  menu.addEventListener('click', e => e.stopPropagation())

  const pollItem = document.createElement('button')
  pollItem.className = 'msg-menu-item'
  pollItem.textContent = 'Umfrage'
  pollItem.addEventListener('click', () => { closeAttachMenu(); openPollModal() })
  menu.appendChild(pollItem)

  anchorBtn.parentElement.appendChild(menu)
  applyEmojiImages(menu)
  openAttachMenuEl = menu
}

document.addEventListener('click', closeAttachMenu)

// ----- Emoji-Button links im Eingabefeld: fügt ein Emoji im Text ein -----
let openTextEmojiEl = null

function closeTextEmojiPicker() {
  if (openTextEmojiEl) { openTextEmojiEl.remove(); openTextEmojiEl = null }
}

function toggleTextEmojiPicker(anchorBtn, evt) {
  if (evt) evt.stopPropagation() // sonst schließt der Klick den Picker über den globalen Listener sofort wieder
  if (openTextEmojiEl) { closeTextEmojiPicker(); return }
  closeAttachMenu()

  const picker = document.createElement('div')
  picker.className = 'emoji-picker input-emoji-picker'
  picker.addEventListener('click', e => e.stopPropagation())

  QUICK_EMOJI.forEach(emoji => {
    const btn = document.createElement('button')
    btn.className = 'emoji-picker-btn'
    btn.textContent = emoji
    btn.addEventListener('click', () => insertEmojiInInput(emoji))
    picker.appendChild(btn)
  })

  anchorBtn.parentElement.appendChild(picker)
  applyEmojiImages(picker)
  openTextEmojiEl = picker
}

document.addEventListener('click', closeTextEmojiPicker)

function insertEmojiInInput(emoji) {
  const input = document.getElementById('message-input')
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? input.value.length
  input.value = input.value.slice(0, start) + emoji + input.value.slice(end)
  const pos = start + emoji.length
  input.focus()
  input.setSelectionRange(pos, pos)
  autoResizeMessageInput()
}

// Reaktionen (Daumen hoch/runter) zu einer Liste von Nachrichten-IDs laden
async function loadReactionsFor(ids) {
  const map = {}
  if (!ids || ids.length === 0) return map

  const table = isDmRoom() ? 'dm_reactions' : 'message_reactions'
  const { data } = await supabaseClient
    .from(table)
    .select('message_id, emoji, user_id')
    .in('message_id', ids)

  ;(data || []).forEach(r => {
    if (!map[r.message_id]) map[r.message_id] = { counts: {}, mine: null }
    map[r.message_id].counts[r.emoji] = (map[r.message_id].counts[r.emoji] || 0) + 1
    if (r.user_id === currentUser.id) map[r.message_id].mine = r.emoji
  })

  return map
}

function showEmptyHint() {
  const hint = document.createElement('p')
  hint.className = 'chat-empty'
  hint.textContent = 'Noch keine Nachrichten. Schreib die erste!'
  document.getElementById('chat-box').appendChild(hint)
}

// Zeitstempel: heute nur Uhrzeit, gestern mit "Gestern", sonst Datum
function formatTime(isoString) {
  const d = new Date(isoString)
  const now = new Date()
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

  if (d.toDateString() === now.toDateString()) return time

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Gestern, ' + time

  const date = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
  return date + ', ' + time
}

// Nur die Uhrzeit, ohne Datum - das Datum steht ja schon im Trenner über der Nachricht
function formatTimeOnly(isoString) {
  return new Date(isoString).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

// Zeit-Anzeige für die Chatliste: heute nur die Uhrzeit, älter nur das Datum (ohne Uhrzeit dazu)
function formatChatListTime(isoString) {
  const d = new Date(isoString)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

// Emojis als kleine Bilder statt als (unter Windows hässliche) Systemzeichen zeichnen.
// window.twemoji kommt von der Bibliothek, die in index.html eingebunden ist.
function applyEmojiImages(el) {
  if (window.twemoji) window.twemoji.parse(el, { folder: 'svg', ext: '.svg' })
}

// Eine Nachricht als Element in den Chat einfügen
// (textContent statt innerHTML: Namen und Text können kein HTML einschleusen)
function renderMessage(msg) {
  const chatBox = document.getElementById('chat-box')

  // Doppelte vermeiden (z. B. wenn Realtime und Laden sich überschneiden)
  if (chatBox.querySelector(`[data-id="${msg.id}"]`)) return

  const emptyHint = chatBox.querySelector('.chat-empty')
  if (emptyHint) emptyHint.remove()

  noteSeenMessage(msg)

  messagesById[msg.id] = msg

  const isOwn = msg.sender_id === perspectiveUserId()
  const author =
    (msg.profiles && msg.profiles.display_name) ||
    (profileCache[msg.sender_id] && profileCache[msg.sender_id].name) ||
    'Unbekannt'

  const row = document.createElement('div')
  row.className = 'msg-row ' + (isOwn ? 'own' : 'other')
  row.dataset.id = msg.id
  row.dataset.createdAt = msg.created_at
  row.dataset.senderId = msg.sender_id

  if (!isOwn) {
    const avatar = document.createElement('div')
    avatar.className = 'msg-avatar'
    avatar.style.background = avatarColor(msg.sender_id)
    avatar.textContent = initialsOf(author)
    row.appendChild(avatar)
  }

  const msgElement = document.createElement('div')
  msgElement.className = 'msg ' + (isOwn ? 'own' : 'other')

  const meta = document.createElement('div')
  meta.className = 'msg-meta'

  // Im Einzelchat kennt man den Absender schon durch den Titel oben, im Gruppenchat nicht
  if (!isOwn && currentRoom.type === 'group') {
    const authorEl = document.createElement('span')
    authorEl.className = 'msg-author'
    authorEl.textContent = author
    meta.appendChild(authorEl)
  }

  // Uhrzeit (und "bearbeitet") stehen unten an der Nachricht, nicht oben
  const footer = document.createElement('div')
  footer.className = 'msg-footer'

  const timeEl = document.createElement('span')
  timeEl.className = 'msg-time'
  timeEl.textContent = formatTimeOnly(msg.created_at)
  footer.appendChild(timeEl)

  if (msg.edited_at) {
    const editedTag = document.createElement('span')
    editedTag.className = 'msg-edited'
    editedTag.textContent = '(bearbeitet)'
    footer.appendChild(editedTag)
  }

  // Menü öffnen: nicht mehr über einen eigenen Button, sondern per Rechtsklick (PC) oder
  // langem Tippen (Handy) direkt auf der Nachricht - Kopieren geht bei jeder Nachricht,
  // der Rest hängt davon ab, wem sie gehört
  const canEdit = isOwn && !isAdmin()
  const canDelete = isOwn || isAdmin()
  const canReact = !isAdmin()
  const canReply = !isAdmin() && (currentRoom.type === 'group' || currentRoom.type === 'dm')
  const canCopy = true
  // Info (wer hat die Nachricht gelesen/bekommen) und Häkchen gibt es für eigene Nachrichten in Einzelchat und Gruppe
  const canInfo = READ_RECEIPTS_ENABLED && isOwn && !isAdmin() && (currentRoom.type === 'group' || currentRoom.type === 'dm')

  attachMessageMenuTriggers(msgElement, msg, { canEdit, canDelete, canReact, canInfo, canReply, canCopy })

  const textEl = document.createElement('div')
  textEl.className = 'msg-text'
  // Der Text selbst steht als reiner Textknoten davor, die Fußzeile (Uhrzeit + Haken)
  // wird gleich als eigenes, rechts schwebendes Element direkt danach eingehängt (siehe unten) -
  // dadurch rutscht sie bei kurzen Nachrichten ans Textende, bei langen presst sie sich unten rechts an
  appendTextWithLinks(textEl, msg.text)

  const reactRow = document.createElement('div')
  reactRow.className = 'msg-reactions'
  renderReactionChips(reactRow, msg.id)

  if (meta.children.length > 0) msgElement.appendChild(meta)
  if (msg.reply_to_id) msgElement.appendChild(buildReplyQuote(msg.reply_to_id))
  msgElement.appendChild(textEl)

  // Häkchen direkt neben der Uhrzeit (1 grau = gesendet, 2 grau = zugestellt, 2 blau = gelesen)
  if (canInfo) {
    const ticksEl = document.createElement('button')
    ticksEl.type = 'button'
    ticksEl.className = 'msg-ticks sent'
    ticksEl.addEventListener('click', (e) => {
      e.stopPropagation()
      openMessageInfo(msg.created_at)
    })
    footer.appendChild(ticksEl)
    row.classList.add('has-ticks')
  }

  // Als letztes Kind IN den Text eingehängt (nicht danach als eigener Block) - das "float" in der
  // CSS lässt den Text drum herum laufen, wie bei WhatsApp
  textEl.appendChild(footer)
  msgElement.appendChild(reactRow)

  row.appendChild(msgElement)
  updateTicks(row)

  // Nur nach unten scrollen, wenn man schon unten war (oder selbst schreibt)
  const nearBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80

  const key = dateKey(msg.created_at)
  if (key !== lastMessageDateKey) {
    insertDateSeparator(msg.created_at)
    lastMessageDateKey = key
  }

  if (selectMode) makeRowSelectable(row)

  chatBox.appendChild(row)
  applyEmojiImages(row)
  if (nearBottom || isOwn) chatBox.scrollTop = chatBox.scrollHeight
}

// ===== Häkchen und Nachrichten-Info =====
// Grundlage sind zwei Markierungen pro Person und Chat:
//  - zugestellt (delivery_marks): die App der Person hat die Nachricht bekommen
//  - gelesen (read_marks): die Person hat den Chat bis zu dieser Nachricht gesehen
// Einzelchat: 1 grau = gesendet, 2 grau = zugestellt, 2 blau = gelesen.
// Gruppe: 2 grau = an alle zugestellt, 2 blau = von allen gelesen (bis dahin 1 grau).

// Unter welchem Schlüssel die ANDEREN ihre Markierungen für diesen Chat speichern
function peerKeyForRoom(room) {
  if (room.type === 'group') return room.groupKey || 'main'
  if (room.type === 'dm') return 'dm:' + currentUser.id // aus Sicht des Partners ist "der andere" ich
  return null
}

// Wer zählt bei einer Nachricht als Empfänger? (Gruppe: alle Mitglieder außer mir, Admin und Gesperrten)
function recipientIdsForRoom() {
  if (currentRoom.type === 'dm') return [currentRoom.userId]
  if (currentRoom.type !== 'group') return []

  const key = currentRoom.groupKey || 'main'
  return Object.entries(profileCache)
    .filter(([id, info]) => {
      if (id === currentUser.id || info.role === 'admin' || info.blocked || info.active === false) return false
      return key === 'main' || info.gender === key
    })
    .map(([id]) => id)
}

function peerEntry(userId) {
  if (!peerMarks[userId]) peerMarks[userId] = { readAt: null, deliveredAt: null }
  return peerMarks[userId]
}

async function loadPeerMarks() {
  const key = peerKeyForRoom(currentRoom)
  if (!READ_RECEIPTS_ENABLED || !key || isAdmin()) return
  const roomAtStart = currentRoom

  let readQuery = supabaseClient.from('read_marks').select('user_id, last_read_at').eq('chat_key', key)
  let deliveredQuery = supabaseClient.from('delivery_marks').select('user_id, delivered_at').eq('chat_key', key)
  if (roomAtStart.type === 'dm') {
    readQuery = readQuery.eq('user_id', roomAtStart.userId)
    deliveredQuery = deliveredQuery.eq('user_id', roomAtStart.userId)
  }

  const [readRes, deliveredRes] = await Promise.all([readQuery, deliveredQuery])
  // Zwischenzeitlich in einen anderen Chat gewechselt? Dann verwerfen
  if (currentRoom !== roomAtStart) return

  peerMarks = {}
  if (readRes.error) console.error('Lesemarkierungen konnten nicht geladen werden:', readRes.error)
  else (readRes.data || []).forEach(m => { peerEntry(m.user_id).readAt = new Date(m.last_read_at) })

  if (deliveredRes.error) console.error('Zustellmarkierungen konnten nicht geladen werden:', deliveredRes.error)
  else (deliveredRes.data || []).forEach(m => { peerEntry(m.user_id).deliveredAt = new Date(m.delivered_at) })

  refreshTicks()
}

// Neue Markierungen der anderen live mithören - in einem eigenen Channel, damit die Nachrichten
// selbst auch dann weiterlaufen, falls hier mal etwas nicht klappt
function startPeerListening() {
  stopPeerListening()
  const key = peerKeyForRoom(currentRoom)
  if (!READ_RECEIPTS_ENABLED || !key || isAdmin()) return

  function apply(kind, row) {
    if (!row || row.chat_key !== key || row.user_id === currentUser.id) return
    if (currentRoom.type === 'dm' && row.user_id !== currentRoom.userId) return
    const entry = peerEntry(row.user_id)
    if (kind === 'read') entry.readAt = new Date(row.last_read_at)
    else entry.deliveredAt = new Date(row.delivered_at)
    refreshTicks()
  }

  peerChannel = supabaseClient
    .channel('peers:' + key)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'read_marks' }, (p) => apply('read', p.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'delivery_marks' }, (p) => apply('delivered', p.new))
    .subscribe()
}

function stopPeerListening() {
  if (peerChannel) {
    supabaseClient.removeChannel(peerChannel)
    peerChannel = null
  }
}

// Für eine Nachricht: wer hat sie gelesen, wem wurde sie zugestellt, wer hat sie noch nicht
function deliveryListsFor(createdAt) {
  const sentAt = new Date(createdAt)
  const lists = { read: [], delivered: [], pending: [] }

  recipientIdsForRoom().forEach(id => {
    const marks = peerMarks[id] || {}
    const person = { id: id, name: (profileCache[id] && profileCache[id].name) || 'Unbekannt' }
    if (marks.readAt && marks.readAt >= sentAt) lists.read.push(person)
    else if (marks.deliveredAt && marks.deliveredAt >= sentAt) lists.delivered.push(person)
    else lists.pending.push(person)
  })

  Object.values(lists).forEach(l => l.sort((a, b) => a.name.localeCompare(b.name)))
  return lists
}

function tickStatus(createdAt) {
  const lists = deliveryListsFor(createdAt)
  const total = lists.read.length + lists.delivered.length + lists.pending.length
  if (total === 0 || lists.pending.length > 0) return 'sent'
  return lists.delivered.length > 0 ? 'delivered' : 'read'
}

const TICK_LABELS = { sent: 'Gesendet', delivered: 'Zugestellt', read: 'Gelesen' }

// Ein Häkchen (gesendet) oder zwei Häkchen (zugestellt/gelesen) als kleine Grafik
function tickSVG(double) {
  const check = 'M1 5.8l3.2 3.2L10.6 1.8'
  const second = 'M5.6 5.8l3.2 3.2L15.2 1.8'
  return '<svg viewBox="0 0 17 11" width="17" height="11" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="' + check + '"/>' + (double ? '<path d="' + second + '"/>' : '') + '</svg>'
}

function updateTicks(row) {
  const el = row.querySelector('.msg-ticks')
  if (!el) return
  const status = tickStatus(row.dataset.createdAt)
  el.className = 'msg-ticks ' + status
  el.innerHTML = tickSVG(status !== 'sent')
  el.setAttribute('aria-label', TICK_LABELS[status] + ' - Info öffnen')
}

function refreshTicks() {
  document.querySelectorAll('#chat-box .msg-row.has-ticks').forEach(updateTicks)
}

// Pop-up "Nachrichten-Info": wer hat die Nachricht gelesen, wem wurde sie zugestellt, wer noch nicht
function openMessageInfo(createdAt) {
  const lists = deliveryListsFor(createdAt)
  document.getElementById('info-sent').textContent = 'Gesendet: ' + formatTime(createdAt)

  const box = document.getElementById('info-sections')
  box.innerHTML = ''

  // Im Einzelchat gibt es nur eine Person - da muss man niemanden namentlich auflisten,
  // ein einzelner Status reicht (die Häkchen selbst zeigen das eigentlich schon)
  if (currentRoom.type === 'dm') {
    const status = tickStatus(createdAt)
    const labels = { sent: 'Noch nicht zugestellt', delivered: 'Zugestellt', read: 'Gelesen' }

    const head = document.createElement('div')
    head.className = 'info-section-title ' + status
    const icon = document.createElement('span')
    icon.className = 'info-tick'
    icon.innerHTML = tickSVG(status !== 'sent')
    head.appendChild(icon)
    head.appendChild(document.createTextNode(labels[status]))
    box.appendChild(head)

    document.getElementById('info-modal').style.display = 'flex'
    return
  }

  const sections = [
    { title: 'Gelesen von', people: lists.read, status: 'read' },
    { title: 'Zugestellt an', people: lists.delivered, status: 'delivered' },
    { title: 'Noch nicht zugestellt an', people: lists.pending, status: 'sent' }
  ]

  sections.forEach(section => {
    if (section.people.length === 0) return

    const head = document.createElement('div')
    head.className = 'info-section-title ' + section.status
    const icon = document.createElement('span')
    icon.className = 'info-tick'
    icon.innerHTML = tickSVG(section.status !== 'sent')
    head.appendChild(icon)
    head.appendChild(document.createTextNode(section.title + ' (' + section.people.length + ')'))
    box.appendChild(head)

    const list = document.createElement('ul')
    list.className = 'info-list'
    section.people.forEach(person => {
      const item = document.createElement('li')
      item.className = 'info-item'

      const avatar = document.createElement('div')
      avatar.className = 'info-avatar'
      avatar.style.background = avatarColor(person.id)
      avatar.textContent = initialsOf(person.name)

      const name = document.createElement('span')
      name.textContent = person.name

      item.appendChild(avatar)
      item.appendChild(name)
      list.appendChild(item)
    })
    box.appendChild(list)
  })

  if (box.children.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'info-empty'
    empty.textContent = 'Noch keine Empfänger.'
    box.appendChild(empty)
  }

  document.getElementById('info-modal').style.display = 'flex'
}

function closeInfoModal() {
  document.getElementById('info-modal').style.display = 'none'
}

// Reaktions-Chips unter einer Nachricht neu aufbauen (ein Chip pro benutztem Emoji)
function renderReactionChips(container, messageId) {
  container.innerHTML = ''
  const info = reactionMap[messageId] || { counts: {}, mine: null }

  Object.entries(info.counts).forEach(([emoji, count]) => {
    if (count <= 0) return
    const chip = document.createElement('button')
    chip.className = 'reaction-btn' + (info.mine === emoji ? ' active' : '')
    chip.textContent = emoji + ' ' + count
    chip.addEventListener('click', () => toggleReaction(messageId, emoji))
    container.appendChild(chip)
  })
}

// Die Emoji, die im Reagieren-Menü zur Auswahl stehen
const QUICK_EMOJI = ['👍', '👎', '❤️', '😂', '😮', '😢', '🙏']

let openMenuEl = null

function closeMessageMenu() {
  if (openMenuEl) {
    openMenuEl.remove()
    openMenuEl = null
  }
}

document.addEventListener('click', closeMessageMenu)
// 'scroll' bubbelt nicht - mit capture:true trifft das trotzdem den Chatverlauf beim Scrollen
document.addEventListener('scroll', closeMessageMenu, true)

// Öffnet das Drei-Punkte-Menü neben einer Nachricht
// Öffnet das Nachrichtenmenü nicht mehr über einen eigenen Button, sondern per Rechtsklick
// (PC) oder langem Tippen (Handy) direkt auf der Nachricht. Auf den Haken, dem Zitat und den
// Reaktions-Chips wird das ignoriert, die haben ihre eigene Funktion bei einem normalen Klick.
function attachMessageMenuTriggers(msgElement, msg, options) {
  const hasMenu = options.canEdit || options.canDelete || options.canReact || options.canReply || options.canCopy
  if (!hasMenu) return

  function isExcluded(target) {
    return target.closest('.msg-ticks, .msg-reply-quote, .reaction-btn')
  }

  msgElement.addEventListener('contextmenu', (e) => {
    if (selectMode) { e.preventDefault(); return } // im Auswahlmodus gibt es kein Menü
    if (isExcluded(e.target)) return
    e.preventDefault()
    openMessageMenu(msgElement, msg, options)
  })

  let pressTimer = null

  msgElement.addEventListener('touchstart', (e) => {
    if (selectMode || isExcluded(e.target)) return
    pressTimer = setTimeout(() => {
      pressTimer = null
      openMessageMenu(msgElement, msg, options)
    }, 450)
  }, { passive: true })

  ;['touchmove', 'touchend', 'touchcancel'].forEach(evt => {
    msgElement.addEventListener(evt, () => { clearTimeout(pressTimer) })
  })
}

function openMessageMenu(anchorEl, msg, options) {
  closeMessageMenu()

  const menu = document.createElement('div')
  menu.className = 'msg-menu'
  menu.addEventListener('click', (e) => e.stopPropagation())

  function showMainOptions() {
    menu.innerHTML = ''

    if (options.canReply) {
      const replyItem = document.createElement('button')
      replyItem.className = 'msg-menu-item'
      replyItem.textContent = 'Antworten'
      replyItem.addEventListener('click', () => {
        closeMessageMenu()
        startReplyingTo(msg.id)
      })
      menu.appendChild(replyItem)
    }

    if (options.canCopy) {
      const copyItem = document.createElement('button')
      copyItem.className = 'msg-menu-item'
      copyItem.textContent = 'Kopieren'
      copyItem.addEventListener('click', async () => {
        closeMessageMenu()
        try {
          await navigator.clipboard.writeText(msg.text)
        } catch (err) {
          console.error('Kopieren fehlgeschlagen:', err)
        }
      })
      menu.appendChild(copyItem)
    }

    if (options.canReact) {
      const reactItem = document.createElement('button')
      reactItem.className = 'msg-menu-item'
      reactItem.textContent = 'Reagieren'
      reactItem.addEventListener('click', showEmojiPicker)
      menu.appendChild(reactItem)
    }

    if (options.canInfo) {
      const infoItem = document.createElement('button')
      infoItem.className = 'msg-menu-item'
      infoItem.textContent = 'Info'
      infoItem.addEventListener('click', () => {
        closeMessageMenu()
        openMessageInfo(msg.created_at)
      })
      menu.appendChild(infoItem)
    }

    if (options.canEdit && withinEditWindow(msg.created_at)) {
      const editItem = document.createElement('button')
      editItem.className = 'msg-menu-item'
      editItem.textContent = 'Bearbeiten'
      editItem.addEventListener('click', () => {
        closeMessageMenu()
        startEditingMessage(msg.id, msg.text)
      })
      menu.appendChild(editItem)
    }

    if (options.canDelete) {
      const selectItem = document.createElement('button')
      selectItem.className = 'msg-menu-item'
      selectItem.textContent = 'Auswählen'
      selectItem.addEventListener('click', () => {
        closeMessageMenu()
        enterSelectMode(msg.id)
      })
      menu.appendChild(selectItem)

      const delItem = document.createElement('button')
      delItem.className = 'msg-menu-item danger'
      delItem.textContent = 'Löschen'
      delItem.addEventListener('click', () => {
        closeMessageMenu()
        deleteMessage(msg.id)
      })
      menu.appendChild(delItem)
    }
  }

  function showEmojiPicker() {
    menu.innerHTML = ''
    const picker = document.createElement('div')
    picker.className = 'emoji-picker'
    QUICK_EMOJI.forEach(emoji => {
      const btn = document.createElement('button')
      btn.className = 'emoji-picker-btn'
      btn.textContent = emoji
      btn.addEventListener('click', () => {
        closeMessageMenu()
        toggleReaction(msg.id, emoji)
      })
      picker.appendChild(btn)
    })
    menu.appendChild(picker)
    positionFloatingMenu(menu, anchorEl)
  }

  showMainOptions()
  document.body.appendChild(menu)
  positionFloatingMenu(menu, anchorEl)
  openMenuEl = menu
}

// Platziert ein frei schwebendes Menü neben seinem Auslöser, innerhalb des Bildschirms:
// seitlich wie bisher (eigene Nachrichten links vom Text, fremde rechts), und senkrecht so,
// dass es nie über den unteren oder oberen Bildschirmrand hinausragt und unlesbar wird
function positionFloatingMenu(menu, anchorEl) {
  const rect = anchorEl.getBoundingClientRect()
  const isOwn = anchorEl.classList.contains('own')
  const margin = 8

  const menuRect = menu.getBoundingClientRect()
  let left, top

  // Zuerst versuchen, das Menü seitlich NEBEN die Blase zu setzen (eigene Nachrichten: links davon,
  // fremde: rechts davon) - so verdeckt es die Nachricht nie. Erst wenn seitlich zu wenig Platz ist
  // (z.B. schmaler Handy-Bildschirm), weicht es stattdessen nach unten oder oben aus.
  if (isOwn && rect.left - margin * 2 >= menuRect.width) {
    left = rect.left - menuRect.width - margin
    top = rect.top
  } else if (!isOwn && window.innerWidth - rect.right - margin * 2 >= menuRect.width) {
    left = rect.right + margin
    top = rect.top
  } else {
    // Kein Platz seitlich: unter die Nachricht setzen, oder darüber, falls unten nicht genug Raum ist
    left = isOwn ? rect.right - menuRect.width : rect.left
    top = (rect.bottom + margin + menuRect.height <= window.innerHeight - margin)
      ? rect.bottom + margin
      : rect.top - menuRect.height - margin
  }

  left = Math.min(Math.max(left, margin), window.innerWidth - menuRect.width - margin)
  top = Math.min(Math.max(top, margin), window.innerHeight - menuRect.height - margin)

  menu.style.position = 'fixed'
  menu.style.left = left + 'px'
  menu.style.top = top + 'px'
}

// 6. Neue Nachricht senden (Gruppe oder Einzelchat)
async function sendMessage() {
  const input = document.getElementById('message-input')
  const sendBtn = document.getElementById('send-btn')
  const text = input.value.trim()

  if (!text || !currentUser) return

  if (editingMessageId) {
    await saveEditedMessage(text)
    return
  }

  sendBtn.disabled = true

  const row = { sender_id: currentUser.id, text: text }
  if (currentRoom.type === 'dm') row.recipient_id = currentRoom.userId
  else row.group_key = currentRoom.groupKey || null
  if (replyingToId) row.reply_to_id = replyingToId

  // .select() liefert die neue Zeile zurück, damit sie sofort angezeigt werden kann
  const { data: inserted, error } = await supabaseClient
    .from(currentTable())
    .insert([row])
    .select('*, profiles!sender_id(display_name)')
    .single()

  sendBtn.disabled = false

  if (error) {
    await handleSendError(error)
  } else {
    cancelReplyingTo()
    renderMessage(inserted)
    input.value = ''
    autoResizeMessageInput()
    input.focus()
  }
}

// Wenn Senden fehlschlägt: prüfen, ob der Grund eine Sperre ist
async function handleSendError(error) {
  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('is_blocked')
    .eq('id', currentUser.id)
    .single()

  if (profile && profile.is_blocked) {
    showToast('Dein Zugang wurde gesperrt.')
    await logout()
  } else {
    showToast('Fehler beim Senden: ' + error.message)
  }
}

// 7. Live-Updates für den gerade offenen Chat (Echtzeit)
function listenForNewMessages() {
  stopListening()
  const table = currentTable()
  const roomKey =
    currentRoom.type === 'dm-view' ? currentRoom.userA + '-' + currentRoom.userB
    : (currentRoom.userId || currentRoom.groupKey || 'main')

  let channel = supabaseClient
    .channel('room:' + table + ':' + roomKey)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: table }, async (payload) => {
      if (!belongsToCurrentRoom(payload.new)) return
      const msg = payload.new
      if (!profileCache[msg.sender_id]) await fetchProfileName(msg.sender_id)
      renderMessage(msg)
      // Der Chat ist offen, die Nachricht wird gerade gesehen -> nicht später als ungelesen zählen
      if (msg.sender_id !== currentUser.id && document.visibilityState === 'visible') markCurrentRoomRead()
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: table }, (payload) => {
      if (!belongsToCurrentRoom(payload.new)) return
      updateMessageElement(payload.new)
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: table }, (payload) => {
      removeMessageElement(payload.old.id)
    })

  chatChannel = channel.subscribe()
  startPeerListening()
}

function stopListening() {
  exitSelectMode()
  if (chatChannel) {
    supabaseClient.removeChannel(chatChannel)
    chatChannel = null
  }
  stopPeerListening()
  stopPollListening()
}

// Solange man eingeloggt ist: bei jeder neuen Nachricht (egal wo) die Chatliste neu sortieren
// und Vorschauen/Zähler auffrischen. Läuft in einem eigenen Channel, damit der offene Chat (am PC
// neben der Liste) davon unberührt bleibt.
let listChannel = null
let listRefreshTimer = null

function scheduleListRefresh() {
  // Kurz sammeln: kommen mehrere Nachrichten hintereinander, wird nur einmal neu geladen
  clearTimeout(listRefreshTimer)
  listRefreshTimer = setTimeout(() => { if (currentUser) renderChatList() }, 250)
}

function listenForListUpdates() {
  if (listChannel) return
  listChannel = supabaseClient
    .channel('list-updates')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, scheduleListRefresh)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages' }, scheduleListRefresh)
    .subscribe()
}

function stopListListening() {
  clearTimeout(listRefreshTimer)
  if (listChannel) {
    supabaseClient.removeChannel(listChannel)
    listChannel = null
  }
}

// Prüft, ob eine per Realtime hereinkommende Zeile zum gerade geöffneten Chat gehört
function belongsToCurrentRoom(row) {
  if (currentRoom.type === 'group') {
    return (row.group_key || null) === (currentRoom.groupKey || null)
  }
  if (currentRoom.type === 'dm-view') {
    const a = currentRoom.userA
    const b = currentRoom.userB
    return (
      (row.sender_id === a && row.recipient_id === b) ||
      (row.sender_id === b && row.recipient_id === a)
    )
  }
  const me = currentUser.id
  const other = currentRoom.userId
  return (
    (row.sender_id === me && row.recipient_id === other) ||
    (row.sender_id === other && row.recipient_id === me)
  )
}

function removeMessageElement(id, cleanup = true) {
  const el = document.querySelector(`#chat-box [data-id="${id}"]`)
  if (el) el.remove()
  if (cleanup) cleanupDateSeparators()
}

// Ein Datums-Trenner ("Gestern", "Heute", ...) bleibt nur, solange darunter noch mindestens eine
// Nachricht oder Umfrage von diesem Tag steht. Wird nach jedem Löschen aufgerufen.
function cleanupDateSeparators() {
  const chatBox = document.getElementById('chat-box')
  const children = Array.from(chatBox.children)

  children.forEach((el, i) => {
    if (!el.classList.contains('date-separator')) return
    let hasRow = false
    for (let j = i + 1; j < children.length; j++) {
      if (children[j].classList.contains('date-separator')) break
      if (children[j].classList.contains('msg-row')) { hasRow = true; break }
    }
    if (!hasRow) el.remove()
  })

  // Für den nächsten neuen Eintrag: Tag der letzten verbleibenden Nachricht merken
  const rows = chatBox.querySelectorAll('.msg-row[data-created-at]')
  lastMessageDateKey = rows.length ? dateKey(rows[rows.length - 1].dataset.createdAt) : null

  if (chatBox.children.length === 0) showEmptyHint()
}

// ===== Mehrere Nachrichten auswählen und gemeinsam löschen =====
// Nur Nachrichten, die man löschen darf (eigene, als Admin alle). Umfragen sind davon ausgenommen.
function isRowDeletable(row) {
  return !!row.dataset.id && !row.classList.contains('poll-row') &&
    (isAdmin() || row.dataset.senderId === currentUser.id)
}

function makeRowSelectable(row) {
  if (!isRowDeletable(row)) return
  row.classList.add('selectable')
  if (!row.querySelector('.select-dot')) {
    const dot = document.createElement('span')
    dot.className = 'select-dot'
    row.appendChild(dot)
  }
}

function enterSelectMode(firstId) {
  closeMessageMenu()
  if (typeof cancelReplyingTo === 'function') cancelReplyingTo()
  if (typeof cancelEditingMessage === 'function') cancelEditingMessage()

  selectMode = true
  selectedMessageIds = new Set()

  const chatBox = document.getElementById('chat-box')
  chatBox.classList.add('select-mode')
  chatBox.querySelectorAll('.msg-row').forEach(makeRowSelectable)

  const bar = document.getElementById('select-bar')
  const input = document.querySelector('.chat-input-area')
  if (bar) bar.style.display = 'flex'
  if (input) input.style.display = 'none' // die Auswahl-Leiste ersetzt das Eingabefeld

  if (firstId !== undefined) toggleSelected(String(firstId))
  else updateSelectBar()
}

function exitSelectMode() {
  selectMode = false
  selectedMessageIds = new Set()

  const chatBox = document.getElementById('chat-box')
  chatBox.classList.remove('select-mode')
  chatBox.querySelectorAll('.msg-row.selectable, .msg-row.selected').forEach(row => row.classList.remove('selectable', 'selected'))
  chatBox.querySelectorAll('.select-dot').forEach(dot => dot.remove())

  const bar = document.getElementById('select-bar')
  const input = document.querySelector('.chat-input-area')
  if (bar) bar.style.display = 'none'
  if (input) input.style.display = isAdmin() ? 'none' : 'flex' // beim Admin bleibt das Eingabefeld immer weg (nur lesen)
}

function toggleSelected(id) {
  const row = document.querySelector(`#chat-box .msg-row[data-id="${id}"]`)
  if (!row || !row.classList.contains('selectable')) return

  if (selectedMessageIds.has(id)) {
    selectedMessageIds.delete(id)
    row.classList.remove('selected')
  } else {
    selectedMessageIds.add(id)
    row.classList.add('selected')
  }
  updateSelectBar()
}

function updateSelectBar() {
  const count = selectedMessageIds.size
  const countEl = document.getElementById('select-bar-count')
  const deleteBtn = document.getElementById('select-bar-delete')
  if (countEl) countEl.textContent = count === 1 ? '1 ausgewählt' : count + ' ausgewählt'
  if (deleteBtn) deleteBtn.disabled = count === 0
}

function deleteSelectedMessages() {
  const ids = Array.from(selectedMessageIds)
  if (ids.length === 0) return

  const question = ids.length === 1 ? 'Diese Nachricht wirklich löschen?' : ids.length + ' Nachrichten wirklich löschen?'
  showConfirmModal(question, async () => {
    // .select() liefert die tatsächlich gelöschten Zeilen zurück (fehlende Berechtigung = nicht dabei)
    const { data, error } = await supabaseClient
      .from(currentTable())
      .delete()
      .in('id', ids)
      .select()

    if (error) {
      showToast('Löschen fehlgeschlagen: ' + error.message)
      return
    }

    const deleted = (data || []).map(r => String(r.id))
    deleted.forEach(id => removeMessageElement(id, false))
    cleanupDateSeparators()

    if (deleted.length < ids.length) {
      showToast((ids.length - deleted.length) + ' Nachricht(en) konnten nicht gelöscht werden.')
    }
    exitSelectMode()
  })
}

// Im Auswahlmodus wählt ein Klick (oder Tippen) auf eine Nachricht sie aus/ab - Links, Reaktionen usw. sind dann aus
document.getElementById('chat-box').addEventListener('click', (e) => {
  if (!selectMode) return
  e.preventDefault()
  e.stopPropagation()
  const row = e.target.closest('.msg-row')
  if (row && row.classList.contains('selectable')) toggleSelected(row.dataset.id)
}, true)

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectMode) exitSelectMode()
})

// Reaktion setzen, wechseln oder wieder entfernen (ein Klick auf die bereits aktive schaltet sie aus)
async function toggleReaction(messageId, emoji) {
  const table = isDmRoom() ? 'dm_reactions' : 'message_reactions'
  const info = reactionMap[messageId] || { counts: {}, mine: null }

  if (info.mine === emoji) {
    await supabaseClient
      .from(table)
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', currentUser.id)
      .eq('emoji', emoji)
  } else {
    if (info.mine) {
      await supabaseClient
        .from(table)
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', currentUser.id)
        .eq('emoji', info.mine)
    }
    await supabaseClient
      .from(table)
      .insert([{ message_id: messageId, user_id: currentUser.id, emoji: emoji }])
  }

  const updated = await loadReactionsFor([messageId])
  reactionMap[messageId] = updated[messageId] || { counts: {}, mine: null }

  const row = document.querySelector(`#chat-box [data-id="${messageId}"] .msg-reactions`)
  if (row) renderReactionChips(row, messageId)
}

// ===== Datums-Trenner zwischen Nachrichten verschiedener Tage =====
function dateKey(iso) {
  const d = new Date(iso)
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate()
}

function formatDateSeparator(iso) {
  const d = new Date(iso)
  const now = new Date()
  if (dateKey(iso) === dateKey(now)) return 'Heute'

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dateKey(iso) === dateKey(yesterday)) return 'Gestern'

  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function insertDateSeparator(iso) {
  const el = document.createElement('div')
  el.className = 'date-separator'
  const pill = document.createElement('span')
  pill.className = 'date-separator-pill'
  pill.textContent = formatDateSeparator(iso)
  el.appendChild(pill)
  document.getElementById('chat-box').appendChild(el)
}

// Erkennt Links (http/https, www. oder eine .de-Adresse) in einem Nachrichtentext und baut daraus
// echte, in einem neuen Tab öffnende <a>-Elemente, der Rest bleibt normaler Text
function appendTextWithLinks(container, text) {
  const LINK_REGEX = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.de(?:\/[^\s]*)?)/gi
  let lastIndex = 0
  let match

  while ((match = LINK_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
    }

    let raw = match[0]
    // Satzzeichen am Ende (Punkt, Komma, Klammer zu, ...) gehören meist nicht mehr zum Link
    const trailMatch = raw.match(/[).,!?;:]+$/)
    let trailing = ''
    if (trailMatch) {
      trailing = trailMatch[0]
      raw = raw.slice(0, -trailing.length)
    }

    const link = document.createElement('a')
    link.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw
    link.textContent = raw
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.className = 'msg-link'
    link.addEventListener('click', (e) => e.stopPropagation())
    container.appendChild(link)

    if (trailing) container.appendChild(document.createTextNode(trailing))
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) container.appendChild(document.createTextNode(text.slice(lastIndex)))
}

// Baut das kleine Zitat der beantworteten Nachricht oben in einer Sprechblase
function buildReplyQuote(replyToId) {
  const original = messagesById[replyToId]
  const quote = document.createElement('button')
  quote.type = 'button'
  quote.className = 'msg-reply-quote'

  if (!original) {
    quote.classList.add('missing')
    quote.disabled = true
    quote.textContent = 'Ursprüngliche Nachricht nicht mehr verfügbar'
    return quote
  }

  const authorName =
    (original.profiles && original.profiles.display_name) ||
    (profileCache[original.sender_id] && profileCache[original.sender_id].name) ||
    'Unbekannt'

  const authorEl = document.createElement('span')
  authorEl.className = 'msg-reply-author'
  authorEl.textContent = authorName
  const snippetEl = document.createElement('span')
  snippetEl.className = 'msg-reply-snippet'
  snippetEl.textContent = original.text

  quote.appendChild(authorEl)
  quote.appendChild(snippetEl)
  quote.addEventListener('click', (e) => {
    e.stopPropagation()
    jumpToMessage(replyToId)
  })
  return quote
}

// Springt zur ursprünglichen Nachricht und hebt sie kurz hervor
function jumpToMessage(id) {
  const target = document.querySelector(`#chat-box [data-id="${id}"]`)
  if (!target) return
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target.classList.add('highlight')
  setTimeout(() => target.classList.remove('highlight'), 1500)
}

// ----- Auf eine bestimmte Nachricht antworten -----
let replyingToId = null

function startReplyingTo(id) {
  const original = messagesById[id]
  if (!original) return

  cancelEditingMessage() // Antworten und gleichzeitig eine eigene Nachricht bearbeiten schließen sich aus
  replyingToId = id

  const authorName =
    (original.profiles && original.profiles.display_name) ||
    (profileCache[original.sender_id] && profileCache[original.sender_id].name) ||
    'Unbekannt'

  document.getElementById('reply-bar-author').textContent = authorName
  document.getElementById('reply-bar-snippet').textContent = original.text
  document.getElementById('reply-bar').style.display = 'flex'
  document.getElementById('message-input').focus()
}

function cancelReplyingTo() {
  replyingToId = null
  document.getElementById('reply-bar').style.display = 'none'
}

// Eigene Nachricht bearbeiten: der Text wandert unten ins Eingabefeld,
// der Senden-Pfeil wird währenddessen zu einem Häkchen (wie bei WhatsApp)
let editingMessageId = null

// Eine Nachricht lässt sich nur 15 Minuten nach dem Senden bearbeiten (die Datenbank prüft das ebenfalls)
const EDIT_WINDOW_MS = 15 * 60 * 1000

function withinEditWindow(createdAt) {
  const time = new Date(createdAt).getTime()
  return !isNaN(time) && Date.now() - time < EDIT_WINDOW_MS
}

function editWindowExpiredToast() {
  showToast('Bearbeiten ist nur in den ersten 15 Minuten nach dem Senden möglich.')
}

function startEditingMessage(id, oldText) {
  const row = document.querySelector(`#chat-box [data-id="${id}"]`)
  if (row && row.dataset.createdAt && !withinEditWindow(row.dataset.createdAt)) {
    editWindowExpiredToast()
    return
  }
  cancelReplyingTo() // Bearbeiten und gleichzeitig auf etwas antworten schließen sich aus
  editingMessageId = id
  const input = document.getElementById('message-input')
  input.value = oldText
  input.focus()
  autoResizeMessageInput()
  document.getElementById('edit-bar').style.display = 'flex'
  document.getElementById('send-btn').textContent = '✓'
}

function cancelEditingMessage() {
  editingMessageId = null
  document.getElementById('message-input').value = ''
  autoResizeMessageInput()
  document.getElementById('edit-bar').style.display = 'none'
  document.getElementById('send-btn').textContent = '➤'
}

async function saveEditedMessage(newText) {
  const id = editingMessageId
  const input = document.getElementById('message-input')

  // Die Zeit kann während des Bearbeitens abgelaufen sein
  const row = document.querySelector(`#chat-box [data-id="${id}"]`)
  if (row && row.dataset.createdAt && !withinEditWindow(row.dataset.createdAt)) {
    editWindowExpiredToast()
    cancelEditingMessage()
    return
  }

  const { data, error } = await supabaseClient
    .from(currentTable())
    .update({ text: newText, edited_at: new Date().toISOString() })
    .eq('id', id)
    .select()

  if (error) {
    showToast('Bearbeiten fehlgeschlagen: ' + error.message)
  } else if (!data || data.length === 0) {
    showToast('Bearbeiten nicht erlaubt.')
  } else {
    updateMessageElement(data[0])
    cancelEditingMessage()
    return
  }

  input.value = newText
}

// Text (und ggf. den "bearbeitet"-Hinweis) einer bereits angezeigten Nachricht aktualisieren
function updateMessageElement(msg) {
  const row = document.querySelector(`#chat-box [data-id="${msg.id}"]`)
  if (!row) return

  const textEl = row.querySelector('.msg-text')
  if (textEl) textEl.textContent = msg.text

  if (msg.edited_at && !row.querySelector('.msg-edited')) {
    const meta = row.querySelector('.msg-meta')
    const tag = document.createElement('span')
    tag.className = 'msg-edited'
    tag.textContent = '(bearbeitet)'
    meta.appendChild(tag)
  }
}

// 8. Nachricht löschen (eigene Nachricht oder, als Admin, jede Nachricht)
function deleteMessage(id) {
  showConfirmModal('Diese Nachricht wirklich löschen?', async () => {
    // .select() liefert die gelöschten Zeilen zurück; leer = keine Berechtigung (RLS)
    const { data, error } = await supabaseClient
      .from(currentTable())
      .delete()
      .eq('id', id)
      .select()

    if (error) {
      showToast('Löschen fehlgeschlagen: ' + error.message)
    } else if (!data || data.length === 0) {
      showToast('Löschen nicht erlaubt.')
    } else {
      removeMessageElement(id)
    }
  })
}

// 9. Einstellungen: eigener Bildschirm. Eigenes Passwort ändern für alle,
//    bei Admins zusätzlich die Nutzerverwaltung darunter.
function openSettings() {
  if (!desktopQuery.matches) stopListening() // am PC bleibt der Chat rechts offen
  showScreen('settings-bereich')
  document.getElementById('admin-group').style.display = isAdmin() ? '' : 'none'
  document.getElementById('push-group').style.display = isAdmin() ? 'none' : ''
  refreshPushToggleUI()
  updateInstallMenu()
}

function openEmailChange() {
  showScreen('email-change-bereich')
  document.getElementById('current-email-display').value = currentUser.email || ''
  document.getElementById('new-email').value = ''
}

function openPasswordChange() {
  showScreen('password-change-bereich')
  document.getElementById('old-password').value = ''
  document.getElementById('new-password').value = ''
  document.getElementById('repeat-password').value = ''
  refreshPasswordToggles()
}

// ===== Passwort-Auge =====
// Deine beiden SVGs (visible.svg / invisible.svg), direkt eingebaut. So übernehmen sie die Textfarbe
// (auch im dunklen Modus) und brauchen keine extra Datei.
const EYE_VISIBLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="20" height="20" aria-hidden="true"><g transform="translate(0,96) scale(0.1,-0.1)" fill="currentColor" stroke="none"><path d="M360 764 c-93 -25 -162 -64 -231 -133 -101 -102 -158 -241 -101 -249 14 -2 24 3 28 15 24 72 68 146 112 190 224 224 599 148 718 -146 19 -45 27 -56 46 -56 59 0 -1 145 -101 245 -129 127 -306 178 -471 134z"/><path d="M405 601 c-125 -58 -155 -207 -61 -309 111 -122 326 -35 326 132 0 25 -5 57 -11 73 -24 64 -109 123 -179 123 -19 0 -53 -9 -75 -19z m130 -55 c104 -44 98 -200 -10 -241 -45 -18 -88 -12 -125 18 -75 58 -62 186 23 222 41 18 69 18 112 1z"/></g></svg>'
const EYE_INVISIBLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="20" height="20" aria-hidden="true"><g transform="translate(0,96) scale(0.1,-0.1)" fill="currentColor" stroke="none"><path d="M456 502 c-380 -381 -404 -410 -352 -420 13 -3 52 29 126 103 l108 108 29 -21 c78 -56 189 -47 249 20 67 73 73 190 13 254 -19 20 -18 20 29 67 l47 47 46 -38 c61 -50 106 -110 135 -179 19 -47 27 -58 46 -58 20 0 23 5 21 33 -2 58 -52 143 -128 218 l-73 72 65 63 c43 43 63 71 61 84 -8 55 -40 29 -422 -353z m139 -12 c36 -69 5 -156 -65 -184 -51 -20 -55 -20 -108 5 l-44 22 93 93 c52 52 97 94 101 94 4 0 14 -13 23 -30z"/><path d="M360 764 c-93 -25 -162 -64 -231 -133 -101 -102 -158 -241 -101 -249 14 -2 24 3 28 15 71 210 254 337 460 319 66 -5 73 -4 93 18 l23 24 -52 11 c-68 15 -153 13 -220 -5z"/><path d="M405 601 c-69 -31 -130 -123 -114 -170 2 -5 48 35 103 90 83 83 95 99 75 99 -13 0 -42 -9 -64 -19z"/></g></svg>'

// Passt Auge und Feld an: Auge nur sichtbar, wenn etwas im Feld steht.
// Passwort verborgen -> "visible"-Icon (Klick zeigt es), Passwort sichtbar -> "invisible"-Icon (Klick verbirgt es).
function updatePasswordToggle(input) {
  const btn = input.closest('.password-field')?.querySelector('.toggle-password')
  if (!btn) return

  // Feld leer: Passwort wieder verbergen und Auge ausblenden
  if (input.value === '') {
    input.type = 'password'
    btn.style.display = 'none'
    return
  }

  const isShown = input.type !== 'password'
  btn.style.display = ''
  btn.innerHTML = isShown ? EYE_INVISIBLE_SVG : EYE_VISIBLE_SVG
  btn.setAttribute('aria-label', isShown ? 'Passwort verbergen' : 'Passwort anzeigen')
}

// Nach programmatischem Leeren der Felder (Logout, Passwort geändert, ...) aufrufen
function refreshPasswordToggles() {
  document.querySelectorAll('.password-field input').forEach(updatePasswordToggle)
  document.querySelectorAll('[data-rules-for]').forEach(list => updatePasswordRules(list.dataset.rulesFor))
  document.querySelectorAll('[data-match-for]').forEach(hint => updatePasswordMatch(hint.dataset.matchFor))
}

// Regeln unter einem neuen Passwort-Feld: erscheinen beim Tippen, erfüllte Punkte werden grün.
// pwId ist die id des Passwort-Felds, z.B. 'new-password' (Einstellungen) oder 'reset-password'
// (Passwort setzen/Einladung) - so funktioniert dieselbe Logik für beide Stellen.
function updatePasswordRules(pwId) {
  const pw = document.getElementById(pwId).value
  const list = document.querySelector(`[data-rules-for="${pwId}"]`)
  if (!list) return
  list.style.display = pw ? '' : 'none'
  const ok = { length: pw.length >= 8, letter: /[a-zA-Z]/.test(pw), digit: /[0-9]/.test(pw) }
  list.querySelectorAll('li').forEach(li => li.classList.toggle('ok', ok[li.dataset.rule]))
}

// Unter der Wiederholung: stimmt sie mit dem neuen Passwort überein? (siehe updatePasswordRules)
function updatePasswordMatch(pwId) {
  const repeatInput = document.querySelector(`[data-repeat-for="${pwId}"]`)
  const hint = document.querySelector(`[data-match-for="${pwId}"]`)
  if (!repeatInput || !hint) return
  const pw = document.getElementById(pwId).value
  const repeat = repeatInput.value
  hint.style.display = repeat ? '' : 'none'
  const same = repeat === pw
  hint.textContent = same ? '✓ Passwörter stimmen überein' : 'Passwörter stimmen noch nicht überein'
  hint.className = 'pw-match ' + (same ? 'ok' : 'bad')
}

// Zeigt/versteckt den Inhalt eines Passwortfelds über das zugehörige Augen-Symbol
function toggleFieldVisibility(inputId, btn) {
  const input = document.getElementById(inputId)
  input.type = input.type === 'password' ? 'text' : 'password'
  updatePasswordToggle(input)
  input.focus()
}

document.querySelectorAll('.password-field input').forEach(input => {
  input.addEventListener('input', () => updatePasswordToggle(input))
})
document.getElementById('new-password').addEventListener('input', () => { updatePasswordRules('new-password'); updatePasswordMatch('new-password') })
document.getElementById('repeat-password').addEventListener('input', () => updatePasswordMatch('new-password'))
document.getElementById('reset-password').addEventListener('input', () => { updatePasswordRules('reset-password'); updatePasswordMatch('reset-password') })
document.getElementById('reset-repeat-password').addEventListener('input', () => updatePasswordMatch('reset-password'))
refreshPasswordToggles()

async function sendPasswordReset() {
  const username = document.getElementById('forgot-username').value.trim()

  if (!username) {
    showToast('Bitte trage deinen Benutzernamen ein.')
    return
  }

  const btn = document.getElementById('forgot-send-btn')
  btn.disabled = true

  const { data: email, error: lookupError } = await lookupEmailByUsername(username)

  if (lookupError || !email) {
    btn.disabled = false
    showToast('Dieser Benutzername ist uns nicht bekannt.')
    return
  }

  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.href.split('#')[0].split('?')[0]
  })

  btn.disabled = false

  if (error) {
    showToast('Fehler: ' + error.message)
  } else {
    showToast('Ein Link zum Zurücksetzen wurde an die hinterlegte E-Mail-Adresse geschickt. Bitte auch den Spam-Ordner prüfen.', 'success')
    showLogin()
  }
}

// Eigene E-Mail-Adresse ändern (der Benutzername bleibt dabei unverändert,
// er wird nur beim Anlegen eines Kontos einmalig aus der E-Mail abgeleitet)
async function changeEmail() {
  const input = document.getElementById('new-email')
  const newEmail = input.value.trim()

  if (!newEmail) {
    showToast('Bitte eine neue E-Mail-Adresse eingeben.')
    return
  }

  const btn = document.getElementById('change-email-btn')
  btn.disabled = true

  const { error } = await supabaseClient.auth.updateUser({ email: newEmail })

  btn.disabled = false

  if (error) {
    showToast('Fehler beim Ändern: ' + error.message)
  } else {
    input.value = ''
    showToast('Prüf-Link wurde an die neue Adresse geschickt. Erst nach dem Bestätigen gilt die Änderung.', 'success')
    openSettings()
  }
}

// Ein einfacher Mindeststandard: 8+ Zeichen, mindestens ein Buchstabe und eine Zahl
function isStrongPassword(pw) {
  return pw.length >= 8 && /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw)
}

async function changePassword() {
  const oldPassword = document.getElementById('old-password').value
  const newPassword = document.getElementById('new-password').value
  const repeatPassword = document.getElementById('repeat-password').value

  if (!oldPassword) {
    showToast('Bitte dein aktuelles Passwort eingeben.')
    return
  }

  if (!isStrongPassword(newPassword)) {
    showToast('Das neue Passwort muss mindestens 8 Zeichen haben, mit Buchstaben und einer Zahl.')
    return
  }

  if (newPassword !== repeatPassword) {
    showToast('Die Wiederholung stimmt nicht mit dem neuen Passwort überein.')
    return
  }

  const btn = document.getElementById('change-password-btn')
  btn.disabled = true

  // Altes Passwort bestätigen, bevor das neue gesetzt wird
  const { error: checkError } = await supabaseClient.auth.signInWithPassword({
    email: currentUser.email,
    password: oldPassword
  })

  if (checkError) {
    btn.disabled = false
    showToast('Das aktuelle Passwort ist falsch.')
    return
  }

  const { error } = await supabaseClient.auth.updateUser({ password: newPassword })

  btn.disabled = false

  if (error) {
    showToast('Fehler beim Ändern: ' + error.message)
  } else {
    document.getElementById('old-password').value = ''
    document.getElementById('new-password').value = ''
    document.getElementById('repeat-password').value = ''
    refreshPasswordToggles()
    await signOutOtherDevices(currentUser.id)
    showToast('Passwort wurde geändert. Auf allen anderen Geräten wurdest du abgemeldet.', 'success')
    openSettings()
  }
}

// Nach Klick auf den Link aus der "Passwort vergessen"-E-Mail: neues Passwort setzen,
// bis dahin ist nichts anderes möglich als genau das
async function completePasswordReset() {
  const input = document.getElementById('reset-password')
  const newPassword = input.value
  const repeatPassword = document.getElementById('reset-repeat-password').value

  if (!isStrongPassword(newPassword)) {
    showToast('Das Passwort erfüllt noch nicht alle Anforderungen.')
    return
  }
  if (newPassword !== repeatPassword) {
    showToast('Die Passwörter stimmen nicht überein.')
    return
  }

  const btn = document.getElementById('reset-password-btn')
  btn.disabled = true

  // needs_password: false hebt die Sperre für eingeladene Nutzer dauerhaft auf
  const { error } = await supabaseClient.auth.updateUser({
    password: newPassword,
    data: { needs_password: false }
  })

  btn.disabled = false

  if (error) {
    showToast('Fehler beim Setzen des Passworts: ' + error.message)
    return
  }

  const wasRecovery = recoveryMode
  recoveryMode = false
  inviteMode = false
  showToast('Passwort gesetzt. Du bist jetzt eingeloggt.', 'success')

  const { data: { user } } = await supabaseClient.auth.getUser()
  // Nach "Passwort vergessen" sind alle anderen Anmeldungen weg (falls jemand Fremdes noch eingeloggt war)
  if (user && wasRecovery) await signOutOtherDevices(user.id)
  if (user) await enterApp(user)
  else showLogin()
}

// 10. Admin: Nutzerverwaltung - Liste A bis Z, Klick auf einen Namen öffnet rechts die Einstellungen der Person
function openUserManagement() {
  if (!isAdmin()) return
  if (!desktopQuery.matches) stopListening()
  showScreen('users-bereich')
  if (desktopQuery.matches) closeSettingsPanels()
  loadUsers()
}

async function loadUsers() {
  const list = document.getElementById('user-list')

  const { data: users, error } = await supabaseClient
    .from('profiles')
    .select('*')
    .order('display_name')

  if (error) {
    list.textContent = 'Nutzer konnten nicht geladen werden: ' + error.message
    return
  }

  list.innerHTML = ''

  users
    .filter(u => u.id !== currentUser.id)
    .sort((x, y) => (x.display_name || '').localeCompare(y.display_name || '', 'de', { sensitivity: 'base' }))
    .forEach(u => {
      const row = document.createElement('li')
      if (u.is_blocked) row.classList.add('blocked')
      row.dataset.userId = u.id

      const name = document.createElement('span')
      name.className = 'user-name'
      name.textContent = (u.display_name || 'Ohne Namen') +
        (u.is_blocked ? ' (gesperrt)' : '') +
        (u.active === false ? ' (Einladung offen)' : '')
      row.appendChild(name)

      const arrow = document.createElement('span')
      arrow.className = 'settings-arrow'
      arrow.textContent = '›'
      row.appendChild(arrow)

      row.addEventListener('click', () => openUserDetail(u))
      list.appendChild(row)
    })

  if (list.children.length === 0) {
    list.textContent = 'Noch keine anderen Nutzer.'
  }
}

// Einstellungen einer einzelnen Person (Geschlecht, Sperren)
function openUserDetail(u) {
  showScreen('user-detail-bereich')
  renderUserDetail(u)
}

function renderUserDetail(u) {
  document.getElementById('user-detail-title').textContent = u.display_name || 'Ohne Namen'
  const box = document.getElementById('user-detail-content')
  box.innerHTML = `
    <div class="input-group">
      <label>Geschlecht</label>
      <div class="gender-choice">
        <button type="button" class="gender-btn junge${u.gender === 'junge' ? ' active' : ''}" data-value="junge">Junge</button>
        <button type="button" class="gender-btn maedchen${u.gender === 'maedchen' ? ' active' : ''}" data-value="maedchen">Mädchen</button>
      </div>
    </div>
    <div class="user-actions">
      <button type="button" class="${u.is_blocked ? 'unblock-btn' : 'block-btn'}" id="user-block-btn">${u.is_blocked ? 'Entsperren' : 'Sperren'}</button>
      <button type="button" class="delete-btn" id="user-delete-btn">Nutzer löschen</button>
    </div>
  `
  box.querySelectorAll('.gender-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Nochmal auf die gewählte Option drücken hebt die Auswahl wieder auf
      setGender(u, btn.classList.contains('active') ? null : btn.dataset.value)
    })
  })
  document.getElementById('user-block-btn').addEventListener('click', () => setBlocked(u, !u.is_blocked))
  document.getElementById('user-delete-btn').addEventListener('click', () => deleteUser(u))
}

// Nutzer endgültig löschen - läuft über die Edge Function "delete-user" (braucht den geheimen Schlüssel)
async function deleteUser(user) {
  if (!isAdmin()) return
  const name = user.display_name || 'diesen Nutzer'
  if (!(await askConfirm(name + ' wirklich löschen? Das Konto kann nicht wiederhergestellt werden.', { okText: 'Löschen', danger: true }))) return

  const { error } = await supabaseClient.functions.invoke('delete-user', { body: { userId: user.id } })
  if (error) {
    showToast('Löschen fehlgeschlagen: ' + await readFunctionError(error))
    return
  }
  openUserManagement()
}

async function setGender(user, gender) {
  const { error } = await supabaseClient
    .from('profiles')
    .update({ gender: gender || null })
    .eq('id', user.id)

  if (error) {
    showToast('Fehler: ' + error.message)
  } else {
    user.gender = gender || null
    renderUserDetail(user)
  }
  loadUsers()
}

async function setBlocked(user, blocked) {
  if (!isAdmin()) return
  const name = user.display_name || 'diesen Nutzer'
  const question = blocked ? name + ' sperren?' : name + ' wieder entsperren?'
  if (!(await askConfirm(question, { okText: blocked ? 'Sperren' : 'Entsperren', danger: blocked }))) return

  const { data, error } = await supabaseClient
    .from('profiles')
    .update({ is_blocked: blocked })
    .eq('id', user.id)
    .select()

  if (error) {
    showToast('Fehler: ' + error.message)
  } else if (!data || data.length === 0) {
    showToast('Änderung nicht erlaubt.')
  } else {
    user.is_blocked = blocked
    renderUserDetail(user)
  }

  loadUsers()
}

// Neuen Nutzer per E-Mail einladen. Die eigentliche Arbeit macht eine Supabase Edge Function
// ("invite-user"), weil das Anlegen von Konten nicht im Browser passieren darf.
function openNewUser() {
  showScreen('new-user-bereich')
  document.getElementById('new-user-email').value = ''
  document.getElementById('new-user-email').focus()
}

// Edge Functions melden Fehler als "non-2xx" - der eigentliche Grund steckt im Antworttext
async function readFunctionError(error) {
  try {
    const res = error && error.context
    if (res && typeof res.json === 'function') {
      const body = await res.json()
      if (body && (body.error || body.message)) return body.error || body.message
    }
  } catch (e) { /* Antwort war kein JSON */ }
  return error.message
}

async function inviteUser() {
  if (!isAdmin()) return
  const input = document.getElementById('new-user-email')
  const btn = document.getElementById('invite-user-btn')
  const email = input.value.trim()

  if (!email || !email.includes('@')) {
    showToast('Bitte eine gültige E-Mail-Adresse eingeben.')
    return
  }

  btn.disabled = true

  // Aktuelle Sitzung holen (erneuert den Token bei Bedarf) und das Admin-JWT ausdrücklich mitschicken
  const { data: { session } } = await supabaseClient.auth.getSession()
  if (!session) {
    btn.disabled = false
    showToast('Deine Sitzung ist abgelaufen. Bitte melde dich neu an.')
    return
  }

  const { data, error } = await supabaseClient.functions.invoke('invite-user', {
    body: { email },
    headers: { Authorization: 'Bearer ' + session.access_token }
  })
  btn.disabled = false

  if (error) {
    showToast('Einladung konnte nicht gesendet werden: ' + await readFunctionError(error))
    return
  }
  if (data && data.error) {
    showToast('Einladung konnte nicht gesendet werden: ' + data.error)
    return
  }

  input.value = ''
  showToast('Einladung an ' + email + ' gesendet.', 'success')
  loadUsers()
}

// 11. Ausloggen
async function logout() {
  const confirmed = await askConfirm(
    'Möchtest du dich wirklich abmelden? Du erhältst auf diesem Gerät erst wieder Benachrichtigungen, wenn du dich erneut anmeldest.',
    { okText: 'Abmelden', cancelText: 'Abbrechen', danger: true }
  )
  if (!confirmed) return

  await teardownPushSubscription() // vor dem Abmelden, solange die Berechtigung zum Löschen noch da ist
  await supabaseClient.auth.signOut()
  showLogin()
}

// ===== Angemeldete Geräte =====
// Die Liste kommt aus der Datenbank (Funktion list_my_sessions). Ein Gerät abmelden heißt: seine Anmeldung
// löschen. Es bleibt noch bis zu etwa einer Stunde drin (so lange gilt sein letzter Zugangsschlüssel),
// kann sich danach aber nicht mehr erneuern und landet im Login.
async function getCurrentSessionId() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession()
    if (!session) return null
    const part = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(part)).session_id || null
  } catch (e) {
    return null
  }
}

// Aus dem technischen Browser-Text einen lesbaren Gerätenamen machen ("Chrome auf Windows")
function describeDevice(ua) {
  ua = ua || ''
  if (!ua) return 'Unbekanntes Gerät'
  let browser = 'Browser'
  if (/edg\//i.test(ua)) browser = 'Edge'
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera'
  else if (/samsungbrowser/i.test(ua)) browser = 'Samsung Internet'
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox'
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome'
  else if (/safari/i.test(ua)) browser = 'Safari'

  let os = ''
  if (/windows/i.test(ua)) os = 'Windows'
  else if (/iphone/i.test(ua)) os = 'iPhone'
  else if (/ipad/i.test(ua)) os = 'iPad'
  else if (/android/i.test(ua)) os = 'Android'
  else if (/cros/i.test(ua)) os = 'Chromebook'
  else if (/mac os x|macintosh/i.test(ua)) os = 'Mac'
  else if (/linux/i.test(ua)) os = 'Linux'

  return os ? browser + ' auf ' + os : browser
}

function formatLastActive(value) {
  const date = new Date(value)
  if (isNaN(date.getTime())) return ''
  const minutes = Math.round((Date.now() - date.getTime()) / 60000)
  if (minutes < 2) return 'gerade eben aktiv'
  if (minutes < 60) return 'zuletzt aktiv vor ' + minutes + ' Min.'
  const hours = Math.round(minutes / 60)
  if (hours < 24) return 'zuletzt aktiv vor ' + hours + ' Std.'
  return 'zuletzt aktiv am ' + date.toLocaleString('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function openDevices() {
  showScreen('devices-bereich')
  loadDevices()
}

async function loadDevices() {
  const list = document.getElementById('device-list')
  list.innerHTML = ''
  const loading = document.createElement('li')
  loading.className = 'device-empty'
  loading.textContent = 'Lade ...'
  list.appendChild(loading)

  const [{ data, error }, currentId] = await Promise.all([
    supabaseClient.rpc('list_my_sessions'),
    getCurrentSessionId()
  ])

  list.innerHTML = ''
  if (error) {
    const li = document.createElement('li')
    li.className = 'device-empty'
    li.textContent = 'Geräte konnten nicht geladen werden: ' + error.message
    list.appendChild(li)
    return
  }

  // Dieses Gerät zuerst, dann nach letzter Aktivität
  const sessions = (data || []).slice().sort((a, b) => {
    if (a.id === currentId) return -1
    if (b.id === currentId) return 1
    return new Date(b.last_active) - new Date(a.last_active)
  })

  sessions.forEach(sess => {
    const isThis = sess.id === currentId
    const li = document.createElement('li')
    li.className = 'device-item'

    const info = document.createElement('div')
    info.className = 'device-info'

    const name = document.createElement('span')
    name.className = 'device-name'
    name.textContent = describeDevice(sess.user_agent)
    info.appendChild(name)

    const meta = document.createElement('span')
    meta.className = 'device-meta'
    meta.textContent = isThis ? 'Dieses Gerät' : formatLastActive(sess.last_active)
    info.appendChild(meta)

    li.appendChild(info)

    if (!isThis) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'device-logout-btn'
      btn.textContent = 'Abmelden'
      btn.addEventListener('click', () => logoutDevice(sess))
      li.appendChild(btn)
    }
    list.appendChild(li)
  })

  if (sessions.length === 0) {
    const li = document.createElement('li')
    li.className = 'device-empty'
    li.textContent = 'Keine Geräte gefunden.'
    list.appendChild(li)
  }
}

async function logoutDevice(sess) {
  const name = describeDevice(sess.user_agent)
  if (!(await askConfirm(name + ' abmelden?', { okText: 'Abmelden', danger: true }))) return

  const { error } = await supabaseClient.rpc('revoke_my_session', { session_id: sess.id })
  if (error) {
    showToast('Abmelden fehlgeschlagen: ' + error.message)
    return
  }
  showToast(name + ' wurde abgemeldet.', 'success')
  loadDevices()
}

// Push-Abos dieser Person löschen - auf Wunsch das dieses Geräts behalten
async function dropPushSubscriptions(userId, { keepThisDevice }) {
  let query = supabaseClient.from('push_subscriptions').delete().eq('user_id', userId)
  if (keepThisDevice && 'serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = registration && await registration.pushManager.getSubscription()
    if (subscription) query = query.neq('endpoint', subscription.endpoint)
  }
  const { error } = await query
  if (error) console.error('Push-Abos konnten nicht gelöscht werden:', error)
}

// Alle anderen Geräte abmelden (dieses bleibt drin) - samt ihrer Benachrichtigungen
async function signOutOtherDevices(userId) {
  await dropPushSubscriptions(userId, { keepThisDevice: true })
  const { error } = await supabaseClient.auth.signOut({ scope: 'others' })
  if (error) console.error('Andere Geräte konnten nicht abgemeldet werden:', error)
  return !error
}

async function logoutOtherDevices() {
  const question = 'Alle anderen Geräte abmelden? Dieses Gerät bleibt angemeldet.'
  if (!(await askConfirm(question, { okText: 'Abmelden', danger: true }))) return

  if (await signOutOtherDevices(currentUser.id)) {
    showToast('Alle anderen Geräte wurden abgemeldet.', 'success')
  } else {
    showToast('Abmelden fehlgeschlagen. Bitte versuche es nochmal.')
  }
  loadDevices()
}

async function logoutAllDevices() {
  const question = 'Auf allen Geräten abmelden, auch auf diesem? Danach musst du dich überall neu anmelden.'
  if (!(await askConfirm(question, { okText: 'Überall abmelden', danger: true }))) return

  await teardownPushSubscription() // dieses Gerät
  await dropPushSubscriptions(currentUser.id, { keepThisDevice: false }) // alle anderen Abos
  const { error } = await supabaseClient.auth.signOut({ scope: 'global' })
  if (error) console.error('Globales Abmelden fehlgeschlagen:', error)
  showLogin()
}

// ===== Eigene Pop-ups statt alert()/confirm() =====
// Meldung oben am Bildschirm: type 'error' (rot, Standard) oder 'success' (grün).
// Verschwindet nach einigen Sekunden von selbst, ein Klick schließt sie sofort.
function showToast(message, type = 'error') {
  let box = document.getElementById('toast-container')
  if (!box) {
    box = document.createElement('div')
    box.id = 'toast-container'
    box.setAttribute('aria-live', 'polite')
    document.body.appendChild(box)
  }

  // Gleiche Meldung schon sichtbar: nicht doppelt anzeigen
  const existing = Array.from(box.children).find(t => t.dataset.msg === message)
  if (existing) existing.remove()

  // Höchstens drei Meldungen gleichzeitig
  while (box.children.length >= 3) box.firstChild.remove()

  const toast = document.createElement('div')
  toast.className = 'toast ' + (type === 'success' ? 'toast-success' : 'toast-error')
  toast.dataset.msg = message
  toast.setAttribute('role', type === 'success' ? 'status' : 'alert')

  const icon = document.createElement('span')
  icon.className = 'toast-icon'
  icon.textContent = type === 'success' ? '✓' : '!'
  const text = document.createElement('span')
  text.className = 'toast-text'
  text.textContent = message
  toast.append(icon, text)

  const close = () => {
    toast.classList.add('toast-out')
    setTimeout(() => toast.remove(), 200)
  }
  toast.addEventListener('click', close)
  box.appendChild(toast)
  setTimeout(close, 3500 + message.length * 40) // längere Texte bleiben länger stehen
}

// Bestätigungsfenster in der Mitte. Gibt true (bestätigt) oder false (abgebrochen) zurück:
// if (!(await askConfirm('Wirklich löschen?', { okText: 'Löschen', danger: true }))) return
function askConfirm(message, { okText = 'OK', cancelText = 'Abbrechen', danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'confirm-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'confirm-dialog'
    dialog.setAttribute('role', 'alertdialog')
    dialog.setAttribute('aria-modal', 'true')

    const text = document.createElement('p')
    text.textContent = message

    const buttons = document.createElement('div')
    buttons.className = 'confirm-buttons'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'confirm-cancel'
    cancelBtn.textContent = cancelText
    const okBtn = document.createElement('button')
    okBtn.type = 'button'
    okBtn.className = danger ? 'confirm-ok danger' : 'confirm-ok'
    okBtn.textContent = okText
    buttons.append(cancelBtn, okBtn)

    dialog.append(text, buttons)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    cancelBtn.focus() // Vorauswahl ist "Abbrechen", damit man nicht aus Versehen bestätigt

    const finish = result => {
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      resolve(result)
    }
    const onKey = e => { if (e.key === 'Escape') finish(false) }
    document.addEventListener('keydown', onKey)
    cancelBtn.addEventListener('click', () => finish(false))
    okBtn.addEventListener('click', () => finish(true))
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(false) })
  })
}

// Enter-Taste
function onEnter(id, fn) {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      fn()
    }
  })
}

onEnter('message-input', sendMessage)

const MESSAGE_INPUT_MAX_LINES = 5 // so viele Zeilen wächst das Feld mit - danach scrollt es für sich weiter

function autoResizeMessageInput() {
  const input = document.getElementById('message-input')
  input.style.height = 'auto'

  // Das Feld rechnet mit Rahmen (border-box): scrollHeight enthält den Rahmen nicht. Ohne diese 2px blieb das Feld
  // immer ein kleines Stück zu niedrig und war dadurch schon bei einer Zeile "scrollbar".
  const style = getComputedStyle(input)
  const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
  const borderY = input.offsetHeight - input.clientHeight
  let lineHeight = parseFloat(style.lineHeight)
  if (isNaN(lineHeight)) lineHeight = (parseFloat(style.fontSize) || 16) * 1.35

  const maxHeight = Math.ceil(lineHeight * MESSAGE_INPUT_MAX_LINES + paddingY + borderY) // genau 5 Zeilen
  const wanted = input.scrollHeight + borderY
  input.style.height = Math.min(wanted, maxHeight) + 'px'
  input.style.overflowY = wanted > maxHeight + 1 ? 'auto' : 'hidden'

  document.getElementById('attach-btn').classList.toggle('hidden-btn', input.value.trim() !== '')
  updateMessageScrollbar()
}

// Eigener Scroll-Balken im Nachrichtenfeld: erscheint erst, wenn der Text nicht mehr komplett ins Feld passt
// (ab der sechsten Zeile) und zeigt dann, wo man im Text ist. Seine Länge bleibt immer gleich.
function updateMessageScrollbar() {
  const input = document.getElementById('message-input')
  const bar = document.getElementById('message-scrollbar')
  if (!input || !bar) return
  const thumb = bar.firstElementChild

  const style = getComputedStyle(input)
  const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
  let lineHeight = parseFloat(style.lineHeight)
  if (isNaN(lineHeight)) lineHeight = (parseFloat(style.fontSize) || 16) * 1.35
  const overflow = input.scrollHeight - input.clientHeight

  // Alles Geschriebene ist im Feld sichtbar (bis zur fünften Zeile): Balken komplett aus dem Layout nehmen
  if (overflow <= 2) {
    bar.classList.remove('visible')
    thumb.style.transform = ''
    return
  }
  bar.classList.add('visible') // erst jetzt hat der Balken eine Höhe zum Messen

  const SCROLLBAR_INSET = 24 // 12px oben + 12px unten (siehe .field-scrollbar im CSS)
  const trackHeight = bar.clientHeight
  const twoLineLength = Math.round(lineHeight * 2 + paddingY - SCROLLBAR_INSET) // feste Länge des Balkens
  const thumbHeight = Math.max(14, Math.min(twoLineLength, trackHeight))

  // Ganz unten, solange man am Textende schreibt; wandert nach oben, wenn man im Text hochscrollt
  const top = (trackHeight - thumbHeight) * (input.scrollTop / overflow)
  thumb.style.height = thumbHeight + 'px'
  thumb.style.transform = 'translateY(' + Math.round(top) + 'px)'
}

document.getElementById('message-input').addEventListener('input', autoResizeMessageInput)
document.getElementById('message-input').addEventListener('scroll', updateMessageScrollbar)
window.addEventListener('resize', updateMessageScrollbar)
autoResizeMessageInput()

// ===== Meldung bei fehlender Internetverbindung =====
function updateOfflineBanner() {
  document.getElementById('offline-banner').style.display = navigator.onLine ? 'none' : 'block'
}
window.addEventListener('online', updateOfflineBanner)
window.addEventListener('offline', updateOfflineBanner)
updateOfflineBanner()
onEnter('username', login)
onEnter('password', login)
onEnter('forgot-username', sendPasswordReset)
onEnter('reset-password', completePasswordReset)
onEnter('reset-repeat-password', completePasswordReset)
onEnter('new-user-email', inviteUser)

// ===== Push-Benachrichtigungen (kommen auch an, wenn die Seite gar nicht offen ist) =====
// Öffentlicher VAPID-Schlüssel - passend zum privaten Gegenstück, das als Supabase-Secret hinterlegt ist
const VAPID_PUBLIC_KEY = 'BIWDoDgxglJlPAOdWtaY5e3kjw-Q2Fg0DXnM4RsPqiwbxjhhOHIjB2_vHSE_TeYw2tN1JinxIhFCIg4eY27l66Q'

// Geräte-Einstellung (nicht Konto-Einstellung!): merkt sich pro Browser/Gerät, ob hier schon einmal
// über Push entschieden wurde - '1' aktiviert, '0' bewusst deaktiviert, nichts = noch nie gefragt.
// Bleibt beim Abmelden bestehen, damit sich das Gerät beim nächsten Login selbst wieder anmeldet,
// ohne erneut nachzufragen. Mehrere Geräte gleichzeitig sind kein Problem, jedes hat sein eigenes Abo.
const PUSH_DEVICE_FLAG = 'pushDeviceEnabled'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('sw.js')
  } catch (err) {
    console.error('Service Worker konnte nicht registriert werden:', err)
    return null
  }
}

function pushSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window
}

// Läuft nach jedem Login. Entscheidet anhand der Geräte-Einstellung, ob still weitergemacht,
// gefragt, oder gar nichts getan wird - und fragt dabei NIE erneut, wenn für dieses Gerät schon
// einmal eine Entscheidung getroffen wurde.
async function initPushForDevice() {
  if (isAdmin() || !pushSupported()) return

  const deviceFlag = localStorage.getItem(PUSH_DEVICE_FLAG)

  if (deviceFlag === '1') {
    // War auf diesem Gerät schon aktiviert (evtl. für einen anderen Account) - beim erneuten
    // Anmelden automatisch wieder verbinden, ohne die Person nochmal zu fragen
    if (Notification.permission === 'granted') {
      await enablePushNotifications({ silent: true })
    } else {
      localStorage.removeItem(PUSH_DEVICE_FLAG) // Berechtigung wurde inzwischen extern entzogen
    }
    return
  }

  if (deviceFlag === '0') return // hier bewusst ausgeschaltet - nicht erneut fragen

  // Noch nie auf diesem Gerät entschieden
  const ok = await askConfirm(
    'Benachrichtigungen aktivieren, damit du neue Nachrichten auch mitbekommst, wenn die Seite gerade nicht offen ist?',
    { okText: 'Aktivieren', cancelText: 'Später' }
  )
  if (ok) {
    await enablePushNotifications()
  } else {
    localStorage.setItem(PUSH_DEVICE_FLAG, '0')
  }
}

async function enablePushNotifications({ silent = false } = {}) {
  if (isAdmin()) return false // Admin: nirgends und nie Push
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      if (!silent) showToast('Ohne Erlaubnis im Browser können keine Benachrichtigungen ankommen.')
      refreshPushToggleUI()
      return false
    }

    const registration = await registerServiceWorker()
    if (!registration) return false

    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      })
    }

    const json = subscription.toJSON()
    const subRow = {
      user_id: currentUser.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth
    }
    // session_id verknüpft das Push-Abo mit der Anmeldung: wird ein Gerät abgemeldet, verschwindet auch sein Abo.
    // Gibt es die Spalte noch nicht, wird ohne gespeichert (läuft dann wie bisher).
    let { error } = await supabaseClient.from('push_subscriptions')
      .upsert({ ...subRow, session_id: await getCurrentSessionId() }, { onConflict: 'endpoint' })
    if (error && /session_id/.test(error.message || '')) {
      ({ error } = await supabaseClient.from('push_subscriptions').upsert(subRow, { onConflict: 'endpoint' }))
    }

    if (error) {
      console.error('Push-Abo konnte nicht gespeichert werden:', error)
      if (!silent) showToast('Push-Abo konnte nicht gespeichert werden.')
      return false
    }

    localStorage.setItem(PUSH_DEVICE_FLAG, '1')
    refreshPushToggleUI()
    return true
  } catch (err) {
    console.error('Push-Benachrichtigungen konnten nicht aktiviert werden:', err)
    if (!silent) showToast('Push-Benachrichtigungen konnten nicht aktiviert werden.')
    return false
  }
}

// Meldet das aktuelle Gerät komplett ab: Browser-Abo kündigen und den Eintrag in Supabase löschen.
// Rührt die Geräte-Einstellung (PUSH_DEVICE_FLAG) NICHT an - das entscheiden logout() und der
// Einstellungen-Schalter jeweils selbst, je nachdem, ob es ein bewusstes Ausschalten war oder nicht.
async function teardownPushSubscription() {
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) return

  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return

  const endpoint = subscription.endpoint
  try {
    await subscription.unsubscribe()
  } catch (err) {
    console.error('Push-Abo konnte nicht gekündigt werden:', err)
  }

  const { error } = await supabaseClient.from('push_subscriptions').delete().eq('endpoint', endpoint)
  if (error) console.error('Push-Eintrag konnte nicht gelöscht werden:', error)
}

// Schalter in den Einstellungen: manuelles Ein-/Ausschalten pro Gerät
async function onPushToggleChanged() {
  const toggle = document.getElementById('push-toggle')
  if (isAdmin()) { toggle.checked = false; return }
  if (toggle.checked) {
    const ok = await enablePushNotifications()
    toggle.checked = ok
  } else {
    await teardownPushSubscription()
    localStorage.setItem(PUSH_DEVICE_FLAG, '0') // bewusst ausgeschaltet - hier nicht erneut fragen
  }
}

// Setzt den Schalter in den Einstellungen auf den tatsächlichen Stand dieses Geräts
async function refreshPushToggleUI() {
  const toggle = document.getElementById('push-toggle')
  if (!toggle) return
  if (!pushSupported()) {
    toggle.checked = false
    toggle.disabled = true
    return
  }
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = registration ? await registration.pushManager.getSubscription() : null
  toggle.checked = Notification.permission === 'granted' && !!subscription
}

// Kleiner Zahlen-Kreis auf dem App-Symbol (Homescreen/Taskleiste) - nur bei installierter App
// sichtbar und nur in Browsern, die das unterstützen (Chrome/Edge, Safari ab iOS 16.4).
function updateAppBadge(count) {
  if (!('setAppBadge' in navigator)) return
  if (isAdmin()) count = 0 // Admin: keine Zahl auf dem App-Symbol
  if (count > 0) navigator.setAppBadge(count).catch(() => {})
  else navigator.clearAppBadge?.().catch(() => {})
}

// ===== Wer ist online? =====
// Jede angemeldete Person (außer dem Admin, der nur mitliest) meldet sich in einem gemeinsamen Echtzeit-Kanal
// an, solange die App offen und sichtbar ist. Daraus entsteht "online" im Einzelchat und "2 online" in Gruppen.
let presenceChannel = null
let presenceSubscribed = false
let onlineUserIds = new Set()

function startPresence() {
  if (presenceChannel || !currentUser) return

  presenceChannel = supabaseClient.channel('online-users', {
    config: { presence: { key: currentUser.id } }
  })

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      onlineUserIds = new Set(Object.keys(presenceChannel.presenceState()))
      updateOnlineIndicator()
    })
    .subscribe((status) => {
      presenceSubscribed = status === 'SUBSCRIBED'
      if (presenceSubscribed) syncPresenceTracking()
    })
}

// Online ist man, solange die App sichtbar ist (im Hintergrund oder bei gesperrtem Handy nicht)
function syncPresenceTracking() {
  if (!presenceChannel || !presenceSubscribed || isAdmin()) return
  if (document.visibilityState === 'visible') {
    presenceChannel.track({ online_at: new Date().toISOString() })
  } else {
    presenceChannel.untrack()
  }
}

document.addEventListener('visibilitychange', syncPresenceTracking)

function stopPresence() {
  if (presenceChannel) supabaseClient.removeChannel(presenceChannel)
  presenceChannel = null
  presenceSubscribed = false
  onlineUserIds = new Set()
  updateOnlineIndicator()
}

// Die anderen Personen dieses Chats, die gerade online sind (ich selbst zähle nicht mit)
function onlineMembersOfRoom() {
  return recipientIdsForRoom().filter(id => onlineUserIds.has(id))
}

function updateOnlineIndicator() {
  const el = document.getElementById('online-status')
  if (!el) return

  let text = ''
  let clickable = false

  if (currentUser && currentRoom) {
    const online = onlineMembersOfRoom()
    if (currentRoom.type === 'dm') {
      if (online.length > 0) text = 'online'
    } else if (currentRoom.type === 'group') {
      if (online.length > 0) text = online.length + ' online'
      clickable = online.length > 0
    }
  }

  el.textContent = text
  el.style.display = text ? '' : 'none'
  el.classList.toggle('clickable', clickable)
}

function openOnlineList() {
  if (!currentRoom || currentRoom.type !== 'group') return
  const names = onlineMembersOfRoom()
    .map(id => (profileCache[id] && profileCache[id].name) || 'Ohne Namen')
    .sort((a, b) => a.localeCompare(b, 'de'))
  if (names.length === 0) return

  const list = document.getElementById('online-list')
  list.innerHTML = ''
  names.forEach(name => {
    const li = document.createElement('li')
    li.textContent = name
    list.appendChild(li)
  })
  document.getElementById('online-modal').style.display = 'flex'
}

function closeOnlineList() {
  document.getElementById('online-modal').style.display = 'none'
}

// ===== Als App installieren =====
// Beim ersten Besuch auf jedem Gerät erscheint kurz nach dem Laden ein Pop-up. Wer nicht will, findet
// "Als App installieren" danach in den Einstellungen. Ist die App schon installiert (oder läuft die Seite
// bereits als App), kommt weder das Pop-up noch der Eintrag in den Einstellungen.
const INSTALL_DISMISSED_KEY = 'installPopupDismissed' // '1' = hier nicht mehr automatisch fragen
const INSTALLED_KEY = 'appInstalled'                   // '1' = auf diesem Gerät schon installiert
let deferredInstallPrompt = null                       // Chrome/Edge/Android: das echte Installations-Fenster

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) // iPad mit "Desktop-Seite"
}

function isAndroidDevice() {
  return /android/i.test(navigator.userAgent)
}

function isAppInstalledHere() {
  if (isStandaloneApp()) {
    localStorage.setItem(INSTALLED_KEY, '1') // läuft schon als App -> merken
    return true
  }
  return localStorage.getItem(INSTALLED_KEY) === '1'
}

// Chrome/Edge melden, dass die Seite installierbar ist - das Fenster dazu heben wir uns für den Klick auf
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferredInstallPrompt = e
})

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null
  localStorage.setItem(INSTALLED_KEY, '1')
  closeInstallPopup()
  updateInstallMenu()
})

// Der Eintrag in den Einstellungen ist immer da: ist die App schon installiert, steht dort "App installiert" mit Haken
function updateInstallMenu() {
  const label = document.getElementById('menu-install-label')
  const state = document.getElementById('menu-install-state')
  if (!label || !state) return
  const installed = isAppInstalledHere()
  label.textContent = installed ? 'App installiert' : 'Als App installieren'
  state.textContent = installed ? '✓' : '›'
}

function onInstallMenuClick() {
  if (isAppInstalledHere()) {
    showToast('Die App ist schon installiert.', 'success')
  } else {
    openInstallPopup()
  }
}

function installPopupAllowed() {
  return !isAppInstalledHere() && localStorage.getItem(INSTALL_DISMISSED_KEY) !== '1'
}

// Zeigt das Pop-up automatisch, kurz nachdem die Seite geladen ist - nur auf Geräten, auf denen
// Installieren überhaupt geht (Chrome/Edge mit Installations-Fenster, iPhone/iPad, Android)
function scheduleInstallPopup() {
  setTimeout(() => {
    const settingPassword = inviteMode || recoveryMode || /type=(invite|recovery)/.test(window.location.hash)
    if (settingPassword || !installPopupAllowed()) return
    if (deferredInstallPrompt || isIosDevice() || isAndroidDevice()) openInstallPopup()
  }, 2000)
}

function openInstallPopup() {
  const textEl = document.getElementById('install-modal-text')
  const stepsEl = document.getElementById('install-steps')
  const installBtn = document.getElementById('install-confirm-btn')
  const closeBtn = document.getElementById('install-close-btn')
  if (!textEl) return

  stepsEl.innerHTML = ''
  let steps = []

  if (deferredInstallPrompt) {
    textEl.textContent = 'Installiere den JungscharChat als App. Er startet dann direkt von deinem Startbildschirm, ohne Browser-Leiste.'
    installBtn.style.display = ''
    closeBtn.textContent = 'Nicht jetzt'
  } else {
    installBtn.style.display = 'none'
    closeBtn.textContent = 'Schließen'
    if (isIosDevice()) {
      textEl.textContent = 'So legst du den JungscharChat als App auf deinen Home-Bildschirm (in Safari):'
      steps = [
        'Tippe auf das Teilen-Symbol (Quadrat mit Pfeil nach oben).',
        'Wähle „Zum Home-Bildschirm“.',
        'Tippe oben rechts auf „Hinzufügen“.'
      ]
    } else if (isAndroidDevice()) {
      textEl.textContent = 'So legst du den JungscharChat als App auf deinen Startbildschirm:'
      steps = [
        'Tippe im Browser oben rechts auf das Menü (drei Punkte).',
        'Wähle „App installieren“ oder „Zum Startbildschirm hinzufügen“.'
      ]
    } else {
      textEl.textContent = 'Klicke im Browser in der Adressleiste oder im Menü auf „Installieren“ bzw. „App installieren“. Manche Browser bieten das nicht an - am besten klappt es in Chrome oder Edge.'
    }
  }

  steps.forEach(text => {
    const li = document.createElement('li')
    li.textContent = text
    stepsEl.appendChild(li)
  })
  stepsEl.style.display = steps.length ? '' : 'none'

  document.getElementById('install-modal').style.display = 'flex'
}

function closeInstallPopup() {
  const modal = document.getElementById('install-modal')
  if (modal) modal.style.display = 'none'
}

// "Nicht jetzt" / "Schließen": hier nicht mehr automatisch fragen (in den Einstellungen geht es jederzeit)
function dismissInstallPopup() {
  localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
  closeInstallPopup()
}

async function confirmInstall() {
  const promptEvent = deferredInstallPrompt
  if (!promptEvent) return
  deferredInstallPrompt = null // ein Installations-Fenster lässt sich nur einmal benutzen
  closeInstallPopup()

  promptEvent.prompt()
  const { outcome } = await promptEvent.userChoice
  if (outcome === 'accepted') {
    localStorage.setItem(INSTALLED_KEY, '1')
  } else {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
  }
  updateInstallMenu()
}

registerServiceWorker()

init()
scheduleInstallPopup()