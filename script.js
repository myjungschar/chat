// 1. Supabase Client initialisieren
const SUPABASE_URL = 'https://qawjgxikppiumpptchow.supabase.co' // Aus Settings -> API
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhd2pneGlrcHBpdW1wcHRjaG93Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwMDc0NDYsImV4cCI6MjEwNTU4MzQ0Nn0.CIhHOS2Zznk9pYbWWTrcqO2A-QWbSSGAJC7TY0UQgTs'     // Aus Settings -> API

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,   // Anmeldung bleibt auf jedem Gerät gespeichert
    autoRefreshToken: true  // der Zugangsschlüssel wird im Hintergrund selbst erneuert
  },
  realtime: {
    // Kürzerer Herzschlag: eine tote Verbindung (z. B. nach Standby oder Netzwechsel) fällt schneller auf
    heartbeatIntervalMs: 15000,
    // Bei Verbindungsverlust schnell und immer wieder neu versuchen (0,5 s, 1 s, 2 s, dann alle 3 s)
    reconnectAfterMs: (tries) => [500, 1000, 2000][tries - 1] || 3000
  }
})

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
let profileEmailCache = {}  // user_id -> E-Mail-Adresse (nur Admin), damit sie nicht bei jedem Öffnen neu geladen wird
let profileRequestId = 0    // zählt bei jedem Öffnen/Schließen eines Profils hoch, damit späte Antworten nichts mehr überschreiben
let typingChannel = null    // Realtime (Broadcast): wer im offenen Chat gerade tippt
let typingSubscribed = false
let typingUsers = {}        // user_id -> Timer, der "tippt" nach kurzer Zeit wieder ausblendet
let lastTypingSent = 0      // ms, wann ich zuletzt "ich tippe" gesendet habe

// Welcher Chat ist gerade offen: die Gruppe oder ein Einzelchat mit einer bestimmten Person
let currentRoom = { type: 'group' }

function isAdmin() {
  return currentProfile && currentProfile.role === 'admin'
}

// Feste Farbpalette für Avatare (ohne Lila). Der Admin kann jeder Person eine Farbe zuweisen (profiles.color);
// ohne gespeicherte Farbe wird sie aus der ID berechnet, damit jeder Nutzer immer dieselbe Farbe bekommt.
const AVATAR_COLORS = ['#5b8def', '#3fb98c', '#e2a33d', '#e2665f', '#3fb0c9', '#d16fa8', '#4d6fa3', '#5b8c6b']
// Berechnete Farbe: dieselbe Reihenfolge wie früher, damit jede Person ihre gewohnte Farbe behält.
// Nur das frühere Lila ist durch ein blasses Dunkelblau ersetzt.
const COMPUTED_COLORS = ['#5b8def', '#3fb98c', '#e2a33d', '#e2665f', '#4d6fa3', '#3fb0c9', '#d16fa8']
const AVATAR_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

function computedAvatarColor(id) {
  const text = String(id || '')
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = text.charCodeAt(i) + ((hash << 5) - hash)
  return COMPUTED_COLORS[Math.abs(hash) % COMPUTED_COLORS.length]
}

// Die Farbe landet teils direkt in style="..." - deshalb nur ein echter Hex-Wert, nie beliebiger Text aus der Datenbank
function avatarColor(id) {
  const info = profileCache[id]
  if (info && typeof info.color === 'string' && AVATAR_COLOR_PATTERN.test(info.color)) return info.color
  return computedAvatarColor(id)
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

// Dunkler/heller Modus. Ohne eigene Auswahl folgt die App dem Modus des Geräts/Browsers (und wechselt mit).
// Wer in der App bewusst etwas anderes wählt als das Gerät, behält diese Wahl (gespeichert im Browser, nur auf diesem Gerät).
const systemThemeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null

function systemPrefersLight() {
  return !!(systemThemeQuery && systemThemeQuery.matches)
}

function applyThemeClass(isLight) {
  document.body.classList.toggle('light-theme', isLight)
  syncThemeSwitches(!isLight)
  const themeMeta = document.querySelector('meta[name="theme-color"]')
  if (themeMeta) themeMeta.setAttribute('content', isLight ? '#ffffff' : '#0e1621') // Farbe der Browser-Leiste
}

function applyStoredTheme() {
  const stored = localStorage.getItem('theme')
  const isLight = stored === 'light' || stored === 'dark' ? stored === 'light' : systemPrefersLight()
  applyThemeClass(isLight)
}

// Stellt das Gerät um und es gibt keine eigene Auswahl, zieht die App sofort mit
if (systemThemeQuery && systemThemeQuery.addEventListener) {
  systemThemeQuery.addEventListener('change', () => {
    const stored = localStorage.getItem('theme')
    if (stored !== 'light' && stored !== 'dark') applyStoredTheme()
  })
}

function toggleDarkMode() {
  const toggle = document.getElementById('dark-mode-toggle')
  setTheme(toggle.checked)
}

// Der Schalter oben rechts auf dem Login-Bildschirm - derselbe wie in den Einstellungen, nur
// ohne dass man sich dafür erst einloggen und dorthin navigieren muss
function setTheme(wantsDark) {
  // Entspricht die Wahl dem Gerätemodus, wird nichts gespeichert: dann bleibt die App mit dem Gerät synchron
  if (!wantsDark === systemPrefersLight()) localStorage.removeItem('theme')
  else localStorage.setItem('theme', wantsDark ? 'dark' : 'light')
  applyThemeClass(!wantsDark)
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
      setTimeout(fillResetUsername, 0)
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

  // Einladungs-Link ein zweites Mal angeklickt (verbraucht), die Einladung wurde hier aber nur abgebrochen: weitermachen
  if (linkError && !session && localStorage.getItem(PENDING_INVITE_KEY)) {
    if (!(await resumePendingInvite())) showLogin() // bei Misserfolg zeigt resumePendingInvite() den Hinweis selbst
    return
  }

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
  profileEmailCache = {}
  resetGroupState()
  closeProfileModals()

  const aboutCard = document.getElementById('about-card')
  if (aboutCard) aboutCard.classList.remove('open')
  document.getElementById('username').value = ''
  document.getElementById('password').value = ''
  refreshPasswordToggles()
  updatePendingInviteNotice()
  showScreen('login-bereich')
}

// Trägt den Benutzernamen der gerade angemeldeten Person in das (nur lesbare) Feld ein.
// So kann der Browser beim Speichern des neuen Passworts den richtigen Benutzernamen dazu merken.
async function fillResetUsername(userId) {
  const field = document.getElementById('reset-username')
  field.value = ''
  let id = userId
  if (!id) {
    const { data: { user } } = await supabaseClient.auth.getUser()
    id = user && user.id
  }
  if (!id) return
  const { data: profile } = await supabaseClient.from('profiles').select('display_name').eq('id', id).single()
  if (profile && profile.display_name) field.value = profile.display_name
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
  document.getElementById('reset-username').value = name || ''
  document.getElementById('reset-heading').textContent = name ? `Willkommen, ${name}!` : 'Willkommen!'
  document.getElementById('reset-subtext').textContent =
    'Du wurdest eingeladen. Vergib zuerst ein eigenes Passwort, bevor es weitergeht.'
  showScreen('reset-bereich')
}

// ===== Einladung abbrechen und später fortsetzen =====
// Der Link aus der Einladungs-Mail ist bei Supabase ein Einmal-Link: schon beim ersten Klick ist er verbraucht.
// Damit man trotzdem abbrechen und es auf demselben Gerät nochmal versuchen kann, merkt sich die App die
// angefangene Einladung. Weitermachen geht dann per "Einladung fortsetzen" auf dem Login-Bildschirm
// oder durch erneutes Klicken auf den Link in der Mail.
const PENDING_INVITE_KEY = 'pendingInviteSession'

// Die Sitzung nur in diesem Browser vergessen, ohne sie bei Supabase zu beenden (signOut() würde sie ungültig machen)
function forgetSessionLocally() {
  Object.keys(localStorage)
    .filter(key => /^sb-.+-auth-token(-code-verifier)?$/.test(key))
    .forEach(key => localStorage.removeItem(key))
}

function updatePendingInviteNotice() {
  const box = document.getElementById('pending-invite')
  if (box) box.style.display = localStorage.getItem(PENDING_INVITE_KEY) ? '' : 'none'
}

// "Abbrechen" auf dem Passwort-setzen-Bildschirm: zurück zum normalen Login, als wäre nichts passiert
async function cancelPasswordSetup() {
  const wasRecovery = recoveryMode
  recoveryMode = false
  inviteMode = false
  history.replaceState(null, '', window.location.pathname + window.location.search)

  if (wasRecovery) {
    // "Passwort vergessen": nichts zu merken, die Sitzung einfach beenden
    await supabaseClient.auth.signOut({ scope: 'local' }) // nur dieses Gerät
    showLogin()
    showToast('Abgebrochen.', 'success')
    return
  }

  // Einladung: Sitzung merken, damit sie sich später fortsetzen lässt
  const { data: { session } } = await supabaseClient.auth.getSession()
  if (session) {
    localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token
    }))
    forgetSessionLocally()
  }
  showLogin()
  showToast('Abgebrochen. Mit „Einladung fortsetzen“ kannst du später weitermachen.', 'success')
}

// Angefangene Einladung wieder aufnehmen: führt direkt zurück zum Passwort-setzen-Bildschirm
async function resumePendingInvite() {
  const raw = localStorage.getItem(PENDING_INVITE_KEY)
  if (!raw) return false

  inviteMode = true // damit der Auth-Callback den richtigen Bildschirm zeigt
  try {
    const saved = JSON.parse(raw)
    const { data, error } = await supabaseClient.auth.setSession({
      access_token: saved.access_token,
      refresh_token: saved.refresh_token
    })
    if (error || !data.session) throw error || new Error('keine Sitzung')

    localStorage.removeItem(PENDING_INVITE_KEY)
    await showInviteSetup(data.session.user.id)
    return true
  } catch (e) {
    inviteMode = false
    localStorage.removeItem(PENDING_INVITE_KEY)
    updatePendingInviteNotice()
    showToast('Die Einladung ist nicht mehr gültig. Bitte lass dir eine neue Einladung schicken.')
    return false
  }
}

// Chatliste anzeigen (Startbildschirm nach dem Login): lädt Profil + Nutzerliste
async function enterApp(user) {
  // Eingeladene Person, die noch kein eigenes Passwort gesetzt hat: nicht in den Chat - auch nicht nach
  // einem Neuladen der Seite (dann ist der Link aus der Adresszeile schon weg, die Sitzung aber noch da).
  if (user.user_metadata && user.user_metadata.needs_password === true) {
    await showInviteSetup(user.id)
    return
  }

  // Das Profil laden - bei schlechtem Netz bis zu 3 Versuche. Ein Netzwerkfehler darf NIEMALS zum Abmelden
  // führen (früher wurde dabei die Sitzung auf allen Geräten beendet).
  let profile = null
  let error = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1200))
    ;({ data: profile, error } = await supabaseClient
      .from('profiles')
      // '*' statt Spaltenliste: so läuft die App auch, solange die Spalte "birthdate" noch nicht angelegt ist
      .select('*')
      .eq('id', user.id)
      .single())
    if (profile || (error && error.code === 'PGRST116')) break // gefunden, oder es gibt das Profil wirklich nicht
  }

  if (!profile && error && error.code !== 'PGRST116') {
    // Kein Netz oder Serverproblem: angemeldet bleiben, nur diesmal nicht hineinkommen
    showLogin()
    showToast('Keine Verbindung zum Server. Du bist weiter angemeldet - lade die Seite in einem Moment neu.')
    return
  }

  if (!profile) {
    showToast('Dein Profil konnte nicht geladen werden.')
    await supabaseClient.auth.signOut({ scope: 'local' }) // nur dieses Gerät
    showLogin()
    return
  }

  if (profile.is_blocked) {
    showToast('Dein Zugang wurde gesperrt. Bitte wende dich an die Leitung.')
    await supabaseClient.auth.signOut({ scope: 'local' })
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
  await loadVipIds()
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
  warmUpEmojiPicker()
  ensureBirthdate() // noch kein Geburtsdatum gespeichert? Dann kommt das Pflicht-Fenster
  consumePendingPushOpen() // die App wurde über den Klick auf eine Benachrichtigung gestartet
  showBirthdayAnnouncement() // heute jemand Geburtstag? Einmal am Tag ein Pop-up
  scheduleInstallPopup() // "Zur Startseite hinzufügen" erst, wenn man angemeldet ist
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
    if (isAdmin()) return // Der Admin sieht alle Chats neutral: nirgends ein Ungelesen-Zähler
    if (row.sender_id === me) return
    const lastRead = newMarks[key]
    if (!lastRead || new Date(row.created_at) > lastRead) {
      newUnread[key] = (newUnread[key] || 0) + 1
    }
  }

  const { data: groupRows } = await supabaseClient
    .from('messages')
    .select('text, photo_id, audio_id, created_at, group_key, sender_id')
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
    .select('text, photo_id, audio_id, created_at, sender_id, recipient_id')
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
  updateAppBadge(Object.entries(unreadCounts).reduce((sum, [key, n]) => sum + (isChatMuted(key) ? 0 : n), 0))
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

// Kleines durchgestrichenes Glocken-Symbol hinter dem Namen stummgeschalteter Gruppen
const MUTE_ICON_HTML = '<svg class="mute-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Stummgeschaltet"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>'

