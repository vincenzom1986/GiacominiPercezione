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

db.exec(`
  CREATE TABLE IF NOT EXISTS dtwin_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    objective TEXT, industry TEXT, target_age TEXT, location TEXT,
    n_generated INTEGER DEFAULT 0, rationale TEXT, stratification TEXT
  );
  CREATE TABLE IF NOT EXISTS dtwin_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER, persona_json TEXT,
    tipo_installazioni TEXT, prima_associazione TEXT, uso_prodotti TEXT, prodotti_usati TEXT,
    valutazione_qualita INTEGER, valutazione_facilita INTEGER, valutazione_prezzo INTEGER,
    valutazione_disponibilita INTEGER, valutazione_assistenza INTEGER, valutazione_formazione INTEGER,
    nps INTEGER, competitor_usati TEXT, barriera_non_utilizzo TEXT, leva_attivazione TEXT,
    driver_scelta TEXT, canali_informazione TEXT, contenuto_preferito TEXT,
    anni_attivita TEXT, regione TEXT
  )
`);

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

async function groq(system, user, maxTokens) {
  for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
    try {
      const r = await client.chat.completions.create({
        model, max_tokens: maxTokens, temperature: 0.7,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return r.choices[0].message.content;
    } catch (err) {
      if (err.status === 429 && model !== 'llama-3.1-8b-instant') continue;
      throw err;
    }
  }
}

// Extract as many valid JSON objects as possible from a potentially truncated array
function parseJSONObjects(raw) {
  // Try full parse first
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* fall through to object-by-object extraction */ }

  // Extract individual objects even if array is truncated
  const objects = [];
  const re = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.id || obj.eta || obj.tipo_installazioni) objects.push(obj);
    } catch { /* skip malformed */ }
  }
  return objects;
}

// ── System prompts ────────────────────────────────────────────────────────────

const SYS_ANALYSIS = `Sei un ricercatore di mercato B2B HVAC italiano.
Calcola campione minimo con n = z²·p·(1-p)/e²:
- esplorativa: e=0.12 → usa 20
- descrittiva: e=0.10 → usa 24
- Limita SEMPRE N tra 16 e 24.
Rispondi SOLO con JSON valido, zero testo fuori.`;

const SYS_GEN = `Sei un ricercatore CAWI che genera installatori idraulici italiani sintetici che hanno già risposto a una survey brand perception.
Ogni oggetto deve avere TUTTI i campi. Rispetta le regole di coerenza.
Rispondi ESCLUSIVAMENTE con array JSON. Inizia subito con [ senza testo prima.`;

