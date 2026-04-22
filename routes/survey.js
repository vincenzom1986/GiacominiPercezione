'use strict';

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure db directory exists (Railway has ephemeral filesystem — directory may be absent)
const DB_DIR = path.join(__dirname, '../db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'survey.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    tipo_installazioni TEXT,
    prima_associazione TEXT,
    uso_prodotti TEXT,
    prodotti_usati TEXT,
    valutazione_qualita INTEGER,
    valutazione_facilita INTEGER,
    valutazione_prezzo INTEGER,
    valutazione_disponibilita INTEGER,
    valutazione_assistenza INTEGER,
    valutazione_formazione INTEGER,
    nps INTEGER,
    competitor_usati TEXT,
    barriera_non_utilizzo TEXT,
    leva_attivazione TEXT,
    driver_scelta TEXT,
    canali_informazione TEXT,
    contenuto_preferito TEXT,
    anni_attivita TEXT,
    regione TEXT,
    conversation_json TEXT,
    completed INTEGER DEFAULT 0
  )
`);

// Migrate existing table: add new columns if missing
const existingCols = db.prepare('PRAGMA table_info(responses)').all().map(c => c.name);
const newCols = [
  ['prodotti_usati', 'TEXT'], ['valutazione_qualita', 'INTEGER'],
  ['valutazione_facilita', 'INTEGER'], ['valutazione_prezzo', 'INTEGER'],
  ['valutazione_disponibilita', 'INTEGER'], ['valutazione_assistenza', 'INTEGER'],
  ['valutazione_formazione', 'INTEGER'], ['nps', 'INTEGER'],
  ['competitor_usati', 'TEXT'], ['barriera_non_utilizzo', 'TEXT'],
  ['leva_attivazione', 'TEXT'], ['driver_scelta', 'TEXT'],
  ['canali_informazione', 'TEXT'], ['contenuto_preferito', 'TEXT'],
  ['anni_attivita', 'TEXT'], ['regione', 'TEXT'],
];
for (const [col, type] of newCols) {
  if (!existingCols.includes(col)) db.exec(`ALTER TABLE responses ADD COLUMN ${col} ${type}`);
}

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const SYSTEM_PROMPT = `Sei un intervistatore professionale che raccoglie feedback da installatori e idraulici italiani sul brand Giacomini.

LINGUA: rispondi SEMPRE in italiano.
STILE: cordiale e professionale. Non commentare le risposte, passa direttamente alla domanda successiva.
SCALE: quando ricevi risposte del tipo "4 – Buono" o "3 – Sufficiente", usa solo il numero iniziale come valore numerico.

FLUSSO SURVEY — segui ESATTAMENTE questo ordine:

Q1 [TUTTI | SCELTA SINGOLA]
"Ciao! Raccogliamo opinioni professionali sul brand Giacomini. Ci vogliono circa 4 minuti, grazie per il tuo contributo!

Iniziamo: che tipo di installazioni fai principalmente?
1. Riscaldamento
2. Climatizzazione
3. Idrosanitario
4. Misto"

Q2 [TUTTI | SCELTA SINGOLA]
"Quando senti il nome Giacomini, qual è la prima cosa che ti viene in mente?
1. Qualità e affidabilità
2. Made in Italy / tradizione
3. Prezzo elevato / premium
4. Innovazione e tecnologia
5. Difficile da reperire
6. Non la conosco bene"

Q3 [TUTTI | SCELTA SINGOLA]
"Hai usato prodotti Giacomini negli ultimi 12 mesi?
1. Sì
2. No"

Q3 FOLLOW-UP solo se risponde Sì:
"Quali prodotti hai utilizzato? (puoi sceglierne più di uno)
1. Valvole e detentori
2. Collettori
3. Sistemi radianti a pavimento
4. Contabilizzazione calore
5. Regolazione
6. Altro"

═══ SE Q3 = Sì → PERCORSO UTILIZZATORI ═══

Q4A [SCALA 1-5 su 6 dimensioni — chiedi UNA DIMENSIONE ALLA VOLTA]
Fai le 6 sotto-domande nell'ordine esatto, aspettando la risposta prima di procedere.
Ogni sotto-domanda deve avere esattamente questo formato (5 opzioni su righe separate):

[testo domanda]
1. 1 – Pessimo
2. 2 – Scarso
3. 3 – Sufficiente
4. 4 – Buono
5. 5 – Ottimo

Le 6 sotto-domande:
1. "Valutiamo Giacomini su 6 aspetti, uno alla volta. Come giudichi la qualità dei materiali?"
2. "La facilità di installazione?"
3. "Il rapporto qualità/prezzo?"
4. "La disponibilità in magazzino dal tuo grossista?"
5. "L'assistenza tecnica?"
6. "Il supporto formativo e commerciale?"

