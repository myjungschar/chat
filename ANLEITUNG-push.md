# Push-Benachrichtigungen einrichten

Diese Schritte machst du einmalig in Supabase. Der Code dafür liegt schon bereit:
`sw.js`, `push_subscriptions.sql`, `supabase/functions/send-push/index.ts`.

## 1. Dateien hochladen

- `sw.js` in denselben Ordner wie `index.html` (dieselbe Ebene, nicht in einen Unterordner).
- Prüfe in `sw.js` die Zeilen mit `icon-192.png` - falls dein Icon anders heißt (schau in eure
  `manifest.json`), trag dort den richtigen Dateinamen ein.

## 2. Tabelle anlegen

Supabase-Dashboard → SQL-Editor → Inhalt von `push_subscriptions.sql` einfügen → Ausführen.

## 3. VAPID-Schlüssel eintragen

Diese beiden Schlüssel wurden bereits für euch erzeugt (einmalig, nicht mehr ändern - sonst
müsste sich jedes Gerät neu anmelden):

```
VAPID_PUBLIC_KEY  = BIWDoDgxglJlPAOdWtaY5e3kjw-Q2Fg0DXnM4RsPqiwbxjhhOHIjB2_vHSE_TeYw2tN1JinxIhFCIg4eY27l66Q
VAPID_PRIVATE_KEY = n7EAzjJIr-iGWgcbH2MxeGJawuiXtFigyuODmu2MoWY
```

Der öffentliche Schlüssel steht schon in `script.js` drin. Den privaten Schlüssel NIEMALS in eine
Datei fürs Frontend packen - er kommt nur als Secret in die Edge Function (nächster Schritt).

## 4. Edge Function veröffentlichen

Das geht am einfachsten über die Supabase-CLI auf deinem PC (`npm install -g supabase`, dann
`supabase login`, dann im Projektordner mit `supabase/functions/send-push/index.ts`):

```
supabase secrets set VAPID_PUBLIC_KEY=BIWDoDgxglJlPAOdWtaY5e3kjw-Q2Fg0DXnM4RsPqiwbxjhhOHIjB2_vHSE_TeYw2tN1JinxIhFCIg4eY27l66Q
supabase secrets set VAPID_PRIVATE_KEY=n7EAzjJIr-iGWgcbH2MxeGJawuiXtFigyuODmu2MoWY
supabase secrets set VAPID_CONTACT_EMAIL=deine-email@beispiel.de
supabase functions deploy send-push --no-verify-jwt
```

`--no-verify-jwt` ist wichtig: die Function wird gleich vom Datenbank-Webhook aufgerufen, nicht
von einer eingeloggten Person direkt, die hätte sonst keinen gültigen Zugangs-Token dafür.

Falls dir die Kommandozeile dafür fehlt oder Probleme macht, sag Bescheid - dann suchen wir eine
andere Lösung (z. B. Function direkt im Dashboard-Editor einfügen, falls das bei euch verfügbar ist).

## 5. Datenbank-Webhook einrichten

Supabase-Dashboard → Database → Webhooks → "Create a new hook", zweimal (einmal pro Tabelle):

**Webhook 1**
- Name: `push-on-message`
- Table: `messages`
- Events: nur `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-push`

**Webhook 2**
- Name: `push-on-direct-message`
- Table: `direct_messages`
- Events: nur `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-push`

## 6. Testen

- Auf dem Handy/PC einmal ausloggen und neu einloggen (oder Browser-Daten für die Seite löschen),
  damit die Abfrage "Benachrichtigungen aktivieren?" wieder erscheint. Zustimmen.
- Seite schließen (Tab zu, oder App in den Hintergrund).
- Von einem anderen Gerät/Account eine Nachricht schreiben.
- Die Benachrichtigung sollte erscheinen, auch ohne dass die Seite offen ist.

Kommt nichts an: Supabase-Dashboard → Edge Functions → `send-push` → Logs anschauen, dort steht,
woran es liegt (meist: Secrets falsch geschrieben, oder Webhook zeigt auf die falsche Function).
