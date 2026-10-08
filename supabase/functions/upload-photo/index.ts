// Edge Function "upload-photo": nimmt entweder ein (schon im Browser verkleinertes) Foto + Vorschaubild
// ODER eine Audio-Datei (.mp3, .m4a, .wav) entgegen und legt alles privat in Google Drive ab.
// Antwort bei Fotos: { photo_id, thumb_id }, bei Audio: { audio_id, audio_mime } (Drive-Datei-IDs).
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const MAX_PHOTO = 10 * 1024 * 1024
const MAX_THUMB = 400 * 1024
const MAX_AUDIO = 10 * 1024 * 1024

let tokenCache: { token: string; exp: number } | null = null

async function driveToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
      refresh_token: Deno.env.get('GOOGLE_REFRESH_TOKEN') ?? '',
      grant_type: 'refresh_token'
    })
  })
  const data = await res.json()
  if (!res.ok || !data.access_token) {
    throw new Error('Google-Anmeldung fehlgeschlagen: ' + (data.error_description || data.error || res.status))
  }
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 }
  return data.access_token
}

async function uploadToDrive(bytes: Uint8Array, name: string, mimeType = 'image/jpeg'): Promise<string> {
  const token = await driveToken()
  const boundary = 'chat' + crypto.randomUUID()
  const enc = new TextEncoder()
  const meta = JSON.stringify({ name, parents: [Deno.env.get('DRIVE_FOLDER_ID')], mimeType })
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  )
  const tail = enc.encode(`\r\n--${boundary}--`)
  const body = new Uint8Array(head.length + bytes.length + tail.length)
  body.set(head, 0)
  body.set(bytes, head.length)
  body.set(tail, head.length + bytes.length)

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  })
  const data = await res.json()
  if (!res.ok || !data.id) throw new Error('Drive-Upload fehlgeschlagen: ' + (data.error?.message || res.status))
  return data.id
}

const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to))

// Erkennt am Dateiinhalt (nicht am Namen), ob es wirklich MP3, M4A oder WAV ist. null = nicht erlaubt.
function detectAudio(b: Uint8Array): { ext: string; mime: string } | null {
  if (b.length < 16) return null
  // MP3: entweder ID3-Kennung vorn oder direkt ein MPEG-Frame (0xFF 0xE?/0xF?)
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' }
  // M4A: "ftyp" ab Byte 4, danach die Markenkennung
  if (ascii(b, 4, 8) === 'ftyp' && ['M4A ', 'M4B ', 'mp42', 'isom', 'iso2', 'f4a '].includes(ascii(b, 8, 12))) {
    return { ext: 'm4a', mime: 'audio/mp4' }
  }
  // WAV: "RIFF" .... "WAVE"
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Nur POST erlaubt' }, 405)

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Wer ruft auf? (Zugriffs-Token der Person prüfen)
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
    const { data: userData, error: userError } = await admin.auth.getUser(jwt)
    if (userError || !userData.user) return json({ error: 'Nicht angemeldet' }, 401)

    const { data: profile } = await admin
      .from('profiles')
      .select('role, is_blocked')
      .eq('id', userData.user.id)
      .single()
    if (!profile || profile.is_blocked) return json({ error: 'Zugang gesperrt' }, 403)
    if (profile.role === 'admin') return json({ error: 'Der Admin schreibt nicht' }, 403)

    // Hat der Admin dieser Person das Foto-Senden weggenommen? (Tabelle photo_blocked_users) Gilt auch für Audio.
    const { data: photoBlock } = await admin
      .from('photo_blocked_users')
      .select('user_id')
      .eq('user_id', userData.user.id)
      .maybeSingle()
    if (photoBlock) return json({ error: 'Du darfst im Moment keine Fotos und Audios senden' }, 403)

    const form = await req.formData()

    // ----- Audio -----
    const audio = form.get('audio')
    if (audio instanceof File) {
      if (audio.size > MAX_AUDIO) return json({ error: 'Die Datei ist zu groß (höchstens 10 MB)' }, 413)
      const audioBytes = new Uint8Array(await audio.arrayBuffer())
      const kind = detectAudio(audioBytes)
      if (!kind) return json({ error: 'Nur MP3-, M4A- und WAV-Dateien erlaubt' }, 400)

      const audioId = await uploadToDrive(audioBytes, `${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${kind.ext}`, kind.mime)
      return json({ audio_id: audioId, audio_mime: kind.mime })
    }

    // ----- Foto -----
    const photo = form.get('photo')
    const thumb = form.get('thumb')
    if (!(photo instanceof File) || !(thumb instanceof File)) return json({ error: 'Foto oder Vorschau fehlt' }, 400)
    if (photo.size > MAX_PHOTO) return json({ error: 'Das Foto ist zu groß (höchstens 10 MB)' }, 413)
    if (thumb.size > MAX_THUMB) return json({ error: 'Die Vorschau ist zu groß' }, 413)

    const photoBytes = new Uint8Array(await photo.arrayBuffer())
    const thumbBytes = new Uint8Array(await thumb.arrayBuffer())
    if (!isJpeg(photoBytes) || !isJpeg(thumbBytes)) return json({ error: 'Nur JPEG-Fotos erlaubt' }, 400)

    const base = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
    // Beide gleichzeitig hochladen (spart ein paar Sekunden). Klappt einer nicht, räumt cleanup-photos den anderen später auf.
    const [photoId, thumbId] = await Promise.all([
      uploadToDrive(photoBytes, `${base}.jpg`),
      uploadToDrive(thumbBytes, `${base}_thumb.jpg`)
    ])

    return json({ photo_id: photoId, thumb_id: thumbId })
  } catch (e) {
    console.error('upload-photo:', e)
    return json({ error: e instanceof Error ? e.message : 'Unbekannter Fehler' }, 500)
  }
})