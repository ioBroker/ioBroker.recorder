![Logo](../../admin/recorder.svg)
# ioBroker.recorder

Zeichnet alle relevanten Zustände einer ioBroker-Installation für einen einstellbaren Zeitraum auf
(ein Tag, eine Woche, ein Monat) - ohne jeden einzelnen Datenpunkt zu konfigurieren - und baut darauf
drei Funktionen auf:

- **Zeitreise**: der Zustand des ganzen Hauses zu jedem Zeitpunkt, auch als Wiedergabe
- **Anwesenheitssimulation**: spielt das manuelle Schalten von Lichtern und Rollläden eines
  vergangenen Tages nach
- **Anomalieerkennung**: Werte und Aktivitäten, die nicht zum üblichen Wochenmuster passen

> **Status:** frühe Entwicklung. Alle sechs Meilensteine des Plans sind umgesetzt; die Langzeittests
> auf echten Installationen laufen noch.

English documentation, changelog and license: [README.md](../../README.md)

## Auswahl der Datenpunkte

Die Datenpunkte werden automatisch in vier Stufen ausgewählt; eine spätere Stufe überschreibt eine
frühere:

1. Der Type-Detector erkennt Geräte (Licht, Rollladen, Thermostat, Fenster ...) und die Bedeutung
   ihrer Datenpunkte. Übernommen werden nur aussagekräftige Datenpunkte: keine Batterie,
   Signalstärke oder Erreichbarkeit.
2. Optional nur Datenpunkte, die einem Raum oder einer Funktion zugeordnet sind.
3. Für Datenpunkte ohne erkanntes Gerät entscheidet die Rolle (z. B. `value.temperature`).
4. Ein- und Ausschlussmuster sowie pro Datenpunkt "immer aufzeichnen" / "nie aufzeichnen" im
   Objektbrowser (Custom-Einstellungen).

Die Kategorien Licht, Beschattung, Heizung und Klima, Fenster und Türen, Sicherheit, Schalter und
Steckdosen, Medien, Wetter und Energie lassen sich jeweils abschalten, aufzeichnen oder zu
5-Minuten-Werten aggregieren. Bewegung und Anwesenheit sind zum Schutz der Privatsphäre
standardmäßig **aus**; Energie wird standardmäßig aggregiert.

Der Reiter "Vorschau" in den Instanzeinstellungen zeigt schon vor dem Speichern, welche Datenpunkte
aufgezeichnet würden, mit Begründung und geschätzter Größe.

## Frequenzfilter

Nicht jede Änderung ist es wert, gespeichert zu werden. Jeder aufgezeichnete Datenpunkt bekommt eine
Klasse:

- **diskret** (Schalter, Kontakte, Datenpunkte mit Werteliste): jede Änderung
- **kontinuierlich** (Zahlen): gespeichert, wenn sich der Wert mindestens um das Totband ändert,
  höchstens einmal pro Mindestabstand (dann der letzte Wert), und kleine Änderungen nach dem Heartbeat
- **aggregiert** (Energie und Zahlen, die sich im Stundenmittel mehr als 6-mal pro Minute ändern):
  5-Minuten-Werte (Minimum, Maximum, Mittelwert, letzter Wert)
- **verworfen**: andere Datenpunkte, die sich im Mittel mehr als 60-mal pro Minute ändern

| Rolle                                     | Totband    | Mindestabstand | Heartbeat  |
|-------------------------------------------|------------|----------------|------------|
| `value.temperature`, `level.temperature`  | 0,2        | 60 s           | 1 h        |
| `value.humidity`                          | 2          | 60 s           | 1 h        |
| `value.brightness`                        | 10 %       | 60 s           | 1 h        |
| `level.dimmer`, `level.blind`             | 1          | 0 s            | keiner     |
| `value.power`                             | 5 %        | 60 s           | 15 min     |
| andere Zahlen                             | 1 %        | 60 s           | 1 h        |

Der Reiter "Regeln" überschreibt diese Werte pro Rolle. Ein Datenpunkt, der sich plötzlich mehr als
60-mal pro Minute ändert (ein defekter Sensor), wird gedrosselt und im Log gemeldet. Der Reiter
"Hochfrequent" listet die gemessenen Raten. Pro Datenpunkt kann "Filter" im Objektbrowser "jede
Änderung" oder "aggregieren" erzwingen.

