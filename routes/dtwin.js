'use strict';

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '../db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'survey.db'));

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  -- Persistent twin registry (shadow state — Park et al. + Ditto pattern)
  CREATE TABLE IF NOT EXISTS twins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    nome TEXT, eta INTEGER, genere TEXT DEFAULT 'M',
    regione_it TEXT, regione TEXT,
    tipo_installazioni TEXT, anni_attivita TEXT,
    personalita TEXT,       -- psychographic profile (2 sentences)
    relazione_brand TEXT,   -- historical relationship with Giacomini + competitors
    persona_prompt TEXT,    -- full first-person silicon sampling prompt
    memoria_summary TEXT,   -- reflection synthesis of past responses (Park et al.)
    n_interviews INTEGER DEFAULT 0
  );

  -- Per-session response records (reported state)
  CREATE TABLE IF NOT EXISTS twin_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twin_id INTEGER NOT NULL, session_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    tipo_installazioni TEXT, prima_associazione TEXT,
    uso_prodotti TEXT, prodotti_usati TEXT,
    valutazione_qualita INTEGER, valutazione_facilita INTEGER,
    valutazione_prezzo INTEGER, valutazione_disponibilita INTEGER,
    valutazione_assistenza INTEGER, valutazione_formazione INTEGER,
    nps INTEGER, competitor_usati TEXT,
    barriera_non_utilizzo TEXT, leva_attivazione TEXT,
    driver_scelta TEXT, canali_informazione TEXT,
    contenuto_preferito TEXT, anni_attivita TEXT, regione TEXT
  );

  -- Generation sessions
  CREATE TABLE IF NOT EXISTS twin_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    objective TEXT, industry TEXT, target_age TEXT, location TEXT,
    n_recruited INTEGER DEFAULT 0, n_created INTEGER DEFAULT 0,
    rationale TEXT, stratification TEXT
  );

  -- Session ↔ Twin mapping
  CREATE TABLE IF NOT EXISTS twin_session_map (
    session_id INTEGER, twin_id INTEGER
  );

  -- Legacy tables (kept for backward compatibility)
  CREATE TABLE IF NOT EXISTS dtwin_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')),
    objective TEXT, industry TEXT, target_age TEXT, location TEXT,
    n_generated INTEGER DEFAULT 0, rationale TEXT, stratification TEXT
  );
  CREATE TABLE IF NOT EXISTS dtwin_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, persona_json TEXT,
    tipo_installazioni TEXT, prima_associazione TEXT, uso_prodotti TEXT, prodotti_usati TEXT,
    valutazione_qualita INTEGER, valutazione_facilita INTEGER, valutazione_prezzo INTEGER,
    valutazione_disponibilita INTEGER, valutazione_assistenza INTEGER, valutazione_formazione INTEGER,
    nps INTEGER, competitor_usati TEXT, barriera_non_utilizzo TEXT, leva_attivazione TEXT,
    driver_scelta TEXT, canali_informazione TEXT, contenuto_preferito TEXT,
    anni_attivita TEXT, regione TEXT
  )
`);

// ── AI client ─────────────────────────────────────────────────────────────────
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || 'no-key',
  baseURL: 'https://api.groq.com/openai/v1',
});

async function groq(system, user, maxTokens, temp = 0.7) {
  for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
    try {
      const r = await client.chat.completions.create({
        model, max_tokens: maxTokens, temperature: temp,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return r.choices[0].message.content;
    } catch (err) {
      if (err.status === 429 && model !== 'llama-3.1-8b-instant') continue;
      throw err;
    }
  }
}

function parseJSONObjects(raw) {
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) { const p = JSON.parse(m[0]); if (Array.isArray(p)) return p; }
  } catch {}
  const objects = [];
  const re = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.nome || obj.eta || obj.tipo_installazioni) objects.push(obj);
    } catch {}
  }
  return objects;
}

// ── Silicon sampling persona prompt (Argyle et al. 2023) ──────────────────────
// First-person conditioning: LLM encodes opinion distributions for demographics
function buildPersonaPrompt(twin) {
  const specMap = {
    'Misto': 'impianti misti (riscaldamento, idrosanitario, climatizzazione)',
    'Riscaldamento': 'impianti di riscaldamento e termoidraulica',
    'Idrosanitario': 'impianti idrosanitari e acqua',
    'Climatizzazione': 'impianti di climatizzazione e pompe di calore',
  };
  return `Sono ${twin.nome}, ${twin.eta} anni, installatore idraulico con studio a ${twin.regione_it || twin.regione}.