// Baut den Inhalt eines Listeneintrags: Avatar, Name, Vorschau-Text, Uhrzeit, Ungelesen-Zähler
function chatListItemHTML(avatarHTML, name, preview, unreadCount, muted) {
  const previewText = preview ? truncate(messageSnippet(preview), 34) : 'Noch keine Nachrichten'
  const timeText = preview ? formatChatListTime(preview.created_at) : 'Keine Nachrichten'
  const badge = unreadCount > 0
    ? `<span class="unread-badge">${unreadCount}</span>`
    : ''
  return `
    ${avatarHTML}
    <div class="chat-list-text">
      <div class="chat-list-name">${escapeHTML(name)}${muted ? MUTE_ICON_HTML : ''}</div>
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
  await loadMutedChats()
  await loadChatPreviews()
  // Zwischenzeitlich ausgeloggt oder schon ein neuerer Ladevorgang gestartet? Dann nichts mehr zeichnen
  if (!currentUser || myRenderId !== chatListRenderId) return
  birthdayDayRendered = toISODate(new Date())
  await loadChatGroups()
  if (!currentUser || myRenderId !== chatListRenderId) return
  updateNewGroupButton()

  const list = document.getElementById('chat-list')
  list.innerHTML = ''

  const groupItem = document.createElement('li')
  groupItem.className = 'chat-list-item pinned' + (isChatMuted('main') ? ' muted' : '')
  groupItem.innerHTML = chatListItemHTML(
    '<div class="chat-list-avatar group-avatar">📌</div>',
    'JungscharChat',
    groupPreviews['main'],
    unreadFor('main'),
    isChatMuted('main')
  )
  groupItem.dataset.chatKey = 'main'
  groupItem.dataset.tabs = 'alle gruppen'
  groupItem.dataset.name = 'JungscharChat'
  groupItem.addEventListener('click', openGroupChat)
  list.appendChild(groupItem)

  // Eigene Gruppen: direkt unter der Hauptgruppe
  appendCustomGroupItems(list)

  if (isAdmin() || currentProfile.gender === 'junge') {
    const item = document.createElement('li')
    item.className = 'chat-list-item pinned' + (isChatMuted('junge') ? ' muted' : '')
    item.innerHTML = chatListItemHTML(
      '<div class="chat-list-avatar group-avatar">👦</div>',
      'Jungs',
      groupPreviews['junge'],
      unreadFor('junge'),
      isChatMuted('junge')
    )
    item.dataset.chatKey = 'junge'
    item.dataset.tabs = 'alle gruppen' // die Gruppe selbst gehört nur unter "Gruppen", die passenden Einzelchats tragen "junge" schon eigenständig
    item.dataset.name = 'Jungs'
    item.addEventListener('click', () => openGenderGroup('junge', 'Jungs'))
    list.appendChild(item)
  }

  if (isAdmin() || currentProfile.gender === 'maedchen') {
    const item = document.createElement('li')
    item.className = 'chat-list-item pinned' + (isChatMuted('maedchen') ? ' muted' : '')
    item.innerHTML = chatListItemHTML(
      '<div class="chat-list-avatar group-avatar">👧</div>',
      'Mädels',
      groupPreviews['maedchen'],
      unreadFor('maedchen'),
      isChatMuted('maedchen')
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
    item.className = 'chat-list-item' + (isChatMuted('dm:' + id) ? ' muted' : '')
    item.innerHTML = chatListItemHTML(
      `<div class="chat-list-avatar${hasBirthdayToday(id) ? ' birthday' : ''}" style="background:${avatarColor(id)}">${initialsOf(name)}</div>`,
      (name || 'Ohne Namen') + birthdayMark(id),
      dmPreviews[id],
      unreadFor('dm:' + id),
      isChatMuted('dm:' + id)
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

  applyEmojiImages(list)
  renderChatTabs()
  applyChatTabFilter()

  markActiveListItem()
}

// Ungelesen-Zähler für die Liste. Der Chat, der am PC gerade rechts offen ist, zeigt keinen.
function unreadFor(key) {
  if (isAdmin()) return 0
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
    .select('sender_id, recipient_id, text, photo_id, audio_id, created_at')
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
  document.getElementById('conversation-title').textContent = title + (currentRoom && currentRoom.type === 'dm' ? birthdayMark(currentRoom.userId) : '')
  updateConversationTitleTap()
  updateOnlineIndicator()
  showScreen('conversation-bereich')
  cancelEditingMessage()
  cancelReplyingTo()

  // Admins lesen überall mit, schreiben aber nirgends
  document.querySelector('.chat-input-area').style.display = isAdmin() ? 'none' : 'flex'

  latestSeenAt = null
  peerMarks = {}
  markActiveListItem() // am PC: den geöffneten Chat links hervorheben
  loadVipIds() // frische VIP-Liste, muss nicht abgewartet werden
  await loadMessages()
  listenForNewMessages()
  startPollListening()
  startPinListening()
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
    profileCache[p.id] = { name: p.display_name, role: p.role, blocked: !!p.is_blocked, gender: p.gender, active: p.active !== false, birthdate: p.birthdate || null, color: p.color || null }
  })
}

async function fetchProfileName(userId) {
  const { data } = await supabaseClient
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (data) {
    profileCache[userId] = { name: data.display_name, role: data.role, blocked: !!data.is_blocked, gender: data.gender, birthdate: data.birthdate || null, color: data.color || null }
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
  const unreadFromId = firstUnreadMessageId(messages)
  closeChatSearch() // Suche gehört zum bisherigen Chat
  suppressMissedCount = true // beim Laden des Verlaufs zählt nichts als "verpasst"
  messages.forEach(msg => renderMessage(msg))
  suppressMissedCount = false
  resetMissedCount()
  await loadPollsForRoom() // fügt sich zeitlich passend zwischen die Nachrichten ein
  await loadPinForRoom() // angepinnte Nachricht (Leiste oben + Hinweis im Verlauf)

  if (chatBox.children.length === 0) showEmptyHint()
  applyEmojiImages(chatBox)
  chatBox.scrollTop = chatBox.scrollHeight
  showUnreadDivider(unreadFromId, messages)
}

// Ab welcher Nachricht ist im Chat noch nichts gelesen? (nur eigene Chats, nicht für den Admin; nur wenn der Chat
// schon einmal geöffnet war - sonst wäre ja alles "neu" und die Linie ganz oben ohne Aussage)
function firstUnreadMessageId(messages) {
  if (!currentUser || isAdmin() || (currentRoom.type !== 'group' && currentRoom.type !== 'dm')) return null
  const key = chatKeyForRoom(currentRoom)
  const lastRead = key ? readMarks[key] : null
  if (!lastRead) return null
  const first = messages.find(m => m.sender_id !== currentUser.id && new Date(m.created_at) > lastRead)
  return first ? first.id : null
}

// Setzt die Linie "N neue Nachrichten" direkt vor die erste ungelesene Nachricht. Sind es mehr, als auf den Bildschirm
// passen, springt der Chat dorthin, statt ganz unten zu starten.
function showUnreadDivider(messageId, messages) {
  if (!messageId) return
  const chatBox = document.getElementById('chat-box')
  const row = chatBox.querySelector('[data-id="' + messageId + '"]')
  if (!row) return

  const first = messages.findIndex(m => m.id === messageId)
  const count = messages.slice(first).filter(m => m.sender_id !== currentUser.id).length

  const divider = document.createElement('div')
  divider.className = 'unread-divider'
  const label = document.createElement('span')
  label.textContent = count === 1 ? '1 neue Nachricht' : count + ' neue Nachrichten'
  divider.appendChild(label)
  row.before(divider)

  const dividerTop = divider.getBoundingClientRect().top - chatBox.getBoundingClientRect().top + chatBox.scrollTop
  if (dividerTop < chatBox.scrollTop) chatBox.scrollTop = Math.max(0, dividerTop - 12)
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

  if (!isPhotoBlockedSelf()) { // wer keine Fotos senden darf, bekommt die Punkte "Foto" und "Audio" gar nicht erst
    const photoItem = document.createElement('button')
    photoItem.className = 'msg-menu-item'
    photoItem.textContent = 'Foto'
    photoItem.addEventListener('click', () => { closeAttachMenu(); startPhotoFlow() })
    menu.appendChild(photoItem)

    const audioItem = document.createElement('button')
    audioItem.className = 'msg-menu-item'
    audioItem.textContent = 'Audio'
    audioItem.addEventListener('click', () => { closeAttachMenu(); startAudioFlow() })
    menu.appendChild(audioItem)
  }

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

// ===== Fotos =====
// Ablauf: Plus -> "Foto" -> Hinweis auf SwissTransfer -> Foto aussuchen -> Vorschau (mit "HD"-Schalter und optionaler
// Bildunterschrift) -> Senden. Das Foto wird im Browser verkleinert und an die Edge Function "upload-photo" geschickt,
// die es privat in Google Drive ablegt. In der Nachricht stehen nur die Drive-Datei-IDs (photo_id = Foto,
// photo_thumb_id = kleine Vorschau). Angezeigt wird über die Edge Function "get-photo", die vorher prüft, ob man den Chat sehen darf.
const PHOTO_MAX_EDGE = 1600           // Standard: längste Seite in Pixeln
const PHOTO_QUALITY = 0.8
const PHOTO_MAX_BYTES = 1.5 * 1024 * 1024
const PHOTO_HD_MAX_EDGE = 4096        // HD: nur begrenzt, nicht im Original (spart Speicher und Zeit)
const PHOTO_HD_QUALITY = 0.92
const PHOTO_HD_MAX_BYTES = 8 * 1024 * 1024
const PHOTO_THUMB_EDGE = 480
const PHOTO_THUMB_QUALITY = 0.72
const PHOTO_THUMB_MAX_BYTES = 200 * 1024
const PHOTO_INPUT_MAX_BYTES = 40 * 1024 * 1024 // größer als das darf die Original-Datei nicht sein
const PHOTO_CAPTION_MAX = 1000
const SWISSTRANSFER_URL = 'https://www.swisstransfer.com'
const PHOTO_CACHE_NAME = 'chat-photos'
const PHOTO_CACHE_MAX_ENTRIES = 150

let photoInputEl = null
let photoSending = false

function messageSnippet(msg) {
  return (msg && msg.text) || (msg && msg.photo_id ? '📷 Foto' : '') || (msg && msg.audio_id ? '🎵 Audio' : '')
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB'
}

function getPhotoInput() {
  if (!photoInputEl) {
    photoInputEl = document.createElement('input')
    photoInputEl.type = 'file'
    photoInputEl.accept = 'image/*'
    photoInputEl.style.display = 'none'
    photoInputEl.addEventListener('change', () => {
      const file = photoInputEl.files && photoInputEl.files[0]
      photoInputEl.value = ''
      if (file) openPhotoPreview(file)
    })
    document.body.appendChild(photoInputEl)
  }
  return photoInputEl
}

function startPhotoFlow(pastedFile) {
  if (!currentUser || isAdmin() || currentRoom.type === 'dm-view') return
  if (isPhotoBlockedSelf()) { showToast('Du darfst im Moment keine Fotos senden.'); return }
  if (editingMessageId) { showToast('Schließe zuerst das Bearbeiten ab.'); return }
  if (!navigator.onLine) { showToast('Keine Internetverbindung.'); return }
  // Der Hinweis kommt bei JEDEM Foto. Erst danach öffnet sich die Foto-Auswahl.
  showSwissTransferHint(() => {
    if (pastedFile) openPhotoPreview(pastedFile) // Foto kam aus der Zwischenablage
    else getPhotoInput().click()
  })
}

// Foto aus der Zwischenablage einfügen (Strg+V bzw. "Einfügen"), z. B. ein Screenshot
document.getElementById('message-input').addEventListener('paste', (e) => {
  const data = e.clipboardData
  if (!data || !data.items) return
  if (data.getData('text/plain')) return // normaler Text (auch aus Word/Excel, die zusätzlich ein Bild mitliefern)
  for (const item of data.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (!file) continue
      e.preventDefault()
      startPhotoFlow(file)
      return
    }
  }
})

// Pop-up: bei vielen Fotos bitte SwissTransfer nutzen (kommt bei jedem Foto, ohne Wartezeit)
function showSwissTransferHint(onContinue) {
  const overlay = document.createElement('div')
  overlay.className = 'confirm-overlay'

  const dialog = document.createElement('div')
  dialog.className = 'confirm-dialog photo-hint-dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')

  const title = document.createElement('p')
  title.className = 'photo-hint-title'
  title.textContent = 'Viele Fotos?'

  const text = document.createElement('p')
  text.className = 'photo-hint-text'
  text.textContent = 'Nutze dafür bitte SwissTransfer und schick den Link hier in den Chat.'

  const link = document.createElement('a')
  link.className = 'photo-hint-link'
  link.href = SWISSTRANSFER_URL
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = 'SwissTransfer öffnen'

  const buttons = document.createElement('div')
  buttons.className = 'confirm-buttons'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'confirm-cancel'
  cancelBtn.textContent = 'Abbrechen'
  const okBtn = document.createElement('button')
  okBtn.type = 'button'
  okBtn.className = 'confirm-ok'
  okBtn.textContent = 'Ein Foto senden'
  buttons.append(cancelBtn, okBtn)

  dialog.append(title, text, link, buttons)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  const finish = () => {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  const onKey = e => { if (e.key === 'Escape') finish() }
  document.addEventListener('keydown', onKey)
  cancelBtn.addEventListener('click', finish)
  overlay.addEventListener('click', e => { if (e.target === overlay) finish() })
  okBtn.addEventListener('click', () => {
    finish()
    onContinue() // direkt im Klick, sonst blockt der Browser die Foto-Auswahl
  })
}

// ----- Verkleinern im Browser -----
async function loadImageSource(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }) } catch (e) { /* Fallback unten */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild nicht lesbar')) }
    img.src = url
  })
}

function drawScaled(src, maxEdge) {
  const sw = src.naturalWidth || src.width
  const sh = src.naturalHeight || src.height
  const scale = Math.min(1, maxEdge / Math.max(sw, sh))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff' // durchsichtige Stellen (PNG) werden weiß statt schwarz
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height)
  return canvas
}

function canvasToBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
}

// Verkleinert, bis das Ergebnis unter maxBytes liegt (höchstens 5 Versuche)
async function compressImage(src, maxEdge, quality, maxBytes) {
  let edge = maxEdge
  let q = quality
  for (let i = 0; i < 5; i++) {
    const canvas = drawScaled(src, edge)
    const blob = await canvasToBlob(canvas, q)
    if (!blob) throw new Error('Verkleinern fehlgeschlagen')
    if (blob.size <= maxBytes || i === 4) return { blob, width: canvas.width, height: canvas.height }
    q = Math.max(0.6, q - 0.08)
    edge = Math.round(edge * 0.85)
  }
}

// ----- Vorschau vor dem Senden -----
async function openPhotoPreview(file) {
  if (!file.type || !file.type.startsWith('image/')) { showToast('Das ist kein Foto.'); return }
  if (file.size > PHOTO_INPUT_MAX_BYTES) { showToast('Das Foto ist zu groß (höchstens 40 MB).'); return }

  let src
  try {
    src = await loadImageSource(file)
  } catch (e) {
    showToast('Dieses Foto kann nicht geöffnet werden.')
    return
  }

  const results = {}      // 'normal' / 'hd' -> { blob, width, height, url }
  let thumbResult = null
  let hd = false
  let busy = false
  let closed = false

  const overlay = document.createElement('div')
  overlay.className = 'confirm-overlay'
  const dialog = document.createElement('div')
  dialog.className = 'confirm-dialog photo-dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')

  // Das Foto mit kleinem "HD"-Knopf oben in der Ecke
  const previewWrap = document.createElement('div')
  previewWrap.className = 'photo-dialog-preview loading'
  const previewImg = document.createElement('img')
  previewImg.alt = 'Vorschau'
  const hdBtn = document.createElement('button')
  hdBtn.type = 'button'
  hdBtn.className = 'photo-hd-btn'
  hdBtn.textContent = 'HD'
  hdBtn.title = 'Volle Qualität'
  hdBtn.setAttribute('aria-pressed', 'false')
  previewWrap.append(previewImg, hdBtn)

  const caption = document.createElement('input')
  caption.type = 'text'
  caption.className = 'photo-caption'
  caption.placeholder = 'Nachricht'
  caption.maxLength = PHOTO_CAPTION_MAX

  const buttons = document.createElement('div')
  buttons.className = 'confirm-buttons'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'confirm-cancel'
  cancelBtn.textContent = 'Abbrechen'
  const sendBtn = document.createElement('button')
  sendBtn.type = 'button'
  sendBtn.className = 'confirm-ok'
  sendBtn.textContent = 'Senden'
  sendBtn.disabled = true
  buttons.append(cancelBtn, sendBtn)

  dialog.append(previewWrap, caption, buttons)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  async function showVersion() {
    const key = hd ? 'hd' : 'normal'
    previewWrap.classList.add('loading')
    sendBtn.disabled = true
    try {
      if (!results[key]) {
        const r = hd
          ? await compressImage(src, PHOTO_HD_MAX_EDGE, PHOTO_HD_QUALITY, PHOTO_HD_MAX_BYTES)
          : await compressImage(src, PHOTO_MAX_EDGE, PHOTO_QUALITY, PHOTO_MAX_BYTES)
        r.url = URL.createObjectURL(r.blob)
        results[key] = r
      }
    } catch (e) {
      console.error('Foto verkleinern:', e)
      previewWrap.classList.remove('loading')
      showToast('Das Foto konnte nicht vorbereitet werden.')
      return
    }
    if (closed || key !== (hd ? 'hd' : 'normal')) return // inzwischen umgeschaltet oder geschlossen
    previewImg.src = results[key].url
    previewWrap.classList.remove('loading')
    sendBtn.disabled = busy
  }

  function close() {
    closed = true
    document.removeEventListener('keydown', onKey)
    overlay.remove()
    Object.values(results).forEach(r => URL.revokeObjectURL(r.url))
    if (src && typeof src.close === 'function') src.close()
  }

  function setBusy(value) {
    busy = value
    cancelBtn.disabled = value
    hdBtn.disabled = value
    caption.disabled = value
    sendBtn.disabled = value
    sendBtn.textContent = value ? 'Sendet …' : 'Senden'
  }

  async function submit() {
    if (busy || sendBtn.disabled) return
    setBusy(true)
    try {
      const main = results[hd ? 'hd' : 'normal']
      if (!thumbResult) thumbResult = await compressImage(src, PHOTO_THUMB_EDGE, PHOTO_THUMB_QUALITY, PHOTO_THUMB_MAX_BYTES)
      const ok = await sendPhotoMessage(main, thumbResult, caption.value.trim())
      if (ok) { close(); return }
    } catch (e) {
      console.error('Foto senden:', e)
      showToast('Das Foto konnte nicht gesendet werden.')
    }
    setBusy(false)
  }

  const onKey = e => { if (e.key === 'Escape' && !busy) close() }
  document.addEventListener('keydown', onKey)
  cancelBtn.addEventListener('click', () => { if (!busy) close() })
  hdBtn.addEventListener('click', () => {
    if (busy) return
    hd = !hd
    hdBtn.classList.toggle('active', hd)
    hdBtn.setAttribute('aria-pressed', hd ? 'true' : 'false')
    showVersion()
  })
  sendBtn.addEventListener('click', submit)
  caption.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit() } })

  showVersion()
}

// Lädt das Foto hoch und legt danach die Nachricht an. true = geschafft
async function sendPhotoMessage(main, thumb, captionText) {
  if (!currentUser || photoSending) return false
  photoSending = true

  // Den Chat von jetzt merken - falls man während des Hochladens in einen anderen Chat wechselt
  const room = currentRoom
  const table = currentTable()
  const replyId = replyingToId

  try {
    const form = new FormData()
    form.append('photo', main.blob, 'foto.jpg')
    form.append('thumb', thumb.blob, 'vorschau.jpg')

    const { data: up, error: upError } = await supabaseClient.functions.invoke('upload-photo', { body: form })
    if (upError || !up || !up.photo_id) {
      const detail = upError ? await readFunctionError(upError) : 'Unbekannter Fehler'
      showToast('Foto konnte nicht hochgeladen werden: ' + detail)
      return false
    }

    const row = {
      sender_id: currentUser.id,
      text: captionText || '',
      photo_id: up.photo_id,
      photo_thumb_id: up.thumb_id || null,
      photo_w: main.width,
      photo_h: main.height
    }
    if (room.type === 'dm') row.recipient_id = room.userId
    else row.group_key = room.groupKey || null
    if (replyId) row.reply_to_id = replyId

    const { data: inserted, error } = await supabaseClient
      .from(table)
      .insert([row])
      .select('*, profiles!sender_id(display_name)')
      .single()

    if (error) {
      await handleSendError(error)
      return false
    }

    if (replyingToId === replyId) cancelReplyingTo()
    if (currentRoom === room && belongsToCurrentRoom(inserted)) renderMessage(inserted)
    return true
  } finally {
    photoSending = false
  }
}

// ===== Audio =====
// Ablauf: Plus -> "Audio" -> Datei aussuchen (.mp3, .m4a, .wav, höchstens 10 MB) -> bestätigen. Die Datei geht über
// dieselbe Edge Function wie die Fotos ("upload-photo") privat nach Google Drive; in der Nachricht stehen nur die
// Drive-ID (audio_id) und der Typ (audio_mime). Abgespielt wird über "get-photo", das vorher prüft, ob man den Chat sehen darf.
const AUDIO_MAX_BYTES = 50 * 1024 * 1024
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav']
let audioInputEl = null
let audioSending = false

function getAudioInput() {
  if (!audioInputEl) {
    audioInputEl = document.createElement('input')
    audioInputEl.type = 'file'
    audioInputEl.accept = '.mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav'
    audioInputEl.style.display = 'none'
    audioInputEl.addEventListener('change', () => {
      const file = audioInputEl.files && audioInputEl.files[0]
      audioInputEl.value = ''
      if (file) confirmAndSendAudio(file)
    })
    document.body.appendChild(audioInputEl)
  }
  return audioInputEl
}

function startAudioFlow() {
  if (!currentUser || isAdmin() || currentRoom.type === 'dm-view') return
  if (isPhotoBlockedSelf()) { showToast('Du darfst im Moment keine Fotos und Audios senden.'); return }
  if (editingMessageId) { showToast('Schließe zuerst das Bearbeiten ab.'); return }
  if (!navigator.onLine) { showToast('Keine Internetverbindung.'); return }
  getAudioInput().click()
}

async function confirmAndSendAudio(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (!AUDIO_EXTENSIONS.includes(ext)) { showToast('Erlaubt sind nur .mp3, .m4a und .wav.'); return }
  if (file.size === 0) { showToast('Die Datei ist leer.'); return }
  if (file.size > AUDIO_MAX_BYTES) { showToast('Die Datei ist zu groß (höchstens ' + formatBytes(AUDIO_MAX_BYTES) + ').'); return }

  const name = await askAudioName(file)
  if (name) await sendAudioMessage(file, name)
}

// Kleines Fenster vor dem Senden: den Dateinamen ändern. Die Endung (.mp3 ...) steht fest dahinter und bleibt.
// Gibt den ganzen neuen Namen zurück, oder null bei "Abbrechen".
function askAudioName(file) {
  return new Promise(resolve => {
    const dot = file.name.lastIndexOf('.')
    const ext = dot > 0 ? file.name.slice(dot) : '.' + (file.name.split('.').pop() || 'mp3')
    const base = dot > 0 ? file.name.slice(0, dot) : file.name

    const overlay = document.createElement('div')
    overlay.className = 'confirm-overlay'
    const dialog = document.createElement('div')
    dialog.className = 'confirm-dialog audio-name-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')

    const heading = document.createElement('p')
    heading.className = 'audio-name-heading'
    heading.textContent = 'Audio senden (' + formatBytes(file.size) + ')'

    const row = document.createElement('div')
    row.className = 'audio-name-row'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = base
    input.maxLength = 100
    input.autocomplete = 'off'
    input.setAttribute('aria-label', 'Dateiname')
    const suffix = document.createElement('span')
    suffix.className = 'audio-name-ext'
    suffix.textContent = ext
    row.append(input, suffix)

    const buttons = document.createElement('div')
    buttons.className = 'confirm-buttons'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'confirm-cancel'
    cancelBtn.textContent = 'Abbrechen'
    const okBtn = document.createElement('button')
    okBtn.type = 'button'
    okBtn.className = 'confirm-ok'
    okBtn.textContent = 'Senden'
    buttons.append(cancelBtn, okBtn)

    dialog.append(heading, row, buttons)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    input.focus()
    input.select()

    const finish = (send) => {
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      if (!send) return resolve(null)
      const cleaned = input.value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
      resolve((cleaned || base) + ext)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false)
      else if (e.key === 'Enter' && document.activeElement !== cancelBtn) { e.preventDefault(); finish(true) }
    }
    document.addEventListener('keydown', onKey)
    cancelBtn.addEventListener('click', () => finish(false))
    okBtn.addEventListener('click', () => finish(true))
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false) })
  })
}

// Sofort nach dem Senden erscheint diese Blase im Chat: Dateiname, ein drehender Kreis statt Play und "wird hochgeladen".
// Sobald die echte Nachricht da ist, wird sie ersetzt.
function addPendingAudioBubble(name, size) {
  const chatBox = document.getElementById('chat-box')
  const emptyHint = chatBox.querySelector('.chat-empty')
  if (emptyHint) emptyHint.remove()

  const row = document.createElement('div')
  row.className = 'msg-row own pending-audio'
  const msgEl = document.createElement('div')
  msgEl.className = 'msg own has-audio'

  const wrap = document.createElement('div')
  wrap.className = 'msg-audio'
  const btn = document.createElement('div')
  btn.className = 'msg-audio-play'
  btn.innerHTML = AUDIO_SPINNER
  const body = document.createElement('div')
  body.className = 'msg-audio-body'
  const title = document.createElement('div')
  title.className = 'msg-audio-title'
  title.textContent = name
  const meta = document.createElement('div')
  meta.className = 'msg-audio-meta'
  meta.textContent = formatBytes(size) + ' · wird hochgeladen …'
  body.append(title, meta)
  wrap.append(btn, body)
  msgEl.appendChild(wrap)
  row.appendChild(msgEl)

  chatBox.appendChild(row)
  chatBox.scrollTop = chatBox.scrollHeight
  return row
}

// Lädt die Audio-Datei hoch und legt danach die Nachricht an
async function sendAudioMessage(file, displayName) {
  if (!currentUser || audioSending) return
  audioSending = true

  // Den Chat von jetzt merken - falls man während des Hochladens in einen anderen Chat wechselt
  const room = currentRoom
  const table = currentTable()
  const replyId = replyingToId
  const title = displayName || file.name
  const pending = addPendingAudioBubble(title, file.size)

  try {
    const durationPromise = readAudioDuration(file) // läuft nebenher, damit das Hochladen sofort startet
    const form = new FormData()
    form.append('audio', file, file.name)

    const { data: up, error: upError } = await supabaseClient.functions.invoke('upload-photo', { body: form })
    if (upError || !up || !up.audio_id) {
      const detail = upError ? await readFunctionError(upError) : 'Unbekannter Fehler'
      pending.remove()
      showToast('Audio konnte nicht hochgeladen werden: ' + detail)
      return
    }
    const duration = await durationPromise

    const row = {
      sender_id: currentUser.id, text: '', audio_id: up.audio_id, audio_mime: up.audio_mime || null,
      audio_name: audioTitleFromFile(title), audio_size: file.size
    }
    if (duration) row.audio_duration = duration
    if (room.type === 'dm') row.recipient_id = room.userId
    else row.group_key = room.groupKey || null
    if (replyId) row.reply_to_id = replyId

    const { data: inserted, error } = await supabaseClient
      .from(table)
      .insert([row])
      .select('*, profiles!sender_id(display_name)')
      .single()

    pending.remove()
    if (error) {
      await handleSendError(error)
      return
    }

    if (replyingToId === replyId) cancelReplyingTo()
    if (currentRoom === room && belongsToCurrentRoom(inserted)) renderMessage(inserted)
  } catch (e) {
    pending.remove()
    console.error('Audio senden:', e)
    showToast('Audio senden hat nicht geklappt.')
  } finally {
    audioSending = false
  }
}

// Titel = der echte Dateiname, unverändert (nur auf 120 Zeichen gekürzt, die Endung bleibt am Ende erhalten)
function audioTitleFromFile(fileName) {
  const name = String(fileName || '').trim()
  if (name.length <= 120) return name || 'Audio'
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : ''
  return name.slice(0, 120 - ext.length) + ext
}

// Titel für die Anzeige. Ältere Audios haben keinen gespeicherten Namen: dann steht das Datum dabei statt nur "Audio".
function audioDisplayTitle(msg) {
  if (msg.audio_name) return msg.audio_name
  const d = msg.created_at ? new Date(msg.created_at) : null
  return d && !isNaN(d) ? 'Audio vom ' + d.toLocaleDateString('de-DE') : 'Audio'
}

// Länge der Datei in ganzen Sekunden (oder null, wenn der Browser sie nicht lesen kann)
function readAudioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const probe = document.createElement('audio')
    let timer = null
    const done = (value) => {
      clearTimeout(timer)
      probe.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve(value)
    }
    timer = setTimeout(() => done(null), 4000)
    probe.preload = 'metadata'
    probe.onloadedmetadata = () => done(isFinite(probe.duration) && probe.duration > 0 ? Math.round(probe.duration) : null)
    probe.onerror = () => done(null)
    probe.src = url
  })
}

function formatAudioTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + sec : m + ':' + sec
}

// Dateiendung nach dem gespeicherten Typ (Standard: mp3)
function audioExtension(msg) {
  const mime = String((msg && msg.audio_mime) || '').toLowerCase()
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a'
  return 'mp3'
}

async function downloadAudio(msg) {
  try {
    showToast('Audio wird geladen …')
    const blob = await fetchPhotoBlob(msg.audio_id)
    const mime = msg.audio_mime || 'audio/mpeg'
    const file = blob.type && blob.type.startsWith('audio/') ? blob : new Blob([blob], { type: mime })
    let name = audioDisplayTitle(msg).replace(/[\\/:*?"<>|]+/g, '_')
    if (!/\.(mp3|m4a|wav)$/i.test(name)) name += '.' + audioExtension(msg)
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 15000)
  } catch (e) {
    console.error('Audio herunterladen:', e)
    showToast(e && e.status === 404 ? 'Das Audio gibt es nicht mehr.' : 'Herunterladen hat nicht geklappt.')
  }
}

const AUDIO_SPEEDS = [1, 1.25, 1.5, 2]
let audioSpeed = 1          // die gewählte Geschwindigkeit gilt für alle Audios (Auswahl über das Menü der Nachricht)
let activeAudioPause = null // es läuft immer nur ein Audio gleichzeitig

const AUDIO_PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>'
const AUDIO_SPINNER = '<span class="audio-spinner" aria-hidden="true"></span>'
const AUDIO_PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>'

function audioSpeedLabel(speed) {
  return String(speed).replace('.', ',') + 'x'
}

// Geschwindigkeit setzen: wirkt sofort auf das laufende Audio und auf alle weiteren
function setAudioSpeed(speed) {
  audioSpeed = speed
  if (activeAudioPause && activeAudioPause.audio) activeAudioPause.audio.playbackRate = speed
}

// Der Player in der Nachrichten-Blase. Vor dem Start: Knopf, Titel und darunter "Länge, Größe" (wie bei Telegram).
// Ab dem Start: der Titel rückt nach oben, darunter die schlanke Leiste und darunter links die verstrichene Zeit,
// rechts die Gesamtlänge. Die Höhe bleibt gleich. Die Datei wird erst beim ersten Abspielen geholt.
function buildAudioElement(msg) {
  const wrap = document.createElement('div')
  wrap.className = 'msg-audio'

  const playBtn = document.createElement('button')
  playBtn.type = 'button'
  playBtn.className = 'msg-audio-play'
  playBtn.setAttribute('aria-label', 'Abspielen')
  playBtn.innerHTML = AUDIO_PLAY_ICON

  const body = document.createElement('div')
  body.className = 'msg-audio-body'

  const title = document.createElement('div')
  title.className = 'msg-audio-title'
  title.textContent = audioDisplayTitle(msg)

  const metaEl = document.createElement('div')
  metaEl.className = 'msg-audio-meta'

  const seek = document.createElement('input')
  seek.type = 'range'
  seek.className = 'msg-audio-seek'
  seek.min = '0'
  seek.max = '1000'
  seek.step = '1'
  seek.value = '0'
  seek.disabled = true
  seek.setAttribute('aria-label', 'Position im Audio')

  const times = document.createElement('div')
  times.className = 'msg-audio-times'

  body.append(title, metaEl, seek, times)
  wrap.append(playBtn, body)

  const knownDuration = Number(msg.audio_duration) > 0 ? Number(msg.audio_duration) : null
  let audio = null
  let started = false // ab dem ersten Abspielen gilt die Ansicht mit Leiste und Zeiten
  let loading = false
  let seeking = false
  let frame = 0

  const durationNow = () => (audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : knownDuration)
  const showTimes = () => {
    const duration = durationNow()
    const durationText = duration ? formatAudioTime(duration) : '–:–'
    if (!started) {
      // Nur anzeigen, was bekannt ist (bei älteren Audios fehlen Länge und Größe in der Datenbank)
      const parts = []
      if (duration) parts.push(durationText)
      if (Number(msg.audio_size) > 0) parts.push(formatBytes(Number(msg.audio_size)))
      metaEl.textContent = parts.join(', ')
      return
    }
    times.textContent = formatAudioTime(audio ? audio.currentTime : 0) + ' / ' + durationText
  }
  const showProgress = () => {
    const duration = durationNow()
    const current = audio ? audio.currentTime : 0
    const fraction = duration ? Math.min(1, current / duration) : 0
    if (!seeking) seek.value = String(Math.round(fraction * 1000))
    seek.style.setProperty('--p', (Number(seek.value) / 10) + '%')
    showTimes()
  }
  const showPlaying = (playing) => {
    playBtn.innerHTML = playing ? AUDIO_PAUSE_ICON : AUDIO_PLAY_ICON
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen')
  }
  const tick = () => {
    showProgress()
    if (audio && !audio.paused && !audio.ended) frame = requestAnimationFrame(tick) // läuft Bild für Bild mit, nicht ruckelig
  }

  const attach = (blob) => {
    const playable = blob.type && blob.type.startsWith('audio/') ? blob : new Blob([blob], { type: msg.audio_mime || 'audio/mpeg' })
    audio = new Audio()
    audio.preload = 'auto'
    audio.src = URL.createObjectURL(playable)
    audio.playbackRate = audioSpeed
    audio.addEventListener('loadedmetadata', () => { audio.playbackRate = audioSpeed; showProgress() })
    audio.addEventListener('play', () => {
      started = true
      wrap.classList.add('started')
      audio.playbackRate = audioSpeed
      if (activeAudioPause && activeAudioPause.audio !== audio) activeAudioPause.pause()
      activeAudioPause = { audio, pause: () => audio.pause() }
      showPlaying(true)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    })
    audio.addEventListener('pause', () => { showPlaying(false); showProgress() })
    // Am Ende ist alles wieder wie vor dem ersten Start: keine Leiste mehr, wieder "Länge, Größe" unter dem Titel
    audio.addEventListener('ended', () => {
      started = false
      wrap.classList.remove('started')
      showPlaying(false)
      audio.currentTime = 0
      seek.value = '0'
      showProgress()
    })
    seek.disabled = false
  }

  playBtn.addEventListener('click', async () => {
    if (openMenuEl || selectMode) return // gerade wurde das Nachrichten-Menü per langem Drücken geöffnet
    if (loading) return
    if (audio) {
      if (audio.paused) audio.play().catch(() => {})
      else audio.pause()
      return
    }
    loading = true
    playBtn.disabled = true
    playBtn.innerHTML = AUDIO_SPINNER // dreht sich, solange die Datei geladen wird
    metaEl.textContent = 'Lädt …'
    let gone = false
    try {
      attach(await fetchPhotoBlob(msg.audio_id))
      showProgress()
      audio.play().catch(() => { /* manche Handys verlangen noch einen Tipp auf Play */ })
    } catch (e) {
      if (e && e.status === 404) {
        gone = true
        metaEl.textContent = 'Nicht mehr vorhanden'
      } else {
        console.error('Audio laden:', e)
        metaEl.textContent = 'Laden fehlgeschlagen - nochmal tippen'
      }
    } finally {
      loading = false
      playBtn.disabled = gone
      showPlaying(!!audio && !audio.paused)
    }
  })

  // Spulen: beim Ziehen springt die Position sofort mit
  ;['pointerdown', 'touchstart'].forEach(name => seek.addEventListener(name, () => { seeking = true }, { passive: true }))
  ;['pointerup', 'pointercancel', 'touchend', 'change'].forEach(name => seek.addEventListener(name, () => { seeking = false }))
  seek.addEventListener('input', () => {
    if (!audio) return
    const duration = durationNow()
    if (!duration) return
    audio.currentTime = (Number(seek.value) / 1000) * duration
    showProgress()
  })

  showProgress()
  return wrap
}

// ----- Anzeigen -----
const photoMemUrls = {}   // Drive-ID -> Objekt-URL (nur die kleinen Vorschaubilder)
const photoPending = []
let photoActive = 0
let photoViewerEl = null
let photoViewerUrl = null
let photoViewerKey = null

function pumpPhotoQueue() {
  while (photoActive < 4 && photoPending.length) {
    const job = photoPending.shift()
    photoActive++
    job().catch(() => {}).finally(() => { photoActive--; pumpPhotoQueue() })
  }
}

// Holt ein Bild: erst aus dem Zwischenspeicher des Browsers, sonst über "get-photo" (mit Rechte-Prüfung)
async function fetchPhotoBlob(id) {
  const req = new Request('https://photo-cache.invalid/' + encodeURIComponent(id))
  let cache = null
  if ('caches' in window) {
    try {
      cache = await caches.open(PHOTO_CACHE_NAME)
      const hit = await cache.match(req)
      if (hit) return await hit.blob()
    } catch (e) { cache = null }
  }

  const { data: sessionData } = await supabaseClient.auth.getSession()
  const session = sessionData && sessionData.session
  if (!session) throw new Error('Nicht angemeldet')

  const res = await fetch(SUPABASE_URL + '/functions/v1/get-photo?id=' + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + session.access_token, apikey: SUPABASE_KEY }
  })
  if (!res.ok) {
    const err = new Error('Foto nicht verfügbar (' + res.status + ')')
    err.status = res.status
    throw err
  }
  const blob = await res.blob()

  if (cache) {
    try {
      await cache.put(req, new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } }))
      const keys = await cache.keys()
      for (let i = 0; i < keys.length - PHOTO_CACHE_MAX_ENTRIES; i++) await cache.delete(keys[i]) // die ältesten zuerst
    } catch (e) { /* Zwischenspeicher voll - egal */ }
  }
  return blob
}

async function getThumbUrl(id) {
  if (photoMemUrls[id]) return photoMemUrls[id]
  const blob = await fetchPhotoBlob(id)
  if (!photoMemUrls[id]) photoMemUrls[id] = URL.createObjectURL(blob)
  return photoMemUrls[id]
}

function loadThumbInto(wrap, img, id) {
  wrap.classList.remove('failed')
  wrap.classList.add('loading')
  photoPending.push(async () => {
    try {
      img.src = await getThumbUrl(id)
    } catch (e) {
      if (e && e.status === 404) wrap.classList.add('gone') // Foto wurde gelöscht (Nachricht weg oder Speicher voll)
      else { console.error('Foto laden:', e); wrap.classList.add('failed') }
    }
    wrap.classList.remove('loading')
  })
  pumpPhotoQueue()
}

// Das Foto in der Nachrichten-Blase
function buildPhotoElement(msg) {
  const wrap = document.createElement('button')
  wrap.type = 'button'
  wrap.className = 'msg-photo'
  wrap.setAttribute('aria-label', 'Foto ansehen')

  const w = Number(msg.photo_w) || 4
  const h = Number(msg.photo_h) || 3
  wrap.style.aspectRatio = String(Math.min(1.8, Math.max(0.7, w / h))) // Platz ist reserviert, bevor das Bild da ist

  const img = document.createElement('img')
  img.alt = 'Foto'
  img.draggable = false
  wrap.appendChild(img)

  const thumbId = msg.photo_thumb_id || msg.photo_id
  wrap.addEventListener('click', () => {
    if (openMenuEl) return // gerade wurde das Nachrichten-Menü per langem Drücken geöffnet
    if (selectMode || wrap.classList.contains('gone')) return
    if (wrap.classList.contains('failed')) { loadThumbInto(wrap, img, thumbId); return }
    openPhotoViewer(msg)
  })

  loadThumbInto(wrap, img, thumbId)
  return wrap
}

function closePhotoViewer() {
  if (photoViewerEl) { photoViewerEl.remove(); photoViewerEl = null }
  if (photoViewerUrl) { URL.revokeObjectURL(photoViewerUrl); photoViewerUrl = null }
  photoViewerKey = null
  document.removeEventListener('keydown', onPhotoViewerKey)
}

function onPhotoViewerKey(e) {
  if (e.key === 'Escape') closePhotoViewer()
}

// Großansicht: erst die Vorschau, dann nachgeladen das Foto in voller Qualität.
// Oben rechts zwei runde Knöpfe: Speichern (Pfeil nach unten) und Schließen (Kreuz).
async function openPhotoViewer(msg) {
  closePhotoViewer()
  const key = msg.photo_id + ':' + Date.now()
  photoViewerKey = key
  let fullBlob = null

  const overlay = document.createElement('div')
  overlay.className = 'photo-viewer loading'

  const img = document.createElement('img')
  img.alt = 'Foto'
  if (msg.photo_thumb_id && photoMemUrls[msg.photo_thumb_id]) img.src = photoMemUrls[msg.photo_thumb_id]

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'photo-viewer-btn photo-viewer-save'
  saveBtn.setAttribute('aria-label', 'In der Galerie speichern')
  saveBtn.title = 'Speichern'
  saveBtn.disabled = true
  saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'photo-viewer-btn photo-viewer-close'
  closeBtn.setAttribute('aria-label', 'Schließen')
  closeBtn.title = 'Schließen'
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>'
  closeBtn.addEventListener('click', closePhotoViewer)

  const buttons = document.createElement('div')
  buttons.className = 'photo-viewer-buttons'
  buttons.append(saveBtn, closeBtn)

  const status = document.createElement('div')
  status.className = 'photo-viewer-status'
  status.textContent = 'Wird geladen …'

  // Speichern: am Handy über das Teilen-Menü ("Bild speichern" -> Galerie), sonst normaler Download
  saveBtn.addEventListener('click', async () => {
    if (!fullBlob) return
    const name = 'Foto_' + String(msg.created_at || '').slice(0, 10) + '.jpg'
    try {
      const file = new File([fullBlob], name, { type: 'image/jpeg' })
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] })
        return
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return // Teilen-Menü wurde geschlossen
    }
    const a = document.createElement('a')
    a.href = photoViewerUrl
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
  })

  overlay.append(img, buttons, status)
  overlay.addEventListener('click', e => { if (e.target === overlay) closePhotoViewer() })
  document.body.appendChild(overlay)
  photoViewerEl = overlay
  document.addEventListener('keydown', onPhotoViewerKey)

  try {
    const blob = await fetchPhotoBlob(msg.photo_id)
    if (photoViewerKey !== key) return // inzwischen geschlossen
    fullBlob = blob
    photoViewerUrl = URL.createObjectURL(blob)
    img.src = photoViewerUrl
    saveBtn.disabled = false
    overlay.classList.remove('loading')
  } catch (e) {
    console.error('Foto öffnen:', e)
    if (photoViewerKey === key) status.textContent = e && e.status === 404 ? 'Dieses Foto wurde gelöscht.' : 'Das Foto konnte nicht geladen werden.'
  }
}

// Beim Abmelden: Zwischenspeicher leeren (wichtig auf geteilten Geräten)
async function clearPhotoCache() {
  closePhotoViewer()
  Object.keys(photoMemUrls).forEach(id => { URL.revokeObjectURL(photoMemUrls[id]); delete photoMemUrls[id] })
  try { if ('caches' in window) await caches.delete(PHOTO_CACHE_NAME) } catch (e) { /* egal */ }
}

// ----- Emoji-Button links im Eingabefeld: fügt ein Emoji im Text ein -----
let openTextEmojiEl = null

function closeTextEmojiPicker() {
  if (openTextEmojiEl) { openTextEmojiEl.remove(); openTextEmojiEl = null }
}

// Die Emoji-Daten (emojis.json: name, category, code, search) werden beim ersten Öffnen geladen und gemerkt
const EMOJI_RECENT_NAME = 'Häufig genutzt'
const EMOJI_TAB_ICONS = {
  'Smileys & Emotionen': '😀', 'Menschen & Körper': '👋', 'Tiere & Natur': '🐻', 'Essen & Trinken': '🍔',
  'Reisen & Orte': '🚗', 'Aktivitäten': '⚽', 'Objekte': '💡', 'Symbole': '❤️', 'Flaggen': '🏁'
}
let emojiDataPromise = null

// Suchtext vereinheitlichen: klein geschrieben, ohne Akzente und Umlautpunkte ("Mädchen" findet auch "madchen")
function normalizeEmojiSearch(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function loadEmojiData() {
  if (!emojiDataPromise) {
    emojiDataPromise = fetch('emojis.json')
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(list => {
        const categories = []
        const byCategory = {}
        const byEmoji = {}
        list.forEach(item => {
          item._s = normalizeEmojiSearch(item.name + ' ' + item.search)
          if (!byCategory[item.category]) { byCategory[item.category] = []; categories.push(item.category) }
          byCategory[item.category].push(item)
          byEmoji[item.emoji] = item
        })
        return { list, categories, byCategory, byEmoji }
      })
      .catch(err => { emojiDataPromise = null; throw err })
  }
  return emojiDataPromise
}

// ----- "Häufig genutzt": pro Nutzer (auf diesem Gerät) die am meisten und zuletzt benutzten Emojis -----
const EMOJI_RECENT_SHOWN = 24
const EMOJI_RECENT_STORED = 60

function emojiRecentKey() {
  return 'emojiRecent:' + (currentUser ? currentUser.id : 'gast')
}

function readEmojiRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(emojiRecentKey()) || '[]')
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

// Wertung: Anzahl der Benutzungen, die mit der Zeit abklingt (Halbwertszeit 14 Tage) - so steigen oft benutzte
// Emojis nach oben, und neu benutzte werden nicht von alten Dauerbrennern verdrängt
function emojiRecentScore(entry) {
  const days = Math.max(0, (Date.now() - entry.t) / 86400000)
  return entry.n * Math.pow(0.5, days / 14)
}

function recordEmojiUse(emoji) {
  try {
    const list = readEmojiRecent()
    const entry = list.find(x => x.e === emoji)
    if (entry) { entry.n += 1; entry.t = Date.now() }
    else list.push({ e: emoji, n: 1, t: Date.now() })
    list.sort((a, b) => emojiRecentScore(b) - emojiRecentScore(a))
    localStorage.setItem(emojiRecentKey(), JSON.stringify(list.slice(0, EMOJI_RECENT_STORED)))
  } catch (e) { /* Speicher nicht verfügbar: dann merkt sich die App eben nichts */ }
}

// Ein Emoji aus "Häufig genutzt" entfernen (zum Beispiel, wenn man es aus Versehen angetippt hat)
function removeEmojiFromRecent(emoji) {
  try {
    const list = readEmojiRecent().filter(entry => entry.e !== emoji)
    localStorage.setItem(emojiRecentKey(), JSON.stringify(list))
  } catch (e) { /* nichts zu tun */ }
}

// Rechtsklick (PC) oder langes Drücken (Handy) auf ein Emoji ruft onOpen auf (öffnet das Löschen-Menü)
function enableEmojiMenu(btn, onOpen) {
  let timer = null
  let opened = false
  const open = () => {
    if (opened) return
    opened = true
    clearTimeout(timer)
    onOpen()
  }
  btn.addEventListener('mousedown', () => { opened = false })
  btn.addEventListener('contextmenu', e => { e.preventDefault(); open() })
  btn.addEventListener('touchstart', () => { opened = false; timer = setTimeout(open, 500) }, { passive: true })
  btn.addEventListener('touchmove', () => clearTimeout(timer), { passive: true })
  btn.addEventListener('touchcancel', () => clearTimeout(timer))
  btn.addEventListener('touchend', e => {
    clearTimeout(timer)
    if (opened) e.preventDefault() // das Loslassen nach dem langen Drücken soll nichts einfügen
  })
}

// Kleines Menü mit "Löschen" unter (oder über) dem Emoji. Schließt wie das Nachrichtenmenü bei einem Klick daneben.
function openEmojiDeleteMenu(anchorBtn, onDelete) {
  closeMessageMenu()

  const menu = document.createElement('div')
  menu.className = 'msg-menu'
  menu.addEventListener('click', e => e.stopPropagation())

  const del = document.createElement('button')
  del.className = 'msg-menu-item danger'
  del.textContent = 'Löschen'
  del.addEventListener('click', () => {
    closeMessageMenu()
    onDelete()
  })
  menu.appendChild(del)
  document.body.appendChild(menu)

  const margin = 8
  const rect = anchorBtn.getBoundingClientRect()
  const size = menu.getBoundingClientRect()
  let left = rect.left + rect.width / 2 - size.width / 2
  let top = rect.bottom + 6
  if (top + size.height > window.innerHeight - margin) top = rect.top - size.height - 6
  left = Math.min(Math.max(left, margin), window.innerWidth - size.width - margin)
  menu.style.left = left + 'px'
  menu.style.top = Math.max(margin, top) + 'px'

  openMenuEl = menu
}

function getRecentEmojiItems(data) {
  return readEmojiRecent()
    .sort((a, b) => emojiRecentScore(b) - emojiRecentScore(a))
    .map(entry => data.byEmoji[entry.e])
    .filter(Boolean)
    .slice(0, EMOJI_RECENT_SHOWN)
}

// Emoji-Auswahl im Hintergrund vorwärmen: Daten und die ersten Bilder werden schon nach dem Login geladen
// und liegen dann im Zwischenspeicher des Browsers - der Picker geht danach deutlich schneller auf
function warmUpEmojiPicker() {
  const run = () => loadEmojiData().then(data => {
    const firstCategory = data.byCategory[data.categories[0]] || []
    const emojis = firstCategory.slice(0, 48).map(item => item.emoji)
      .concat(Object.values(EMOJI_TAB_ICONS), ['🕒'])
    emojis.forEach(emoji => { new Image().src = emojiSourceChain(emojiIconId(emoji))[0] })
  }).catch(() => {})

  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 5000 })
  else setTimeout(run, 3000)
}

// Baut die Emoji-Auswahl (Suche, Reiter, Raster). onPick(emoji) wird beim Antippen eines Emojis aufgerufen.
// Genutzt vom Nachrichtenfeld (Knopf 😊) und für Reaktionen (Knopf +). allowRemove: "Häufig genutzt" lässt sich aufräumen.
function buildEmojiPanel(onPick, { allowRemove = false } = {}) {
  const picker = document.createElement('div')
  picker.className = 'emoji-picker emoji-panel'
  // Klicks im Picker nicht an die Seite weitergeben (die schließt sonst Menüs); ein offenes Löschen-Menü schließen
  picker.addEventListener('click', e => { e.stopPropagation(); if (openMenuEl && openMenuEl !== picker) closeMessageMenu() })

  const search = document.createElement('input')
  search.type = 'text'
  search.className = 'emoji-search'
  search.placeholder = 'Emoji suchen …'
  search.autocomplete = 'off'
  search.setAttribute('aria-label', 'Emoji suchen')
  search.enterKeyHint = 'search'

  // Ein Klick auf ein Emoji soll den Cursor im Nachrichtenfeld nicht wegnehmen (nur das Suchfeld darf den Fokus holen)
  picker.addEventListener('mousedown', e => { if (e.target !== search) e.preventDefault() })

  const tabs = document.createElement('div')
  tabs.className = 'emoji-tabs'
  const grid = document.createElement('div')
  grid.className = 'emoji-grid'
  grid.textContent = 'Lade Emojis …'

  picker.appendChild(search)
  picker.appendChild(tabs)
  picker.appendChild(grid)

  loadEmojiData().then(data => {
    if (!picker.isConnected) return // wurde inzwischen wieder geschlossen

    const sections = []
    sections.push({ name: EMOJI_RECENT_NAME, icon: '🕒', items: getRecentEmojiItems(data) })
    data.categories.forEach(name => {
      sections.push({ name, icon: EMOJI_TAB_ICONS[name] || data.byCategory[name][0].emoji, items: data.byCategory[name] })
    })

    function renderItems(items, emptyText, removable = false) {
      grid.innerHTML = ''
      grid.scrollTop = 0
      if (items.length === 0) {
        const note = document.createElement('p')
        note.className = 'emoji-empty'
        note.textContent = emptyText
        grid.appendChild(note)
        return
      }
      items.forEach(item => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'emoji-picker-btn'
        btn.title = item.name
        btn.setAttribute('aria-label', item.name)
        btn.appendChild(createEmojiImg(item.emoji))
        btn.addEventListener('click', () => {
          onPick(item.emoji)
          recordEmojiUse(item.emoji)
        })
        if (removable && allowRemove) {
          enableEmojiMenu(btn, () => openEmojiDeleteMenu(btn, () => {
            removeEmojiFromRecent(item.emoji)
            sections[0].items = getRecentEmojiItems(data)
            btn.remove()
            if (!grid.querySelector('.emoji-picker-btn')) showSection(0)
          }))
        }
        grid.appendChild(btn)
      })
      if (removable && allowRemove) {
        const hint = document.createElement('p')
        hint.className = 'emoji-hint'
        hint.textContent = 'Zum Löschen: Rechtsklick oder gedrückt halten'
        grid.appendChild(hint)
      }
    }

    let currentIndex = 0
    function showSection(index) {
      currentIndex = index
      search.value = ''
      tabs.querySelectorAll('.emoji-tab').forEach((tab, i) => tab.classList.toggle('active', i === index))
      const section = sections[index]
      renderItems(
        section.items,
        'Noch leer. Hier erscheinen deine am häufigsten und zuletzt benutzten Emojis.',
        section.name === EMOJI_RECENT_NAME
      )
    }

    sections.forEach((section, index) => {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'emoji-tab'
      tab.title = section.name
      tab.setAttribute('aria-label', section.name)
      tab.appendChild(createEmojiImg(section.icon))
      tab.addEventListener('click', () => showSection(index))
      tabs.appendChild(tab)
    })

    // Suche: alle Wörter müssen im Namen oder in den Suchbegriffen vorkommen (Deutsch und Englisch)
    search.addEventListener('input', () => {
      const query = normalizeEmojiSearch(search.value).trim()
      if (!query) { showSection(currentIndex); return }
      const words = query.split(/\s+/)
      tabs.querySelectorAll('.emoji-tab').forEach(tab => tab.classList.remove('active'))
      renderItems(
        data.list.filter(item => words.every(word => item._s.includes(word))).slice(0, 200),
        'Keine Treffer.'
      )
    })

    // Startet bei "Häufig genutzt", solange dort schon etwas steht, sonst bei den Smileys
    showSection(sections[0].items.length > 0 ? 0 : 1)
  }).catch(() => {
    if (picker.isConnected) grid.textContent = 'Emojis konnten nicht geladen werden.'
  })

  return picker
}

function toggleTextEmojiPicker(anchorBtn, evt) {
  if (evt) evt.stopPropagation() // sonst schließt der Klick den Picker über den globalen Listener sofort wieder
  if (openTextEmojiEl) { closeTextEmojiPicker(); return }
  closeAttachMenu()

  const picker = buildEmojiPanel(emoji => insertEmojiInInput(emoji), { allowRemove: true })
  picker.classList.add('input-emoji-picker')
  anchorBtn.parentElement.appendChild(picker)
  openTextEmojiEl = picker
}

document.addEventListener('click', closeTextEmojiPicker)

function insertEmojiInInput(emoji) {
  insertIntoMessageInput(emoji)
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
    if (!map[r.message_id]) map[r.message_id] = { counts: {}, mine: null, users: [] }
    map[r.message_id].users.push({ user_id: r.user_id, emoji: r.emoji })
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

// "Heute", "Gestern" oder "Vorgestern" für Nachrichten der letzten drei Kalendertage, sonst null
function relativeDayLabel(date) {
  const now = new Date()
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
  const days = Math.round((startOf(now) - startOf(date)) / 86400000)
  if (days === 0) return 'Heute'
  if (days === 1) return 'Gestern'
  if (days === 2) return 'Vorgestern'
  return null
}

// Zeitstempel: heute nur Uhrzeit, gestern/vorgestern mit Wort, sonst Datum
function formatTime(isoString) {
  const d = new Date(isoString)
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

  const label = relativeDayLabel(d)
  if (label === 'Heute') return time
  if (label) return label + ', ' + time

  const date = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
  return date + ', ' + time
}

// Nur die Uhrzeit, ohne Datum - das Datum steht ja schon im Trenner über der Nachricht
function formatTimeOnly(isoString) {
  return new Date(isoString).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

// Zeit-Anzeige für die Chatliste: heute die Uhrzeit, dann "Gestern" und "Vorgestern", älter nur das Datum
function formatChatListTime(isoString) {
  const d = new Date(isoString)
  const label = relativeDayLabel(d)
  if (label === 'Heute') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  }
  if (label) return label
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

// ===== Emojis: überall als Noto-Bilder, nirgends als (hässliche) Systemzeichen =====
// Alle Emoji-Bilder kommen über das CDN jsDelivr aus dem Satz "Noto Emoji" von Google (Apache-Lizenz):
// Bild-Adresse = EMOJI_CDN_BASE + Emoji-Code + ".png". Es werden keine einzelnen Bilder im Projekt gespeichert.
// Achtung: Den Pfad ".../noto-emoji@main/png/72/..." gibt es im Noto-Repository nicht mehr (404). Die Bilder liegen
// jetzt unter 2D/ (flach) und 3D/ (plastisch). Für den flachen Look unten "3D" durch "2D" ersetzen.
// Die Version ist auf einen festen Stand gepinnt, damit spätere Umbauten im Repository nichts kaputt machen.
const EMOJI_CDN_BASE = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e/3D/png/72/emoji_u'
const EMOJI_TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/' // Ersatz, falls ein Noto-Bild fehlt

function emojiHexParts(emoji) {
  return Array.from(emoji).map(ch => ch.codePointAt(0).toString(16))
}

// Twemoji-Schreibweise des Emoji-Codes: Hex mit "-", das Zusatzzeichen fe0f nur bei Verbund-Emojis
function emojiIconId(emoji) {
  const parts = emojiHexParts(emoji)
  return (parts.includes('200d') ? parts : parts.filter(part => part !== 'fe0f')).join('-')
}

// Reihenfolge der Bildquellen: Noto (ohne fe0f), Noto (mit fe0f, falls anders), Twemoji. Danach das Systemzeichen.
function emojiSourceChain(icon) {
  const parts = icon.split('-')
  const stripped = parts.filter(part => part !== 'fe0f').join('_')
  const kept = parts.join('_')
  const chain = [EMOJI_CDN_BASE + stripped + '.png']
  if (kept !== stripped) chain.push(EMOJI_CDN_BASE + kept + '.png')
  chain.push(EMOJI_TWEMOJI_BASE + icon + '.svg')
  return chain
}

// Fehlt ein Bild, geht es mit der nächsten Quelle weiter; zuletzt bleibt das Emoji-Zeichen stehen
function attachEmojiFallback(img) {
  if (img.dataset.emojiReady) return
  img.dataset.emojiReady = '1'
  img.addEventListener('error', () => {
    const chain = emojiSourceChain(img.dataset.emoji || '')
    const next = Number(img.dataset.emojiStage || 0) + 1
    if (next < chain.length) {
      img.dataset.emojiStage = String(next)
      img.src = chain[next]
    } else if (img.parentNode) {
      img.replaceWith(document.createTextNode(img.alt))
    }
  })
}

// Ein Emoji-Bild direkt bauen (für den Emoji-Picker)
function createEmojiImg(emoji) {
  const img = document.createElement('img')
  img.className = 'emoji'
  img.alt = emoji
  img.draggable = false
  img.loading = 'lazy'
  img.decoding = 'async'
  img.dataset.emoji = emojiIconId(emoji)
  attachEmojiFallback(img)
  img.src = emojiSourceChain(img.dataset.emoji)[0]
  return img
}

// Alle Emoji-Zeichen im Text eines Elements durch Bilder ersetzen.
// window.twemoji (aus index.html) wird nur zum Finden der Emojis benutzt, die Bilder kommen von Noto.
function applyEmojiImages(el) {
  if (!window.twemoji || !el) return
  window.twemoji.parse(el, {
    callback: icon => emojiSourceChain(icon)[0],
    attributes: (rawText, iconId) => ({ 'data-emoji': iconId })
  })
  if (el.querySelectorAll) el.querySelectorAll('img.emoji').forEach(attachEmojiFallback)
}

// Automatisch für ALLES, was in der App neu erscheint (empfangene und gesendete Nachrichten, Antworten, Chatliste,
// Reaktionen, Umfragen ...): Emoji-Zeichen werden sofort durch Bilder ersetzt. Das Nachrichtenfeld regelt sich selbst
// (wegen des Cursors) und wird hier ausgelassen.
function startEmojiObserver() {
  if (!window.twemoji || !('MutationObserver' in window)) return
  const pending = new Set()
  let scheduled = false

  function flush() {
    scheduled = false
    pending.forEach(node => {
      const target = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
      if (!target || !target.isConnected) return
      if (target.closest && target.closest('#message-input')) return
      if (window.twemoji.test(target.textContent)) applyEmojiImages(target)
    })
    pending.clear()
  }

  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') pending.add(mutation.target)
      else mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) pending.add(node)
      })
    }
    if (pending.size && !scheduled) {
      scheduled = true
      requestAnimationFrame(flush)
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true })
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
    authorEl.textContent = author + birthdayMark(msg.sender_id)
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
  const canEdit = isOwn && !isAdmin() && !msg.photo_id && !msg.audio_id // Foto- und Audio-Nachrichten lassen sich nicht bearbeiten
  const canDelete = isOwn || isAdmin()
  const canReact = !isAdmin()
  const canReply = !isAdmin() && (currentRoom.type === 'group' || currentRoom.type === 'dm')
  const canCopy = !!msg.text
  const canDownloadAudio = !!msg.audio_id
  const canReport = !isOwn && !isAdmin() && (currentRoom.type === 'group' || currentRoom.type === 'dm')
  // Info (wer hat die Nachricht gelesen/bekommen) und Häkchen gibt es für eigene Nachrichten in Einzelchat und Gruppe
  const canInfo = READ_RECEIPTS_ENABLED && isOwn && !isAdmin() && (currentRoom.type === 'group' || currentRoom.type === 'dm')

  attachMessageMenuTriggers(msgElement, msg, { canEdit, canDelete, canReact, canInfo, canReply, canCopy, canDownloadAudio, canReport })

  const textEl = document.createElement('div')
  textEl.className = 'msg-text'
  // Der Text selbst steht als reiner Textknoten davor, die Fußzeile (Uhrzeit + Haken)
  // wird gleich als eigenes, rechts schwebendes Element direkt danach eingehängt (siehe unten) -
  // dadurch rutscht sie bei kurzen Nachrichten ans Textende, bei langen presst sie sich unten rechts an
  appendTextWithLinks(textEl, msg.text || '')
  markBigEmoji(textEl, msg.text || '')

  const reactRow = document.createElement('div')
  reactRow.className = 'msg-reactions'
  renderReactionChips(reactRow, msg.id)

  if (meta.children.length > 0) msgElement.appendChild(meta)
  if (msg.reply_to_id) msgElement.appendChild(buildReplyQuote(msg.reply_to_id))
  if (msg.photo_id) {
    msgElement.classList.add('has-photo')
    msgElement.appendChild(buildPhotoElement(msg))
    if (!msg.text) textEl.classList.add('photo-only')
  }
  if (msg.audio_id) {
    msgElement.classList.add('has-audio')
    msgElement.appendChild(buildAudioElement(msg))
  }
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
  msgElement.classList.toggle('has-reactions', reactRow.childElementCount > 0)

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
  else if (!suppressMissedCount) noteMissedMessage() // man liest weiter oben: der Knopf "nach unten" zeigt, wie viele neu sind
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
  if (currentRoom.groupId) return customGroupMemberIds(currentRoom.groupId).filter(id => id !== currentUser.id)

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

// ===== Reaktionen =====
// Pro Person gibt es eine Reaktion je Nachricht (Tabellen message_reactions für Gruppen, dm_reactions für Einzelchats).
// Unter der Nachricht steht unten links ein kleiner dunkler Chip mit den Emojis und der Anzahl. Ein Klick darauf öffnet
// das Fenster "Reaktionen" mit allen Personen. Zum Reagieren gibt es die Emoji-Leiste: am PC erscheint sie beim
// Darüberfahren mit der Maus, am Handy oben im Menü beim langen Drücken.
const QUICK_EMOJI = ['👍', '👎', '❤️', '😅', '🙏']
const QUICK_EXTRA_MAX = 2     // so viele Extra-Emojis (die man über das Plus oft nimmt) rücken automatisch in die Leiste
const QUICK_EXTRA_MIN_USES = 2 // ab so vielen Benutzungen über das Plus gilt ein Emoji als "oft genutzt"

function reactionExtraKey() {
  return 'reactionExtra:' + (currentUser ? currentUser.id : 'gast')
}

function readReactionExtra() {
  try {
    const list = JSON.parse(localStorage.getItem(reactionExtraKey()) || '[]')
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

// Merkt sich, welche Emojis man über das Plus für Reaktionen nimmt (nur die, die nicht schon fest in der Leiste sind)
function recordReactionExtra(emoji) {
  if (QUICK_EMOJI.includes(emoji)) return
  try {
    const list = readReactionExtra()
    const entry = list.find(x => x.e === emoji)
    if (entry) { entry.n += 1; entry.t = Date.now() }
    else list.push({ e: emoji, n: 1, t: Date.now() })
    list.sort((a, b) => emojiRecentScore(b) - emojiRecentScore(a))
    localStorage.setItem(reactionExtraKey(), JSON.stringify(list.slice(0, 30)))
  } catch (e) { /* Speicher nicht verfügbar: dann merkt sich die App eben nichts */ }
}

// Die 5 festen Emojis plus die (bis zu 2) am häufigsten über das Plus genutzten Emojis
function quickEmojiList() {
  const extras = readReactionExtra()
    .filter(x => x.n >= QUICK_EXTRA_MIN_USES && !QUICK_EMOJI.includes(x.e))
    .sort((a, b) => emojiRecentScore(b) - emojiRecentScore(a))
    .slice(0, QUICK_EXTRA_MAX)
    .map(x => x.e)
  return QUICK_EMOJI.concat(extras)
}

// Eine Reaktion macht die Nachricht höher. Wer unten im Chat ist, bleibt deshalb ganz unten,
// damit die Reaktion nicht abgeschnitten wird.
function renderReactionChips(container, messageId) {
  const chatBox = document.getElementById('chat-box')
  const wasNearBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 160
  renderReactionChipsInner(container, messageId)
  if (wasNearBottom) {
    chatBox.scrollTop = chatBox.scrollHeight
    requestAnimationFrame(() => { chatBox.scrollTop = chatBox.scrollHeight })
  }
}

function renderReactionChipsInner(container, messageId) {
  container.innerHTML = ''
  const info = reactionMap[messageId] || { counts: {}, mine: null, users: [] }
  const entries = Object.entries(info.counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((sum, [, n]) => sum + n, 0)

  const msgEl = container.closest('.msg')
  if (msgEl) msgEl.classList.toggle('has-reactions', total > 0)
  if (total === 0) return

  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'reaction-btn reaction-chip' + (info.mine ? ' active' : '')
  chip.setAttribute('aria-label', 'Reaktionen anzeigen')
  entries.slice(0, 3).forEach(([emoji]) => chip.appendChild(createEmojiImg(emoji)))
  // Wie bei WhatsApp: eine einzelne Reaktion zeigt nur das Emoji, erst ab zwei Reaktionen steht eine Zahl daneben
  if (total >= 2) {
    const count = document.createElement('span')
    count.className = 'reaction-count'
    count.textContent = String(total)
    chip.appendChild(count)
  }
  chip.addEventListener('click', e => {
    e.stopPropagation()
    openReactionsModal(messageId)
  })
  container.appendChild(chip)
}

function closeReactionsModal() {
  document.getElementById('reactions-modal').style.display = 'none'
}

// Fenster "Reaktionen" (wie bei WhatsApp): oben ein Knopf für ein neues Emoji, daneben ein Knopf je vorhandenem Emoji
// mit Anzahl. Ein vorhandenes Emoji antippen = selbst auch so reagieren (ist es schon deins, ist es hervorgehoben und
// ein weiteres Tippen nimmt es zurück). Darunter stehen alle Personen mit ihrem Emoji.
function openReactionsModal(messageId) {
  closeMessageMenu()
  hideReactionBar()
  const info = reactionMap[messageId]
  const users = info && info.users ? info.users : []
  if (users.length === 0) return

  const modal = document.getElementById('reactions-modal')
  const tabs = document.getElementById('reactions-tabs')
  const list = document.getElementById('reactions-list')

  const counts = {}
  users.forEach(u => { counts[u.emoji] = (counts[u.emoji] || 0) + 1 })
  const emojis = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
  const mineEmoji = (users.find(u => u.user_id === currentUser.id) || {}).emoji || null

  document.getElementById('reactions-title').textContent = users.length + (users.length === 1 ? ' Reaktion' : ' Reaktionen')

  // Nach dem Antippen: Fenster mit dem neuen Stand neu aufbauen (oder schließen, wenn nichts mehr da ist)
  async function reactWith(emoji) {
    await toggleReaction(messageId, emoji)
    refreshModal()
  }
  function refreshModal() {
    const rest = reactionMap[messageId] && reactionMap[messageId].users ? reactionMap[messageId].users : []
    if (rest.length > 0) openReactionsModal(messageId)
    else closeReactionsModal()
  }

  const realName = userId => (profileCache[userId] && profileCache[userId].name) || 'Unbekannt'

  function render() {
    tabs.innerHTML = ''

    // Ganz links: ein neues Emoji aussuchen
    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'reactions-tab reactions-add'
    addBtn.setAttribute('aria-label', 'Emoji hinzufügen')
    addBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="13" r="8"/><path d="M7.8 15.2c.8 1.1 2 1.7 3.2 1.7s2.4-.6 3.2-1.7"/><circle cx="8.6" cy="11.6" r=".7" fill="currentColor"/><circle cx="13.4" cy="11.6" r=".7" fill="currentColor"/><path d="M19 2.5v5M16.5 5h5"/></svg>'
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openReactionPicker(addBtn, messagesById[messageId] || { id: messageId }, refreshModal)
    })
    tabs.appendChild(addBtn)

    // Daneben ein Knopf je vorhandenem Emoji (mit Anzahl); das eigene ist hervorgehoben
    emojis.forEach(emoji => {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'reactions-tab' + (emoji === mineEmoji ? ' active' : '')
      tab.appendChild(createEmojiImg(emoji))
      const count = document.createElement('span')
      count.textContent = String(counts[emoji])
      tab.appendChild(count)
      tab.addEventListener('click', () => reactWith(emoji))
      tabs.appendChild(tab)
    })

    list.innerHTML = ''
    users
      .slice()
      .sort((a, b) => {
        if (a.user_id === currentUser.id) return -1
        if (b.user_id === currentUser.id) return 1
        return realName(a.user_id).localeCompare(realName(b.user_id), 'de')
      })
      .forEach(u => {
        const isMe = u.user_id === currentUser.id
        const li = document.createElement('li')
        li.className = 'reactions-item' + (isMe ? ' mine' : '')

        const avatar = document.createElement('div')
        avatar.className = 'reaction-avatar'
        avatar.style.background = avatarColor(u.user_id)
        avatar.textContent = initialsOf(realName(u.user_id))

        const text = document.createElement('div')
        text.className = 'reactions-item-text'
        const name = document.createElement('span')
        name.className = 'reactions-item-name'
        name.textContent = realName(u.user_id) + (isMe ? ' (Du)' : '')
        text.appendChild(name)
        if (isMe) {
          const hint = document.createElement('span')
          hint.className = 'reactions-item-hint'
          hint.textContent = 'Tippen zum Entfernen'
          text.appendChild(hint)
        }

        li.append(avatar, text, createEmojiImg(u.emoji))

        if (isMe) {
          li.addEventListener('click', async () => {
            await toggleReaction(messageId, u.emoji)
            const rest = reactionMap[messageId] && reactionMap[messageId].users ? reactionMap[messageId].users : []
            if (rest.length > 0) openReactionsModal(messageId)
            else closeReactionsModal()
          })
        }
        list.appendChild(li)
      })
  }

  render()
  modal.style.display = 'flex'
}

// Die Emoji-Leiste: 5 feste Emojis, bis zu 2 oft genutzte aus dem Plus (also höchstens 7), und ganz rechts ein Plus für die volle Auswahl
function buildReactionBar(msg, { onPick, onMore }) {
  const bar = document.createElement('div')
  bar.className = 'reaction-bar'
  const mine = reactionMap[msg.id] ? reactionMap[msg.id].mine : null

  quickEmojiList().forEach(emoji => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'reaction-bar-btn' + (mine === emoji ? ' active' : '')
    btn.appendChild(createEmojiImg(emoji))
    btn.addEventListener('click', e => {
      e.stopPropagation()
      onPick()
      toggleReaction(msg.id, emoji)
    })
    bar.appendChild(btn)
  })

  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'reaction-bar-btn reaction-plus'
  more.textContent = '+'
  more.setAttribute('aria-label', 'Weitere Emojis')
  more.addEventListener('click', e => {
    e.stopPropagation()
    onMore()
  })
  bar.appendChild(more)
  return bar
}

// Die volle Emoji-Auswahl (aus emojis.json) für eine Reaktion, direkt unter oder über der Nachricht
function openReactionPicker(anchorEl, msg, afterPick) {
  closeMessageMenu()
  hideReactionBar()

  const panel = buildEmojiPanel(async emoji => {
    closeMessageMenu()
    recordReactionExtra(emoji)
    await toggleReaction(msg.id, emoji)
    if (afterPick) afterPick()
  })
  panel.classList.add('reaction-full-picker')
  document.body.appendChild(panel)

  const margin = 8
  const rect = anchorEl.getBoundingClientRect()
  const size = panel.getBoundingClientRect()
  let top = rect.bottom + 8
  if (top + size.height > window.innerHeight - margin) top = rect.top - size.height - 8
  top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - size.height - margin))
  let left = rect.left + rect.width / 2 - size.width / 2
  left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - size.width - margin))
  panel.style.left = left + 'px'
  panel.style.top = top + 'px'

  openMenuEl = panel
}

// ----- PC: Beim Darüberfahren mit der Maus erscheint die Emoji-Leiste an der Nachricht -----
let hoverBarEl = null
let hoverBarMsgEl = null
let hoverBarTimer = null
let hoverBarSticky = false // true = Leiste gehört zum geöffneten Menü (Handy), verschwindet mit ihm statt per Maus

// Nur Geräte mit echter Maus (Hover). Am Handy gibt es stattdessen das Menü beim langen Drücken.
function canHoverReact() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

function hideReactionBar() {
  clearTimeout(hoverBarTimer)
  if (hoverBarEl) hoverBarEl.remove()
  hoverBarEl = null
  hoverBarMsgEl = null
  hoverBarSticky = false
}

// Kurze Verzögerung, damit die Maus von der Nachricht zur Leiste wandern kann
function scheduleHideReactionBar() {
  clearTimeout(hoverBarTimer)
  hoverBarTimer = setTimeout(hideReactionBar, 250)
}

function showReactionBar(msgElement, msg) {
  if (!canHoverReact() || selectMode || openMenuEl) return
  clearTimeout(hoverBarTimer)
  if (hoverBarEl && hoverBarMsgEl === msgElement) return
  hideReactionBar()

  const bar = buildReactionBar(msg, {
    onPick: hideReactionBar,
    onMore: () => openReactionPicker(msgElement, msg)
  })
  bar.classList.add('floating')
  bar.addEventListener('mouseenter', () => clearTimeout(hoverBarTimer))
  bar.addEventListener('mouseleave', scheduleHideReactionBar)
  document.body.appendChild(bar)

  const margin = 8
  const rect = msgElement.getBoundingClientRect()
  const size = bar.getBoundingClientRect()
  const chatRect = document.getElementById('chat-box').getBoundingClientRect()
  const isOwn = msgElement.classList.contains('own')

  let top = rect.top - size.height - 2 // direkt über der Sprechblase
  if (top < chatRect.top) top = rect.bottom + 2 // oben kein Platz: darunter
  let left = isOwn ? rect.right - size.width : rect.left
  left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - size.width - margin))
  top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - size.height - margin))
  bar.style.left = left + 'px'
  bar.style.top = top + 'px'

  hoverBarEl = bar
  hoverBarMsgEl = msgElement
}

document.getElementById('chat-box').addEventListener('scroll', hideReactionBar, { passive: true })

// Reaktionen anderer Personen live nachladen (wenn die Tabelle in Supabase Realtime freigegeben ist)
let reactionRefreshTimer = null
function scheduleReactionRefresh() {
  clearTimeout(reactionRefreshTimer)
  reactionRefreshTimer = setTimeout(async () => {
    const rows = Array.from(document.querySelectorAll('#chat-box .msg-row[data-id]:not(.poll-row)'))
    const ids = rows.map(row => row.dataset.id)
    if (ids.length === 0) return
    const fresh = await loadReactionsFor(ids)
    rows.forEach(row => {
      const id = row.dataset.id
      reactionMap[id] = fresh[id] || { counts: {}, mine: null, users: [] }
      const reactRow = row.querySelector('.msg-reactions')
      if (reactRow) renderReactionChips(reactRow, id)
    })
  }, 300)
}

let openMenuEl = null

function closeMessageMenu() {
  if (openMenuEl) {
    openMenuEl.remove()
    openMenuEl = null
  }
  // Die Emoji-Leiste vom Handy (langes Drücken) schließt zusammen mit dem Menü
  if (hoverBarSticky) hideReactionBar()
}

document.addEventListener('click', closeMessageMenu)
// 'scroll' bubbelt nicht - mit capture:true trifft das trotzdem den Chatverlauf beim Scrollen
document.addEventListener('scroll', (e) => {
  if (openMenuEl && e.target instanceof Node && openMenuEl.contains(e.target)) return // Scrollen im Menü selbst
  closeMessageMenu()
}, true)

// Öffnet das Drei-Punkte-Menü neben einer Nachricht
// Öffnet das Nachrichtenmenü nicht mehr über einen eigenen Button, sondern per Rechtsklick
// (PC) oder langem Tippen (Handy) direkt auf der Nachricht. Auf den Haken, dem Zitat und den
// Reaktions-Chips wird das ignoriert, die haben ihre eigene Funktion bei einem normalen Klick.
function attachMessageMenuTriggers(msgElement, msg, options) {
  const hasMenu = options.canEdit || options.canDelete || options.canReact || options.canReply || options.canCopy
  if (!hasMenu) return

  function isExcluded(target) {
    return target.closest('.msg-ticks, .msg-reply-quote, .reaction-btn, .msg-audio-seek')
  }

  // Rechtsklick (PC) und langes Drücken (Handy): Emoji-Leiste und Menü erscheinen gemeinsam,
  // als zwei getrennte Elemente. Beim bloßen Darüberfahren mit der Maus passiert nichts.
  msgElement.addEventListener('contextmenu', (e) => {
    if (selectMode) { e.preventDefault(); return } // im Auswahlmodus gibt es kein Menü
    if (isExcluded(e.target)) return
    e.preventDefault()
    openMessageMenu(msgElement, msg, options, { withReactions: true })
  })

  let pressTimer = null

  msgElement.addEventListener('touchstart', (e) => {
    if (selectMode || isExcluded(e.target)) return
    pressTimer = setTimeout(() => {
      pressTimer = null
      openMessageMenu(msgElement, msg, options, { withReactions: true })
    }, 450)
  }, { passive: true })

  ;['touchmove', 'touchend', 'touchcancel'].forEach(evt => {
    msgElement.addEventListener(evt, () => { clearTimeout(pressTimer) })
  })
}

function openMessageMenu(anchorEl, msg, options, { withReactions = false } = {}) {
  closeMessageMenu()

  // Handy: die Emoji-Leiste ist ein eigenes, freistehendes Element (nicht im Menü-Kasten)
  let bar = null
  if (withReactions && options.canReact) {
    hideReactionBar()
    bar = buildReactionBar(msg, {
      onPick: closeMessageMenu,
      onMore: () => openReactionPicker(anchorEl, msg)
    })
    bar.classList.add('floating')
    bar.addEventListener('click', (e) => e.stopPropagation())
    document.body.appendChild(bar)
    hoverBarEl = bar
    hoverBarMsgEl = anchorEl
    hoverBarSticky = true
  }

  const menu = document.createElement('div')
  menu.className = 'msg-menu'
  menu.addEventListener('click', (e) => e.stopPropagation())

  // Untermenü: die vier Geschwindigkeiten, die aktive ist markiert
  function showSpeedOptions() {
    menu.innerHTML = ''
    AUDIO_SPEEDS.forEach(speed => {
      const item = document.createElement('button')
      item.className = 'msg-menu-item'
      item.textContent = (speed === audioSpeed ? '✓ ' : '') + audioSpeedLabel(speed)
      item.addEventListener('click', () => {
        setAudioSpeed(speed)
        closeMessageMenu()
      })
      menu.appendChild(item)
    })
  }

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

    if (options.canReport) {
      const reportItem = document.createElement('button')
      reportItem.className = 'msg-menu-item danger'
      reportItem.textContent = 'Melden'
      reportItem.addEventListener('click', () => {
        closeMessageMenu()
        reportMessage(msg)
      })
      menu.appendChild(reportItem)
    }

    if (options.canDownloadAudio) {
      const downloadItem = document.createElement('button')
      downloadItem.className = 'msg-menu-item'
      downloadItem.textContent = 'Herunterladen'
      downloadItem.addEventListener('click', () => {
        closeMessageMenu()
        downloadAudio(msg)
      })
      menu.appendChild(downloadItem)
    }

    if (options.canDownloadAudio) {
      const speedItem = document.createElement('button')
      speedItem.className = 'msg-menu-item'
      speedItem.textContent = 'Geschwindigkeit'
      speedItem.addEventListener('click', showSpeedOptions)
      menu.appendChild(speedItem)
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

    // Anpinnen: nur für VIPs; "Anpinnen aufheben" nur für den, der angepinnt hat, und den Admin
    const pinnedHere = !!currentPin && String(currentPin.message_id) === String(msg.id)
    if (canPinHere() && !pinnedHere) {
      const pinItem = document.createElement('button')
      pinItem.className = 'msg-menu-item'
      pinItem.textContent = 'Anpinnen'
      pinItem.addEventListener('click', () => {
        closeMessageMenu()
        pinMessage(msg)
      })
      menu.appendChild(pinItem)
    }
    if (pinnedHere && canUnpinCurrent()) {
      const unpinItem = document.createElement('button')
      unpinItem.className = 'msg-menu-item'
      unpinItem.textContent = 'Anpinnen aufheben'
      unpinItem.addEventListener('click', () => {
        closeMessageMenu()
        unpinCurrent()
      })
      menu.appendChild(unpinItem)
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

  showMainOptions()
  const hasItems = menu.children.length > 0

  if (hasItems) {
    document.body.appendChild(menu)
    openMenuEl = menu
  }

  if (bar) positionBarAndMenu(bar, hasItems ? menu : null, anchorEl)
  else if (hasItems) positionFloatingMenu(menu, anchorEl)
}

// Handy: Emoji-Leiste und Menü-Kasten sind zwei getrennte Elemente. Ideal: Leiste direkt über der Nachricht,
// Menü darunter. Ist dafür kein Platz, werden beide zusammen unter oder über die Nachricht gesetzt.
function positionBarAndMenu(bar, menu, anchorEl) {
  const margin = 8
  const gap = 6
  const rect = anchorEl.getBoundingClientRect()
  const isOwn = anchorEl.classList.contains('own')
  const barSize = bar.getBoundingClientRect()
  const menuSize = menu ? menu.getBoundingClientRect() : { width: 0, height: 0 }
  const stackHeight = barSize.height + (menu ? gap + menuSize.height : 0)
  const spaceAbove = rect.top - margin
  const spaceBelow = window.innerHeight - rect.bottom - margin

  let barTop, menuTop
  if (spaceAbove >= barSize.height + gap && (!menu || spaceBelow >= menuSize.height + gap)) {
    barTop = rect.top - gap - barSize.height
    menuTop = rect.bottom + gap
  } else if (spaceBelow >= stackHeight + gap) {
    barTop = rect.bottom + gap
    menuTop = barTop + barSize.height + gap
  } else if (spaceAbove >= stackHeight + gap) {
    barTop = rect.top - gap - barSize.height
    menuTop = rect.top - gap - stackHeight
  } else {
    // Sehr hohe Nachricht: beide am Bildschirm halten
    barTop = Math.max(margin, Math.min(rect.top - gap - barSize.height, window.innerHeight - stackHeight - margin))
    menuTop = barTop + barSize.height + gap
  }

  const place = (el, size, top) => {
    let left = isOwn ? rect.right - size.width : rect.left
    left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - size.width - margin))
    top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - size.height - margin))
    el.style.position = 'fixed'
    el.style.left = left + 'px'
    el.style.top = top + 'px'
  }
  place(bar, barSize, barTop)
  if (menu) place(menu, menuSize, menuTop)
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
  const text = getMessageText().trim()

  if (!text || !currentUser) return

  if (editingMessageId) {
    await saveEditedMessage(text)
    return
  }

  sendBtn.dataset.busy = '1'
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

  delete sendBtn.dataset.busy
  updateSendButton()

  if (error) {
    await handleSendError(error)
  } else {
    cancelReplyingTo()
    renderMessage(inserted)
    clearMessageInput()
    notifyTyping() // Feld ist leer -> "tippt" beim anderen ausblenden
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
  } else if (/failed to fetch|networkerror|network request|load failed/i.test(String(error.message))) {
    // Kein Netz: der Text bleibt im Eingabefeld, man kann einfach nochmal auf Senden tippen
    showToast('Keine Verbindung. Deine Nachricht steht noch im Feld, tippe später nochmal auf Senden.')
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
      clearTyping(msg.sender_id) // die Nachricht ist da, "tippt" ist erledigt
      // Ton nur, wenn das Fenster gerade aktiv ist. Sonst kommt über den Service Worker das Banner - nicht beides.
      if (msg.sender_id !== currentUser.id && !isAdmin() && document.visibilityState === 'visible' && document.hasFocus() && !isChatMuted(chatKeyForRoom(currentRoom))) playMessageSound()
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
    .on('postgres_changes', { event: '*', schema: 'public', table: isDmRoom() ? 'dm_reactions' : 'message_reactions' }, () => {
      scheduleReactionRefresh()
    })

  chatChannel = channel.subscribe()
  startPeerListening()
  startTypingChannel()
}

function stopListening() {
  exitSelectMode()
  hideReactionBar()
  clearTimeout(reactionRefreshTimer)
  if (chatChannel) {
    supabaseClient.removeChannel(chatChannel)
    chatChannel = null
  }
  stopPeerListening()
  stopPollListening()
  stopPinListening()
  stopTypingChannel()
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
  stopGroupListening()
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
  hideReactionBar()
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
    dropPinForMessages(deleted)

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
  const info = reactionMap[messageId] || { counts: {}, mine: null, users: [] }

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
  reactionMap[messageId] = updated[messageId] || { counts: {}, mine: null, users: [] }

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
  const label = relativeDayLabel(d)
  if (label) return label

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
  snippetEl.textContent = messageSnippet(original)

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
  document.getElementById('reply-bar-snippet').textContent = messageSnippet(original)
  applyEmojiImages(document.getElementById('reply-bar-snippet'))
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
  setMessageText(oldText)
  document.getElementById('edit-bar').style.display = 'flex'
  document.getElementById('send-btn').textContent = '✓'
}

function cancelEditingMessage() {
  editingMessageId = null
  clearMessageInput()
  document.getElementById('edit-bar').style.display = 'none'
  document.getElementById('send-btn').textContent = '➤'
}

let savingEdit = false // verhindert, dass ein doppelter Enter-Druck die Änderung zweimal abschickt

// Das Bearbeiten wieder öffnen, falls das Speichern nicht geklappt hat (nur wenn das Feld inzwischen leer ist)
function reopenEditing(id, text) {
  if (getMessageText().trim() !== '') return
  editingMessageId = id
  setMessageText(text)
  document.getElementById('edit-bar').style.display = 'flex'
  document.getElementById('send-btn').textContent = '✓'
}

async function saveEditedMessage(newText) {
  const id = editingMessageId
  if (!id || savingEdit) return

  // Die Zeit kann während des Bearbeitens abgelaufen sein
  const row = document.querySelector(`#chat-box [data-id="${id}"]`)
  if (row && row.dataset.createdAt && !withinEditWindow(row.dataset.createdAt)) {
    editWindowExpiredToast()
    cancelEditingMessage()
    return
  }

  // Das Eingabefeld sofort schließen, nicht erst nach der Antwort vom Server
  savingEdit = true
  cancelEditingMessage()

  try {
    const { data, error } = await supabaseClient
      .from(currentTable())
      .update({ text: newText, edited_at: new Date().toISOString() })
      .eq('id', id)
      .select()

    if (error) {
      showToast('Bearbeiten fehlgeschlagen: ' + error.message)
      reopenEditing(id, newText)
    } else if (!data || data.length === 0) {
      showToast('Bearbeiten nicht erlaubt.')
      reopenEditing(id, newText)
    } else {
      try {
        updateMessageElement(data[0])
      } catch (e) {
        console.error('Nachricht konnte nicht neu angezeigt werden:', e)
      }
    }
  } catch (e) {
    showToast('Bearbeiten fehlgeschlagen.')
    reopenEditing(id, newText)
  } finally {
    savingEdit = false
  }
}