## Daten lesen

`getHistory` funktioniert wie bei `history`, `sql` und `influxdb` (dieselben Optionen, dieselbe
Aggregation über `@iobroker/aggregate`), sodass Diagramme und Skripte den Recorder als Quelle nutzen
können:

```js
sendTo('recorder.0', 'getHistory', {
    id: 'hm-rpc.0.ABC.1.LEVEL',
    options: { start: Date.now() - 86400000, aggregate: 'none', from: true },
}, result => console.log(result.result));
```

Datenpunkte, die zu 5 Minuten aggregiert werden (Energie), liefern einen Wert pro Intervall.
`enableHistory` / `disableHistory` setzen "immer aufzeichnen" / "nie aufzeichnen" für einen
Datenpunkt.

## Zeitreise

Der Admin-Reiter **Time machine** zeigt den Zustand jedes Raums zu jedem Zeitpunkt des
aufgezeichneten Zeitraums:

- ein Zeitstrahl mit der Dichte der Änderungen; ziehen, klicken oder Pfeiltasten
- Wiedergabe / Pause mit 1x, 10x, 60x, 600x oder 3600x Geschwindigkeit
- Kacheln pro Raum mit Lichtern, Fenstern, Klima, Rollläden ... und das Journal der Änderungen vor
  dem Cursor ("07:12 Bad · Licht **an** (admin)")
- Filter für Raum, Kategorie und "nur manuelle Aktionen"

**Wiedergabe in Datenpunkte:** `recorder.0.replay.time` (beschreibbar: Sprung),
`recorder.0.replay.speed` und `recorder.0.replay.active` spielen die Vergangenheit in der Instanz
selbst ab. Mit "Spiegel-Datenpunkte für die Wiedergabe" bekommt jeder aufgezeichnete Datenpunkt eine
schreibgeschützte Kopie `recorder.0.mirror.<ID mit _>`, die den wiedergegebenen Wert zeigt. So kann
ein vis-Projekt die Vergangenheit anzeigen, ohne die echten Geräte zu schalten.

### Nachrichten für Skripte, vis und den MCP-Server

Der Reiter verwendet drei Nachrichten, die jedem zur Verfügung stehen:

| Nachricht     | Beantwortet die Frage                                      | Ergebnis                             |
|---------------|------------------------------------------------------------|--------------------------------------|
| `getSnapshot` | Wie war der Zustand des Hauses zum Zeitpunkt T?            | ein Wert pro Datenpunkt              |
| `getEvents`   | Was hat sich zwischen A und B geändert, und wer war es?    | Liste der Änderungen (Journal)       |
| `getTimeline` | Wann war wie viel los?                                     | Anzahl der Änderungen pro Intervall  |

#### Gemeinsame Regeln

**Aufruf** im JavaScript-Adapter mit Callback oder mit `sendToAsync`, im Browser mit
`socket.sendTo('recorder.0', ...)`, über den MCP-Server mit `send_to`:

```js
sendTo('recorder.0', 'getSnapshot', { ts: '2026-11-16T20:00' }, answer => { /* ... */ });
const answer = await sendToAsync('recorder.0', 'getEvents', { src: 'user' });
```

**Zeitangaben** (`ts`, `start`, `end`): Millisekunden seit 1970, eine Zahl als String oder alles, was
`new Date()` versteht, z. B. `'2026-11-16T20:00'`. Ohne Zeitzone gilt die **lokale Zeit des
ioBroker-Hosts**.

**Filter** (bei allen drei Nachrichten; jeweils ein einzelner Wert oder ein Array):

| Filter     | Bedeutung                                                                                                            | Vergleich                                                                             |
|------------|----------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| `room`     | Name des Raum-Enums in der Systemsprache, z. B. `'Wohnzimmer'`                                                       | Groß-/Kleinschreibung egal; ein Datenpunkt in mehreren Räumen passt zu jedem davon    |
| `category` | `light`, `shading`, `climate`, `windowsDoors`, `motion`, `security`, `sockets`, `media`, `weather`, `energy`          | Groß-/Kleinschreibung egal                                                            |
| `ids`      | Objekt-IDs                                                                                                           | exakt                                                                                 |
| `src`      | `user`, `script`, `adapter`, `system` (nur `getEvents` und `getTimeline`)                                            |                                                                                       |

