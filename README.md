# JungscharChat

Ein privater, webbasierter Gruppen-Chat für unsere Jungschar mit Login-System und Echtzeit-Kommunikation.

🌐 **Live-Anwendung:** [myjungschar.github.io/chat](https://myjungschar.github.io/chat/)

---

## 🚀 Features

* 🔐 **Benutzer-Authentifizierung:** Sicherer Login für Gruppenmitglieder via Supabase Auth, Einladung per E-Mail.
* ⚡ **Echtzeit-Chat:** Nachrichten werden ohne Neuladen der Seite sofort empfangen (Supabase Realtime).
* 💬 **Chats:** Hauptgruppe, Jungs, Mädels, eigene Gruppen und Einzelchats.
* 👥 **Eigene Gruppen:** Jedes Mitglied kann Gruppen erstellen (Einstellungen → "Neue Gruppe erstellen"). Der Admin kann das pro Person abschalten.
* 🔕 **Stummschalten:** Rechtsklick oder langes Drücken auf eine Gruppe oder einen Einzelchat in der Chatliste. Stummgeschaltete Gruppen machen keinen Ton und schicken keine Push-Meldung. Eigene Gruppen können dort auch gelöscht werden (Ersteller und Admin).
* 😀 **Nachrichten:** Reaktionen, Antworten, Umfragen, Anpinnen, Fotos und Audio, "tippt …"-Anzeige, Lesehäkchen.
* 🎵 **Audio:** MP3, M4A und WAV bis 50 MB mit eigenem Player (Spulen, Geschwindigkeit, Herunterladen per Rechtsklick oder langem Drücken). Der Dateiname lässt sich vor dem Senden ändern.
* 🌗 **Dunkel/Hell:** Die App folgt dem Modus des Geräts, man kann ihn in den Einstellungen aber auch selbst wählen.
* 🧭 **Orientierung im Chat:** Linie „neue Nachrichten“ beim Öffnen und ein Knopf „nach unten“ mit Zähler.
* 🚩 **Melden:** Mitglieder können Nachrichten anderer über das Menü melden. Der Admin sieht die Meldungen unter Einstellungen → Verwaltung → Meldungen und kann sie erledigen oder die Nachricht löschen.
* ↩️ **Schnell antworten:** Doppelklick oder Doppeltipp auf die Höhe einer Nachricht startet die Antwort.
* 🔍 **Suche im Chat:** Über die Lupe oben rechts nach Wörtern suchen und von Treffer zu Treffer springen.
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