// Text (und ggf. den "bearbeitet"-Hinweis) einer bereits angezeigten Nachricht aktualisieren
// Besteht eine Nachricht nur aus 1 bis 3 Emojis (sonst nichts), werden sie groß dargestellt wie bei WhatsApp
const BIG_EMOJI_ONE = '(?:\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*)'

function bigEmojiCount(text) {
  try {
    const compact = String(text || '').replace(/\s+/g, '')
    if (!compact) return 0
    if (!new RegExp('^' + BIG_EMOJI_ONE + '+$', 'u').test(compact)) return 0
    const count = (compact.match(new RegExp(BIG_EMOJI_ONE, 'gu')) || []).length
    return count >= 1 && count <= 3 ? count : 0
  } catch (e) {
    return 0 // ältere Browser ohne diese Emoji-Erkennung: normale Größe
  }
}

function markBigEmoji(textEl, text) {
  textEl.classList.remove('emoji-big', 'emoji-big-1', 'emoji-big-2', 'emoji-big-3')
  const count = bigEmojiCount(text)
  if (count > 0) textEl.classList.add('emoji-big', 'emoji-big-' + count)
}

function updateMessageElement(msg) {
  const row = document.querySelector(`#chat-box [data-id="${msg.id}"]`)
  if (!row) return

  const textEl = row.querySelector('.msg-text')
  if (textEl && !msg.photo_id && !msg.audio_id) {
    textEl.textContent = msg.text
    markBigEmoji(textEl, msg.text)
  }

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
      dropPinForMessages([id])
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
  updateNewGroupButton()
  if (isAdmin()) updateReportsBadge()
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

  const sendResetMail = () => supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.href.split('#')[0].split('?')[0]
  })
  let { error } = await sendResetMail()
  if (error && (!error.status || error.status >= 500)) {
    // Netz- oder Serverfehler beim ersten Versuch: einmal automatisch wiederholen
    await new Promise(resolve => setTimeout(resolve, 1200))
    ;({ error } = await sendResetMail())
  }

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
  localStorage.removeItem(PENDING_INVITE_KEY)
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
  await loadVipIds()

  const { data: users, error } = await supabaseClient
    .from('profiles')
    .select('*')
    .order('display_name')

  if (error) {
    list.textContent = 'Nutzer konnten nicht geladen werden: ' + error.message
    return
  }

  allUsers = users
    .filter(u => u.id !== currentUser.id)
    .sort((x, y) => (x.display_name || '').localeCompare(y.display_name || '', 'de', { sensitivity: 'base' }))
  renderUserList()
}