Die Werte eines Filters sind ODER-verknüpft (`room: ['Bad', 'Küche']`), verschiedene Filter
UND-verknüpft (`room: 'Bad', category: 'light'` liefert nur die Lichter im Bad).

**Quellen** (`src`) werden aus `state.from` abgeleitet:

| `src`     | `from` ist ...                                                                                                                                          |
|-----------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| `user`    | eine Bedienoberfläche oder ein Sprach- bzw. Chat-Kanal: admin, web, vis, vis-2, material, iqontrol, jarvis, lovelace, cloud, iot, alexa2, matter, telegram, mcp, rest-api ... |
| `script`  | javascript, scenes, node-red, scheduler, alarm, flow, ai-server                                                                                         |
| `adapter` | jeder andere Adapter, also die Geräte-Adapter (hm-rpc, zigbee, shelly ...)                                                                              |
| `system`  | `system.host.*` oder unbekannt                                                                                                                          |

Ein Druck auf einen **Wandschalter** kommt als Bestätigung (`ack: true`) vom Geräte-Adapter und hat
deshalb `src: 'adapter'`, nicht `user`.

**Antworten** enthalten immer `ms` (Rechenzeit). Bei einem Fehler lautet die Antwort
`{ error: '...' }`, z. B. `'The instance is not ready yet'` direkt nach dem Start.

**Stammdaten**: `name`, `room`, `category` und `unit` sind die *aktuellen*. Ein Gerät, das seitdem
umbenannt oder in einen anderen Raum verschoben wurde, erscheint mit seinem neuen Namen und Raum.

#### `getSnapshot`: der Zustand zu einem Zeitpunkt

Anfrage: `{ ts?, room?, category?, ids? }`. `ts` ist standardmäßig jetzt; ein Zeitpunkt in der Zukunft
wird auf jetzt gesetzt.

So wird der Zustand berechnet:

1. Zu jeder vollen Stunde (und beim Start) schreibt die Instanz einen **Keyframe** mit den Werten
   aller aufgezeichneten Datenpunkte. Grundlage ist der neueste Keyframe zum oder vor `ts`.
2. Darauf werden alle gespeicherten Änderungen im Zeitraum (Keyframe, `ts`] angewendet, einschließlich
   des noch nicht geschriebenen Puffers.
3. Datenpunkte der Klasse "aggregiert" (hochfrequent, z. B. Leistung) bekommen den letzten Wert des
   neuesten **abgeschlossenen** 5-Minuten-Intervalls vor `ts`.

Es wird also höchstens etwa eine Stunde Änderungen gelesen; gemessen: etwa 15 ms für 1.000
Datenpunkte.

Antwort:

```ts
{
    ts: number,               // der angefragte Zeitpunkt (höchstens jetzt)
    keyframe: number | null,  // Zeit des verwendeten Keyframes; null: vor ts wurde nichts aufgezeichnet
    states: [{
        id, name, room, func, category, role, unit,
        val,                  // Wert mit seinem Typ (boolean, number, string)
        text?,                // Text aus common.states, z. B. 'offen' für 2
        lc: number | null,    // Zeit der Änderung, wenn sie zwischen Keyframe und ts liegt, sonst null
        ack?, from?, user?, src?, // nur wenn lc gesetzt ist (der Wert stammt aus einer Änderung)
        aggregated?: true,    // letzter Wert eines 5-Minuten-Intervalls
    }],                       // nach id sortiert
    ms: number,
}
```

Gut zu wissen:

- **`lc: null` heißt nicht "nie geändert"**, sondern nur "seit dem Keyframe davor nicht geändert"
  (höchstens etwa eine Stunde vor `ts`). Wann sich der Wert wirklich zuletzt geändert hat, beantwortet
  `getHistory` oder `getEvents` mit längerem Zeitraum.
- Der Wert eines aggregierten Datenpunkts kann bis zu 5 Minuten alt sein; sein `lc` ist das Ende des
  Intervalls.
- `getSnapshot` hat keinen `src`-Filter: Ein Snapshot ist ein Zustand, keine Liste von Aktionen.
- `keyframe: null` mit leerem `states`: `ts` liegt vor dem Beginn der Aufzeichnung oder vor der
  Aufbewahrungsgrenze.

