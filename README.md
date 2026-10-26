# JungscharChat

Ein privater, webbasierter Gruppen-Chat für unsere Jungschar mit Login-System und Echtzeit-Kommunikation.

🌐 **Live-Anwendung:** [myjungschar.github.io/chat](https://myjungschar.github.io/chat/)

---

## 🚀 Features

* 🔐 **Benutzer-Authentifizierung:** Sicherer Login für Gruppenmitglieder via Supabase Auth, Einladung per E-Mail.
* ⚡ **Echtzeit-Chat:** Nachrichten werden ohne Neuladen der Seite sofort empfangen (Supabase Realtime).
* 💬 **Chats:** Hauptgruppe, Jungs, Mädels, eigene Gruppen und Einzelchats.
* 👥 **Eigene Gruppen:** Jedes Mitglied kann Gruppen erstellen (Einstellungen → "Neue Gruppe erstellen"), auch eine Gruppe nur für sich allein. Der Admin kann das pro Person abschalten. Jede Gruppe hat einen oder mehrere Gruppen-Admins (zuerst der Ersteller): Nur sie ändern Name, Mitglieder und Farbe, ernennen weitere Admins und löschen die Gruppe für alle. Jedes Mitglied kann die Gruppe verlassen; der letzte Gruppen-Admin bestimmt vorher einen Nachfolger. Als Bild der Gruppe stehen ihre Kürzel (z. B. KH für "Kleine Helden").
* 🔕 **Stummschalten:** Rechtsklick oder langes Drücken auf eine Gruppe oder einen Einzelchat in der Chatliste. Stummgeschaltete Gruppen machen keinen Ton und schicken keine Push-Meldung. Eigene Gruppen können dort auch gelöscht werden (Ersteller und Admin).
* 😀 **Nachrichten:** Reaktionen (in der Chatliste steht dann "Max hat mit 👍 reagiert: …", ohne Push-Meldung), Antworten, Umfragen, Anpinnen, Fotos und Audio, "tippt …"-Anzeige, Lesehäkchen.
* 🎵 **Audio:** MP3, M4A und WAV bis 50 MB mit eigenem Player (Spulen, Geschwindigkeit, Herunterladen per Rechtsklick oder langem Drücken). Der Dateiname lässt sich vor dem Senden ändern.
* 📄 **Dateien:** PDF, Word, Excel, PowerPoint, Text und CSV bis 50 MB über Plus → Datei (Foto, Audio oder Dokument), als Karte mit Name und Größe in der Nachricht. Bei PDFs gibt es eine Vorschau mit der ersten Seite und der Seitenzahl. Ein Tipp öffnet PDFs in einem neuen Tab, alle anderen Dateien werden heruntergeladen. Der Dateiname lässt sich vor dem Senden ändern. Ausführbare Dateien und Archive sind nicht erlaubt.
* 🌗 **Dunkel/Hell:** Die App folgt dem Modus des Geräts, man kann ihn in den Einstellungen aber auch selbst wählen.
* 🧭 **Orientierung im Chat:** Linie „neue Nachrichten“ beim Öffnen und ein Knopf „nach unten“ mit Zähler.
* ↪️ **Weiterleiten:** Text-Nachrichten lassen sich an die Hauptgruppe, die eigene Jungs-/Mädels-Gruppe, eigene Gruppen oder einzelne Personen weiterleiten (mit Vermerk „Weitergeleitet“).
* 📩 **Einladung anfragen:** Über den Reiter „Neu hier?“ oben rechts am Login-Fenster können Neue und Eingeladene, bei denen die Einladung nicht geklappt hat, ihre E-Mail-Adresse und, wenn sie wollen, eine Nachricht hinterlassen. Der Admin sieht die Anfrage unter Einstellungen → Verwaltung → Einladungs-Anfragen und lädt direkt von dort neu ein.
* 💌 **Rückmeldung:** Unter Einstellungen → Rückmeldung gibt es drei Einträge: „Vermisst du jemanden?“ (E-Mail-Adresse der Person), „Hast du ein Problem?“ und „Verbesserungsvorschlag“ (höchstens 3 pro Tag und Person). Der Admin sieht alles unter Einstellungen → Verwaltung → Rückmeldungen und kann vermisste Personen direkt einladen.
* 🚩 **Melden:** Mitglieder können Nachrichten anderer über das Menü melden. Der Admin sieht die Meldungen unter Einstellungen → Verwaltung → Meldungen und kann sie erledigen oder die Nachricht löschen.
* ↩️ **Schnell antworten:** Doppelklick oder Doppeltipp auf die Höhe einer Nachricht startet die Antwort.
* 🔍 **Suche im Chat:** Über die Lupe oben rechts nach Wörtern suchen und von Treffer zu Treffer springen.
* 🔎 **Suche in der Chatliste:** Die Suchleiste filtert Chats und durchsucht zugleich die Nachrichten aller Chats, die man sehen darf. Ein Tipp auf ein Ergebnis öffnet den Chat und springt zur Nachricht.
* ⏳ **Schnell geladen:** Beim Laden erscheinen graue Platzhalter statt einer leeren Seite.
* 🔔 **Benachrichtigungen:** Web-Push (auch bei geschlossener App) und ein Ton mit einstellbarer Lautstärke.
* 🎂 **Profile und Geburtstage:** Geburtsdatum, Profil-Pop-up und Geburtstags-Pop-up mit Konfetti. Die Profilfarbe kann der Admin ändern.
* 🛡️ **Sicherheit & Datenbank:** XSS-Schutz für Nachrichten, Rechte über Row Level Security und Datenbankfunktionen, automatischer Ringpuffer in PostgreSQL (max. 300 Nachrichten pro Chat).
* 🛠️ **Verwaltung (Admin):** Nutzer einladen, sperren und löschen, Besondere Rechte (VIP, Foto-Sperre, Gruppen erstellen), Geburtsdatum und Profilfarbe ändern. Der Admin liest überall mit und schreibt nie.

---

## 🛠️ Tech Stack

* **Frontend:** HTML5, CSS3, Vanilla JavaScript (Single-Page-Application)
* **Backend / Datenbank:** Supabase (PostgreSQL mit RLS, Auth, Realtime, Edge Functions)
* **Push:** Service Worker (`sw.js`) und die Edge Function `send-push`
* **Hosting:** GitHub Pages

---

*Erstellt für die Jungschar-Gruppe.*