// ── Routes ────────────────────────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
  const { objective, industry, targetAge, location } = req.body;
  if (!objective || objective.trim().length < 10) {
    return res.status(400).json({ error: 'Descrivi l\'obiettivo (min 10 caratteri)' });
  }

  try {
    // ── Call 1: Analysis ─────────────────────────────────────────────────────
    const analysisRaw = await groq(SYS_ANALYSIS,
      `Obiettivo: "${objective}"
Industry: ${industry || 'Installatori/Idraulici italiani'}
Target età: ${targetAge || 'Tutte'}
Localizzazione: ${location || 'Italia'}
JSON: {"n":<16-24>,"rationale":"<2 frasi>","test_type":"<esplorativa|descrittiva>","stratification":{"geographic":{"Nord-Ovest":<pct>,"Nord-Est":<pct>,"Centro":<pct>,"Sud e Isole":<pct>},"specialty":{"Misto":<pct>,"Riscaldamento":<pct>,"Idrosanitario":<pct>,"Climatizzazione":<pct>},"giacomini_users_pct":<25-45>}}`,
      500);

    let analysis;
    try { analysis = parseJSONObjects(analysisRaw)[0] || JSON.parse(analysisRaw.match(/\{[\s\S]*\}/)[0]); }
    catch {
      analysis = {
        n: 20, rationale: 'Campione esplorativo n=20.', test_type: 'esplorativa',
        stratification: { geographic: { 'Nord-Ovest': 28, 'Nord-Est': 17, 'Centro': 25, 'Sud e Isole': 30 },
          specialty: { Misto: 40, Riscaldamento: 30, Idrosanitario: 20, Climatizzazione: 10 },
          giacomini_users_pct: 38 },
      };
    }

    const n = Math.min(Math.max(parseInt(analysis.n) || 20, 16), 24);
    const strat = analysis.stratification || {};
    const stratStr = JSON.stringify(strat);

    const sess = db.prepare(
      'INSERT INTO dtwin_sessions (objective,industry,target_age,location,rationale,stratification) VALUES (?,?,?,?,?,?)'
    ).run(objective, industry || '', targetAge || '', location || '', analysis.rationale || '', stratStr);
    const sessionId = sess.lastInsertRowid;

    // ── Call 2: Generate flat profiles (demographics + survey responses) ──────
    const genPrompt =
`Genera ${n} installatori idraulici italiani per survey Giacomini.
Obiettivo: "${objective}"${targetAge ? '\nTarget età: ' + targetAge : ''}${location ? '\nArea: ' + location : ''}
Stratificazione: ${stratStr}

REGOLE COERENZA (obbligatorie):
- uso_prodotti="Sì" → valutazioni 1-5 non null, nps 0-10 non null, barriera=null, leva=null
- uso_prodotti="No" → valutazioni null, nps null, barriera NON null, leva NON null
- prima_associazione="Non la conosco bene" → uso_prodotti="No"
- regione="Sud e Isole" → uso_prodotti="No" almeno 55% di questi
- Giacomini awareness: ~70% Nord, ~40% Sud → più "Non la conosco bene" al Sud
- ${Math.round(strat.giacomini_users_pct || 38)}% degli installatori usa Giacomini

CAMPI (tutti obbligatori, rispetta esattamente i valori ammessi):
id: "DT_001"…"DT_0${String(n).padStart(2,'0')}"
nome: nome italiano (es. "Marco")
eta: numero intero
regione_it: città italiana (es. "Bergamo")
regione: "Nord-Ovest"|"Nord-Est"|"Centro"|"Sud e Isole"
tipo_installazioni: "Riscaldamento"|"Climatizzazione"|"Idrosanitario"|"Misto"
anni_attivita: "Meno di 3 anni"|"Da 3 a 10 anni"|"Da 10 a 20 anni"|"Oltre 20 anni"
prima_associazione: "Qualità e affidabilità"|"Made in Italy / tradizione"|"Prezzo elevato / premium"|"Innovazione e tecnologia"|"Difficile da reperire"|"Non la conosco bene"
uso_prodotti: "Sì"|"No"
prodotti_usati: es. "Valvole termostatiche, Collettori" oppure null
valutazione_qualita: 1-5 oppure null
valutazione_facilita: 1-5 oppure null
valutazione_prezzo: 1-5 oppure null
valutazione_disponibilita: 1-5 oppure null
valutazione_assistenza: 1-5 oppure null
valutazione_formazione: 1-5 oppure null
nps: 0-10 oppure null
competitor_usati: es. "Caleffi, FAR" oppure null
barriera_non_utilizzo: es. "Non lo trovo dal mio fornitore" oppure null
leva_attivazione: es. "Sconto sul primo ordine" oppure null
driver_scelta: es. "Affidabilità nel tempo, Disponibilità immediata" (max 3, virgola)
canali_informazione: es. "Rappresentanti commerciali, YouTube e social" (max 3, virgola)
contenuto_preferito: "Video installazione"|"Schede tecniche PDF"|"Corsi di formazione"|"Post social"|"Catalogo prodotti"|"Newsletter"

Esempio oggetto:
{"id":"DT_001","nome":"Marco","eta":42,"regione_it":"Bergamo","regione":"Nord-Ovest","tipo_installazioni":"Misto","anni_attivita":"Da 10 a 20 anni","prima_associazione":"Qualità e affidabilità","uso_prodotti":"Sì","prodotti_usati":"Valvole termostatiche, Collettori","valutazione_qualita":4,"valutazione_facilita":3,"valutazione_prezzo":3,"valutazione_disponibilita":4,"valutazione_assistenza":3,"valutazione_formazione":3,"nps":8,"competitor_usati":"Caleffi","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Affidabilità nel tempo, Disponibilità immediata","canali_informazione":"Rappresentanti commerciali, Colleghi e passaparola","contenuto_preferito":"Video installazione"}`;

    const genRaw = await groq(SYS_GEN, genPrompt, 4096);
    console.log('[dtwin] genRaw[:500]:', genRaw.substring(0, 500));

    let rawProfiles = parseJSONObjects(genRaw);
    console.log('[dtwin] parsed profiles count:', rawProfiles.length);

    if (rawProfiles.length < 5) {
      db.prepare('DELETE FROM dtwin_sessions WHERE id=?').run(sessionId);
      return res.status(500).json({ error: `Solo ${rawProfiles.length} profili estratti (min 5). Riprova.` });
    }

    rawProfiles = rawProfiles.slice(0, n);

    // Wrap into {persona, risposte} structure
    const profiles = rawProfiles.map(p => ({
      persona: {
        id: p.id,
        eta: p.eta,
        nome: p.nome,
        genere: p.genere || 'M',
        regione_it: p.regione_it,
        specializzazione: p.tipo_installazioni,
        anni_att: p.anni_attivita,
      },
      risposte: {
        tipo_installazioni: p.tipo_installazioni,
        prima_associazione: p.prima_associazione,
        uso_prodotti: p.uso_prodotti,
        prodotti_usati: p.prodotti_usati,
        valutazione_qualita: p.valutazione_qualita ?? null,
        valutazione_facilita: p.valutazione_facilita ?? null,
        valutazione_prezzo: p.valutazione_prezzo ?? null,
        valutazione_disponibilita: p.valutazione_disponibilita ?? null,
        valutazione_assistenza: p.valutazione_assistenza ?? null,
        valutazione_formazione: p.valutazione_formazione ?? null,
        nps: p.nps ?? null,
        competitor_usati: p.competitor_usati,
        barriera_non_utilizzo: p.barriera_non_utilizzo,
        leva_attivazione: p.leva_attivazione,
        driver_scelta: p.driver_scelta,
        canali_informazione: p.canali_informazione,
        contenuto_preferito: p.contenuto_preferito,
        anni_attivita: p.anni_attivita,
        regione: p.regione,
      },
    }));

    // ── Persist ───────────────────────────────────────────────────────────────
    const ins = db.prepare(`INSERT INTO dtwin_profiles (
      session_id,persona_json,tipo_installazioni,prima_associazione,uso_prodotti,prodotti_usati,
      valutazione_qualita,valutazione_facilita,valutazione_prezzo,valutazione_disponibilita,
      valutazione_assistenza,valutazione_formazione,nps,competitor_usati,barriera_non_utilizzo,
      leva_attivazione,driver_scelta,canali_informazione,contenuto_preferito,anni_attivita,regione
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    db.transaction((profs) => {
      for (const p of profs) {
        const r = p.risposte;
        ins.run(
          sessionId, JSON.stringify(p.persona),
          r.tipo_installazioni, r.prima_associazione, r.uso_prodotti, r.prodotti_usati,
          r.valutazione_qualita, r.valutazione_facilita, r.valutazione_prezzo,
          r.valutazione_disponibilita, r.valutazione_assistenza, r.valutazione_formazione,
          r.nps, r.competitor_usati, r.barriera_non_utilizzo, r.leva_attivazione,
          r.driver_scelta, r.canali_informazione, r.contenuto_preferito,
          r.anni_attivita, r.regione
        );
      }
    })(profiles);

    db.prepare('UPDATE dtwin_sessions SET n_generated=? WHERE id=?').run(profiles.length, sessionId);

    res.json({
      sessionId, n: profiles.length,
      rationale: analysis.rationale, testType: analysis.test_type,
      stratification: analysis.stratification, profiles,
    });

  } catch (err) {
    console.error('[dtwin] error:', err.status, err.message);
    res.status(500).json({ error: err.message || 'Errore generazione DTWIN' });
  }
});

router.get('/sessions', (req, res) => {
  res.json(db.prepare('SELECT * FROM dtwin_sessions ORDER BY created_at DESC LIMIT 10').all());
});

router.get('/results/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM dtwin_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const profiles = db.prepare('SELECT * FROM dtwin_profiles WHERE session_id=?').all(req.params.id);
  res.json({ session, profiles });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM dtwin_profiles WHERE session_id=?').run(req.params.id);
  db.prepare('DELETE FROM dtwin_sessions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