```js
// Welche Lichter brannten gestern um 23:00?
sendTo('recorder.0', 'getSnapshot', { ts: '2026-11-18T23:00', category: 'light' }, a => {
    const on = a.states.filter(s => s.val === true || (typeof s.val === 'number' && s.val > 0));
    log(on.map(s => `${s.room}: ${s.name}`).join('\n'));
});

// Waren um 2 Uhr nachts Fenster offen? (true oder 1/2 = gekippt/offen)
sendTo('recorder.0', 'getSnapshot', { ts: '2026-11-19T02:00', category: 'windowsDoors' }, a =>
    log(a.states
        .filter(s => s.val === true || (typeof s.val === 'number' && s.val > 0))
        .map(s => `${s.room} ${s.name}: ${s.text ?? s.val}`)));

// Was war um 18:00 anders als um 08:00?
const morning = await sendToAsync('recorder.0', 'getSnapshot', { ts: '2026-11-19T08:00' });
const evening = await sendToAsync('recorder.0', 'getSnapshot', { ts: '2026-11-19T18:00' });
const before = new Map(morning.states.map(s => [s.id, s.val]));
for (const s of evening.states) {
    if (before.get(s.id) !== s.val) {
        log(`${s.name}: ${before.get(s.id)} -> ${s.val}`);
    }
}
```

#### `getEvents`: die Änderungen in einem Zeitraum

Anfrage:

```ts
{
    start?,     // Standard: end - 1 Stunde
    end?,       // Standard: jetzt
    room?, category?, ids?,
    src?,       // z. B. 'user' für nur manuelle Aktionen
    limit?,     // Standard 1000, höchstens 10000
    newest?,    // bei mehr als limit Änderungen: die neuesten statt der ältesten
}
```

Der Zeitraum schließt beide Grenzen ein, [start, end]; vertauschte Grenzen werden zurückgetauscht.

Antwort:

```ts
{
    events: [{
        ts, id, name, room, category, role, unit,
        val, text?,
        ack: boolean,   // false: Befehl, true: Bestätigung oder Messung des Geräts
        from?, user?,   // z. B. 'system.adapter.vis-2.0', 'system.user.admin'
        src,            // user | script | adapter | system
    }],
    more: boolean,      // es gab mehr als limit Änderungen
    ms: number,
}
```

`events` ist **immer aufsteigend nach Zeit sortiert**, auch mit `newest: true`; `newest` entscheidet
nur, welche `limit` Änderungen zurückkommen.

Gut zu wissen:

- **Befehl und Bestätigung sind zwei Einträge.** Ein über vis geschaltetes Licht ergibt einen Eintrag
  mit `ack: false, src: 'user'` (vis) und kurz danach einen mit `ack: true, src: 'adapter'`
  (Geräte-Adapter). Mit `src: 'user'` bleibt nur der Befehl übrig.
- **Wandschalter** sind Bestätigungen ohne vorausgehenden Befehl (`ack: true`, `src: 'adapter'`). Wer
  sie mit sehen will, fragt `src: ['user', 'adapter']` ab und wertet die Einträge selbst aus.
- **Aggregierte Datenpunkte** (Leistung, Energie, sehr häufige Sensoren) haben keine einzelnen
  Änderungen und erscheinen nicht; für sie gibt es `getHistory`.
- Gespeichert ist nur, was der **Frequenzfilter** durchgelassen hat: Kleine Änderungen einer
  Temperatur innerhalb des Totbands fehlen.
- **Blättern**: Bei `more: true` die nächste Seite mit `start` = letztes `ts` anfragen; Einträge mit
  genau diesem `ts` kommen doppelt und müssen übersprungen werden. Oder den Zeitraum verkürzen.

```js
// Was wurde in den letzten 24 Stunden von Hand geschaltet?
sendTo('recorder.0', 'getEvents', { start: Date.now() - 86400000, src: 'user' }, a => {
    for (const e of a.events) {
        log(`${new Date(e.ts).toLocaleTimeString()} ${e.room ?? ''} · ${e.name}: ${e.text ?? e.val} (${e.from})`);
    }
});

// Die letzten 20 Änderungen im Bad
sendTo('recorder.0', 'getEvents',
    { start: Date.now() - 7 * 86400000, room: 'Bad', limit: 20, newest: true }, a => log(a.events));

// Wer hat die Haustür gestern Abend geöffnet oder verriegelt?
sendTo('recorder.0', 'getEvents', {
    start: '2026-11-18T18:00',
    end: '2026-11-18T23:59',
    ids: ['hm-rpc.0.ABC123.1.STATE', 'nuki.0.door.lockState'],
}, a => log(a.events.map(e => `${e.ts} ${e.name}=${e.val} ack=${e.ack} ${e.from} ${e.user ?? ''}`)));
```

