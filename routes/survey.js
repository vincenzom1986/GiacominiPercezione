'use strict';

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../db/survey.db'));

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

const existingCols = db.prepare('PRAGMA table_info(responses)').all().map(c => c.name);
const newCols = [
  ['prodotti_usati', 'TEXT'], ['valutazione_qualita', 'INTEGER'],
  ['valutazione_facilita', 'INTEGER'], ['valutazione_prezzo', 'INTEGER'],
  ['valutazione_disponibilita', 'INTEGER'], ['valutazione_assistenza', 'INTEGER'],
  ['valutazione_formazione', 'INTEGER'], ['nps', 'INTEGER'],
  ['competitor_usati', 'TEXT'], ['barriera_non_utilizzo', 'TEXT'],
  ['leva_attivazione', 'TEXT'], ['driver_scelta', 'TEXT'],
  ['contenuto_preferito', 'TEXT'], ['anni_attivita', 'TEXT'], ['regione', 'TEXT'],
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
"Hai usato prodotti Giacomini negli ultimi 24 mesi?
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

Q4A [SCALA 1-5 su 6 dimensioni]
"Valuta Giacomini da 1 (pessimo) a 5 (ottimo) su questi aspetti. Rispondi con 6 numeri separati da virgola nell'ordine indicato:
1. Qualità materiali
2. Facilità installazione
3. Rapporto qualità/prezzo
4. Disponibilità in magazzino
5. Assistenza tecnica
6. Formazione/supporto commerciale
Esempio: 4,3,5,2,4,3"

Q5A [NPS 0-10]
"Da 0 a 10, quanto consiglieresti Giacomini a un collega? (solo il numero)"

Q6A [MULTIPLA MAX 3]
"Quali altri brand hai comprato negli ultimi 12 mesi? Scegli max 3.
1. Caleffi
2. Herz
3. Oventrop
4. Danfoss
5. Ivar
6. Honeywell Resideo
7. RBM
8. Altro"

═══ SE Q3 = No → PERCORSO NON UTILIZZATORI ═══

Q4B [SCELTA SINGOLA]
"Perché non hai ancora provato Giacomini?
1. Non la trovo dal mio grossista
2. Prezzo percepito alto
3. Sono abituato ad altro brand
4. Non conosco i prodotti
5. Nessun contatto commerciale
6. Esperienza negativa passata"

Q5B [SCELTA SINGOLA]
"Cosa ti farebbe provare Giacomini per la prima volta?
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
4. Facilità installazione
5. Assistenza post-vendita
6. Rapporto con il rappresentante
7. Formazione"

Q8 [SCELTA SINGOLA]
"Dove ti informi principalmente su nuovi prodotti?
1. Rappresentanti commerciali
2. Fiere (MCE, Klimahouse…)
3. Riviste specializzate
4. YouTube / social media
5. Colleghi e passaparola
6. Sito produttore / catalogo"

Q9 [SCELTA SINGOLA]
"Se Giacomini realizzasse un contenuto utile, quale preferiresti?
1. Video montaggio collettore
2. Confronto diretto con Caleffi
3. Guida dimensionamento radiante
4. Casi reali di cantiere
5. Novità normative"

Q10a [SCELTA SINGOLA]
"Due ultime domande. Quanti anni di attività hai?
1. Meno di 5 anni
2. Da 5 a 15 anni
3. Oltre 15 anni"

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

router.post('/message', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [] });
    db.prepare('INSERT OR IGNORE INTO responses (session_id) VALUES (?)').run(sessionId);
  }

  const session = sessions.get(sessionId);
  if (message) session.messages.push({ role: 'user', content: message });

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
      const dataMatch = assistantText.match(/\[DATA:(.*?)\]$/s);
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
      .replace(/\[DATA:.*?\]$/s, '')
      .trim();

    res.json({ reply: displayText, complete: isComplete });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella conversazione' });
  }
});

function saveResponses(sessionId, messages, d) {
  const vals = (d.valutazione || '').split(',').map(v => parseInt(v.trim()) || null);
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
    SELECT id, created_at, tipo_installazioni, prima_associazione, nps, uso_prodotti, completed
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

  const allCompleted = db.prepare('SELECT * FROM responses WHERE completed = 1').all();

  res.json({ total, completed, recent, byType, byAssociation, byRating, avgNps, allCompleted });
});

module.exports = router;
