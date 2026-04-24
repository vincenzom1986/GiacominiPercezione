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

function parseJSON(raw, isArray) {
  const m = raw.match(isArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : raw);
}

// ── System prompts ────────────────────────────────────────────────────────────

const SYS_ANALYSIS = `Sei un ricercatore di mercato senior B2B nel settore HVAC italiano.
Determina campione minimo con n = z²·p·(1-p)/e²:
- esplorativa (awareness/usage): e=0.12 → n≈67 → usa 30 (budget token limitato)
- descrittiva (confronto sottogruppi): e=0.10 → n≈97 → usa 36
- Limita SEMPRE N tra 20 e 36.
Rispondi SOLO con JSON valido, zero testo fuori dal JSON.`;

const SYS_GEN = `Sei un ricercatore CAWI che genera campioni sintetici di installatori idraulici italiani per brand perception research su Giacomini.

MERCATO ITALIANO (dati reali):
- Giacomini awareness: ~70% Nord, ~40% Sud
- Utilizzo ultimo anno: ~35-40% installatori
- NPS: promotori 9-10 (25%), passivi 7-8 (30%), neutri 5-6 (25%), detrattori 0-4 (20%)
- Competitor: Caleffi (leader), FAR, Ivar, Herz, Oventrop, Danfoss, WATTS

REGOLE COERENZA INTERNA (obbligatorie):
1. uso_prodotti="Sì" → valutazioni 1-5 NON null, nps 0-10 NON null, barriera=null, leva=null
2. uso_prodotti="No" → valutazioni=null, nps=null, barriera NON null, leva NON null
3. prima_associazione="Non la conosco bene" → uso_prodotti="No"
4. prima_associazione="Qualità e affidabilità" → nps≥7 nell'80% dei casi
5. prima_associazione="Prezzo elevato / premium" → valutazione_prezzo≤3
6. Regione Sud e Isole → uso_prodotti="No" almeno 55% dei casi

VALORI ESATTI AMMESSI:
tipo_installazioni: "Riscaldamento"|"Climatizzazione"|"Idrosanitario"|"Misto"
prima_associazione: "Qualità e affidabilità"|"Made in Italy / tradizione"|"Prezzo elevato / premium"|"Innovazione e tecnologia"|"Difficile da reperire"|"Non la conosco bene"
uso_prodotti: "Sì"|"No"
anni_attivita: "Meno di 3 anni"|"Da 3 a 10 anni"|"Da 10 a 20 anni"|"Oltre 20 anni"
regione: "Nord-Ovest"|"Nord-Est"|"Centro"|"Sud e Isole"

Rispondi ESCLUSIVAMENTE con array JSON valido. Zero testo fuori dal JSON.`;