#### `getTimeline`: die Dichte der Änderungen

Anfrage: `{ start?, end?, buckets?, room?, category?, ids?, src? }`. `end` ist standardmäßig jetzt,
`start` gleich `end` - 24 Stunden, `buckets` gleich 100 (höchstens 2000).

Antwort:

```ts
{
    start: number,
    end: number,          // = start + step * buckets (kann etwas nach dem angefragten end liegen)
    step: number,         // Länge eines Intervalls in ms = ceil((end - start) / buckets), mindestens 1000
    counts: number[],     // buckets Einträge; counts[i] gilt für [start + i * step, start + (i + 1) * step)
    first: number | null, // der älteste aufgezeichnete Zeitpunkt (Keyframe oder Änderung)
    ms: number,
}
```

Gut zu wissen:

- Gezählt werden nur **bereits geschriebene** Änderungen: Der Puffer der letzten bis zu 30 s
  (`flushInterval`) fehlt am rechten Rand, und aggregierte Datenpunkte zählen nicht.
- `first` hängt nicht von den Filtern ab; es ist die linke Grenze eines Zeitstrahls oder Sliders
  ("aufgezeichnet seit ...").
- Typischer Ablauf: mit `getTimeline` die Spitzen finden, dann die Details des Intervalls `i` mit
  `getEvents` holen: `start: t.start + i * t.step, end: t.start + (i + 1) * t.step - 1`.

```js
// Aktivität pro Stunde in den letzten 7 Tagen, nur Bewegung
sendTo('recorder.0', 'getTimeline',
    { start: Date.now() - 7 * 86400000, buckets: 168, category: 'motion' }, t => {
    t.counts.forEach((n, i) => n && log(`${new Date(t.start + i * t.step).toLocaleString()}: ${n}`));
});

// Die unruhigste Viertelstunde der letzten Nacht und was dort passiert ist
const t = await sendToAsync('recorder.0', 'getTimeline',
    { start: '2026-11-18T22:00', end: '2026-11-19T06:00', buckets: 32 });
const i = t.counts.indexOf(Math.max(...t.counts));
const a = await sendToAsync('recorder.0', 'getEvents',
    { start: t.start + i * t.step, end: t.start + (i + 1) * t.step - 1 });
log(a.events);
```

#### Welche Nachricht wofür?

| Frage                                                                         | Nachricht                                                                      |
|-------------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| "Wie sah es um 20:00 aus?", ein Zustand des Hauses für eine vis               | `getSnapshot`                                                                  |
| "Was ist passiert, und wer war es?", ein Protokoll, Fragen an eine KI         | `getEvents`                                                                    |
| ein Zeitstrahl, eine Übersicht über die Aktivität                             | `getTimeline`                                                                  |
| der Verlauf eines Werts für ein Diagramm, aggregierte Werte                   | `getHistory`                                                                   |
| die Vergangenheit **in Datenpunkte** abspielen (eine vis ohne eigenes Skript) | `replay.time` / `replay.speed` / `replay.active` mit den Spiegel-Datenpunkten  |

## Anwesenheitssimulation

Solange niemand zu Hause ist, spielt die Instanz das Schalten von Lichtern und Rollläden eines
aufgezeichneten Tages nach, an dem jemand zu Hause war. Aktiviert wird sie im Reiter
"Anwesenheitssimulation" der Instanzeinstellungen.

- **Start und Stopp**: ein Datenpunkt, der Abwesenheit meldet (z. B. `0_userdata.0.away` oder eine
  scharf geschaltete Alarmanlage; "Der Datenpunkt meldet Anwesenheit" für einen Datenpunkt, der zu
  Hause `true` ist), oder `recorder.0.simulation.enabled` von Hand, aus einem Skript oder einer vis.
  Das Ende der Abwesenheit stoppt die Simulation sofort: Nichts wird nachgeholt, und die Lichter und
  Medien, die sie eingeschaltet hat, werden ausgeschaltet.