Lavoro principalmente su ${specMap[twin.tipo_installazioni] || twin.tipo_installazioni} — ho ${twin.anni_attivita} di esperienza nel settore.
${twin.personalita || ''}
${twin.relazione_brand || ''}
${twin.memoria_summary ? '\nMiei ricordi e opinioni maturate nel tempo:\n' + twin.memoria_summary : ''}`;
}

// ── Interview system prompt (silicon sampling conditioning) ────────────────────
const SYS_INTERVIEW = `Sei un intervistato in una survey di mercato B2B sul settore idrotermosanitario italiano.
Rispondi SEMPRE in prima persona, in carattere, come la persona descritta.
Sii specifico e naturale — un professionista del settore, non un questionario.

VALORI ESATTI (usa solo questi):
prima_associazione: "Qualità e affidabilità"|"Made in Italy / tradizione"|"Prezzo elevato / premium"|"Innovazione e tecnologia"|"Difficile da reperire"|"Non la conosco bene"
uso_prodotti: "Sì"|"No"
canali_informazione: max 3, da: "Rappresentanti commerciali","Fiere di settore","Riviste specializzate","YouTube e social","Colleghi e passaparola","Sito del produttore"
contenuto_preferito: "Video installazione"|"Schede tecniche PDF"|"Corsi di formazione"|"Post social"|"Catalogo prodotti"|"Newsletter"
driver_scelta: max 3, da: "Affidabilità nel tempo","Disponibilità immediata","Prezzo competitivo","Supporto tecnico","Familiarità col brand","Consiglio del fornitore"

REGOLE COERENZA (obbligatorie):
- uso_prodotti="Sì" → valutazioni_* 1-5 non null, nps 0-10 non null, barriera=null, leva=null
- uso_prodotti="No" → valutazioni_* null, nps null, barriera non null, leva non null
- prima_associazione="Non la conosco bene" → uso_prodotti="No" sempre
- Rispondi SOLO con un oggetto JSON. Zero testo fuori dal JSON.`;

async function interviewTwin(twin, sessionId) {
  const personaPrompt = twin.persona_prompt || buildPersonaPrompt(twin);
  const systemMsg = personaPrompt + '\n\n' + SYS_INTERVIEW;

  const userMsg = `Rispondi alla survey Giacomini come ${twin.nome}.