// ── Routes ────────────────────────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
  const { objective, industry, targetAge, location } = req.body;
  if (!objective || objective.trim().length < 10) {
    return res.status(400).json({ error: 'Descrivi l\'obiettivo (min 10 caratteri)' });
  }

  try {
    // ── Step 1: determine N and stratification (1 API call, ~5s) ──────────
    const analysisRaw = await groq(SYS_ANALYSIS,
      `Obiettivo: "${objective}"
Industry: ${industry || 'Installatori/Idraulici italiani'}
Target età: ${targetAge || 'Tutte le fasce'}
Localizzazione: ${location || 'Italia'}

JSON da restituire:
{"n":<20-36>,"rationale":"<2 frasi con formula e motivazione>","test_type":"<esplorativa|descrittiva|comparativa>","stratification":{"geographic":{"Nord-Ovest":<pct>,"Nord-Est":<pct>,"Centro":<pct>,"Sud e Isole":<pct>},"specialty":{"Misto":<pct>,"Riscaldamento":<pct>,"Idrosanitario":<pct>,"Climatizzazione":<pct>},"age":{"<30":<pct>,"30-44":<pct>,"45-59":<pct>,"60+":<pct>},"giacomini_users_pct":<25-50>}}`,
      600);

    let analysis;
    try { analysis = parseJSON(analysisRaw, false); }
    catch (e) {
      analysis = {
        n: 24, rationale: 'Campione esplorativo n=24 (vincolo token API).', test_type: 'esplorativa',
        stratification: { geographic: { 'Nord-Ovest': 28, 'Nord-Est': 17, 'Centro': 25, 'Sud e Isole': 30 },
          specialty: { Misto: 40, Riscaldamento: 30, Idrosanitario: 20, Climatizzazione: 10 },
          age: { '<30': 12, '30-44': 38, '45-59': 36, '60+': 14 }, giacomini_users_pct: 38 },
      };
    }

    const n = Math.min(Math.max(parseInt(analysis.n) || 24, 20), 36);
    const stratStr = JSON.stringify(analysis.stratification || {});

    // Create DB session
    const sess = db.prepare(
      'INSERT INTO dtwin_sessions (objective,industry,target_age,location,rationale,stratification) VALUES (?,?,?,?,?,?)'
    ).run(objective, industry || '', targetAge || '', location || '', analysis.rationale || '', stratStr);
    const sessionId = sess.lastInsertRowid;

    // ── Step 2: generate all profiles in ONE call (1 API call, ~10-15s) ───
    const genRaw = await groq(SYS_GEN,
      `Obiettivo: "${objective}"
Stratificazione: ${stratStr}
Target: ${targetAge || 'tutti'} | Location: ${location || 'Italia'}

Genera ESATTAMENTE ${n} profili (DT_001…DT_${String(n).padStart(3, '0')}).
Rispetta la stratificazione proporzionalmente.

Array JSON di ${n} oggetti con questa struttura:
[{"persona":{"id":"DT_001","eta":42,"genere":"M","regione_it":"Lombardia","specializzazione":"Misto","anni_att":"Da 10 a 20 anni"},"risposte":{"tipo_installazioni":"Misto","prima_associazione":"Qualità e affidabilità","uso_prodotti":"Sì","prodotti_usati":"Valvole e detentori, Collettori","valutazione_qualita":4,"valutazione_facilita":4,"valutazione_prezzo":3,"valutazione_disponibilita":3,"valutazione_assistenza":4,"valutazione_formazione":3,"nps":7,"competitor_usati":"Caleffi, Ivar","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Affidabilità nel tempo, Disponibilità immediata","canali_informazione":"Rappresentanti commerciali, Colleghi e passaparola","contenuto_preferito":"Video montaggio collettore","anni_attivita":"Da 10 a 20 anni","regione":"Nord-Ovest"}}]`,
      4096);

    let profiles = [];
    try {
      const parsed = parseJSON(genRaw, true);
      if (Array.isArray(parsed)) profiles = parsed.slice(0, n);
    } catch (e) {
      console.error('[dtwin] JSON parse error:', e.message, genRaw.substring(0, 200));
      const partial = [];
      const regex = /\{[^{}]*"id"\s*:\s*"DT_[\s\S]*?\}(?=\s*[,\]])/g;
      let match;
      while ((match = regex.exec(genRaw)) !== null) {
        try { partial.push(JSON.parse(match[0])); } catch (e2) {}
      }
      if (partial.length < 5) {
        db.prepare('DELETE FROM dtwin_sessions WHERE id=?').run(sessionId);
        return res.status(500).json({ error: 'Il modello AI non ha restituito JSON valido. Riprova.' });
      }
      profiles = partial;
    }

    if (!profiles.length) {
      db.prepare('DELETE FROM dtwin_sessions WHERE id=?').run(sessionId);
      return res.status(500).json({ error: 'Nessun profilo generato. Riprova.' });
    }

    // Normalize: AI sometimes returns flat objects instead of {persona, risposte}
    profiles = profiles.map(p => {
      if (p.risposte) return p;
      return {
        persona: {
          id: p.id || p.persona_id,
          eta: p.eta || p.age,
          genere: p.genere || p.gender || 'M',
          regione_it: p.regione_it || p.regione_italiana || p.citta,
          specializzazione: p.specializzazione || p.tipo_installazioni || 'Misto',
          anni_att: p.anni_att || p.anni_attivita,
        },
        risposte: {
          tipo_installazioni: p.tipo_installazioni,
          prima_associazione: p.prima_associazione,
          uso_prodotti: p.uso_prodotti,
          prodotti_usati: p.prodotti_usati,
          valutazione_qualita: p.valutazione_qualita,
          valutazione_facilita: p.valutazione_facilita,
          valutazione_prezzo: p.valutazione_prezzo,
          valutazione_disponibilita: p.valutazione_disponibilita,
          valutazione_assistenza: p.valutazione_assistenza,
          valutazione_formazione: p.valutazione_formazione,
          nps: p.nps,
          competitor_usati: p.competitor_usati,
          barriera_non_utilizzo: p.barriera_non_utilizzo,
          leva_attivazione: p.leva_attivazione,
          driver_scelta: p.driver_scelta,
          canali_informazione: p.canali_informazione,
          contenuto_preferito: p.contenuto_preferito,
          anni_attivita: p.anni_attivita || p.anni_att,
          regione: p.regione,
        },
      };
    });
    console.log('[dtwin] sample profile[0]:', JSON.stringify(profiles[0]).substring(0, 300));

    // ── Step 3: persist to DB ─────────────────────────────────────────────
    const ins = db.prepare(`INSERT INTO dtwin_profiles (
      session_id,persona_json,tipo_installazioni,prima_associazione,uso_prodotti,prodotti_usati,
      valutazione_qualita,valutazione_facilita,valutazione_prezzo,valutazione_disponibilita,
      valutazione_assistenza,valutazione_formazione,nps,competitor_usati,barriera_non_utilizzo,
      leva_attivazione,driver_scelta,canali_informazione,contenuto_preferito,anni_attivita,regione
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    db.transaction((profs) => {
      for (const p of profs) {
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