- **Was abgespielt wird**: zufällig einer der gleichen Wochentage 1 bis 4 Wochen zurück, an dem
  Lichter oder Rollläden mindestens 3-mal geschaltet wurden; gibt es keinen, ein anderer Tag mit
  Anwesenheit. Ein simulierter Tag läuft von Mittag bis Mittag, sodass der Abend und das Ausschalten
  in der Nacht vom selben aufgezeichneten Tag stammen.
- **Wer geschaltet hat**: nur Personen - Befehle aus Bedienoberflächen (admin, vis, Apps,
  Sprachassistenten, Telegram ...) und Wandschalter (eine von einem Gerät gemeldete Änderung ohne
  vorherigen Befehl). Skripte laufen ohnehin weiter; ihr Schalten wird nur auf Wunsch abgespielt. Die
  Befehle der Simulation selbst zählen nie.
- **Zeitversatz**: jede Gruppe von Schaltvorgängen zufällig um bis zu ±15 Minuten; Nachmittag und
  Abend zusätzlich um den Unterschied der Sonnenuntergänge (Koordinaten aus den Systemeinstellungen).
- **Was geschaltet wird**: Lichter (an/aus, Helligkeit) und Rollläden (Position), optional Medien
  an/aus. Heizung, Schlösser, Türen, Tore, Steckdosen, Ventile, Alarme und schreibgeschützte
  Datenpunkte werden nie geschaltet, egal was die Einstellungen sagen.
- **Test**: "Nur loggen, nichts schalten" schreibt jeden geplanten Schaltvorgang ins Log. Der Reiter
  zeigt den Plan für heute (auch vor dem Speichern der Einstellungen),
  `sendTo('recorder.0', 'getSimulationPlan', {})` liefert ihn als Daten.

`recorder.0.simulation.sourceDay`, `nextAction` und `lastAction` zeigen, was die Simulation tut. Eine
laufende Simulation läuft nach einem Neustart der Instanz weiter.

## Anomalieerkennung

Für jeden aufgezeichneten Datenpunkt lernt die Instanz, was in jeder Stunde der Woche üblich ist, und
meldet, was nicht dazu passt. Die Statistik wird immer gesammelt (auch bei abgeschalteter Erkennung,
ein Jahr lang aufbewahrt); ein Profil wird nach einer Lernphase von 14 Tagen verwendet. Die Regeln
werden im Reiter "Anomalien" der Instanzeinstellungen aktiviert und eingestellt.

Beim ersten Start wird die Statistik der vorhandenen Aufzeichnung (bis zu 8 Wochen) im Hintergrund
berechnet; mit 14 Tagen Aufzeichnung arbeiten die Regeln also sofort. Nur "Stiller Sensor" und
"Rasender Datenpunkt" brauchen die gezählten Aktualisierungen, die die Aufzeichnung nicht enthält:
Sie starten nach 7 Tagen.

| Regel                          | Meldet                                                                                                                                       | Standard               |
|--------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|------------------------|
| Ungewöhnlicher Wert            | eine Temperatur, eine Leistung ... weit weg vom üblichen Wert dieser Wochenstunde (z-Wert) und außerhalb von allem, was zu dieser Zeit vorkam | z > 3 für 30 min       |
| Seltene Aktivität              | eine Tür, ein Fenster, Bewegung oder ein Licht in einer Stunde, in der das kaum je vorkommt (die Haustür um 3 Uhr nachts)                     | < 2 % der Wochen       |
| Stiller Sensor                 | keine Aktualisierung für das 4-Fache des üblichen Abstands                                                                                   | mindestens 6 h         |
| Ungewöhnlich lange offen/an    | Fenster, Türen und Lichter, verglichen mit der üblichen Dauer (95. Perzentil)                                                                | 1,5-fach               |
| Fenster offen bei Kälte        | ein Fenster oder eine Tür offen, während es draußen kalt ist                                                                                 | < 5 °C für 30 min      |
| Rasender Datenpunkt            | weit mehr Änderungen pro Stunde als üblich oder gedrosselt durch das Burst-Limit (ein defekter Sensor)                                       | 10-fach                |

- **Abwesenheit**: Solange der Abwesenheits-Datenpunkt aus dem Reiter "Anwesenheitssimulation"
  Abwesenheit meldet, wird jede Bewegung und jedes Öffnen einer Tür oder eines Fensters gemeldet.
- **Außentemperatur**: der eingestellte Datenpunkt, sonst eine aufgezeichnete aktuelle
  Wettertemperatur.
