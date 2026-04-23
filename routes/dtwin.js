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
    objective TEXT,
    industry TEXT,
    target_age TEXT,
    location TEXT,
    n_generated INTEGER DEFAULT 0,
    rationale TEXT,
    stratification TEXT
  );
  CREATE TABLE IF NOT EXISTS dtwin_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    persona_json TEXT,
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
    regione TEXT
  )
`);

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

async function callGroq(systemPrompt, userPrompt, maxTokens, fast = false) {
  const models = fast
    ? ['llama-3.1-8b-instant']
    : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  for (const model of models) {
    try {
      const r = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature: 0.75,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      return r.choices[0].message.content;
    } catch (err) {
      if (err.status === 429 && models.indexOf(model) < models.length - 1) continue;
      throw err;
    }
  }
}

// ── System prompts ────────────────────────────────────────────────────────────

const ANALYSIS_SYS = `Sei un ricercatore di mercato senior specializzato in studi B2B nel settore HVAC italiano.
Devi determinare il campione minimo necessario e il piano di stratificazione per un'analisi su installatori/idraulici italiani.

Formula campionamento: n = z²·p·(1-p)/e²
- Analisi esplorativa (awareness, usage rate): z=1.96, p=0.5, e=0.12 → n≈67
- Analisi descrittiva (confronto sottogruppi): z=1.96, p=0.5, e=0.10 → n≈97
- Regola pratica: se l'obiettivo implica confronto tra ≥3 sottogruppi, aggiungi 20%
- Limita N tra 30 e 72 per vincoli di costo API (es. 72 = 6 batch da 12)
- Se servirebbero più di 72 profili, indica N=72 e segnalalo nel rationale

Rispondi ESCLUSIVAMENTE con JSON valido, zero testo fuori dal JSON.`;

const GENERATION_SYS = `Sei un esperto CAWI (Computer Assisted Web Interview) che genera campioni sintetici per brand perception research.
Stai simulando installatori idraulici italiani per un'analisi su Giacomini.

DATI DI MERCATO REALI (usali per il realismo dei profili):
- Giacomini: brand premium italiano, awareness ~70% Nord, ~40% Sud/Isole
- Quota utilizzo ultimo anno: ~35-40% del campione installatori
- Competitor per quota: Caleffi (leader), FAR Rubinetterie, Ivar, Herz, Oventrop, Danfoss, WATTS
- NPS atteso: promotori 9-10 (25%), passivi 7-8 (30%), neutri 5-6 (25%), detrattori 0-4 (20%)
- Canali info: Rappresentanti commerciali (72%), Passaparola colleghi (61%), YouTube/social (38% under 40)
- Distribuzione installatori per area: Nord-Ovest 28%, Nord-Est 17%, Centro 25%, Sud/Isole 30%

REGOLE DI COERENZA INTERNA (obbligatorie, viola = profilo invalido):
1. uso_prodotti="Sì" → valutazioni 1-5 NON null, nps 0-10 NON null, barriera=null, leva=null
2. uso_prodotti="No" → valutazioni=null, nps=null, barriera_non_utilizzo NON null, leva_attivazione NON null
3. prima_associazione="Non la conosco bene" → uso_prodotti DEVE essere "No"
4. prima_associazione="Qualità e affidabilità" → nps tendenzialmente ≥7 (80% dei casi)
5. prima_associazione="Prezzo elevato / premium" → valutazione_prezzo ≤3
6. Installatori Sud e Isole → uso_prodotti="No" almeno 55% dei casi
7. Distribuzione valutazioni: media ~3.5, deviazione standard ~0.9 (no risposte tutte uguali)