// Nutzerliste mit Suche (Name) und Filter (Alle / Jungs / Mädchen)
let allUsers = []
let userFilterGender = 'all'

function setUserFilter(value) {
  userFilterGender = value
  document.querySelectorAll('#user-filter .filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === value)
  })
  renderUserList()
}

function renderUserList() {
  const list = document.getElementById('user-list')
  const query = (document.getElementById('user-search').value || '').trim().toLowerCase()
  list.innerHTML = ''

  allUsers
    .filter(u => userFilterGender === 'all' || u.gender === userFilterGender)
    .filter(u => !query || (u.display_name || '').toLowerCase().includes(query))
    .forEach(u => {
      const row = document.createElement('li')
      if (u.is_blocked) row.classList.add('blocked')
      row.dataset.userId = u.id

      const name = document.createElement('span')
      name.className = 'user-name'
      name.textContent = (u.display_name || 'Ohne Namen') +
        (!u.gender && u.role !== 'admin' ? ' (Geschlecht fehlt)' : '') +
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
    list.textContent = allUsers.length === 0 ? 'Noch keine anderen Nutzer.' : 'Keine passenden Nutzer gefunden.'
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
      <label for="user-name-input">Name (zugleich der Benutzername zum Anmelden)</label>
      <input type="text" id="user-name-input" maxlength="40" autocomplete="off" value="${escapeHTML(u.display_name || '')}">
      <label for="user-email-input" class="user-edit-label">E-Mail-Adresse</label>
      <input type="email" id="user-email-input" autocomplete="off" placeholder="Wird geladen …" disabled>
      <p class="field-error" id="user-identity-error" style="display: none;"></p>
      <button type="button" class="user-color-btn" id="user-identity-save-btn" disabled>Speichern</button>
    </div>
    <div class="input-group">
      <label>Geschlecht</label>
      <div class="gender-choice">
        <button type="button" class="gender-btn junge${u.gender === 'junge' ? ' active' : ''}" data-value="junge">Junge</button>
        <button type="button" class="gender-btn maedchen${u.gender === 'maedchen' ? ' active' : ''}" data-value="maedchen">Mädchen</button>
      </div>
    </div>
    <div class="input-group">
      <div class="rights-row">
        <div class="rights-row-text">
          <span class="rights-row-title">Besondere Rechte</span>
          <span class="rights-row-state">${vipIds.has(u.id) ? 'Ja' : 'Nein'}</span>
        </div>
        <button type="button" class="rights-switch${vipIds.has(u.id) ? ' on' : ''}" id="user-rights-switch" role="switch" aria-checked="${vipIds.has(u.id)}" aria-label="Besondere Rechte"></button>
      </div>
    </div>
    <div class="input-group">
      <div class="rights-row">
        <div class="rights-row-text">
          <span class="rights-row-title">Darf Fotos und Audio senden</span>
          <span class="rights-row-state">${photoBlockedIds.has(u.id) ? 'Nein' : 'Ja'}</span>
        </div>
        <button type="button" class="rights-switch${photoBlockedIds.has(u.id) ? '' : ' on'}" id="user-photo-switch" role="switch" aria-checked="${!photoBlockedIds.has(u.id)}" aria-label="Darf Fotos und Audio senden"></button>
      </div>
    </div>
    <div class="input-group">
      <div class="rights-row">
        <div class="rights-row-text">
          <span class="rights-row-title">Darf Gruppen erstellen</span>
          <span class="rights-row-state">${groupCreateBlockedIds.has(u.id) ? 'Nein' : 'Ja'}</span>
        </div>
        <button type="button" class="rights-switch${groupCreateBlockedIds.has(u.id) ? '' : ' on'}" id="user-group-switch" role="switch" aria-checked="${!groupCreateBlockedIds.has(u.id)}" aria-label="Darf Gruppen erstellen"></button>
      </div>
    </div>
    <div class="input-group">
      <label>Profilfarbe</label>
      <div class="user-color-row">
        <div class="reaction-avatar" id="user-color-preview" style="background:${avatarColor(u.id)}">${escapeHTML(initialsOf(u.display_name || ''))}</div>
        <button type="button" class="user-color-btn" id="user-color-btn">Farbe neu würfeln</button>
      </div>
    </div>
    <div class="input-group">
      <label>Geburtsdatum</label>
      <div class="birth-select-row">
        <select id="user-birth-day" aria-label="Tag"></select>
        <select id="user-birth-month" aria-label="Monat"></select>
        <select id="user-birth-year" aria-label="Jahr"></select>
      </div>
      <p class="field-error" id="user-birth-error" style="display: none;"></p>
      <button type="button" class="user-color-btn" id="user-birth-save-btn" disabled>Geburtsdatum speichern</button>
    </div>
    <div class="user-actions">
      <button type="button" class="${u.is_blocked ? 'unblock-btn' : 'block-btn'}" id="user-block-btn">${u.is_blocked ? 'Entsperren' : 'Sperren'}</button>
      <button type="button" class="delete-btn" id="user-delete-btn">Nutzer löschen</button>
    </div>
  `
  box.querySelectorAll('.gender-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Das Geschlecht muss immer eingestellt sein: die gewählte Option nochmal drücken ändert nichts
      if (btn.classList.contains('active')) return
      setGender(u, btn.dataset.value)
    })
  })
  document.getElementById('user-rights-switch').addEventListener('click', () => setVip(u, !vipIds.has(u.id)))
  document.getElementById('user-photo-switch').addEventListener('click', () => setPhotoAllowed(u, photoBlockedIds.has(u.id)))
  document.getElementById('user-group-switch').addEventListener('click', () => setGroupCreateAllowed(u, groupCreateBlockedIds.has(u.id)))
  setupAdminIdentity(u)
  document.getElementById('user-color-btn').addEventListener('click', () => rerollUserColor(u))
  setupAdminBirthdate(u)
  document.getElementById('user-block-btn').addEventListener('click', () => setBlocked(u, !u.is_blocked))
  document.getElementById('user-delete-btn').addEventListener('click', () => deleteUser(u))
}

// Admin: Name (= Benutzername zum Anmelden) und E-Mail-Adresse einer Person ändern.
// Der Name steht in "profiles" (Admin-Policy), die E-Mail in auth.users und lässt sich nur über die Edge Function
// "admin-update-user" ändern, die serverseitig prüft, ob der Aufrufer Admin ist.
function setupAdminIdentity(user) {
  const nameInput = document.getElementById('user-name-input')
  const emailInput = document.getElementById('user-email-input')
  const saveBtn = document.getElementById('user-identity-save-btn')
  const errorEl = document.getElementById('user-identity-error')
  let savedName = user.display_name || ''
  let savedEmail = profileEmailCache[user.id] || ''
  nameInput.value = savedName
  let emailLoaded = !!savedEmail
  let saving = false

  const showError = (text) => {
    errorEl.textContent = text || ''
    errorEl.style.display = text ? '' : 'none'
  }
  const nameProblem = (name) => {
    if (name.length < 2) return 'Der Name ist zu kurz.'
    const taken = allUsers.some(o => o.id !== user.id && (o.display_name || '').trim().toLowerCase() === name.toLowerCase())
    return taken ? 'Diesen Namen gibt es schon.' : ''
  }
  const emailProblem = (email) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Bitte eine gültige E-Mail-Adresse eingeben.')
  const refresh = () => {
    const name = nameInput.value.trim()
    const email = emailInput.value.trim()
    const nameChanged = name !== savedName
    const emailChanged = emailLoaded && email !== savedEmail
    const problem = (nameChanged ? nameProblem(name) : '') || (emailChanged ? emailProblem(email) : '')
    showError(problem)
    saveBtn.disabled = saving || !(nameChanged || emailChanged) || !!problem
  }
  nameInput.addEventListener('input', refresh)
  emailInput.addEventListener('input', refresh)

  // Aktuelle E-Mail-Adresse holen (kommt nur für den Admin über die Edge Function "get-user-email")
  const showEmail = () => {
    emailInput.value = savedEmail
    emailInput.disabled = false
    emailInput.placeholder = ''
    refresh()
  }
  if (emailLoaded) showEmail()
  else {
    supabaseClient.functions.invoke('get-user-email', { body: { userId: user.id } }).then(({ data, error }) => {
      if (!document.body.contains(emailInput)) return
      if (error || !data || !data.email) {
        emailInput.placeholder = 'Konnte nicht geladen werden'
        return
      }
      savedEmail = data.email
      emailLoaded = true
      profileEmailCache[user.id] = savedEmail
      showEmail()
    })
  }

  saveBtn.addEventListener('click', async () => {
    if (!isAdmin() || saving) return
    const name = nameInput.value.trim()
    const email = emailInput.value.trim()
    const nameChanged = name !== savedName
    const emailChanged = emailLoaded && email !== savedEmail
    if (!nameChanged && !emailChanged) return
    if ((nameChanged && nameProblem(name)) || (emailChanged && emailProblem(email))) return

    if (emailChanged && !(await askConfirm('Die E-Mail-Adresse von ' + (savedName || 'dieser Person') + ' wirklich auf ' + email + ' ändern? Einladungs- und Passwort-Mails gehen dann dorthin.', { okText: 'Ändern' }))) return

    saving = true
    saveBtn.disabled = true
    showError('')
    try {
      if (nameChanged) {
        const { data, error } = await supabaseClient.from('profiles').update({ display_name: name }).eq('id', user.id).select('id')
        if (error) throw new Error(error.code === '23505' ? 'Diesen Namen gibt es schon.' : error.message)
        if (!data || data.length === 0) throw new Error('Änderung nicht erlaubt.')
        user.display_name = name
        savedName = name
        if (profileCache[user.id]) profileCache[user.id].name = name
        document.getElementById('user-detail-title').textContent = name
        const preview = document.getElementById('user-color-preview')
        if (preview) preview.textContent = initialsOf(name)
        renderUserList()
        renderChatList()
      }
      if (emailChanged) {
        const { data: session } = await supabaseClient.auth.getSession()
        if (!session || !session.session) throw new Error('Deine Sitzung ist abgelaufen. Bitte melde dich neu an.')
        const { data, error } = await supabaseClient.functions.invoke('admin-update-user', {
          body: { userId: user.id, email },
          headers: { Authorization: 'Bearer ' + session.session.access_token }
        })
        if (error) throw new Error(await readFunctionError(error))
        if (data && data.error) throw new Error(data.error)
        savedEmail = email
        profileEmailCache[user.id] = email
      }
      showToast('Gespeichert.', 'success')
    } catch (e) {
      showError(e.message || 'Speichern hat nicht geklappt.')
    } finally {
      saving = false
      refresh()
    }
  })
}

// Admin: der Person zufällig eine neue Farbe aus der Palette geben (gespeichert in profiles.color)
async function rerollUserColor(user) {
  if (!isAdmin()) return
  const current = avatarColor(user.id).toLowerCase()
  const options = AVATAR_COLORS.filter(c => c.toLowerCase() !== current)
  const color = options[Math.floor(Math.random() * options.length)]

  const btn = document.getElementById('user-color-btn')
  if (btn) btn.disabled = true
  const { data, error } = await supabaseClient.from('profiles').update({ color }).eq('id', user.id).select('id')
  if (btn) btn.disabled = false

  if (error) {
    showToast('Fehler: ' + error.message)
    return
  }
  if (!data || data.length === 0) {
    showToast('Änderung nicht erlaubt (oder die Spalte "color" fehlt noch).')
    return
  }
  user.color = color
  if (profileCache[user.id]) profileCache[user.id].color = color
  const preview = document.getElementById('user-color-preview')
  if (preview) preview.style.background = color
  renderChatList()
}

// Admin: Geburtsdatum mit drei Auswahlfeldern (Tag, Monat, Jahr) - das Jahr steht direkt zur Wahl
const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']

function fillSelect(select, placeholder, options, selected) {
  select.innerHTML = ''
  const first = document.createElement('option')
  first.value = ''
  first.textContent = placeholder
  select.appendChild(first)
  options.forEach(([value, label]) => {
    const opt = document.createElement('option')
    opt.value = String(value)
    opt.textContent = label
    select.appendChild(opt)
  })
  select.value = selected ? String(selected) : ''
}

function setupAdminBirthdate(user) {
  const daySel = document.getElementById('user-birth-day')
  const monthSel = document.getElementById('user-birth-month')
  const yearSel = document.getElementById('user-birth-year')
  const saveBtn = document.getElementById('user-birth-save-btn')
  const errorEl = document.getElementById('user-birth-error')
  const saved = (profileCache[user.id] && profileCache[user.id].birthdate) || user.birthdate || null
  const [sy, sm, sd] = saved ? saved.split('-').map(Number) : [0, 0, 0]

  const thisYear = new Date().getFullYear()
  const years = []
  for (let y = thisYear - BIRTH_MIN_AGE; y >= thisYear - BIRTH_MAX_AGE; y--) years.push([y, String(y)])
  const days = []
  for (let d = 1; d <= 31; d++) days.push([d, String(d)])
  fillSelect(daySel, 'Tag', days, sd)
  fillSelect(monthSel, 'Monat', MONTH_NAMES.map((name, i) => [i + 1, name]), sm)
  fillSelect(yearSel, 'Jahr', years, sy)

  const currentValue = () => {
    if (!daySel.value || !monthSel.value || !yearSel.value) return null
    return yearSel.value + '-' + pad2(Number(monthSel.value)) + '-' + pad2(Number(daySel.value))
  }
  const refresh = () => {
    const value = currentValue()
    const problem = value ? birthdateError(value) : null
    errorEl.textContent = problem || ''
    errorEl.style.display = problem ? '' : 'none'
    saveBtn.disabled = !value || !!problem || value === saved
  }
  ;[daySel, monthSel, yearSel].forEach(sel => sel.addEventListener('change', refresh))
  refresh()

  saveBtn.addEventListener('click', async () => {
    if (!isAdmin()) return
    const value = currentValue()
    const problem = value ? birthdateError(value) : 'Bitte Tag, Monat und Jahr wählen.'
    if (problem) {
      errorEl.textContent = problem
      errorEl.style.display = ''
      return
    }
    saveBtn.disabled = true
    const { data, error } = await supabaseClient.from('profiles').update({ birthdate: value }).eq('id', user.id).select('id')
    if (error || !data || data.length === 0) {
      errorEl.textContent = error ? error.message : 'Änderung nicht erlaubt.'
      errorEl.style.display = ''
      saveBtn.disabled = false
      return
    }
    user.birthdate = value
    if (profileCache[user.id]) profileCache[user.id].birthdate = value
    showToast('Geburtsdatum gespeichert.', 'success')
    renderUserDetail(user)
    renderChatList() // Geburtstags-Markierungen neu setzen
  })
}

// Nutzer endgültig löschen - läuft über die Edge Function "delete-user" (braucht den geheimen Schlüssel)
async function deleteUser(user) {
  if (!isAdmin()) return
  const name = user.display_name || 'diesen Nutzer'
  // Doppelte Warnung: erst nach beiden Bestätigungen wird wirklich gelöscht
  if (!(await askConfirm('Bist du dir sicher, dass du diesen Nutzer unwiderruflich löschen möchtest? (' + name + ')', { okText: 'Ja, weiter', danger: true }))) return
  if (!(await askConfirm('Letzte Warnung: ' + name + ' und das Konto werden endgültig gelöscht und können NICHT wiederhergestellt werden. Wirklich löschen?', { okText: 'Endgültig löschen', danger: true }))) return

  const { error } = await supabaseClient.functions.invoke('delete-user', { body: { userId: user.id } })
  if (error) {
    showToast('Löschen fehlgeschlagen: ' + await readFunctionError(error))
    return
  }
  openUserManagement()
}

// ===== VIP und angepinnte Nachrichten =====
// VIPs (Tabelle vip_users) dürfen Nachrichten anpinnen. Pro Chat gibt es höchstens eine angepinnte Nachricht
// (Tabelle pinned_messages, mit Kopie des Textes - sie bleibt also auch nach dem Ringpuffer stehen).
let vipIds = new Set()   // IDs aller VIP-Nutzer
let currentPin = null    // angepinnte Nachricht des gerade offenen Chats (oder null)
let pinChannel = null    // Realtime: anpinnen/lösen im offenen Chat

// Wer keine Fotos senden darf (Tabelle photo_blocked_users). Die Person sieht Fotos weiterhin, kann aber keine senden.
// Der Admin sieht die ganze Liste, alle anderen nur ihre eigene Zeile.
let photoBlockedIds = new Set()

async function loadPhotoBlockedIds() {
  const { data, error } = await supabaseClient.from('photo_blocked_users').select('user_id')
  if (error) {
    console.error('Foto-Sperrliste konnte nicht geladen werden:', error)
    return
  }
  photoBlockedIds = new Set((data || []).map(r => r.user_id))
}

function isPhotoBlockedSelf() {
  return !isAdmin() && !!currentUser && photoBlockedIds.has(currentUser.id)
}

async function setPhotoAllowed(user, allowed) {
  if (!isAdmin()) return
  const { error } = allowed
    ? await supabaseClient.from('photo_blocked_users').delete().eq('user_id', user.id)
    : await supabaseClient.from('photo_blocked_users').insert({ user_id: user.id })

  if (error) {
    showToast('Fehler: ' + error.message)
    return
  }
  if (allowed) photoBlockedIds.delete(user.id)
  else photoBlockedIds.add(user.id)
  renderUserDetail(user)
}

async function setGroupCreateAllowed(user, allowed) {
  if (!isAdmin()) return
  const { error } = allowed
    ? await supabaseClient.from('group_create_blocked_users').delete().eq('user_id', user.id)
    : await supabaseClient.from('group_create_blocked_users').insert({ user_id: user.id })

  if (error) {
    showToast('Fehler: ' + error.message)
    return
  }
  if (allowed) groupCreateBlockedIds.delete(user.id)
  else groupCreateBlockedIds.add(user.id)
  renderUserDetail(user)
}

async function loadVipIds() {
  await loadPhotoBlockedIds()
  await loadGroupBlockedIds()
  const { data, error } = await supabaseClient.from('vip_users').select('user_id')
  if (error) {
    console.error('VIP-Liste konnte nicht geladen werden:', error)
    return
  }
  vipIds = new Set((data || []).map(r => r.user_id))
}

function isVip() {
  return !isAdmin() && !!currentUser && vipIds.has(currentUser.id)
}

// Anpinnen darf ein VIP im eigenen Chat (nicht im rein lesenden Einblick in fremde Einzelchats)
function canPinHere() {
  return isVip() && (currentRoom.type === 'group' || currentRoom.type === 'dm')
}

// Aufheben darf, wer angepinnt hat, und der Admin
function canUnpinCurrent() {
  return !!currentPin && !!currentUser && (isAdmin() || currentPin.pinned_by === currentUser.id)
}

function pinChatKey() {
  return pollChatKey(currentRoom)
}

// Zeigt im Verlauf die aktuelle Fassung, solange die Nachricht noch geladen ist, sonst die gespeicherte Kopie
function currentPinText() {
  if (!currentPin) return ''
  const live = messagesById[currentPin.message_id]
  return live ? messageSnippet(live) : currentPin.message_text
}

async function loadPinForRoom() {
  currentPin = null
  const key = pinChatKey()
  if (key) {
    const { data, error } = await supabaseClient
      .from('pinned_messages')
      .select('*')
      .eq('chat_key', key)
      .maybeSingle()
    if (error) console.error('Angepinnte Nachricht konnte nicht geladen werden:', error)
    else currentPin = data
  }
  renderPin()
}

// Zeichnet die Leiste oben und den Hinweis "<Name> hat eine Nachricht angepinnt" mitten im Verlauf neu
function renderPin() {
  const chatBox = document.getElementById('chat-box')
  const bar = document.getElementById('pin-bar')
  chatBox.querySelectorAll('.pin-notice').forEach(el => el.remove())

  if (!currentPin) {
    bar.style.display = 'none'
    return
  }

  const name = (profileCache[currentPin.pinned_by] && profileCache[currentPin.pinned_by].name) || 'Jemand'
  document.getElementById('pin-bar-label').textContent = 'Angepinnt von ' + name
  const textEl = document.getElementById('pin-bar-text')
  textEl.textContent = truncate(currentPinText().replace(/\s+/g, ' '), 120)
  applyEmojiImages(textEl)
  document.getElementById('pin-bar-close').style.display = canUnpinCurrent() ? '' : 'none'
  bar.style.display = 'flex'

  // Hinweis-Pille zeitlich einsortieren (wie die Umfragen)
  const notice = document.createElement('div')
  notice.className = 'pin-notice'
  notice.dataset.createdAt = currentPin.pinned_at
  const pill = document.createElement('span')
  pill.className = 'pin-notice-pill'
  pill.textContent = name + ' hat eine Nachricht angepinnt'
  notice.appendChild(pill)

  const pinnedAt = new Date(currentPin.pinned_at)
  const sibling = Array.from(chatBox.children).find(el => el.dataset.createdAt && new Date(el.dataset.createdAt) > pinnedAt)
  if (sibling) chatBox.insertBefore(notice, sibling)
  else chatBox.appendChild(notice)
}

// Tipp auf die Leiste: zur Nachricht springen, oder (wenn sie nicht mehr im Chat steht) den ganzen Text zeigen
function onPinBarClick() {
  if (!currentPin) return
  const target = document.querySelector(`#chat-box .msg-row[data-id="${currentPin.message_id}"]`)
  if (target) jumpToMessage(currentPin.message_id)
  else showInfoDialog(currentPinText())
}

async function pinMessage(msg) {
  const key = pinChatKey()
  if (!key || !canPinHere()) return
  const { data, error } = await supabaseClient
    .from('pinned_messages')
    .upsert({
      chat_key: key,
      message_id: String(msg.id),
      message_text: messageSnippet(msg),
      sender_id: msg.sender_id,
      message_created_at: msg.created_at,
      pinned_by: currentUser.id
    }, { onConflict: 'chat_key' })
    .select()
    .single()

  if (error) {
    showToast('Anpinnen fehlgeschlagen: ' + error.message)
    return
  }
  currentPin = data
  renderPin()
}

async function unpinCurrent() {
  if (!currentPin || !canUnpinCurrent()) return
  const { data, error } = await supabaseClient
    .from('pinned_messages')
    .delete()
    .eq('id', currentPin.id)
    .select()

  if (error) {
    showToast('Aufheben fehlgeschlagen: ' + error.message)
  } else if (!data || data.length === 0) {
    showToast('Aufheben nicht erlaubt.')
  } else {
    currentPin = null
    renderPin()
  }
}

// Das ✕ in der Leiste (nur für den, der angepinnt hat, und den Admin)
async function unpinFromBar() {
  if (!(await askConfirm('Soll die Nachricht nicht mehr angepinnt sein?', { okText: 'Aufheben', cancelText: 'Abbrechen' }))) return
  unpinCurrent()
}

// Wird eine angepinnte Nachricht gelöscht, verschwindet auch das Anpinnen
async function dropPinForMessages(ids) {
  if (!currentPin) return
  if (!ids.map(String).includes(String(currentPin.message_id))) return
  const pinId = currentPin.id
  currentPin = null
  renderPin()
  await supabaseClient.from('pinned_messages').delete().eq('id', pinId)
}

function startPinListening() {
  stopPinListening()
  const key = pinChatKey()
  if (!key) return

  pinChannel = supabaseClient
    .channel('pin:' + key)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pinned_messages', filter: 'chat_key=eq.' + key },
      (payload) => {
        currentPin = payload.eventType === 'DELETE' ? null : payload.new
        renderPin()
      })
    .subscribe()
}

function stopPinListening() {
  if (pinChannel) {
    supabaseClient.removeChannel(pinChannel)
    pinChannel = null
  }
}

// Admin: einer Person VIP-Rechte geben oder wieder wegnehmen
async function setVip(user, makeVip) {
  if (!isAdmin()) return
  const { error } = makeVip
    ? await supabaseClient.from('vip_users').insert({ user_id: user.id })
    : await supabaseClient.from('vip_users').delete().eq('user_id', user.id)

  if (error) {
    showToast('Fehler: ' + error.message)
    return
  }
  if (makeVip) vipIds.add(user.id)
  else vipIds.delete(user.id)
  renderUserDetail(user)
  loadUsers()
}

async function setGender(user, gender) {
  if (!isAdmin() || !gender) return
  // Wechsel von einer Gruppe in die andere (z. B. Mädchen -> Junge): erst nachfragen
  if (user.gender && gender && user.gender !== gender) {
    const question = gender === 'junge' ? 'Ist das wirklich ein Junge?' : 'Ist das wirklich ein Mädchen?'
    if (!(await askConfirm(question, { okText: 'Ja, wechseln', cancelText: 'Abbrechen' }))) return
  }

  const { error } = await supabaseClient
    .from('profiles')
    .update({ gender })
    .eq('id', user.id)

  if (error) {
    showToast('Fehler: ' + error.message)
  } else {
    user.gender = gender
    renderUserDetail(user)
  }
  loadUsers()
}

async function setBlocked(user, blocked) {
  if (!isAdmin()) return
  const name = user.display_name || 'diesen Nutzer'
  const question = blocked
    ? 'Möchtest du diesen Nutzer wirklich sperren? (' + name + ' kann sich danach nicht mehr im Chat anmelden oder schreiben, bis du die Sperre wieder aufhebst.)'
    : name + ' wieder entsperren?'
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
  document.querySelectorAll('#new-user-gender .gender-btn').forEach(b => b.classList.remove('active'))
  updateInviteButton()
  document.getElementById('new-user-email').focus()
}

// "Einladung senden" ist ausgegraut, bis eine gültige E-Mail-Adresse eingetragen und Junge/Mädchen gewählt ist
let inviteSending = false
function updateInviteButton() {
  const email = document.getElementById('new-user-email').value.trim()
  const hasGender = !!document.querySelector('#new-user-gender .gender-btn.active')
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  document.getElementById('invite-user-btn').disabled = inviteSending || !validEmail || !hasGender
}

// Edge Functions antworten beim allerersten Aufruf manchmal nicht ("kalter Start", kurzer Netzaussetzer).
// Solche Fehler (Netzwerk, Serverfehler, abgelaufener Schlüssel) werden deshalb einmal automatisch wiederholt;
// echte Fehler der Anfrage (z. B. 400/403) nicht. buildOptions wird bei jedem Versuch neu aufgerufen (frischer Schlüssel).
async function invokeWithRetry(name, buildOptions, retries = 1) {
  let result = await supabaseClient.functions.invoke(name, await buildOptions())
  for (let i = 0; i < retries && result.error; i++) {
    const status = result.error.context && result.error.context.status
    if (typeof status === 'number' && status < 500 && status !== 401 && status !== 408 && status !== 429) break
    if (status === 401) await supabaseClient.auth.refreshSession()
    await new Promise(resolve => setTimeout(resolve, 1200))
    result = await supabaseClient.functions.invoke(name, await buildOptions())
  }
  return result
}

// Junge/Mädchen im Admin-Formular auswählen (einmal gewählt bleibt immer eins ausgewählt)
function selectNewUserGender(value) {
  document.querySelectorAll('#new-user-gender .gender-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === value)
  })
  updateInviteButton()
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

// Kleines Pop-up: Junge oder Mädchen? Gibt 'junge', 'maedchen' oder null (abgebrochen) zurück
function askGender(email) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'confirm-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'confirm-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')

    const text = document.createElement('p')
    text.textContent = 'Ist ' + email + ' ein Junge oder ein Mädchen?'

    const choice = document.createElement('div')
    choice.className = 'gender-choice'
    const boyBtn = document.createElement('button')
    boyBtn.type = 'button'
    boyBtn.className = 'gender-btn junge'
    boyBtn.textContent = 'Junge'
    const girlBtn = document.createElement('button')
    girlBtn.type = 'button'
    girlBtn.className = 'gender-btn maedchen'
    girlBtn.textContent = 'Mädchen'
    choice.append(boyBtn, girlBtn)

    const buttons = document.createElement('div')
    buttons.className = 'confirm-buttons'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'confirm-cancel'
    cancelBtn.textContent = 'Abbrechen'
    buttons.appendChild(cancelBtn)

    dialog.append(text, choice, buttons)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    const finish = result => {
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      resolve(result)
    }
    const onKey = e => { if (e.key === 'Escape') finish(null) }
    document.addEventListener('keydown', onKey)
    boyBtn.addEventListener('click', () => finish('junge'))
    girlBtn.addEventListener('click', () => finish('maedchen'))
    cancelBtn.addEventListener('click', () => finish(null))
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null) })
  })
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

  const activeGenderBtn = document.querySelector('#new-user-gender .gender-btn.active')
  const gender = activeGenderBtn ? activeGenderBtn.dataset.value : null
  if (!gender) {
    showToast('Bitte Junge oder Mädchen auswählen.')
    return
  }

  // Frage 1: besondere Rechte? (Esc oder daneben tippen zählt als "Nein")
  const makeVip = await askConfirm('Soll die Person besondere Rechte bekommen?', { okText: 'Ja', cancelText: 'Nein' })

  // Frage 2: wirklich senden?
  if (!(await askConfirm('Möchtest du die E-Mail wirklich an ' + email + ' senden?', { okText: 'Senden', cancelText: 'Abbrechen' }))) return

  inviteSending = true
  btn.disabled = true
  btn.textContent = 'Wird gesendet …'
  const finishSending = () => {
    inviteSending = false
    btn.textContent = 'Einladung senden'
    updateInviteButton()
  }

  // Aktuelle Sitzung holen (erneuert den Token bei Bedarf) und das Admin-JWT ausdrücklich mitschicken
  const { data: { session } } = await supabaseClient.auth.getSession()
  if (!session) {
    finishSending()
    showToast('Deine Sitzung ist abgelaufen. Bitte melde dich neu an.')
    return
  }

  const { data, error } = await invokeWithRetry('invite-user', async () => {
    const { data: { session: fresh } } = await supabaseClient.auth.getSession()
    return {
      body: { email, gender, vip: makeVip },
      headers: { Authorization: 'Bearer ' + (fresh || session).access_token }
    }
  })
  finishSending()

  if (error) {
    showToast('Einladung konnte nicht gesendet werden: ' + await readFunctionError(error))
    return
  }
  if (data && data.error) {
    showToast('Einladung konnte nicht gesendet werden: ' + data.error)
    return
  }

  input.value = ''
  document.querySelectorAll('#new-user-gender .gender-btn').forEach(b => b.classList.remove('active'))

  // Die (neue) Funktion speichert Geschlecht und Rechte selbst und meldet das zurück. Bei der alten Fassung
  // der Funktion wird das Geschlecht hier nachgetragen (mehrere Versuche, falls das Profil noch angelegt wird).
  const userId = (data && (data.userId || data.user_id || data.id || (data.user && data.user.id))) || null
  let genderSaved = !!(data && data.genderSaved === true)
  let genderProblem = ''

  if (!genderSaved) {
    if (!userId) {
      genderProblem = 'Die Funktion hat keine Nutzer-ID zurückgegeben.'
    } else {
      for (let attempt = 0; attempt < 6 && !genderSaved; attempt++) {
        if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 700))
        const { data: updated, error: genderError } = await supabaseClient
          .from('profiles')
          .update({ gender })
          .eq('id', userId)
          .select('id')
        if (genderError) genderProblem = genderError.message
        else if (!updated || updated.length === 0) genderProblem = 'Das Profil wurde nicht gefunden oder darf nicht geändert werden.'
        else genderSaved = true
      }
    }
  }

  if (makeVip && userId && !(data && data.vipSaved === true)) {
    const { error: vipError } = await supabaseClient.from('vip_users').insert({ user_id: userId })
    if (vipError && vipError.code !== '23505') showToast('Besondere Rechte konnten nicht gespeichert werden: ' + vipError.message)
  }

  if (!genderSaved) {
    await showInfoDialog('Die E-Mail an ' + email + ' wurde gesendet, aber das Geschlecht konnte NICHT gespeichert werden (' + genderProblem + '). Bitte sofort unter „Nutzer verwalten“ Junge oder Mädchen einstellen.')
  } else {
    await showInfoDialog('Die E-Mail an ' + email + ' wurde erfolgreich gesendet!')
  }
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
  await clearPhotoCache()
  // scope 'local': nur dieses Gerät melden wir ab, Anmeldungen auf anderen Geräten (z. B. Handy) bleiben unberührt
  await supabaseClient.auth.signOut({ scope: 'local' })
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