- **Ruhezeit**: höchstens eine Meldung pro Datenpunkt und Regel innerhalb von 12 Stunden. Ein Zustand
  (Fenster bei Kälte, stiller Sensor ...) endet von selbst, wenn er nicht mehr zutrifft.
- **Ausgabe**: `recorder.0.anomaly.active`, `count`, `list` (JSON) und `last`; eine
  ioBroker-Benachrichtigung (im Admin angezeigt, vom Adapter notification-manager weitergeleitet) und
  optional eine Nachricht an eine Instanz wie `telegram.0` oder `pushover.0`.
  `recorder.0.anomaly.ack` bestätigt alle offenen Anomalien.
- **Nachrichten**: `getAnomalies` (`{ start, end, open }`), `getProfile` (`{ id }`: die 168 Stunden
  der Woche mit Mittelwert, Abweichung, Minimum, Maximum und Anteil der Aktivität), `ackAnomaly`
  (`{ id }`, ohne `id`: alle).

## Unterschied zu `history`, `sql` und `influxdb`

|                          | recorder                                                                                                                                                                                                 | `history`, `sql`, `influxdb`                                                                   |
|--------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| Welche Datenpunkte       | automatisch nach ihrer Bedeutung ausgewählt (Type-Detector, Enums, Rollen), dazu Regeln und Ausnahmen pro Datenpunkt                                                                                     | nur Datenpunkte mit Einstellungen in `common.custom`, einzeln konfiguriert                     |
| Was gespeichert wird     | gefiltert nach Rolle (Totband, Mindestabstand, Heartbeat); hochfrequente Zahlen als 5-Minuten-Werte (Minimum, Maximum, Mittelwert, letzter Wert)                                                         | pro Datenpunkt konfiguriert (Entprellen, nur Änderungen ...)                                   |
| Wie lange                | 1, 7, 30 oder 90 Tage Rohdaten für alle Datenpunkte; Stundenstatistik für ein Jahr                                                                                                                      | pro Datenpunkt konfiguriert, auch unbegrenzt                                                   |
| Wer geschaltet hat       | jede Änderung mit `from` und `user`, eingeordnet als Benutzer, Skript, Adapter oder System; genutzt von Journal, Wiedergabe und Simulation                                                              | die Quelle wird nicht ausgewertet                                                              |
| Alle Datenpunkte zu T    | eine Abfrage, beantwortet aus stündlichen Keyframes in Millisekunden (`getSnapshot`)                                                                                                                     | ein `getHistory` pro Datenpunkt                                                                |
| Diagramme und Skripte    | `getHistory` mit denselben Optionen und derselben Aggregation (`@iobroker/aggregate`); echarts ab 6.3.0 listet alle aufgezeichneten Datenpunkte, der Objektbrowser im Admin nur die mit Eintrag in `common.custom` | Objektbrowser im Admin, echarts, Skripte                                                       |
| Schreiben                | nur lesen: kein `storeState`, kein Ändern oder Löschen von Werten; `q` wird nicht gespeichert                                                                                                            | `storeState`, Ändern und Löschen von Werten (je nach Adapter)                                  |
| Datenbank                | SQLite-Dateien im Datenverzeichnis der Instanz, eine pro Woche; kein Server                                                                                                                              | `history`: JSON-Dateien; `sql`: ein Datenbankserver oder SQLite; `influxdb`: ein InfluxDB-Server |
| Darüber hinaus           | Zeitreise, Anwesenheitssimulation, Anomalieerkennung                                                                                                                                                      | -                                                                                              |

Der Recorder läuft neben ihnen. Langzeitarchive in voller Auflösung bleiben Aufgabe von `influxdb`
und `sql`.

## Speicherung

SQLite im Datenverzeichnis der Instanz (`iobroker-data/recorder.0/`):

- `meta.sqlite`: Stammdaten der aufgezeichneten Datenpunkte, Quellen, Statistik
- `ev-YYYY-Www.sqlite`: Änderungen und Keyframes einer ISO-Woche (UTC)

Änderungen werden im Speicher gesammelt und alle 30 Sekunden in einer Transaktion geschrieben
(WAL-Modus), das schont SD-Karten. Die Aufbewahrung löscht täglich um 03:30 ganze Wochendateien.

Benötigt Node.js 22.19 oder neuer (`node:sqlite`, kein natives Modul).
