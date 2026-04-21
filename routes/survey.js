const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
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
    valutazione_competitor TEXT,
    delusioni_miglioramenti TEXT,
    canali_informazione TEXT,
    commento_libero TEXT,
    conversation_json TEXT,
    completed INTEGER DEFAULT 0
  )
`);

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const SYSTEM_PROMPT = `Sei un intervistatore professionale che raccoglie feedback da installatori e idraulici italiani sulla percezione del brand Giacomini.

Conduci una conversazione naturale in italiano seguendo ESATTAMENTE questo flusso di 7 domande nell'ordine indicato. Non saltare domande, non aggiungerne altre.

DOMANDE E TIPO:

1. [APERTA] "Ciao! Sono un assistente che raccoglie opinioni professionali sul brand Giacomini. Grazie per aver dedicato 3 minuti. Prima domanda: che tipo di installazioni fai principalmente? (ad es. riscaldamento, climatizzazione, idrosanitario, misto...)"

2. [CHIUSA - SCELTA SINGOLA] "Quando senti il nome Giacomini, qual e' la prima cosa che ti viene in mente?"
Presenta le opzioni numerate:
1. Qualita' e affidabilita'
2. Prezzo elevato / brand premium
3. Innovazione e tecnologia
4. Difficile da reperire / poca distribuzione
5. Non la conosco bene
Chiedi di rispondere con il numero o il testo dell'opzione.

3. [APERTA] "Hai mai usato prodotti Giacomini? Se si', quali prodotti in particolare?"

4. [CHIUSA - SCELTA SINGOLA] "Come valuteresti Giacomini rispetto ai principali competitor che usi?"
Presenta le opzioni numerate:
1. Migliore dei competitor
2. Alla pari con i principali brand
3. Leggermente inferiore
4. Decisamente inferiore
5. Non ho basi per confrontare
Chiedi di rispondere con il numero o il testo dell'opzione.

5. [APERTA] Basandoti sulle risposte precedenti, adatta questa domanda in modo naturale. Se ha detto di aver usato i prodotti: "C'e' qualcosa che ti ha deluso di Giacomini o che miglioreresti?" Se non li ha usati: "Cosa ti frena dall'usare o provare prodotti Giacomini?"

6. [CHIUSA - SCELTA MULTIPLA] "Dove ti informi principalmente su nuovi prodotti per il tuo lavoro?"
Presenta le opzioni numerate (puo' scegliere piu' opzioni):
1. Rappresentanti commerciali
2. Fiere di settore (MCE, Klimahouse...)
3. Riviste specializzate
4. YouTube / social media
5. Colleghi e passaparola
6. Sito del produttore / catalogo
Chiedi di rispondere con i numeri separati da virgola.

7. [APERTA] Basandoti sull'intera conversazione, formula una domanda finale personalizzata e aperta che inviti a condividere pensieri non ancora emersi su Giacomini o il settore. Poi ringrazia calorosamente per il tempo dedicato.

REGOLE IMPORTANTI:
- Rispondi SEMPRE in italiano
- Sii cordiale ma professionale
- Per le domande chiuse, accetta sia il numero che il testo dell'opzione
- Dopo la domanda 7 e la risposta dell'utente, concludi con un messaggio di ringraziamento finale e la parola chiave [SURVEY_COMPLETE]
- Non aggiungere commenti o analisi alle risposte dell'utente, passa semplicemente alla domanda successiva
- Tieni traccia internamente di quale domanda stai ponendo (1-7)`;

const sessions = new Map();

router.post('/message', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], questionIndex: 0 });
    db.prepare('INSERT OR IGNORE INTO responses (session_id) VALUES (?)').run(sessionId);
  }

  const session = sessions.get(sessionId);

  if (message) {
    session.messages.push({ role: 'user', content: message });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: session.messages,
    });

    const assistantText = response.content[0].text;
    session.messages.push({ role: 'assistant', content: assistantText });

    const isComplete = assistantText.includes('[SURVEY_COMPLETE]');
    const displayText = assistantText.replace('[SURVEY_COMPLETE]', '').trim();

    if (isComplete) {
      saveResponses(sessionId, session.messages);
    }

    res.json({ reply: displayText, complete: isComplete });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella conversazione' });
  }
});

function saveResponses(sessionId, messages) {
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.content);
  db.prepare(`
    UPDATE responses SET
      tipo_installazioni = ?,
      prima_associazione = ?,
      uso_prodotti = ?,
      valutazione_competitor = ?,
      delusioni_miglioramenti = ?,
      canali_informazione = ?,
      commento_libero = ?,
      conversation_json = ?,
      completed = 1
    WHERE session_id = ?
  `).run(
    userMessages[0] || null,
    userMessages[1] || null,
    userMessages[2] || null,
    userMessages[3] || null,
    userMessages[4] || null,
    userMessages[5] || null,
    userMessages[6] || null,
    JSON.stringify(messages),
    sessionId
  );
}

router.get('/results', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM responses').get().count;
  const completed = db.prepare('SELECT COUNT(*) as count FROM responses WHERE completed = 1').get().count;
  const recent = db.prepare(`
    SELECT id, created_at, tipo_installazioni, prima_associazione, valutazione_competitor, completed
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
    SELECT valutazione_competitor, COUNT(*) as count
    FROM responses WHERE completed = 1 AND valutazione_competitor IS NOT NULL
    GROUP BY valutazione_competitor ORDER BY count DESC
  `).all();
  const allCompleted = db.prepare('SELECT * FROM responses WHERE completed = 1').all();
  res.json({ total, completed, recent, byType, byAssociation, byRating, allCompleted });
});

module.exports = router;