// Einfaches Hinweis-Pop-up mit nur einem "OK"-Knopf
function showInfoDialog(message, okText = 'OK') {
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
    const okBtn = document.createElement('button')
    okBtn.type = 'button'
    okBtn.className = 'confirm-ok'
    okBtn.textContent = okText
    buttons.appendChild(okBtn)

    dialog.append(text, buttons)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    okBtn.focus()

    const finish = () => {
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      resolve()
    }
    const onKey = e => { if (e.key === 'Escape' || e.key === 'Enter') finish() }
    document.addEventListener('keydown', onKey)
    okBtn.addEventListener('click', finish)
    overlay.addEventListener('click', e => { if (e.target === overlay) finish() })
  })
}

// Enter-Taste
function onEnter(id, fn) {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return // Bestätigen eines Vorschlags der Tastatur ist kein Senden
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      fn()
    }
  })
}

onEnter('message-input', sendMessage)

const MESSAGE_INPUT_MAX_LINES = 5 // so viele Zeilen wächst das Feld mit - danach scrollt es für sich weiter

// Platzhalter "Nachricht" zeigen, sobald im Feld nichts Sichtbares mehr steht. Das Feld selbst ist danach oft nicht
// ganz leer (übrig gebliebene Zeilenumbrüche), deshalb reicht der CSS-Test ":empty" allein nicht.
function updateMessagePlaceholder() {
  const input = document.getElementById('message-input')
  const isEmpty = input.textContent.replace(/[\u200b\s]/g, '') === '' && !input.querySelector('img')
  input.classList.toggle('is-empty', isEmpty)

  // Leer, aber mit Resten (z. B. einem Zeilenumbruch): ganz leeren, sonst blinkt der Cursor HINTER dem Platzhalter
  // statt davor. Nicht mitten in einer Tastatur-Eingabe (Handy), die würde dadurch gestört.
  if (isEmpty && input.innerHTML !== '' && !messageComposing) {
    input.innerHTML = ''
    if (document.activeElement === input) {
      const range = document.createRange()
      range.selectNodeContents(input)
      range.collapse(true)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      savedMessageRange = range.cloneRange()
    }
  }
}