Dopo la sesta risposta memorizza i 6 valori numerici e procedi con Q5A.
Nel blocco DATA riportali come "v1,v2,v3,v4,v5,v6" (es: "4,3,5,2,4,3").

Q5A [NPS 0-10 — usa ESATTAMENTE 11 opzioni numerate, nient'altro]
"Con quale probabilità consiglieresti Giacomini a un collega? (0 = per niente, 10 = assolutamente sì)
1. 0
2. 1
3. 2
4. 3
5. 4
6. 5
7. 6
8. 7
9. 8
10. 9
11. 10"

Q6A [MULTIPLA MAX 3]
"Quali altri brand hai acquistato negli ultimi 12 mesi? Scegli max 3.
1. Caleffi
2. Herz
3. Oventrop
4. Danfoss
5. Ivar
6. Honeywell Resideo
7. FAR Rubinetterie
8. WATTS
9. RBM
10. Altro"

═══ SE Q3 = No → PERCORSO NON UTILIZZATORI ═══

ROUTING: Se il rispondente ha risposto "Non la conosco bene" a Q2, SALTA Q4B e vai
direttamente a Q5B — chi non conosce il brand non può motivare la mancata scelta.

Q4B [SCELTA SINGOLA — salta se Q2 = "Non la conosco bene"]
"Perché non hai usato prodotti Giacomini?
1. Non li trovo dal mio grossista
2. Prezzo percepito alto
3. Sono abituato ad altro brand
4. Non conosco bene i prodotti
5. Nessun contatto commerciale
6. Esperienza negativa passata"

Q5B [SCELTA SINGOLA]
"Cosa ti farebbe provare Giacomini?
1. Kit prova gratuito
2. Video tutorial 2 min su YouTube
3. Corso online con attestato
4. Sconto primo ordine
5. Visita tecnico commerciale"

═══ TUTTI (dopo il percorso) ═══

Q7 [MULTIPLA MAX 3]
"Quando scegli un brand, cosa conta di più? Scegli max 3.
1. Prezzo
2. Affidabilità nel tempo
3. Disponibilità immediata
4. Formazione e supporto tecnico
5. Facilità installazione
6. Assistenza post-vendita
7. Rapporto con il rappresentante"

Q8 [SCELTA SINGOLA]
"Dove ti informi principalmente su nuovi prodotti?
1. Rappresentanti commerciali
2. Fiere di settore (MCE, ISH…)
3. Riviste specializzate
4. YouTube / social media
5. Colleghi e passaparola
6. Sito produttore / catalogo"

Q9 [SCELTA SINGOLA]
"Se Giacomini realizzasse un contenuto utile, quale preferiresti?
1. Video montaggio collettore
2. Confronto tecnico tra soluzioni
3. Guida dimensionamento radiante
4. Casi reali di cantiere
5. Novità normative"

Q10a [SCELTA SINGOLA]
"Due ultime domande. Quanti anni di attività hai?
1. Meno di 3 anni
2. Da 3 a 10 anni
3. Da 10 a 20 anni
4. Oltre 20 anni"

Q10b [SCELTA SINGOLA]
"In quale area geografica lavori principalmente?
1. Nord-Ovest
2. Nord-Est
3. Centro
4. Sud e Isole"

═══ CHIUSURA ═══
Dopo Q10b ringrazia calorosamente, poi emetti ESATTAMENTE questo blocco finale (JSON valido, null senza virgolette per campi non applicabili):

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"<Q1>","prima_associazione":"<Q2>","uso_prodotti":"<si o no>","prodotti_usati":"<Q3 follow-up o null>","valutazione":"<Q4A es 4,3,5,2,4,3 o null>","nps":<Q5A numero intero o null>,"competitor_usati":"<Q6A o null>","barriera_non_utilizzo":"<Q4B o null>","leva_attivazione":"<Q5B o null>","driver_scelta":"<Q7>","canali_informazione":"<Q8>","contenuto_preferito":"<Q9>","anni_attivita":"<Q10a>","regione":"<Q10b>"}]`;

const sessions = new Map();

// Remove sessions inactive for more than 2 hours to prevent memory growth
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.lastActivity < cutoff) sessions.delete(id);
  }
}, 30 * 60 * 1000);

router.post('/message', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], lastActivity: Date.now() });
    db.prepare('INSERT OR IGNORE INTO responses (session_id) VALUES (?)').run(sessionId);
  }

  const session = sessions.get(sessionId);
  session.lastActivity = Date.now();
  // Always push a user turn so the conversation never starts with an assistant message
  // (Groq rejects conversations where the first turn is 'assistant')
  session.messages.push({ role: 'user', content: message || 'Inizia' });

  try {
    const response = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.messages,
      ],
    });

    const assistantText = response.choices[0].message.content;
    session.messages.push({ role: 'assistant', content: assistantText });

    const isComplete = assistantText.includes('[SURVEY_COMPLETE]');

    if (isComplete) {
      const dataMatch = assistantText.match(/\[DATA:(\{[\s\S]*?\})\]/);
      if (dataMatch) {
        try {
          const data = JSON.parse(dataMatch[1]);
          saveResponses(sessionId, session.messages, data);
        } catch (e) {
          console.error('DATA parse error:', e.message, dataMatch[1]);
          saveConversation(sessionId, session.messages);
        }
      } else {
        saveConversation(sessionId, session.messages);
      }
    }

    const displayText = assistantText
      .replace('[SURVEY_COMPLETE]', '')
      .replace(/\[DATA:\{[\s\S]*?\}\]/, '')
      .trim();

    res.json({ reply: displayText, complete: isComplete });
  } catch (err) {
    const errStatus = err.status || 'no-status';
    const errMsg = err.message || String(err);
    console.error('[survey] Groq error:', errStatus, errMsg);
    res.status(500).json({
      reply: `[DEBUG] Groq ${errStatus}: ${errMsg.substring(0, 300)}`,
      complete: false,
    });
  }
});

// Diagnostic endpoint — tests Groq connectivity directly
router.get('/test-groq', async (req, res) => {
  try {
    const r = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 30,
      messages: [{ role: 'user', content: 'Rispondi solo: OK' }],
    });
    res.json({ ok: true, reply: r.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, status: err.status });
  }
});

function saveResponses(sessionId, messages, d) {
  const vals = (d.valutazione || '').split(/[\s,;/\-]+/).map(v => parseInt(v.trim()) || null);
  db.prepare(`
    UPDATE responses SET
      tipo_installazioni = ?, prima_associazione = ?,
      uso_prodotti = ?, prodotti_usati = ?,
      valutazione_qualita = ?, valutazione_facilita = ?, valutazione_prezzo = ?,
      valutazione_disponibilita = ?, valutazione_assistenza = ?, valutazione_formazione = ?,
      nps = ?, competitor_usati = ?,
      barriera_non_utilizzo = ?, leva_attivazione = ?,
      driver_scelta = ?, canali_informazione = ?, contenuto_preferito = ?,
      anni_attivita = ?, regione = ?,
      conversation_json = ?, completed = 1
    WHERE session_id = ?
  `).run(
    d.tipo_installazioni || null, d.prima_associazione || null,
    d.uso_prodotti || null, d.prodotti_usati || null,
    vals[0] || null, vals[1] || null, vals[2] || null,
    vals[3] || null, vals[4] || null, vals[5] || null,
    d.nps !== undefined && d.nps !== null ? Number(d.nps) : null,
    d.competitor_usati || null,
    d.barriera_non_utilizzo || null, d.leva_attivazione || null,
    d.driver_scelta || null, d.canali_informazione || null, d.contenuto_preferito || null,
    d.anni_attivita || null, d.regione || null,
    JSON.stringify(messages), sessionId
  );
}

function saveConversation(sessionId, messages) {
  db.prepare('UPDATE responses SET conversation_json = ?, completed = 1 WHERE session_id = ?')
    .run(JSON.stringify(messages), sessionId);
}

router.get('/results', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM responses').get().count;
  const completed = db.prepare('SELECT COUNT(*) as count FROM responses WHERE completed = 1').get().count;

  const recent = db.prepare(`
    SELECT id, created_at, tipo_installazioni, prima_associazione, nps, uso_prodotti, regione, anni_attivita, completed
    FROM responses ORDER BY created_at DESC LIMIT 20
  `).all();

  const byType = db.prepare(`
    SELECT tipo_installazioni, COUNT(*) as count
    FROM responses WHERE completed = 1 AND tipo_installazioni IS NOT NULL
    GROUP BY tipo_installazioni
  `).all();

  const byAssociation = db.prepare(`
    SELECT prima_associazione, COUNT(*) as count
    FROM responses WHERE completed = 1 AND prima_associazione IS NOT NULL
    GROUP BY prima_associazione ORDER BY count DESC
  `).all();

  const byRating = db.prepare(`
    SELECT
      CASE
        WHEN nps >= 9 THEN 'Promotori (9-10)'
        WHEN nps >= 7 THEN 'Passivi (7-8)'
        WHEN nps IS NOT NULL THEN 'Detrattori (0-6)'
        ELSE 'n.d.'
      END as valutazione_competitor,
      COUNT(*) as count
    FROM responses WHERE completed = 1
    GROUP BY 1 ORDER BY count DESC
  `).all();

  const avgNps = db.prepare(`
    SELECT ROUND(AVG(nps), 1) as avg FROM responses WHERE completed = 1 AND nps IS NOT NULL
  `).get().avg;

  const avgValutazioni = db.prepare(`
    SELECT
      ROUND(AVG(valutazione_qualita), 1) as qualita,
      ROUND(AVG(valutazione_facilita), 1) as facilita,
      ROUND(AVG(valutazione_prezzo), 1) as prezzo,
      ROUND(AVG(valutazione_disponibilita), 1) as disponibilita,
      ROUND(AVG(valutazione_assistenza), 1) as assistenza,
      ROUND(AVG(valutazione_formazione), 1) as formazione
    FROM responses WHERE completed = 1
  `).get();

  const byBarriera = db.prepare(`
    SELECT barriera_non_utilizzo as label, COUNT(*) as count
    FROM responses WHERE completed = 1 AND barriera_non_utilizzo IS NOT NULL
    GROUP BY barriera_non_utilizzo ORDER BY count DESC
  `).all();

  const byLeva = db.prepare(`
    SELECT leva_attivazione as label, COUNT(*) as count
    FROM responses WHERE completed = 1 AND leva_attivazione IS NOT NULL
    GROUP BY leva_attivazione ORDER BY count DESC
  `).all();

  const byRegione = db.prepare(`
    SELECT regione as label, COUNT(*) as count
    FROM responses WHERE completed = 1 AND regione IS NOT NULL
    GROUP BY regione ORDER BY count DESC
  `).all();

  const byAnni = db.prepare(`
    SELECT anni_attivita as label, COUNT(*) as count
    FROM responses WHERE completed = 1 AND anni_attivita IS NOT NULL
    GROUP BY anni_attivita ORDER BY count DESC
  `).all();

  // Multi-select fields: split comma-separated values and count individually
  function parseMulti(field) {
    const rows = db.prepare(`SELECT ${field} FROM responses WHERE completed = 1 AND ${field} IS NOT NULL`).all();
    const counts = {};
    rows.forEach(r => {
      (r[field] || '').split(/[,;]+/).forEach(item => {
        const key = item.trim();
        if (key) counts[key] = (counts[key] || 0) + 1;
      });
    });
    return Object.entries(counts).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  }

  const byCompetitor = parseMulti('competitor_usati');
  const byDriver = parseMulti('driver_scelta');

  const byCanale = db.prepare(`
    SELECT canali_informazione as label, COUNT(*) as count
    FROM responses WHERE completed = 1 AND canali_informazione IS NOT NULL
    GROUP BY canali_informazione ORDER BY count DESC
  `).all();

  const byContenuto = db.prepare(`
    SELECT contenuto_preferito as label, COUNT(*) as count
    FROM responses WHERE completed = 1 AND contenuto_preferito IS NOT NULL
    GROUP BY contenuto_preferito ORDER BY count DESC
  `).all();

  const allCompleted = db.prepare('SELECT * FROM responses WHERE completed = 1').all();

  res.json({
    total, completed, recent, byType, byAssociation, byRating,
    avgNps, avgValutazioni, byBarriera, byLeva, byRegione, byAnni,
    byCompetitor, byDriver, byCanale, byContenuto, allCompleted,
  });
});

// CSV export — scarica tutti i dati come file Excel-compatibile
router.get('/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM responses WHERE completed = 1 ORDER BY created_at ASC').all();

  const cols = [
    'id', 'session_id', 'created_at',
    'tipo_installazioni', 'prima_associazione', 'uso_prodotti', 'prodotti_usati',
    'valutazione_qualita', 'valutazione_facilita', 'valutazione_prezzo',
    'valutazione_disponibilita', 'valutazione_assistenza', 'valutazione_formazione',
    'nps', 'competitor_usati', 'barriera_non_utilizzo', 'leva_attivazione',
    'driver_scelta', 'canali_informazione', 'contenuto_preferito',
    'anni_attivita', 'regione',
  ];

  const escape = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };

  const lines = [
    cols.join(','),
    ...rows.map(r => cols.map(c => escape(r[c])).join(',')),
  ];

  const filename = `giacomini_survey_${new Date().toISOString().slice(0,10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + lines.join('\r\n')); // BOM per Excel italiano
});

module.exports = router;