Compila questo JSON (tutti i campi, rispetta i valori ammessi):
{"prima_associazione":"...","uso_prodotti":"Sì|No","prodotti_usati":"stringa o null","valutazione_qualita":1-5|null,"valutazione_facilita":1-5|null,"valutazione_prezzo":1-5|null,"valutazione_disponibilita":1-5|null,"valutazione_assistenza":1-5|null,"valutazione_formazione":1-5|null,"nps":0-10|null,"competitor_usati":"stringa o null","barriera_non_utilizzo":"stringa o null","leva_attivazione":"stringa o null","driver_scelta":"stringa","canali_informazione":"stringa","contenuto_preferito":"stringa"}`;

  try {
    const raw = await groq(systemMsg, userMsg, 420, 0.8);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in response');
    const parsed = JSON.parse(m[0]);
    console.log(`[dtwin] ${twin.nome}: uso=${parsed.uso_prodotti}, nps=${parsed.nps}, assoc=${parsed.prima_associazione}`);
    return parsed;
  } catch (err) {
    console.error(`[dtwin] interview failed for ${twin.nome}:`, err.message);
    return null;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/dtwin/twins
router.get('/twins', (req, res) => {
  const twins = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM twin_responses tr WHERE tr.twin_id = t.id) AS total_interviews,
      (SELECT tr.nps FROM twin_responses tr WHERE tr.twin_id = t.id ORDER BY tr.created_at DESC LIMIT 1) AS last_nps,
      (SELECT tr.prima_associazione FROM twin_responses tr WHERE tr.twin_id = t.id ORDER BY tr.created_at DESC LIMIT 1) AS last_assoc,
      (SELECT tr.uso_prodotti FROM twin_responses tr WHERE tr.twin_id = t.id ORDER BY tr.created_at DESC LIMIT 1) AS last_uso
    FROM twins t ORDER BY t.created_at DESC LIMIT 200
  `).all();
  res.json(twins);
});

// GET /api/dtwin/twins/:id
router.get('/twins/:id', (req, res) => {
  const twin = db.prepare('SELECT * FROM twins WHERE id=?').get(req.params.id);
  if (!twin) return res.status(404).json({ error: 'not found' });
  const responses = db.prepare('SELECT * FROM twin_responses WHERE twin_id=? ORDER BY created_at DESC').all(req.params.id);
  res.json({ twin, responses });
});