// Der Senden-Knopf ist ausgegraut, solange nichts im Feld steht (oder gerade gesendet wird)
function updateSendButton() {
  const btn = document.getElementById('send-btn')
  if (!btn) return
  btn.disabled = !!btn.dataset.busy || getMessageText().trim() === ''
}

function autoResizeMessageInput() {
  updateSendButton()
  const input = document.getElementById('message-input')
  updateMessagePlaceholder()
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

  document.getElementById('attach-btn').classList.toggle('hidden-btn', getMessageText().trim() !== '')
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

// ===== Nachrichtenfeld: ein beschreibbares Feld, das Emojis als schöne Bilder zeigt =====
// Ein normales Textfeld kann keine Bilder zeigen, deshalb ist das Feld ein <div contenteditable>.
// Die Funktionen unten ersetzen das frühere ".value": Text lesen, setzen, leeren, an der Cursor-Stelle einfügen.
const MESSAGE_MAX_LENGTH = 3000
let savedMessageRange = null // zuletzt bekannte Cursor-Stelle, falls der Klick auf einen Knopf sie kurz wegnimmt
let messageComposing = false // true, solange die Handy-Tastatur gerade einen Vorschlag bildet

function messageInputEl() {
  return document.getElementById('message-input')
}

// Inhalt als reiner Text: Emoji-Bilder werden wieder zu Emoji-Zeichen, Zeilenumbrüche zu \n
function serializeMessageNode(node) {
  let out = ''
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue
    } else if (child.nodeName === 'BR') {
      out += '\n'
    } else if (child.nodeName === 'IMG') {
      out += child.getAttribute('alt') || ''
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if ((child.nodeName === 'DIV' || child.nodeName === 'P') && out && !out.endsWith('\n')) out += '\n'
      out += serializeMessageNode(child)
    }
  })
  return out
}

function getMessageText() {
  return serializeMessageNode(messageInputEl()).replace(/\u00a0/g, ' ')
}

// Text kürzen, ohne ein Emoji (zwei Zeichen) in der Mitte zu zerschneiden
function clipToLength(text, max) {
  let out = ''
  for (const ch of Array.from(text)) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

function textToNodes(text) {
  const holder = document.createElement('span')
  String(text).split('\n').forEach((line, i) => {
    if (i > 0) holder.appendChild(document.createElement('br'))
    if (line) holder.appendChild(document.createTextNode(line))
  })
  applyEmojiImages(holder) // Emoji im Text -> Bilder
  const frag = document.createDocumentFragment()
  while (holder.firstChild) frag.appendChild(holder.firstChild)
  return frag
}

function placeCaretAtEnd(el) {
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
}

function setMessageText(text) {
  const el = messageInputEl()
  el.textContent = ''
  el.appendChild(textToNodes(text))
  placeCaretAtEnd(el)
  autoResizeMessageInput()
}

function clearMessageInput() {
  messageInputEl().textContent = ''
  savedMessageRange = null
  autoResizeMessageInput()
}

// Text oder Emoji an der Cursor-Stelle einfügen (ersetzt eine markierte Stelle)
function insertIntoMessageInput(text) {
  const el = messageInputEl()
  if (!el || !text) return

  // Die Einfüge-Stelle muss VOR dem focus() bestimmt werden: focus() setzt den Cursor sonst oft an den
  // Textanfang, und das Emoji landete dort (zum Beispiel nach dem Suchen im Emoji-Fenster).
  const sel = window.getSelection()
  let range = null
  if (sel.rangeCount && el.contains(sel.anchorNode)) range = sel.getRangeAt(0).cloneRange()
  else if (savedMessageRange && el.contains(savedMessageRange.startContainer)) range = savedMessageRange.cloneRange()
  if (!range) {
    range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
  }

  el.focus()
  sel.removeAllRanges()
  sel.addRange(range)

  range.deleteContents()
  const room = MESSAGE_MAX_LENGTH - getMessageText().length
  if (room <= 0) return
  const frag = textToNodes(clipToLength(text, room))
  const last = frag.lastChild
  if (!last) return
  range.insertNode(frag)

  range.setStartAfter(last)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  savedMessageRange = range.cloneRange()
  autoResizeMessageInput()
}

// Cursor-Stelle als Zeichenzahl vom Textanfang (Emoji-Bilder zählen mit der Länge ihres Zeichens)
function caretOffsetIn(el) {
  const sel = window.getSelection()
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return null
  const range = sel.getRangeAt(0)
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.endContainer, range.endOffset)
  const holder = document.createElement('div')
  holder.appendChild(pre.cloneContents())
  return serializeMessageNode(holder).length
}

function setCaretOffsetIn(el, offset) {
  let remaining = offset
  let target = null
  const walk = (node) => {
    for (let i = 0; i < node.childNodes.length && !target; i++) {
      const child = node.childNodes[i]
      if (child.nodeType === Node.TEXT_NODE) {
        const len = child.nodeValue.length
        if (remaining <= len) target = [child, remaining]
        else remaining -= len
      } else if (child.nodeName === 'BR') {
        if (remaining === 0) target = [node, i]
        else remaining -= 1
      } else if (child.nodeName === 'IMG') {
        const len = (child.getAttribute('alt') || '').length
        if (remaining === 0) target = [node, i]
        else if (remaining <= len) target = [node, i + 1]
        else remaining -= len
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child)
      }
    }
  }
  walk(el)
  if (!target) target = [el, el.childNodes.length]

  const range = document.createRange()
  range.setStart(target[0], target[1])
  range.collapse(true)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
}

// Emoji, die mit der Tastatur getippt wurden (zum Beispiel über Win+.), werden gleich zu schönen Bildern
function convertTypedEmoji() {
  const el = messageInputEl()
  if (!window.twemoji) return
  let hasEmojiText = false
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    if (window.twemoji.test(walker.currentNode.nodeValue)) { hasEmojiText = true; break }
  }
  if (!hasEmojiText) return

  const offset = caretOffsetIn(el)
  applyEmojiImages(el)
  if (offset !== null) setCaretOffsetIn(el, offset)
}

function onMessageInput() {
  const el = messageInputEl()
  if (!messageComposing) {
    try { convertTypedEmoji() } catch (e) { console.error('Emoji-Umwandlung:', e) }
    const text = getMessageText()
    if (text.length > MESSAGE_MAX_LENGTH) setMessageText(clipToLength(text, MESSAGE_MAX_LENGTH))
    else if (text === '') el.innerHTML = '' // übrig gebliebene Umbrüche entfernen, damit der Platzhalter wieder erscheint
  }
  autoResizeMessageInput()
  notifyTyping()
}

;(function setupMessageInput() {
  const el = messageInputEl()

  el.addEventListener('input', onMessageInput)
  el.addEventListener('scroll', updateMessageScrollbar)
  el.addEventListener('compositionstart', () => { messageComposing = true })
  el.addEventListener('compositionend', () => { messageComposing = false; onMessageInput() })

  // Enter an der Handy-Tastatur sendet (Umschalt+Enter macht eine neue Zeile); Längenbegrenzung
  el.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertParagraph') {
      e.preventDefault()
      sendMessage()
      return
    }
    if (e.inputType.startsWith('insert') && !e.isComposing) {
      const selected = window.getSelection().toString().length
      if (getMessageText().length - selected >= MESSAGE_MAX_LENGTH) e.preventDefault()
    }
  })

  // Einfügen und Ziehen: immer nur reiner Text, nie fremde Formatierung
  el.addEventListener('paste', (e) => {
    e.preventDefault()
    const text = (e.clipboardData || window.clipboardData).getData('text/plain')
    insertIntoMessageInput(String(text).replace(/\r\n?/g, '\n'))
  })
  el.addEventListener('drop', (e) => {
    e.preventDefault()
    const text = e.dataTransfer && e.dataTransfer.getData('text/plain')
    if (text) insertIntoMessageInput(String(text).replace(/\r\n?/g, '\n'))
  })

  // Cursor-Stelle merken, falls ein Klick auf den Emoji-Knopf sie kurz wegnimmt
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection()
    if (sel.rangeCount && el.contains(sel.anchorNode)) savedMessageRange = sel.getRangeAt(0).cloneRange()
  })
})()
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
      refreshPushToggleUI()
      if (!silent) {
        if (permission === 'denied') {
          // Wurde einmal "Blockieren" gedrückt, fragt der Browser nicht mehr nach - das geht nur noch in seinen Einstellungen
          await showInfoDialog('Benachrichtigungen sind in deinem Browser blockiert. So gibst du sie wieder frei: Tippe oben neben der Adresse auf das Schloss- bzw. Info-Symbol → Berechtigungen → Benachrichtigungen → Zulassen. Bei der installierten App: Handy-Einstellungen → Apps → JungscharChat → Benachrichtigungen → Erlauben. Danach hier den Schalter nochmal aus- und einschalten.')
        } else {
          showToast('Ohne Erlaubnis im Browser können keine Benachrichtigungen ankommen.')
        }
      }
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

  // Tippt jemand gerade, steht das an derselben Stelle statt "online"
  const typing = typingText()
  if (typing) {
    text = typing
    clickable = false
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

// ===== "tippt …" oben im Chat =====
// Läuft über einen eigenen Broadcast-Channel pro Chat (nichts wird gespeichert). Wer tippt, sendet höchstens alle
// 2,5 Sekunden ein Zeichen; beim Empfänger verschwindet die Anzeige nach 5 Sekunden ohne neues Zeichen von selbst.
const TYPING_EXPIRE_MS = 5000
const TYPING_SEND_EVERY_MS = 2500

function typingChannelName() {
  if (!currentUser || !currentRoom) return null
  if (currentRoom.type === 'dm') return 'typing:dm:' + [currentUser.id, currentRoom.userId].sort().join(':')
  if (currentRoom.type === 'group') return 'typing:group:' + (currentRoom.groupKey || 'main')
  return null
}

function startTypingChannel() {
  stopTypingChannel()
  const name = typingChannelName()
  if (!name) return
  const channel = supabaseClient.channel(name, { config: { broadcast: { self: false } } })
  channel.on('broadcast', { event: 'typing' }, ({ payload }) => onTypingEvent(payload))
  channel.subscribe((status) => {
    if (channel === typingChannel) typingSubscribed = status === 'SUBSCRIBED'
  })
  typingChannel = channel
}

function stopTypingChannel() {
  Object.values(typingUsers).forEach(timer => clearTimeout(timer))
  typingUsers = {}
  lastTypingSent = 0
  typingSubscribed = false
  if (typingChannel) {
    supabaseClient.removeChannel(typingChannel)
    typingChannel = null
  }
  updateOnlineIndicator()
}

function onTypingEvent(payload) {
  if (!payload || !payload.userId || !currentUser || !currentRoom) return
  const id = payload.userId
  if (id === currentUser.id) return
  const info = profileCache[id]
  if (!info || info.role === 'admin') return
  if (currentRoom.type === 'dm' && id !== currentRoom.userId) return
  if (currentRoom.type === 'group' && currentRoom.groupId) {
    if (!customGroupMemberIds(currentRoom.groupId).includes(id)) return
  } else if (currentRoom.type === 'group' && currentRoom.groupKey && info.gender !== currentRoom.groupKey) return

  if (payload.typing) {
    clearTimeout(typingUsers[id])
    typingUsers[id] = setTimeout(() => clearTyping(id), TYPING_EXPIRE_MS)
    updateOnlineIndicator()
  } else {
    clearTyping(id)
  }
}

function clearTyping(id) {
  if (!(id in typingUsers)) return
  clearTimeout(typingUsers[id])
  delete typingUsers[id]
  updateOnlineIndicator()
}

function sendTyping(isTyping) {
  if (!typingChannel || !typingSubscribed || !currentUser || isAdmin()) return
  typingChannel.send({ type: 'broadcast', event: 'typing', payload: { userId: currentUser.id, typing: isTyping } })
}

// Wird bei jeder Eingabe im Nachrichtenfeld aufgerufen
function notifyTyping() {
  const hasText = !editingMessageId && getMessageText().trim() !== ''
  if (hasText) {
    const now = Date.now()
    if (now - lastTypingSent >= TYPING_SEND_EVERY_MS) {
      lastTypingSent = now
      sendTyping(true)
    }
  } else if (lastTypingSent) {
    lastTypingSent = 0
    sendTyping(false)
  }
}

// Text für den grünen Hinweis oben: "tippt …", "Anna tippt …", "Anna und Ben tippen …", "3 tippen …"
function typingText() {
  if (!currentUser || !currentRoom) return ''
  const ids = Object.keys(typingUsers)
  if (ids.length === 0) return ''
  if (currentRoom.type === 'dm') return 'tippt …'
  const first = id => (((profileCache[id] && profileCache[id].name) || 'Jemand').split(/[\s._-]+/)[0]) || 'Jemand'
  if (ids.length === 1) return first(ids[0]) + ' tippt …'
  if (ids.length === 2) return first(ids[0]) + ' und ' + first(ids[1]) + ' tippen …'
  return ids.length + ' tippen …'
}

// ===== Geburtstage =====
// Wer heute Geburtstag hat (nach dem Geburtsdatum im Profil), bekommt ein 🎂 neben dem Namen (Chatliste, Chat-Kopf,
// Gruppenchat, Mitgliederliste, Profil) und einen goldenen Ring um den Avatar. Beim ersten Öffnen am Tag gibt es
// einmal ein Pop-up mit Konfetti (pro Gerät, gemerkt im LocalStorage).
const BIRTHDAY_EMOJI = '🎂'
const BIRTHDAY_SHOWN_KEY = 'birthdayShownOn'
let birthdayDayRendered = ''

function isBirthdayToday(iso) {
  if (!iso) return false
  const [, m, d] = iso.split('-').map(Number)
  const now = new Date()
  const year = now.getFullYear()
  const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  // Wer am 29. Februar geboren ist, feiert in Jahren ohne Schalttag am 28. Februar
  if (m === 2 && d === 29 && !leapYear) return now.getMonth() === 1 && now.getDate() === 28
  return now.getMonth() + 1 === m && now.getDate() === d
}

function hasBirthdayToday(userId) {
  const info = profileCache[userId]
  return !!info && info.role !== 'admin' && !info.blocked && info.active !== false && isBirthdayToday(info.birthdate)
}

function birthdayMark(userId) {
  return hasBirthdayToday(userId) ? ' ' + BIRTHDAY_EMOJI : ''
}

function birthdayTurningAge(userId) {
  const info = profileCache[userId]
  if (!info || !info.birthdate) return 0
  return new Date().getFullYear() - Number(info.birthdate.slice(0, 4))
}

function birthdayPeopleToday() {
  const nameOf = id => (profileCache[id] && profileCache[id].name) || ''
  return Object.keys(profileCache).filter(hasBirthdayToday).sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'de', { sensitivity: 'base' }))
}

function launchConfetti(container) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const colors = ['#ffc83d', '#ff6b6b', '#4ea3e0', '#6bd68a', '#c77dff', '#ff9f43']
  const pieces = []
  for (let i = 0; i < 46; i++) {
    const piece = document.createElement('span')
    piece.className = 'confetti-piece'
    piece.style.left = Math.random() * 100 + '%'
    piece.style.background = colors[i % colors.length]
    piece.style.animationDuration = 2.2 + Math.random() * 2 + 's'
    piece.style.animationDelay = Math.random() * 0.8 + 's'
    piece.style.setProperty('--drift', (Math.random() * 120 - 60) + 'px')
    container.appendChild(piece)
    pieces.push(piece)
  }
  setTimeout(() => pieces.forEach(p => p.remove()), 5500)
}

function showBirthdayAnnouncement() {
  if (!currentUser || !currentProfile) return
  if (document.getElementById('birthdate-modal').style.display === 'flex') return // erst das Pflicht-Fenster
  if (document.getElementById('birthday-modal').style.display === 'flex') return
  const today = toISODate(new Date())
  if (localStorage.getItem(BIRTHDAY_SHOWN_KEY) === today) return
  const ids = birthdayPeopleToday()
  if (ids.length === 0) return
  localStorage.setItem(BIRTHDAY_SHOWN_KEY, today)

  const nameOf = id => (profileCache[id] && profileCache[id].name) || 'Ohne Namen'
  const mine = ids.includes(currentUser.id)
  const others = ids.filter(id => id !== currentUser.id)

  const body = document.getElementById('birthday-body')
  body.innerHTML = ''
  const add = (tag, className, text) => {
    const el = document.createElement(tag)
    el.className = className
    el.textContent = text
    body.appendChild(el)
    return el
  }
  const addList = (people) => {
    const list = document.createElement('ul')
    list.className = 'birthday-list'
    people.forEach(id => {
      const li = document.createElement('li')
      li.textContent = BIRTHDAY_EMOJI + ' ' + nameOf(id) + ' wird ' + birthdayTurningAge(id)
      list.appendChild(li)
    })
    body.appendChild(list)
  }

  add('div', 'birthday-emoji', mine ? '🎉' : BIRTHDAY_EMOJI)
  if (mine) {
    add('p', 'birthday-title', 'Alles Gute zum Geburtstag, ' + nameOf(currentUser.id).split(/\s+/)[0] + '!')
    add('p', 'birthday-sub', 'Du wirst heute ' + birthdayTurningAge(currentUser.id) + ' Jahre alt. 🎈')
    if (others.length > 0) {
      add('p', 'birthday-sub', 'Außerdem hat heute Geburtstag:')
      addList(others)
    }
  } else if (others.length === 1) {
    add('p', 'birthday-title', '🎉 Heute hat ' + nameOf(others[0]) + ' Geburtstag!')
    add('p', 'birthday-sub', 'Wird heute ' + birthdayTurningAge(others[0]) + ' Jahre alt.')
  } else {
    add('p', 'birthday-title', '🎉 Heute haben ' + others.length + ' Geburtstag!')
    addList(others)
  }

  const modal = document.getElementById('birthday-modal')
  modal.style.display = 'flex'
  launchConfetti(modal)
}

function closeBirthdayModal() {
  document.getElementById('birthday-modal').style.display = 'none'
}

// Wird die App nach Mitternacht aus dem Hintergrund geholt: Markierungen neu setzen und Pop-up zeigen
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !currentUser || !currentProfile) return
  if (birthdayDayRendered && birthdayDayRendered !== toISODate(new Date())) renderChatList()
  showBirthdayAnnouncement()
})

// ===== Eigene Gruppen =====
// Jedes Mitglied darf Gruppen erstellen (der Admin kann es einzelnen Personen abschalten, siehe "Darf Gruppen erstellen").
// Eine Gruppe steht in chat_groups, ihre Mitglieder in chat_group_members. Nachrichten liegen wie bei Jungs/Mädels in
// "messages", mit group_key = "grp_<Gruppen-ID>". Erstellen, Ändern und Löschen laufen über Datenbankfunktionen
// (create_chat_group, update_chat_group, delete_chat_group, leave_chat_group), die die Rechte auf dem Server prüfen.
let chatGroups = {}              // Gruppen-ID -> { id, name, created_by, created_at, members: [Nutzer-IDs] }
let chatGroupsAvailable = false  // false, solange die Tabellen in der Datenbank noch fehlen
let chatGroupsDirty = true
let chatGroupsLoadedAt = 0
let groupCreateBlockedIds = new Set()
let groupChannel = null
let groupEditorId = null         // null = neue Gruppe, sonst die Gruppe, die gerade bearbeitet wird
let groupPicked = new Set()
let groupSaving = false

function customGroupKey(id) {
  return 'grp_' + id
}

async function loadChatGroups(force) {
  if (!currentUser) return
  if (!force && !chatGroupsDirty && Date.now() - chatGroupsLoadedAt < 60000) return

  const [groupsRes, membersRes] = await Promise.all([
    supabaseClient.from('chat_groups').select('id, name, created_by, created_at'),
    supabaseClient.from('chat_group_members').select('group_id, user_id')
  ])
  if (!currentUser) return
  if (groupsRes.error || membersRes.error) {
    // Tabellen gibt es noch nicht (SQL noch nicht ausgeführt): dann einfach keine eigenen Gruppen anzeigen
    chatGroups = {}
    chatGroupsAvailable = false
    chatGroupsDirty = false // nicht bei jedem Neuzeichnen erneut fragen, sondern erst in einer Minute wieder
    chatGroupsLoadedAt = Date.now()
    return
  }

  const next = {}
  ;(groupsRes.data || []).forEach(g => { next[g.id] = { ...g, members: [] } })
  ;(membersRes.data || []).forEach(m => { if (next[m.group_id]) next[m.group_id].members.push(m.user_id) })
  chatGroups = next
  chatGroupsAvailable = true
  chatGroupsDirty = false
  chatGroupsLoadedAt = Date.now()
  listenForGroupUpdates()

  // Die gerade offene Gruppe gibt es nicht mehr (gelöscht oder man wurde entfernt)
  if (currentRoom && currentRoom.groupId && !chatGroups[currentRoom.groupId]) {
    showToast('Diese Gruppe gibt es nicht mehr oder du bist nicht mehr dabei.')
    if (desktopQuery.matches) openGroupChat() // am PC rechts stattdessen die Hauptgruppe zeigen
    else showList()
  }
}

function listenForGroupUpdates() {
  if (groupChannel || !chatGroupsAvailable) return
  const changed = () => {
    chatGroupsDirty = true
    scheduleListRefresh()
  }
  groupChannel = supabaseClient
    .channel('group-updates')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_group_members' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_groups' }, changed)
    .subscribe()
}

function stopGroupListening() {
  if (groupChannel) {
    supabaseClient.removeChannel(groupChannel)
    groupChannel = null
  }
}

// Beim Abmelden alles Gruppen-Zeug vergessen
function resetGroupState() {
  stopGroupListening()
  chatGroups = {}
  chatGroupsAvailable = false
  chatGroupsDirty = true
  groupCreateBlockedIds = new Set()
  mutedChatKeys = new Set()
  mutedChatsLoadedAt = 0
  closeChatMenu()
  closeGroupModal()
}

async function loadGroupBlockedIds() {
  const { data, error } = await supabaseClient.from('group_create_blocked_users').select('user_id')
  if (error) return // Tabelle fehlt noch
  groupCreateBlockedIds = new Set((data || []).map(r => r.user_id))
}

function canCreateGroups() {
  return chatGroupsAvailable && !!currentUser && (isAdmin() || !groupCreateBlockedIds.has(currentUser.id))
}

// Der Eintrag "Neue Gruppe erstellen" sitzt in den Einstellungen und ist nur sichtbar, wenn man Gruppen erstellen darf
function updateNewGroupButton() {
  const section = document.getElementById('group-settings-group')
  if (section) section.style.display = canCreateGroups() ? '' : 'none'
}

// Aus den Einstellungen: erst zurück zur Chatliste, dann das gewohnte Pop-up
function openGroupCreatorFromSettings() {
  if (!canCreateGroups()) return
  openGroupCreator()
}

function customGroupMemberIds(groupId) {
  const group = chatGroups[groupId]
  if (!group) return []
  return group.members.filter(id => {
    const info = profileCache[id]
    return info && info.role !== 'admin' && !info.blocked && info.active !== false
  })
}

function openCustomGroup(groupId) {
  const group = chatGroups[groupId]
  if (!group) return
  switchRoom({ type: 'group', groupKey: customGroupKey(groupId), groupId: groupId })
  openConversation(group.name)
}

// Gruppen für die Chatliste: neueste Aktivität zuerst (die frisch erstellte steht also ganz oben, unter der Hauptgruppe)
function customGroupsForList() {
  const activity = g => {
    const preview = groupPreviews[customGroupKey(g.id)]
    return new Date(preview ? preview.created_at : g.created_at).getTime()
  }
  return Object.values(chatGroups).sort((a, b) => activity(b) - activity(a))
}