VALORI ESATTI AMMESSI (usa solo questi, rispetta maiuscole/minuscole):
tipo_installazioni: "Riscaldamento"|"Climatizzazione"|"Idrosanitario"|"Misto"
prima_associazione: "Qualità e affidabilità"|"Made in Italy / tradizione"|"Prezzo elevato / premium"|"Innovazione e tecnologia"|"Difficile da reperire"|"Non la conosco bene"
uso_prodotti: "Sì"|"No"
anni_attivita: "Meno di 3 anni"|"Da 3 a 10 anni"|"Da 10 a 20 anni"|"Oltre 20 anni"
regione: "Nord-Ovest"|"Nord-Est"|"Centro"|"Sud e Isole"

Rispondi ESCLUSIVAMENTE con array JSON valido. Zero testo fuori dal JSON.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractJSON(raw, isArray = false) {
  const pattern = isArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = raw.match(pattern);
  return JSON.parse(match ? match[0] : raw);
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
  const { objective, industry, targetAge, location } = req.body;
  if (!objective || objective.trim().length < 10) {
    return res.status(400).json({ error: 'Descrivi l\'obiettivo dell\'analisi (min 10 caratteri)' });
  }

  try {
    // ── Step 1: analyze objective, determine N and stratification ──────────
    const analysisUser = `Obiettivo ricerca: "${objective}"
Industry: ${industry || 'Installatori/Idraulici italiani'}
Target età: ${targetAge || 'Tutte le fasce'}
Localizzazione: ${location || 'Italia (nazionale)'}

Restituisci JSON con questa struttura esatta:
{
  "n": <intero 30-72>,
  "rationale": "<2 frasi che spiegano N con riferimento alla formula statistica e all'obiettivo>",
  "test_type": "<tipo di analisi: esplorativa|descrittiva|comparativa>",
  "stratification": {
    "geographic": {"Nord-Ovest": <pct>, "Nord-Est": <pct>, "Centro": <pct>, "Sud e Isole": <pct>},
    "specialty": {"Misto": <pct>, "Riscaldamento": <pct>, "Idrosanitario": <pct>, "Climatizzazione": <pct>},
    "age": {"<30": <pct>, "30-44": <pct>, "45-59": <pct>, "60+": <pct>},
    "years": {"Meno di 3 anni": <pct>, "Da 3 a 10 anni": <pct>, "Da 10 a 20 anni": <pct>, "Oltre 20 anni": <pct>},
    "giacomini_users_pct": <int 25-50 basato su obiettivo e localizzazione>
  }
}`;

    const analysisRaw = await callGroq(ANALYSIS_SYS, analysisUser, 700);
    let analysis;
    try { analysis = extractJSON(analysisRaw); }
    catch (e) {
      analysis = {
        n: 50, rationale: 'Campione esplorativo standard (n=50).', test_type: 'esplorativa',
        stratification: {
          geographic: { 'Nord-Ovest': 28, 'Nord-Est': 17, 'Centro': 25, 'Sud e Isole': 30 },
          specialty: { Misto: 40, Riscaldamento: 30, Idrosanitario: 20, Climatizzazione: 10 },
          age: { '<30': 12, '30-44': 38, '45-59': 36, '60+': 14 },
          years: { 'Meno di 3 anni': 10, 'Da 3 a 10 anni': 30, 'Da 10 a 20 anni': 35, 'Oltre 20 anni': 25 },
          giacomini_users_pct: 38,
        },
      };
    }

    const n = Math.min(Math.max(parseInt(analysis.n) || 50, 30), 72);
    const stratStr = JSON.stringify(analysis.stratification || {});

    // Create session
    const sessionInfo = db.prepare(
      'INSERT INTO dtwin_sessions (objective, industry, target_age, location, rationale, stratification) VALUES (?,?,?,?,?,?)'
    ).run(objective, industry || '', targetAge || '', location || '', analysis.rationale || '', stratStr);
    const sessionId = sessionInfo.lastInsertRowid;

    // ── Step 2: generate profiles in batches of 12 ────────────────────────
    const BATCH = 12;
    const allProfiles = [];

    while (allProfiles.length < n) {
      const batchN = Math.min(BATCH, n - allProfiles.length);
      const startIdx = allProfiles.length + 1;

      const genUser = `Obiettivo: "${objective}"
Stratificazione: ${stratStr}
Target: ${targetAge || 'tutti'} — Location: ${location || 'Italia'}

Genera ESATTAMENTE ${batchN} profili sintetici (ID DT_${String(startIdx).padStart(3, '0')} … DT_${String(startIdx + batchN - 1).padStart(3, '0')}).
Rispetta la stratificazione proporzionalmente al batch.

Formato OBBLIGATORIO (array JSON di ${batchN} oggetti):
[{
  "persona": {"id":"DT_001","eta":42,"genere":"M","regione_it":"Lombardia","specializzazione":"Misto","anni_att":"Da 10 a 20 anni"},
  "risposte": {"tipo_installazioni":"Misto","prima_associazione":"Qualità e affidabilità","uso_prodotti":"Sì","prodotti_usati":"Valvole e detentori, Collettori","valutazione_qualita":4,"valutazione_facilita":4,"valutazione_prezzo":3,"valutazione_disponibilita":3,"valutazione_assistenza":4,"valutazione_formazione":3,"nps":7,"competitor_usati":"Caleffi, Ivar","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Affidabilità nel tempo, Disponibilità immediata","canali_informazione":"Rappresentanti commerciali, Colleghi e passaparola","contenuto_preferito":"Video montaggio collettore","anni_attivita":"Da 10 a 20 anni","regione":"Nord-Ovest"}
}]`;

      try {
        const raw = await callGroq(GENERATION_SYS, genUser, 2400, true);
        const batch = extractJSON(raw, true);
        if (Array.isArray(batch)) allProfiles.push(...batch.slice(0, batchN));
      } catch (e) {
        console.error('[dtwin] batch error:', e.message);
      }
    }

    // ── Step 3: persist profiles ──────────────────────────────────────────
    const ins = db.prepare(`INSERT INTO dtwin_profiles (
      session_id, persona_json,
      tipo_installazioni, prima_associazione, uso_prodotti, prodotti_usati,
      valutazione_qualita, valutazione_facilita, valutazione_prezzo,
      valutazione_disponibilita, valutazione_assistenza, valutazione_formazione,
      nps, competitor_usati, barriera_non_utilizzo, leva_attivazione,
      driver_scelta, canali_informazione, contenuto_preferito, anni_attivita, regione
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    db.transaction((profiles) => {
      for (const p of profiles) {
        const r = p.risposte || {};
        ins.run(
          sessionId, JSON.stringify(p.persona || {}),
          r.tipo_installazioni, r.prima_associazione, r.uso_prodotti, r.prodotti_usati,
          r.valutazione_qualita, r.valutazione_facilita, r.valutazione_prezzo,
          r.valutazione_disponibilita, r.valutazione_assistenza, r.valutazione_formazione,
          r.nps, r.competitor_usati, r.barriera_non_utilizzo, r.leva_attivazione,
          r.driver_scelta, r.canali_informazione, r.contenuto_preferito,
          r.anni_attivita, r.regione
        );
      }
    })(allProfiles);

    db.prepare('UPDATE dtwin_sessions SET n_generated=? WHERE id=?').run(allProfiles.length, sessionId);

    res.json({
      sessionId,
      n: allProfiles.length,
      rationale: analysis.rationale,
      testType: analysis.test_type,
      stratification: analysis.stratification,
      profiles: allProfiles,
    });

  } catch (err) {
    console.error('[dtwin] error:', err.status, err.message);
    res.status(500).json({ error: err.message || 'Errore generazione DTWIN' });
  }
});

router.get('/sessions', (req, res) => {
  const rows = db.prepare('SELECT * FROM dtwin_sessions ORDER BY created_at DESC LIMIT 10').all();
  res.json(rows);
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