// DELETE /api/dtwin/twins/:id
router.delete('/twins/:id', (req, res) => {
  db.prepare('DELETE FROM twin_responses WHERE twin_id=?').run(req.params.id);
  db.prepare('DELETE FROM twin_session_map WHERE twin_id=?').run(req.params.id);
  db.prepare('DELETE FROM twins WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/dtwin/generate
router.post('/generate', async (req, res) => {
  const { objective, industry, targetAge, location } = req.body;
  if (!objective || objective.trim().length < 10) {
    return res.status(400).json({ error: 'Descrivi l\'obiettivo (min 10 caratteri)' });
  }

  try {
    // ── Call 1: Analysis (N + stratification) ────────────────────────────────
    const analysisRaw = await groq(
      'Ricercatore di mercato HVAC italiano. Calcola n=z²p(1-p)/e². Esplorativa→20, descrittiva→24. N tra 16 e 24. Solo JSON valido.',
      `Obiettivo: "${objective}"\nIndustry: ${industry||'Installatori IT'}\nTarget: ${targetAge||'tutti'}\nLocation: ${location||'Italia'}
JSON: {"n":<16-24>,"rationale":"<2 frasi>","test_type":"esplorativa|descrittiva","stratification":{"geographic":{"Nord-Ovest":<pct>,"Nord-Est":<pct>,"Centro":<pct>,"Sud e Isole":<pct>},"specialty":{"Misto":<pct>,"Riscaldamento":<pct>,"Idrosanitario":<pct>,"Climatizzazione":<pct>},"giacomini_users_pct":<25-45>}}`,
      500
    );

    let analysis;
    try { const m = analysisRaw.match(/\{[\s\S]*\}/); analysis = JSON.parse(m ? m[0] : analysisRaw); }
    catch { analysis = { n: 20, rationale: 'Campione esplorativo n=20.', test_type: 'esplorativa', stratification: { geographic: { 'Nord-Ovest': 28, 'Nord-Est': 17, 'Centro': 25, 'Sud e Isole': 30 }, specialty: { Misto: 40, Riscaldamento: 30, Idrosanitario: 20, Climatizzazione: 10 }, giacomini_users_pct: 38 } }; }

    const n = Math.min(Math.max(parseInt(analysis.n) || 20, 16), 24);
    const strat = analysis.stratification || {};

    const sessRow = db.prepare('INSERT INTO twin_sessions (objective,industry,target_age,location,rationale,stratification) VALUES (?,?,?,?,?,?)').run(objective, industry||'', targetAge||'', location||'', analysis.rationale||'', JSON.stringify(strat));
    const sessionId = sessRow.lastInsertRowid;

    // ── Call 2: Generate rich psychographic personas ─────────────────────────
    const personasRaw = await groq(
      'Genera profili demografici e psicografici ricchi di installatori idraulici italiani. personalita e relazione_brand devono essere specifici, realistici, non generici. Array JSON. Inizia subito con [.',
      `Ricerca: "${objective}"
Stratificazione: ${JSON.stringify(strat)}${targetAge ? '\nTarget età: '+targetAge : ''}${location ? '\nArea: '+location : ''}

Genera ESATTAMENTE ${n} profili. Array JSON, ogni oggetto ha questi campi:
[{"nome":"Marco","eta":42,"genere":"M","regione_it":"Bergamo","regione":"Nord-Ovest","tipo_installazioni":"Misto","anni_attivita":"Da 10 a 20 anni","personalita":"Pragmatico e scettico verso il marketing. Si fida di chi lavora sul campo, non dei cataloghi. Compra in base all'esperienza diretta e al passaparola tra colleghi.","relazione_brand":"Usa Caleffi da 8 anni per abitudine, ha provato Giacomini 2 anni fa su consiglio di un collega — ne ha apprezzato le valvole termostatiche ma fatica a trovarlo dal suo grossista di zona."}]

valori regione: "Nord-Ovest"|"Nord-Est"|"Centro"|"Sud e Isole"
valori tipo_installazioni: "Riscaldamento"|"Climatizzazione"|"Idrosanitario"|"Misto"
valori anni_attivita: "Meno di 3 anni"|"Da 3 a 10 anni"|"Da 10 a 20 anni"|"Oltre 20 anni"`,
      2800
    );

    let personas = parseJSONObjects(personasRaw);
    console.log('[dtwin] personas:', personas.length, 'sample:', JSON.stringify(personas[0]).substring(0, 200));

    if (personas.length < 4) {
      db.prepare('DELETE FROM twin_sessions WHERE id=?').run(sessionId);
      return res.status(500).json({ error: `Solo ${personas.length} profili generati. Riprova.` });
    }
    personas = personas.slice(0, n);

    // Save to twin registry
    const twinIns = db.prepare('INSERT INTO twins (nome,eta,genere,regione_it,regione,tipo_installazioni,anni_attivita,personalita,relazione_brand,persona_prompt) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const mapIns  = db.prepare('INSERT INTO twin_session_map (session_id,twin_id) VALUES (?,?)');

    const savedTwins = personas.map(p => {
      const prompt = buildPersonaPrompt(p);
      const row = twinIns.run(p.nome, p.eta||30, p.genere||'M', p.regione_it, p.regione, p.tipo_installazioni, p.anni_attivita, p.personalita, p.relazione_brand, prompt);
      mapIns.run(sessionId, row.lastInsertRowid);
      return { id: row.lastInsertRowid, ...p, persona_prompt: prompt };
    });

    // ── Calls 3+: Silicon sampling — one call per twin, batch of 5 ───────────
    // (Argyle et al.: per-persona conditioning, not batch generation)
    const BATCH = 5;
    const interviewResults = new Array(savedTwins.length).fill(null);

    for (let i = 0; i < savedTwins.length; i += BATCH) {
      const batch = savedTwins.slice(i, i + BATCH);
      const settled = await Promise.allSettled(batch.map(t => interviewTwin(t, sessionId)));
      settled.forEach((r, j) => { interviewResults[i + j] = r.status === 'fulfilled' ? r.value : null; });
    }

    // Persist responses (reported state)
    const respIns = db.prepare(`INSERT INTO twin_responses (twin_id,session_id,tipo_installazioni,prima_associazione,uso_prodotti,prodotti_usati,valutazione_qualita,valutazione_facilita,valutazione_prezzo,valutazione_disponibilita,valutazione_assistenza,valutazione_formazione,nps,competitor_usati,barriera_non_utilizzo,leva_attivazione,driver_scelta,canali_informazione,contenuto_preferito,anni_attivita,regione) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const profiles = [];
    db.transaction(() => {
      savedTwins.forEach((twin, i) => {
        const r = interviewResults[i] || {};
        respIns.run(twin.id, sessionId, twin.tipo_installazioni,
          r.prima_associazione, r.uso_prodotti, r.prodotti_usati,
          r.valutazione_qualita??null, r.valutazione_facilita??null, r.valutazione_prezzo??null,
          r.valutazione_disponibilita??null, r.valutazione_assistenza??null, r.valutazione_formazione??null,
          r.nps??null, r.competitor_usati, r.barriera_non_utilizzo, r.leva_attivazione,
          r.driver_scelta, r.canali_informazione, r.contenuto_preferito,
          twin.anni_attivita, twin.regione
        );
        db.prepare('UPDATE twins SET n_interviews=n_interviews+1 WHERE id=?').run(twin.id);
        profiles.push({
          persona: { id: `DT_${String(twin.id).padStart(3,'0')}`, nome: twin.nome, eta: twin.eta, genere: twin.genere, regione_it: twin.regione_it, specializzazione: twin.tipo_installazioni, anni_att: twin.anni_attivita, personalita: twin.personalita, relazione_brand: twin.relazione_brand },
          risposte: { tipo_installazioni: twin.tipo_installazioni, anni_attivita: twin.anni_attivita, regione: twin.regione, ...r },
        });
      });
    })();

    db.prepare('UPDATE twin_sessions SET n_created=? WHERE id=?').run(savedTwins.length, sessionId);

    res.json({ sessionId, n: profiles.length, rationale: analysis.rationale, testType: analysis.test_type, stratification: strat, profiles });

  } catch (err) {
    console.error('[dtwin] error:', err.status, err.message);
    res.status(500).json({ error: err.message || 'Errore generazione' });
  }
});

// GET /api/dtwin/sessions
router.get('/sessions', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, COUNT(DISTINCT m.twin_id) AS n_generated
    FROM twin_sessions s
    LEFT JOIN twin_session_map m ON m.session_id = s.id
    GROUP BY s.id ORDER BY s.created_at DESC LIMIT 10
  `).all();
  res.json(rows);
});

// GET /api/dtwin/results/:id
router.get('/results/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM twin_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const twinIds = db.prepare('SELECT twin_id FROM twin_session_map WHERE session_id=?').all(req.params.id).map(r => r.twin_id);
  if (!twinIds.length) return res.json({ session, profiles: [] });
  const ph = twinIds.map(() => '?').join(',');
  const twins = db.prepare(`SELECT * FROM twins WHERE id IN (${ph})`).all(...twinIds);
  const profiles = twins.map(twin => {
    const resp = db.prepare('SELECT * FROM twin_responses WHERE twin_id=? AND session_id=? ORDER BY created_at DESC LIMIT 1').get(twin.id, req.params.id);
    return {
      persona: { id: `DT_${String(twin.id).padStart(3,'0')}`, nome: twin.nome, eta: twin.eta, genere: twin.genere, regione_it: twin.regione_it, specializzazione: twin.tipo_installazioni, anni_att: twin.anni_attivita, personalita: twin.personalita, relazione_brand: twin.relazione_brand },
      risposte: { tipo_installazioni: twin.tipo_installazioni, anni_attivita: twin.anni_attivita, regione: twin.regione, ...(resp||{}) },
    };
  });
  res.json({ session, profiles });
});

// DELETE /api/dtwin/:id (session — keeps twins in registry)
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM twin_session_map WHERE session_id=?').run(req.params.id);
  db.prepare('DELETE FROM twin_sessions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