function appendCustomGroupItems(list) {
  customGroupsForList().forEach(group => {
    const key = customGroupKey(group.id)
    const item = document.createElement('li')
    item.className = 'chat-list-item pinned' + (isChatMuted(key) ? ' muted' : '')
    item.innerHTML = chatListItemHTML(
      '<div class="chat-list-avatar group-avatar">👥</div>',
      group.name,
      groupPreviews[key],
      unreadFor(key),
      isChatMuted(key)
    )
    item.dataset.chatKey = key
    item.dataset.tabs = 'alle gruppen'
    item.dataset.name = group.name
    item.addEventListener('click', () => openCustomGroup(group.id))
    list.appendChild(item)
  })
}

// ----- Pop-up: Gruppe erstellen / bearbeiten -----
function groupPickCandidates() {
  return Object.entries(profileCache)
    .filter(([id, info]) => id !== currentUser.id && info.role !== 'admin' && !info.blocked && info.active !== false)
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || '', 'de', { sensitivity: 'base' }))
    .map(([id]) => id)
}

function openGroupCreator() {
  if (!canCreateGroups()) return
  groupEditorId = null
  groupPicked = new Set()
  showGroupModal('Neue Gruppe', '')
}

function openGroupEditor() {
  const group = currentRoom && currentRoom.groupId ? chatGroups[currentRoom.groupId] : null
  if (!group) return
  groupEditorId = group.id
  groupPicked = new Set(group.members.filter(id => profileCache[id] && profileCache[id].role !== 'admin' && id !== currentUser.id))
  showGroupModal('Gruppe bearbeiten', group.name)
}

function showGroupModal(title, name) {
  document.getElementById('group-modal-title').textContent = title
  document.getElementById('group-name-input').value = name
  document.getElementById('group-save-btn').textContent = groupEditorId ? 'Speichern' : 'Erstellen'
  document.getElementById('group-delete-btn').style.display = groupEditorId ? '' : 'none'
  renderGroupPicker()
  document.getElementById('group-modal').style.display = 'flex'
  if (desktopQuery.matches) document.getElementById('group-name-input').focus()
}

function closeGroupModal() {
  document.getElementById('group-modal').style.display = 'none'
}

function renderGroupPicker() {
  const list = document.getElementById('group-members-pick')
  list.innerHTML = ''
  // Aufgeteilt in Jungs und Mädchen (wer noch kein Geschlecht hat, steht unten ohne Überschrift)
  const candidates = groupPickCandidates()
  const sections = [
    ['Jungs', candidates.filter(id => profileCache[id].gender === 'junge')],
    ['Mädchen', candidates.filter(id => profileCache[id].gender === 'maedchen')],
    ['', candidates.filter(id => profileCache[id].gender !== 'junge' && profileCache[id].gender !== 'maedchen')]
  ]
  sections.forEach(([title, ids]) => {
    if (ids.length === 0) return
    if (title) {
      const head = document.createElement('li')
      head.className = 'group-pick-title'
      head.textContent = title
      list.appendChild(head)
    }
    ids.forEach(id => addGroupPickItem(list, id))
  })
  updateGroupModalButton()
}

function addGroupPickItem(list, id) {
  const info = profileCache[id]
  const li = document.createElement('li')
  li.className = 'group-pick-item' + (groupPicked.has(id) ? ' on' : '')
  li.setAttribute('role', 'checkbox')
  li.setAttribute('aria-checked', groupPicked.has(id) ? 'true' : 'false')

  const check = document.createElement('span')
  check.className = 'group-pick-check'
  check.textContent = '✓'

  const avatar = document.createElement('div')
  avatar.className = 'reaction-avatar'
  avatar.style.background = avatarColor(id)
  avatar.textContent = initialsOf(info.name || '')

  const name = document.createElement('span')
  name.className = 'reactions-item-name'
  name.textContent = info.name || 'Ohne Namen'

  li.append(check, avatar, name)
  li.addEventListener('click', () => {
    if (groupPicked.has(id)) groupPicked.delete(id)
    else groupPicked.add(id)
    li.classList.toggle('on', groupPicked.has(id))
    li.setAttribute('aria-checked', groupPicked.has(id) ? 'true' : 'false')
    updateGroupModalButton()
  })
  list.appendChild(li)
}

// "Erstellen" ist ausgegraut, bis ein Name und mindestens eine Person gewählt sind
function updateGroupModalButton() {
  const name = document.getElementById('group-name-input').value.trim()
  document.getElementById('group-members-count').textContent = groupPicked.size + ' ausgewählt'
  document.getElementById('group-save-btn').disabled = groupSaving || name.length < 1 || groupPicked.size < 1
}

async function saveGroup() {
  if (groupSaving) return
  const name = document.getElementById('group-name-input').value.trim()
  if (!name || groupPicked.size < 1) return
  groupSaving = true
  updateGroupModalButton()

  const memberIds = [...groupPicked]
  const { data, error } = groupEditorId
    ? await supabaseClient.rpc('update_chat_group', { p_group_id: groupEditorId, p_name: name, p_member_ids: memberIds })
    : await supabaseClient.rpc('create_chat_group', { p_name: name, p_member_ids: memberIds })
  groupSaving = false

  if (error) {
    updateGroupModalButton()
    showToast(error.message || 'Das hat nicht geklappt.')
    return
  }

  const editedId = groupEditorId
  closeGroupModal()
  await loadChatGroups(true)
  if (editedId && currentRoom && currentRoom.groupId === editedId && chatGroups[editedId]) {
    document.getElementById('conversation-title').textContent = chatGroups[editedId].name
    if (isMembersModalOpen()) renderMembersList()
  }
  if (!editedId && !isListVisible() && document.getElementById('settings-bereich').style.display !== 'none') showList()
  else renderChatList()
  showToast(editedId ? 'Gruppe gespeichert.' : 'Gruppe erstellt.', 'success')
}

// Fragt nach und löscht die Gruppe auf dem Server (die Rechte prüft die Datenbankfunktion). true = gelöscht
async function confirmAndDeleteGroup(group) {
  const ok = await askConfirm('Die Gruppe "' + group.name + '" mit allen Nachrichten löschen? Das kann nicht rückgängig gemacht werden.', { okText: 'Gruppe löschen', danger: true })
  if (!ok) return false

  const { error } = await supabaseClient.rpc('delete_chat_group', { p_group_id: group.id })
  if (error) {
    showToast(error.message || 'Löschen hat nicht geklappt.')
    return false
  }
  return true
}

async function deleteGroup() {
  const group = chatGroups[groupEditorId]
  if (!group) return
  if (!(await confirmAndDeleteGroup(group))) return
  closeGroupModal()
  closeMembersModal()
  await loadChatGroups(true) // zeigt bei offener Gruppe den Hinweis und geht zurück zur Liste
  renderChatList()
  showToast('Gruppe gelöscht.', 'success')
}

// Aus dem Kontextmenü der Chatliste
async function deleteGroupFromList(groupId) {
  const group = chatGroups[groupId]
  if (!group) return
  if (!(await confirmAndDeleteGroup(group))) return
  await loadChatGroups(true)
  renderChatList()
  showToast('Gruppe gelöscht.', 'success')
}

async function leaveCurrentGroup() {
  const group = currentRoom && currentRoom.groupId ? chatGroups[currentRoom.groupId] : null
  if (!group) return
  const ok = await askConfirm('Die Gruppe "' + group.name + '" verlassen? Du siehst die Nachrichten dann nicht mehr.', { okText: 'Verlassen', danger: true })
  if (!ok) return

  const { error } = await supabaseClient.rpc('leave_chat_group', { p_group_id: group.id })
  if (error) {
    showToast(error.message || 'Das hat nicht geklappt.')
    return
  }
  closeMembersModal()
  await loadChatGroups(true)
  renderChatList()
  showToast('Du hast die Gruppe verlassen.', 'success')
}

// Knöpfe in der Mitgliederliste: bearbeiten (Ersteller und Admin) bzw. verlassen (alle anderen Mitglieder)
function updateMembersModalButtons() {
  const group = currentRoom && currentRoom.groupId ? chatGroups[currentRoom.groupId] : null
  const mine = !!group && !!currentUser && group.created_by === currentUser.id
  document.getElementById('members-edit-btn').style.display = group && (isAdmin() || mine) ? '' : 'none'
  document.getElementById('members-leave-btn').style.display = group && !isAdmin() && !mine ? '' : 'none'
}

// ===== Nachrichten melden =====
// Mitglieder melden eine Nachricht über das Menü der Nachricht. Der Server speichert dabei einen Auszug
// (Funktion report_message). Der Admin sieht die offenen Meldungen unter Einstellungen > Verwaltung > Meldungen.
async function reportMessage(msg) {
  if (!currentUser || isAdmin()) return
  const ok = await askConfirm('Diese Nachricht dem Admin melden?', { okText: 'Melden', danger: true })
  if (!ok) return
  const { error } = await supabaseClient.rpc('report_message', { p_table: currentTable(), p_message_id: String(msg.id) })
  if (error) {
    showToast('Melden hat nicht geklappt: ' + error.message)
    return
  }
  showToast('Danke, die Nachricht wurde dem Admin gemeldet.', 'success')
}

let openReports = []

async function loadOpenReports() {
  const { data, error } = await supabaseClient
    .from('message_reports')
    .select('*')
    .eq('resolved', false)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) {
    openReports = []
    return false
  }
  openReports = data || []
  return true
}

async function updateReportsBadge() {
  const badge = document.getElementById('reports-badge')
  if (!badge || !isAdmin()) return
  await loadOpenReports()
  badge.textContent = String(openReports.length)
  badge.style.display = openReports.length > 0 ? '' : 'none'
}

function reportChatLabel(report) {
  const key = report.chat_key
  if (report.message_table === 'direct_messages') {
    const other = profileCache[report.recipient_id]
    return 'Einzelchat' + (other && other.name ? ' mit ' + other.name : '')
  }
  if (!key) return 'Hauptgruppe'
  if (key === 'junge') return 'Jungs'
  if (key === 'maedchen') return 'Mädels'
  if (key.startsWith('grp_')) {
    const group = chatGroups[key.slice(4)]
    return group ? group.name : 'Eigene Gruppe'
  }
  return key
}

function reportContentText(report) {
  const parts = []
  if (report.message_text) parts.push(report.message_text)
  if (report.has_photo) parts.push('[Foto]')
  if (report.has_audio) parts.push('[Audio]')
  return parts.join(' ') || '(ohne Text)'
}

async function openReportsModal() {
  if (!isAdmin()) return
  const overlay = document.createElement('div')
  overlay.className = 'confirm-overlay'
  const dialog = document.createElement('div')
  dialog.className = 'confirm-dialog reports-dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); updateReportsBadge() }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })

  const render = () => {
    dialog.innerHTML = ''
    const heading = document.createElement('p')
    heading.className = 'audio-name-heading'
    heading.textContent = openReports.length === 0 ? 'Keine offenen Meldungen' : 'Meldungen (' + openReports.length + ')'
    dialog.appendChild(heading)

    const list = document.createElement('div')
    list.className = 'reports-list'
    openReports.forEach(report => {
      const item = document.createElement('div')
      item.className = 'report-item'

      const sender = profileCache[report.sender_id]
      const reporter = profileCache[report.reporter_id]
      const head = document.createElement('div')
      head.className = 'report-head'
      head.textContent = (sender && sender.name ? sender.name : 'Unbekannt') + ' · ' + reportChatLabel(report)
      const text = document.createElement('div')
      text.className = 'report-text'
      text.textContent = reportContentText(report)
      const meta = document.createElement('div')
      meta.className = 'report-meta'
      meta.textContent = 'Gemeldet von ' + (reporter && reporter.name ? reporter.name : 'Unbekannt') + ', ' + formatTime(report.created_at)

      const actions = document.createElement('div')
      actions.className = 'report-actions'
      const doneBtn = document.createElement('button')
      doneBtn.type = 'button'
      doneBtn.className = 'confirm-cancel'
      doneBtn.textContent = 'Erledigt'
      doneBtn.addEventListener('click', () => resolveReport(report, false))
      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.className = 'confirm-ok danger'
      deleteBtn.textContent = 'Nachricht löschen'
      deleteBtn.addEventListener('click', () => resolveReport(report, true))
      actions.append(doneBtn, deleteBtn)

      item.append(head, text, meta, actions)
      list.appendChild(item)
    })
    dialog.appendChild(list)

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'confirm-cancel'
    closeBtn.textContent = 'Schließen'
    closeBtn.addEventListener('click', close)
    dialog.appendChild(closeBtn)
  }

  const resolveReport = async (report, deleteMessage) => {
    if (deleteMessage) {
      const sure = await askConfirm('Die gemeldete Nachricht für alle löschen?', { okText: 'Löschen', danger: true })
      if (!sure) return
      const { error } = await supabaseClient.from(report.message_table).delete().eq('id', report.message_id)
      if (error) { showToast('Löschen hat nicht geklappt: ' + error.message); return }
    }
    // Alle Meldungen zu derselben Nachricht gleich mit erledigen
    const { error } = await supabaseClient
      .from('message_reports')
      .update({ resolved: true })
      .eq('message_table', report.message_table)
      .eq('message_id', report.message_id)
    if (error) { showToast('Speichern hat nicht geklappt: ' + error.message); return }
    openReports = openReports.filter(r => !(r.message_table === report.message_table && r.message_id === report.message_id))
    render()
    renderChatList()
  }

  const loaded = await loadOpenReports()
  if (!loaded) {
    dialog.innerHTML = ''
    const info = document.createElement('p')
    info.textContent = 'Die Meldungen konnten nicht geladen werden (ist das SQL schon ausgeführt?).'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'confirm-cancel'
    closeBtn.textContent = 'Schließen'
    closeBtn.addEventListener('click', close)
    dialog.append(info, closeBtn)
    return
  }
  render()
}

// ===== Suche im Chat =====
// Durchsucht die geladenen Nachrichten des geöffneten Chats (Text und Audio-Titel), ohne Groß-/Kleinschreibung und
// Umlaut-Unterschiede. Treffer werden markiert, mit den Pfeilen springt man von Treffer zu Treffer (zuerst der neueste).
let chatSearchMatches = []
let chatSearchIndex = -1
let chatSearchTimer = null

function normalizeSearchText(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

// Text einer Nachricht ohne die Uhrzeit-Zeile
function searchableTextOf(row) {
  const parts = []
  const textEl = row.querySelector('.msg-text')
  if (textEl) {
    textEl.childNodes.forEach(node => {
      if (node.nodeType === 1 && node.classList.contains('msg-footer')) return
      parts.push(node.nodeType === 1 && node.tagName === 'IMG' ? node.alt || '' : node.textContent)
    })
  }
  const audioTitle = row.querySelector('.msg-audio-title')
  if (audioTitle) parts.push(audioTitle.textContent)
  return parts.join(' ')
}

function findChatSearchMatches(query) {
  const needle = normalizeSearchText(query).trim()
  if (!needle) return []
  return Array.from(document.querySelectorAll('#chat-box .msg-row')).filter(row => normalizeSearchText(searchableTextOf(row)).includes(needle))
}

function clearChatSearchMarks() {
  document.querySelectorAll('#chat-box .search-hit, #chat-box .search-current').forEach(el => el.classList.remove('search-hit', 'search-current'))
}

function showChatSearchResult() {
  const countEl = document.getElementById('chat-search-count')
  const query = document.getElementById('chat-search-input').value.trim()
  clearChatSearchMarks()
  chatSearchMatches.forEach(row => row.classList.add('search-hit'))

  if (chatSearchMatches.length === 0) {
    countEl.textContent = query ? 'Kein Treffer' : ''
    return
  }
  const current = chatSearchMatches[chatSearchIndex]
  current.classList.add('search-current')
  current.scrollIntoView({ block: 'center' })
  countEl.textContent = (chatSearchIndex + 1) + ' / ' + chatSearchMatches.length
}

function runChatSearch() {
  const query = document.getElementById('chat-search-input').value
  chatSearchMatches = findChatSearchMatches(query)
  chatSearchIndex = chatSearchMatches.length - 1 // neuester Treffer zuerst
  showChatSearchResult()
}

function onChatSearchInput() {
  clearTimeout(chatSearchTimer)
  chatSearchTimer = setTimeout(runChatSearch, 150)
}

// Richtung -1 = ältere Nachricht, +1 = neuere
function stepChatSearch(direction) {
  if (chatSearchMatches.length === 0) return
  chatSearchIndex = (chatSearchIndex + direction + chatSearchMatches.length) % chatSearchMatches.length
  showChatSearchResult()
}

function onChatSearchKey(event) {
  if (event.key === 'Escape') {
    toggleChatSearch()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (document.getElementById('chat-search-input').value.trim() && chatSearchMatches.length === 0) runChatSearch()
    stepChatSearch(event.shiftKey ? 1 : -1)
  }
}

function closeChatSearch() {
  clearTimeout(chatSearchTimer)
  const bar = document.getElementById('chat-search-bar')
  if (!bar) return
  bar.style.display = 'none'
  document.getElementById('chat-search-input').value = ''
  document.getElementById('chat-search-count').textContent = ''
  chatSearchMatches = []
  chatSearchIndex = -1
  clearChatSearchMarks()
}

function toggleChatSearch() {
  const bar = document.getElementById('chat-search-bar')
  if (bar.style.display === 'none') {
    bar.style.display = ''
    document.getElementById('chat-search-input').focus()
  } else {
    closeChatSearch()
  }
}

// ===== Knopf "nach unten" =====
// Erscheint, sobald man im Chat ein Stück nach oben gescrollt hat. Kommen währenddessen neue Nachrichten, steht deren
// Anzahl am Knopf. Er hängt per "fixed" über dem Chatfenster und wird bei jedem Scrollen oder Drehen neu platziert.
let suppressMissedCount = false
let missedWhileScrolledUp = 0
let scrollDownBtn = null
let scrollDownBadge = null

function noteMissedMessage() {
  missedWhileScrolledUp++
  updateScrollDownButton()
}

function resetMissedCount() {
  missedWhileScrolledUp = 0
  updateScrollDownButton()
}

function updateScrollDownButton() {
  if (!scrollDownBtn) return
  const chatBox = document.getElementById('chat-box')
  const rect = chatBox.getBoundingClientRect()
  const distance = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight
  const visible = rect.height > 0 && distance > 240

  if (distance < 80) missedWhileScrolledUp = 0 // wieder unten angekommen
  scrollDownBtn.classList.toggle('visible', visible)
  if (!visible) return

  scrollDownBtn.style.right = Math.max(8, window.innerWidth - rect.right + 12) + 'px'
  scrollDownBtn.style.bottom = Math.max(8, window.innerHeight - rect.bottom + 12) + 'px'
  scrollDownBadge.textContent = missedWhileScrolledUp > 99 ? '99+' : String(missedWhileScrolledUp)
  scrollDownBadge.style.display = missedWhileScrolledUp > 0 ? '' : 'none'
}

function initScrollDownButton() {
  const chatBox = document.getElementById('chat-box')
  scrollDownBtn = document.createElement('button')
  scrollDownBtn.type = 'button'
  scrollDownBtn.className = 'scroll-down-btn'
  scrollDownBtn.setAttribute('aria-label', 'Nach unten zu den neuesten Nachrichten')
  scrollDownBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg><span class="scroll-down-badge" style="display: none;"></span>'
  scrollDownBadge = scrollDownBtn.querySelector('.scroll-down-badge')
  document.body.appendChild(scrollDownBtn)

  scrollDownBtn.addEventListener('click', () => {
    chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: 'smooth' })
  })
  chatBox.addEventListener('scroll', updateScrollDownButton, { passive: true })
  window.addEventListener('resize', updateScrollDownButton)
  // Wird das Chatfenster ausgeblendet (zurück zur Liste), verschwindet auch der Knopf
  if (window.IntersectionObserver) new IntersectionObserver(updateScrollDownButton).observe(chatBox)
}

initScrollDownButton()

// ===== Stummschalten und Kontextmenü der Chatliste =====
// Stummgeschaltet werden können die Hauptgruppe, Jungs, Mädels und eigene Gruppen (Tabelle muted_chats, jede Person sieht
// und ändert nur ihre eigenen Zeilen). Der Server (send-push) schickt dann keine Push-Meldung mehr; hier im Browser
// bleiben Ton und Zahl auf dem App-Symbol aus. Der Admin bekommt ohnehin nie Ton oder Push und hat den Eintrag nicht.
let mutedChatKeys = new Set()
let mutedChatsLoadedAt = 0

const DM_KEY_PATTERN = /^dm:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isMutableChatKey(key) {
  return key === 'main' || key === 'junge' || key === 'maedchen' || (typeof key === 'string' && (key.startsWith('grp_') || DM_KEY_PATTERN.test(key)))
}

function isChatMuted(key) {
  return !!key && mutedChatKeys.has(key)
}

async function loadMutedChats(force) {
  if (!currentUser || isAdmin()) {
    mutedChatKeys = new Set()
    return
  }
  if (!force && Date.now() - mutedChatsLoadedAt < 30000) return
  const { data, error } = await supabaseClient.from('muted_chats').select('chat_key').eq('user_id', currentUser.id)
  if (!currentUser) return
  mutedChatsLoadedAt = Date.now()
  if (error) return // Tabelle gibt es noch nicht (SQL noch nicht ausgeführt): dann ist nichts stummgeschaltet
  mutedChatKeys = new Set((data || []).map(r => r.chat_key))
}

async function toggleChatMute(key) {
  if (!currentUser || isAdmin() || !isMutableChatKey(key)) return
  const muteNow = !mutedChatKeys.has(key)
  const { error } = muteNow
    ? await supabaseClient.from('muted_chats').insert({ user_id: currentUser.id, chat_key: key })
    : await supabaseClient.from('muted_chats').delete().eq('user_id', currentUser.id).eq('chat_key', key)

  if (error && !(muteNow && error.code === '23505')) { // 23505: war schon stummgeschaltet (anderes Gerät) - dann passt es ja
    showToast('Das hat nicht geklappt: ' + error.message)
    return
  }
  if (muteNow) mutedChatKeys.add(key)
  else mutedChatKeys.delete(key)
  mutedChatsLoadedAt = Date.now()
  renderChatList()
  showToast(muteNow ? (key.startsWith('dm:') ? 'Chat stummgeschaltet.' : 'Gruppe stummgeschaltet.') : 'Stummschaltung aufgehoben.', 'success')
}

// Welche Einträge das Menü für diesen Chat hat (leer = gar kein Menü)
function chatMenuItemsFor(key) {
  const items = []
  if (!currentUser || !isMutableChatKey(key)) return items
  if (!isAdmin()) {
    items.push({
      label: isChatMuted(key) ? 'Stummschaltung aufheben' : (key.startsWith('dm:') ? 'Chat stummschalten' : 'Gruppe stummschalten'),
      run: () => toggleChatMute(key)
    })
  }
  if (key.startsWith('grp_')) {
    const groupId = key.slice(4)
    const group = chatGroups[groupId]
    if (group && (isAdmin() || group.created_by === currentUser.id)) {
      items.push({ label: 'Gruppe löschen', danger: true, run: () => deleteGroupFromList(groupId) })
    }
  }
  return items
}

let chatMenuEl = null
let chatMenuLi = null
let chatMenuOpenedAt = 0
let suppressChatClickUntil = 0

function closeChatMenu() {
  if (chatMenuEl) chatMenuEl.remove()
  if (chatMenuLi) chatMenuLi.classList.remove('menu-open')
  chatMenuEl = null
  chatMenuLi = null
}

function openChatMenu(li, x, y) {
  const key = li.dataset.chatKey
  const items = chatMenuItemsFor(key)
  if (items.length === 0) return false
  closeChatMenu()

  const menu = document.createElement('div')
  menu.className = 'msg-menu chat-menu'
  menu.setAttribute('role', 'menu')
  items.forEach(item => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'msg-menu-item' + (item.danger ? ' danger' : '')
    btn.setAttribute('role', 'menuitem')
    btn.textContent = item.label
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      if (Date.now() - chatMenuOpenedAt < 350) return // der Finger vom langen Drücken soll nichts auslösen
      closeChatMenu()
      item.run()
    })
    menu.appendChild(btn)
  })
  document.body.appendChild(menu)

  const margin = 8
  const size = menu.getBoundingClientRect()
  const left = Math.min(Math.max(x, margin), window.innerWidth - size.width - margin)
  const top = Math.min(Math.max(y, margin), window.innerHeight - size.height - margin)
  menu.style.left = left + 'px'
  menu.style.top = top + 'px'

  li.classList.add('menu-open')
  chatMenuEl = menu
  chatMenuLi = li
  chatMenuOpenedAt = Date.now()
  return true
}

function initChatListMenu() {
  const list = document.getElementById('chat-list')
  const LONG_PRESS_MS = 450
  let timer = null
  let pressLi = null
  let startX = 0
  let startY = 0
  let fired = false

  const cancelPress = () => {
    clearTimeout(timer)
    timer = null
    pressLi = null
  }
  const itemOf = (event) => event.target.closest ? event.target.closest('.chat-list-item') : null

  // Rechtsklick am PC (und die Menütaste der Tastatur)
  list.addEventListener('contextmenu', (event) => {
    const li = itemOf(event)
    if (!li) return
    if (chatMenuEl && chatMenuLi === li && Date.now() - chatMenuOpenedAt < 1000) { // Handy: kam gerade schon per langem Drücken
      event.preventDefault()
      return
    }
    cancelPress()
    const x = event.clientX || li.getBoundingClientRect().left + 24
    const y = event.clientY || li.getBoundingClientRect().top + 24
    if (openChatMenu(li, x, y)) event.preventDefault() // ohne Menü-Einträge bleibt das normale Browser-Menü
  })

  // Langes Gedrückthalten am Handy
  list.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return
    const li = itemOf(event)
    if (!li || chatMenuItemsFor(li.dataset.chatKey).length === 0) return
    cancelPress()
    pressLi = li
    startX = event.clientX
    startY = event.clientY
    fired = false
    timer = setTimeout(() => {
      timer = null
      if (!pressLi) return
      if (openChatMenu(pressLi, startX, startY + 12)) {
        fired = true
        if (navigator.vibrate) navigator.vibrate(15)
      }
    }, LONG_PRESS_MS)
  })
  list.addEventListener('pointermove', (event) => {
    if (timer && Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancelPress()
  })
  ;['pointerup', 'pointercancel'].forEach(name => list.addEventListener(name, () => {
    cancelPress()
    if (fired) {
      fired = false
      suppressChatClickUntil = Date.now() + 500 // das Loslassen nach dem langen Drücken soll den Chat nicht öffnen
    }
  }))

  // Klick abfangen, bevor ihn der Listeneintrag bekommt
  list.addEventListener('click', (event) => {
    if (Date.now() < suppressChatClickUntil) {
      event.stopPropagation()
      event.preventDefault()
    }
  }, true)

  // Menü schließen: Klick/Tipp daneben (der Klick selbst wird verschluckt), Scrollen, Escape, Fenster verlassen
  document.addEventListener('pointerdown', (event) => {
    if (!chatMenuEl || chatMenuEl.contains(event.target)) return
    closeChatMenu()
    suppressChatClickUntil = Date.now() + 400
  }, true)
  document.addEventListener('scroll', () => { if (chatMenuEl && Date.now() - chatMenuOpenedAt > 400) closeChatMenu() }, true)
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeChatMenu() })
  window.addEventListener('resize', closeChatMenu)
  window.addEventListener('blur', closeChatMenu)
}

initChatListMenu()

// ===== Scroll-Balken: nur beim Scrollen sichtbar, danach weich ausgeblendet =====
// Scroll-Ereignisse bubblen nicht, deshalb hört ein Listener in der Capture-Phase mit. Das scrollende Element bekommt
// --sb-alpha = 1 (das CSS zeichnet den Balken damit). Nach einer kurzen Pause wird der Wert in einer Animation auf 0
// heruntergeblendet, weil Browser Scrollbalken nicht selbst überblenden können.
const SCROLLBAR_HOLD_MS = 600  // so lange bleibt der Balken nach dem letzten Scrollen voll sichtbar
const SCROLLBAR_FADE_MS = 900  // so lange dauert das Ausblenden
const scrollbarFades = new WeakMap()

function startScrollbarFade(target, state) {
  const startedAt = performance.now()
  const step = (now) => {
    const progress = Math.min(1, (now - startedAt) / SCROLLBAR_FADE_MS)
    if (progress >= 1) {
      target.style.removeProperty('--sb-alpha')
      state.frame = 0
      return
    }
    const eased = progress * progress * (3 - 2 * progress) // weicher Anfang und weiches Ende
    target.style.setProperty('--sb-alpha', String((1 - eased).toFixed(3)))
    state.frame = requestAnimationFrame(step)
  }
  state.frame = requestAnimationFrame(step)
}

document.addEventListener('scroll', (event) => {
  const target = event.target === document ? document.documentElement : event.target
  if (!target || target.nodeType !== 1) return
  let state = scrollbarFades.get(target)
  if (!state) {
    state = { timer: null, frame: 0 }
    scrollbarFades.set(target, state)
  }
  clearTimeout(state.timer)
  cancelAnimationFrame(state.frame)
  target.style.setProperty('--sb-alpha', '1')
  state.timer = setTimeout(() => startScrollbarFade(target, state), SCROLLBAR_HOLD_MS)
}, { capture: true, passive: true })

// ===== Geburtsdatum, Profil und Mitgliederliste =====
// Das Geburtsdatum steht in profiles.birthdate und ist für alle Mitglieder sichtbar. Eingetragen wird es genau einmal:
// die Datenbankfunktion set_my_birthdate füllt nur eine leere Stelle, ein gespeichertes Datum kann man selbst nicht mehr
// ändern. Die E-Mail-Adresse steht in auth.users und kommt nur für den Admin über die Edge Function "get-user-email".
const BIRTH_MIN_AGE = 3    // jünger ist unrealistisch (meist ein Tippfehler im Jahr)
const BIRTH_MAX_AGE = 100  // älter ebenfalls
let birthdateSaving = false

function pad2(n) {
  return String(n).padStart(2, '0')
}

function toISODate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function isoDateYearsAgo(years) {
  const d = new Date()
  d.setFullYear(d.getFullYear() - years)
  return toISODate(d)
}

// "2013-05-12" -> "12.05.2013"
function formatBirthdate(iso) {
  const [y, m, d] = iso.split('-')
  return d + '.' + m + '.' + y
}

function ageFromBirthdate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const now = new Date()
  let age = now.getFullYear() - y
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--
  return age
}

// Gibt einen Fehlertext zurück, oder null wenn das Datum in Ordnung ist
function birthdateError(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return 'Bitte gib dein Geburtsdatum ein.'
  const [y, m, d] = value.split('-').map(Number)
  const check = new Date(y, m - 1, d)
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return 'Dieses Datum gibt es nicht.'
  if (value > toISODate(new Date())) return 'Das Datum liegt in der Zukunft.'
  if (value > isoDateYearsAgo(BIRTH_MIN_AGE) || value < isoDateYearsAgo(BIRTH_MAX_AGE)) {
    return 'Dieses Datum ist nicht möglich. Bitte prüfe es noch einmal.'
  }
  return null
}

// Fehlt das Geburtsdatum? Der Admin muss keins eintragen. "'birthdate' in ..." sorgt dafür, dass niemand ausgesperrt
// wird, solange die Spalte in der Datenbank noch nicht angelegt ist.
function needsBirthdate() {
  return !!currentProfile && !isAdmin() && 'birthdate' in currentProfile && !currentProfile.birthdate
}

function ensureBirthdate() {
  if (!needsBirthdate()) return
  const modal = document.getElementById('birthdate-modal')
  if (modal.style.display === 'flex') return
  const input = document.getElementById('birthdate-input')
  input.min = isoDateYearsAgo(BIRTH_MAX_AGE)
  input.max = isoDateYearsAgo(BIRTH_MIN_AGE)
  input.value = ''
  hideBirthdateError()
  document.getElementById('birthdate-save-btn').disabled = true
  modal.style.display = 'flex'
  if (desktopQuery.matches) input.focus()
}

function showBirthdateError(text) {
  const el = document.getElementById('birthdate-error')
  el.textContent = text
  el.style.display = ''
}

function hideBirthdateError() {
  const el = document.getElementById('birthdate-error')
  el.textContent = ''
  el.style.display = 'none'
}

// Bei jeder Eingabe: Fehler zeigen und "Speichern" erst freigeben, wenn das Datum gültig ist
function onBirthdateInput() {
  const value = document.getElementById('birthdate-input').value
  const problem = value ? birthdateError(value) : null
  if (problem) showBirthdateError(problem)
  else hideBirthdateError()
  document.getElementById('birthdate-save-btn').disabled = !value || !!problem || birthdateSaving
}

function closeBirthdateModal() {
  document.getElementById('birthdate-modal').style.display = 'none'
}

async function saveBirthdate() {
  if (birthdateSaving) return
  const value = document.getElementById('birthdate-input').value
  const problem = birthdateError(value)
  if (problem) {
    showBirthdateError(problem)
    return
  }
  hideBirthdateError()

  const ok = await askConfirm(
    'Dein Geburtsdatum ist der ' + formatBirthdate(value) + '. Das kannst du später nicht mehr selbst ändern. Stimmt das?',
    { okText: 'Ja, speichern', cancelText: 'Ändern' }
  )
  if (!ok) return

  birthdateSaving = true
  const btn = document.getElementById('birthdate-save-btn')
  btn.disabled = true
  const { error } = await supabaseClient.rpc('set_my_birthdate', { p_birthdate: value })
  birthdateSaving = false
  onBirthdateInput()

  if (error) {
    showBirthdateError(error.message || 'Speichern hat nicht geklappt. Bitte versuche es noch einmal.')
    return
  }

  currentProfile.birthdate = value
  if (currentUser && profileCache[currentUser.id]) profileCache[currentUser.id].birthdate = value
  closeBirthdateModal()
  showToast('Geburtsdatum gespeichert.', 'success')
  showBirthdayAnnouncement()
}

// ----- Profil einer Person (Einzelchat-Name oder Eintrag in der Mitgliederliste) -----
function addProfileRow(container, label) {
  const row = document.createElement('div')
  row.className = 'profile-row'
  const labelEl = document.createElement('span')
  labelEl.className = 'profile-row-label'
  labelEl.textContent = label
  const valueEl = document.createElement('span')
  valueEl.className = 'profile-row-value'
  row.append(labelEl, valueEl)
  container.appendChild(row)
  return valueEl
}

function setProfileValue(el, text, muted) {
  el.textContent = text
  el.classList.toggle('empty', !!muted)
}

// Zwei Zeilen im Profil: Geburtsdatum und Alter
function setBirthdateValue(birthEl, ageEl, iso) {
  if (iso) {
    setProfileValue(birthEl, formatBirthdate(iso), false)
    setProfileValue(ageEl, ageFromBirthdate(iso) + ' Jahre', false)
  } else {
    setProfileValue(birthEl, 'Noch nicht eingetragen', true)
    setProfileValue(ageEl, '–', true)
  }
}

// Füllt eine Info-Karte mit Geburtsdatum, Alter und (nur für den Admin) E-Mail-Adresse
function fillProfileInfo(rows, userId, myRequest) {
  const info = profileCache[userId] || {}
  rows.innerHTML = ''
  const birthEl = addProfileRow(rows, 'Geburtsdatum')
  const ageEl = addProfileRow(rows, 'Alter')
  setBirthdateValue(birthEl, ageEl, info.birthdate)

  // E-Mail-Adresse: die eigene steht direkt da, die der anderen wird vom Server geholt
  // (Admin über die Edge Function, alle anderen über die Datenbankfunktion get_member_email)
  if (currentUser && userId === currentUser.id && currentUser.email) {
    setProfileValue(addProfileRow(rows, 'E-Mail-Adresse'), currentUser.email, false)
  } else if (currentUser) {
    const emailEl = addProfileRow(rows, 'E-Mail-Adresse')
    setProfileValue(emailEl, 'Lädt …', true)
    loadProfileEmail(userId, myRequest, emailEl)
  }

  refreshProfileBirthdate(userId, myRequest, birthEl, ageEl)
}

// Frisch nachladen: die Person könnte ihr Geburtsdatum erst nach dem Start dieser App eingetragen haben
async function refreshProfileBirthdate(userId, myRequest, birthEl, ageEl) {
  const { data } = await supabaseClient.from('profiles').select('birthdate').eq('id', userId).single()
  if (!data || myRequest !== profileRequestId) return
  const fresh = data.birthdate || null
  if (profileCache[userId]) profileCache[userId].birthdate = fresh
  setBirthdateValue(birthEl, ageEl, fresh)
}

function openProfile(userId) {
  if (!userId) return
  const myRequest = ++profileRequestId
  const info = profileCache[userId] || {}
  const name = info.name || 'Ohne Namen'

  const avatar = document.getElementById('profile-avatar')
  avatar.style.background = avatarColor(userId)
  avatar.textContent = initialsOf(name)
  avatar.classList.toggle('birthday', hasBirthdayToday(userId))
  document.getElementById('profile-name').textContent = name + birthdayMark(userId)
  const pill = document.getElementById('profile-birthday')
  pill.style.display = hasBirthdayToday(userId) ? '' : 'none'
  if (hasBirthdayToday(userId)) pill.textContent = '🎉 Hat heute Geburtstag und wird ' + birthdayTurningAge(userId)

  fillProfileInfo(document.getElementById('profile-rows'), userId, myRequest)
  document.getElementById('profile-modal').style.display = 'flex'
}

async function loadProfileEmail(userId, myRequest, el) {
  let email = profileEmailCache[userId]
  if (!email) {
    let found = null
    if (isAdmin()) {
      const { data, error } = await supabaseClient.functions.invoke('get-user-email', { body: { userId } })
      if (error) console.error('E-Mail konnte nicht geladen werden:', await readFunctionError(error))
      found = !error && data && data.email ? data.email : null
    } else {
      const { data, error } = await supabaseClient.rpc('get_member_email', { p_user_id: userId })
      if (error) console.error('E-Mail konnte nicht geladen werden:', error.message)
      found = !error && typeof data === 'string' && data ? data : null
    }
    if (myRequest !== profileRequestId) return
    if (!found) {
      setProfileValue(el, 'Nicht verfügbar', true)
      return
    }
    email = found
    profileEmailCache[userId] = email
  }
  if (myRequest !== profileRequestId) return
  setProfileValue(el, email, false)
}

function closeProfileModal() {
  profileRequestId++
  document.getElementById('profile-modal').style.display = 'none'
}

// ----- Mitgliederliste einer Gruppe -----
// Hauptgruppe: alle Mitglieder. Jungs / Mädels: nur die jeweilige Gruppe. Admin, Gesperrte und noch nicht
// angenommene Einladungen stehen nicht darin (genau wie bei den Empfängern einer Nachricht).
function memberIdsOfCurrentGroup() {
  if (currentRoom && currentRoom.groupId) return customGroupMemberIds(currentRoom.groupId)
  const key = (currentRoom && currentRoom.groupKey) || 'main'
  return Object.entries(profileCache)
    .filter(([, info]) => info.role !== 'admin' && !info.blocked && info.active !== false && (key === 'main' || info.gender === key))
    .map(([id]) => id)
}

function renderMembersList() {
  updateMembersModalButtons()
  const nameOf = id => (profileCache[id] && profileCache[id].name) || 'Ohne Namen'
  const ids = memberIdsOfCurrentGroup().sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'de', { sensitivity: 'base' }))

  document.getElementById('members-count').textContent = ids.length
  const list = document.getElementById('members-list')
  list.innerHTML = ''

  if (ids.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'info-empty'
    empty.textContent = 'Noch keine Mitglieder.'
    list.appendChild(empty)
    return
  }

  ids.forEach(id => {
    const name = nameOf(id)
    const li = document.createElement('li')
    li.className = 'reactions-item members-item'

    const avatar = document.createElement('div')
    avatar.className = 'reaction-avatar' + (hasBirthdayToday(id) ? ' birthday' : '')
    avatar.style.background = avatarColor(id)
    avatar.textContent = initialsOf(name)

    const text = document.createElement('div')
    text.className = 'reactions-item-text'
    const nameEl = document.createElement('span')
    nameEl.className = 'reactions-item-name'
    nameEl.textContent = name + birthdayMark(id)
    text.appendChild(nameEl)
    if (currentUser && id === currentUser.id) {
      const hint = document.createElement('span')
      hint.className = 'reactions-item-hint'
      hint.textContent = 'Du'
      text.appendChild(hint)
    }

    li.append(avatar, text)
    li.addEventListener('click', () => openProfile(id))
    list.appendChild(li)
  })
}

function isMembersModalOpen() {
  return document.getElementById('members-modal').style.display === 'flex'
}

function openMembersModal() {
  if (!currentRoom || currentRoom.type !== 'group') return
  renderMembersList()
  document.getElementById('members-modal').style.display = 'flex'
  if (currentRoom.groupId) loadChatGroups(true).then(() => { if (isMembersModalOpen()) renderMembersList() })
  // Wer erst nach dem Start dieser App dazugekommen ist, soll auch schon drinstehen
  loadProfileCache().then(() => {
    if (isMembersModalOpen() && currentRoom && currentRoom.type === 'group') renderMembersList()
  })
}

function closeMembersModal() {
  document.getElementById('members-modal').style.display = 'none'
}

function closeProfileModals() {
  closeBirthdayModal()
  closeBirthdateModal()
  closeProfileModal()
  closeMembersModal()
}

// ----- Tipp auf den Namen oben im Chat -----
function updateConversationTitleTap() {
  const el = document.getElementById('conversation-title')
  const tappable = !!currentRoom && (currentRoom.type === 'group' || currentRoom.type === 'dm')
  el.classList.toggle('tappable', tappable)
  if (tappable) {
    el.setAttribute('role', 'button')
    el.tabIndex = 0
  } else {
    el.removeAttribute('role')
    el.removeAttribute('tabindex')
  }
}

function onConversationTitleClick() {
  if (!currentRoom) return
  if (currentRoom.type === 'group') openMembersModal()
  else if (currentRoom.type === 'dm') openProfile(currentRoom.userId)
}

document.getElementById('conversation-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onConversationTitleClick()
  }
})

// Escape schließt Profil bzw. Mitgliederliste (das Geburtsdatum-Fenster bewusst nicht)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('.confirm-overlay')) return
  if (document.getElementById('profile-modal').style.display === 'flex') closeProfileModal()
  else if (isMembersModalOpen()) closeMembersModal()
})

// ===== Klick auf eine Benachrichtigung: den passenden Chat öffnen =====
// Der Service Worker meldet den Klick (push-open) oder startet die App mit ?push=1&chat=SCHLÜSSEL. Kennt die
// Benachrichtigung ihren Chat (chatKey: "main", "junge", "maedchen" oder "dm:<Nutzer-ID>"), wird genau er geöffnet;
// sonst der Chat mit der neuesten ungelesenen Nachricht.
let pendingPushOpen = null

;(function readPushParams() {
  const params = new URLSearchParams(window.location.search)
  if (params.get('push') !== '1') return
  pendingPushOpen = { chatKey: params.get('chat') || null }
  params.delete('push')
  params.delete('chat')
  const rest = params.toString()
  history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash)
})()

function openChatByKey(key) {
  if (!key || !currentUser || !currentProfile || isAdmin()) return false
  if (key === 'main') {
    openGroupChat()
    return true
  }
  if (key === 'junge' && currentProfile.gender === 'junge') {
    openGenderGroup('junge', 'Jungs')
    return true
  }
  if (key === 'maedchen' && currentProfile.gender === 'maedchen') {
    openGenderGroup('maedchen', 'Mädels')
    return true
  }
  if (key.startsWith('grp_')) {
    const groupId = key.slice(4)
    if (!chatGroups[groupId]) return false
    openCustomGroup(groupId)
    return true
  }
  if (key.startsWith('dm:')) {
    const id = key.slice(3)
    const info = profileCache[id]
    if (!info || id === currentUser.id) return false
    openDirectChat(id, info.name)
    return true
  }
  return false
}

function newestUnreadChatKey() {
  let best = null
  let bestTime = -1
  const consider = (key, preview) => {
    if (!(unreadFor(key) > 0)) return
    const time = preview ? new Date(preview.created_at).getTime() : 0
    if (time > bestTime) {
      best = key
      bestTime = time
    }
  }
  ;['main', 'junge', 'maedchen'].forEach(key => consider(key, groupPreviews[key]))
  Object.keys(dmPreviews).forEach(id => consider('dm:' + id, dmPreviews[id]))
  Object.keys(chatGroups).forEach(id => consider(customGroupKey(id), groupPreviews[customGroupKey(id)]))
  return best
}

async function handlePushOpen(chatKey) {
  // App noch nicht fertig geladen oder noch nicht angemeldet: nach dem Anmelden erledigen
  if (!currentUser || !currentProfile) {
    pendingPushOpen = { chatKey: chatKey || null }
    return
  }
  if (isAdmin()) return
  if (chatKey && openChatByKey(chatKey)) return

  // Chat unbekannt: frische Zähler holen (die App lag vielleicht im Hintergrund) und den neuesten ungelesenen öffnen
  await renderChatList()
  openChatByKey(newestUnreadChatKey())
}

function consumePendingPushOpen() {
  if (!pendingPushOpen) return
  const pending = pendingPushOpen
  pendingPushOpen = null
  handlePushOpen(pending.chatKey)
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
let installPopupScheduled = false
function scheduleInstallPopup() {
  if (installPopupScheduled) return // nur einmal pro Seitenaufruf, nicht bei jedem Aufruf von enterApp
  installPopupScheduled = true
  setTimeout(() => {
    if (!currentUser) return // zwischenzeitlich abgemeldet
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

// ===== Zurück aus dem Hintergrund: sofort wieder verbinden und Verpasstes nachladen =====
// Im Hintergrund hält das Handy die App (und damit die Live-Verbindung) an. Kommt sie zurück,
// wird die Verbindung sofort erneuert, ohne auf den normalen Wiederverbindungs-Timer zu warten.
let hiddenSince = null
let resumeSyncing = false

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenSince = Date.now()
  else resumeSync('visible')
})
window.addEventListener('pageshow', (e) => { if (e.persisted) resumeSync('pageshow') })
window.addEventListener('online', () => resumeSync('online'))

async function resumeSync(reason) {
  if (!currentUser || resumeSyncing) return
  resumeSyncing = true
  try {
    const awayMs = hiddenSince ? Date.now() - hiddenSince : 0
    hiddenSince = null

    // 1. Die Live-Verbindung sofort wieder aufbauen, falls sie weg ist
    try {
      if (!supabaseClient.realtime.isConnected()) supabaseClient.realtime.connect()
    } catch (e) { /* kein Problem: unten werden die Kanäle ohnehin neu aufgebaut */ }

    // 2. Nach längerer Pause oder verlorenem Netz die Live-Kanäle frisch aufbauen (eine "hängende" Verbindung
    //    sieht oft noch verbunden aus, bekommt aber nichts mehr)
    if (awayMs > 15000 || reason === 'online') resubscribeRealtime()

    // 3. Neue Nachrichten, die inzwischen angekommen sind, sofort aus der Datenbank holen
    if (isConversationVisible()) await fetchMissedMessages()
  } catch (e) {
    console.error('Nachladen nach dem Zurückkehren fehlgeschlagen:', e)
  } finally {
    resumeSyncing = false
  }
}

function resubscribeRealtime() {
  if (isConversationVisible()) {
    listenForNewMessages()
    startPollListening()
    startPinListening()
  }
  startInboxChannel()
  if (listChannel) {
    stopListListening()
    listenForListUpdates()
    listenForGroupUpdates()
  }
  if (presenceChannel) {
    stopPresence()
    startPresence()
  }
}

// Holt alles, was im offenen Chat neuer ist als die zuletzt angezeigte Nachricht (ohne den Chat neu aufzubauen)
async function fetchMissedMessages() {
  const newest = Object.values(messagesById).map(m => m.created_at).filter(Boolean).sort().pop()
  if (!newest) {
    await loadMessages() // leerer Chat: einfach alles laden
    return
  }

  let query = supabaseClient
    .from(currentTable())
    .select('*, profiles!sender_id(display_name)')
    .gte('created_at', newest)
    .order('created_at', { ascending: true })

  if (currentRoom.type === 'dm') {
    const me = currentUser.id
    const other = currentRoom.userId
    query = query.or(`and(sender_id.eq.${me},recipient_id.eq.${other}),and(sender_id.eq.${other},recipient_id.eq.${me})`)
  } else if (currentRoom.type === 'dm-view') {
    const a = currentRoom.userA
    const b = currentRoom.userB
    query = query.or(`and(sender_id.eq.${a},recipient_id.eq.${b}),and(sender_id.eq.${b},recipient_id.eq.${a})`)
  } else if (currentRoom.groupKey) {
    query = query.eq('group_key', currentRoom.groupKey)
  } else {
    query = query.is('group_key', null)
  }

  const { data, error } = await query
  if (error || !data) return

  let added = 0
  for (const msg of data) {
    if (messagesById[msg.id]) continue // schon angezeigt
    if (!profileCache[msg.sender_id]) await fetchProfileName(msg.sender_id)
    renderMessage(msg)
    added++
  }
  if (added > 0 && document.visibilityState === 'visible') markCurrentRoomRead()
  scheduleReactionRefresh() // Reaktionen, die inzwischen dazugekommen sind
}

// ===== Ton bei neuen Nachrichten (statt Windows-Banner, solange die App offen und aktiv ist) =====
// Ist die App im Vordergrund, schickt der Service Worker kein Banner, sondern sagt der Seite, dass sie
// einen kurzen Ton spielen soll: ding.mp3 mit der eingestellten Lautstärke. Fehlt die Datei, spielt ein
// kurzer, im Browser erzeugter Ton als Ersatz.
const SOUND_OFF_KEY = 'messageSoundOff'
let audioCtx = null
let lastSoundAt = 0
const SOUND_FILE = 'ding.mp3'                   // liegt neben index.html
const SOUND_VOLUME_KEY = 'messageSoundVolume'   // 0 bis 1, steht dauerhaft im LocalStorage
let soundBuffer = null
let soundBufferLoading = null
let soundFileMissing = false

function soundEnabled() {
  return localStorage.getItem(SOUND_OFF_KEY) !== '1'
}

// Browser erlauben Ton erst nach einem Klick/Tastendruck auf der Seite - das wird hier einmal abgefangen
function unlockAudio() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      loadSoundBuffer() // ding.mp3 schon mal laden, damit der erste Ton nicht wartet
    }
    if (audioCtx.state === 'suspended') audioCtx.resume()
  } catch (e) { /* Ton nicht verfügbar */ }
}
;['pointerdown', 'keydown', 'touchstart'].forEach(evt => {
  document.addEventListener(evt, unlockAudio, { passive: true })
})

function soundVolume() {
  const v = parseFloat(localStorage.getItem(SOUND_VOLUME_KEY))
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7
}

// Die Lautstärke wirkt "im Quadrat": so klingt 50 % auch wirklich etwa halb so laut
function soundGain() {
  const v = soundVolume()
  return v * v
}

function loadSoundBuffer() {
  if (soundBuffer || soundFileMissing || !audioCtx) return Promise.resolve(soundBuffer)
  if (!soundBufferLoading) {
    soundBufferLoading = fetch(SOUND_FILE)
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.arrayBuffer()
      })
      .then(data => new Promise((resolve, reject) => audioCtx.decodeAudioData(data, resolve, reject)))
      .then(buffer => { soundBuffer = buffer; return buffer })
      .catch(() => { soundFileMissing = true; return null })
  }
  return soundBufferLoading
}

async function playMessageSound() {
  if (!soundEnabled() || !audioCtx || audioCtx.state !== 'running') return
  if (soundVolume() <= 0) return
  const now = Date.now()
  if (now - lastSoundAt < 1500) return // nicht doppelt (Push + Live-Nachricht) und nicht wie ein Maschinengewehr
  lastSoundAt = now

  const buffer = await loadSoundBuffer()
  try {
    if (buffer) {
      const source = audioCtx.createBufferSource()
      source.buffer = buffer
      const gain = audioCtx.createGain()
      gain.gain.value = soundGain()
      source.connect(gain)
      gain.connect(audioCtx.destination)
      source.start()
    } else {
      playFallbackSound()
    }
  } catch (e) { /* Ton nicht verfügbar */ }
}

// Ersatzton, falls ding.mp3 nicht geladen werden kann: kurzes, weiches "Plopp"
function playFallbackSound() {
  const t = audioCtx.currentTime
  const master = audioCtx.createGain()
  master.gain.setValueAtTime(0.0001, t)
  master.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.4 * soundGain()), t + 0.012)
  master.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)

  const soften = audioCtx.createBiquadFilter() // nimmt dem Ton die Schärfe
  soften.type = 'lowpass'
  soften.frequency.value = 4000

  master.connect(soften)
  soften.connect(audioCtx.destination)

  ;[[1, 1], [2, 0.12]].forEach(([mult, level]) => { // Grundton + ganz leiser Oberton für etwas Wärme
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(640 * mult, t)
    osc.frequency.exponentialRampToValueAtTime(1100 * mult, t + 0.07)
    gain.gain.value = level
    osc.connect(gain)
    gain.connect(master)
    osc.start(t)
    osc.stop(t + 0.22)
  })
}

// Regler in den Einstellungen (0 bis 100 %)
function updateSoundVolumeUI() {
  const slider = document.getElementById('sound-volume')
  const pct = Math.round(soundVolume() * 100)
  slider.value = pct
  slider.style.setProperty('--fill', pct + '%')
  document.getElementById('sound-volume-value').textContent = pct + ' %'
  slider.disabled = !soundEnabled()
  document.getElementById('sound-volume-row').classList.toggle('disabled', !soundEnabled())
}

function onSoundVolumeInput() {
  const pct = Number(document.getElementById('sound-volume').value)
  localStorage.setItem(SOUND_VOLUME_KEY, String(pct / 100))
  updateSoundVolumeUI()
}

// Loslassen: kurze Hörprobe mit der neuen Lautstärke
function onSoundVolumeChange() {
  unlockAudio()
  lastSoundAt = 0
  setTimeout(playMessageSound, 50)
}

function onSoundToggleChanged() {
  const on = document.getElementById('sound-toggle').checked
  localStorage.setItem(SOUND_OFF_KEY, on ? '0' : '1')
  updateSoundVolumeUI()
  if (on) {
    unlockAudio()
    lastSoundAt = 0
    setTimeout(playMessageSound, 50) // kurze Hörprobe
  }
}

document.getElementById('sound-toggle').checked = soundEnabled()
updateSoundVolumeUI()

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (!event.data) return
    if (event.data.type === 'push-sound' && !isChatMuted(event.data.tag)) playMessageSound()
    if (event.data.type === 'push-open') handlePushOpen(event.data.chatKey)
  })
}

registerServiceWorker()

applyEmojiImages(document.body)
startEmojiObserver()
init()