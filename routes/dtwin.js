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
        model, max_tokens: maxTokens, temperature: 0.75,
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
- esplorativa (awareness/usage): e=0.12 → n≈67 → usa 24
- descrittiva (confronto sottogruppi): e=0.10 → n≈97 → usa 30
- Limita SEMPRE N tra 20 e 30.
Rispondi SOLO con JSON valido, zero testo fuori dal JSON.`;

const SYS_PERSONAS = `Sei un ricercatore che crea campioni demografici sintetici di installatori idraulici italiani.
Genera SOLO dati anagrafici e professionali — NON opinioni sul brand.
Rispetta la stratificazione indicata. Nomi italiani realistici per regione.
Rispondi ESCLUSIVAMENTE con array JSON. Zero testo fuori dal JSON.`;

const SYS_INTERVIEW = `Sei un intervistatore CAWI specializzato in brand perception B2B nel settore HVAC italiano.
Ricevi un elenco di profili di installatori/idraulici. Per ognuno, INTERPRETA QUEL PERSONAGGIO e rispondi alla survey Giacomini come se fossi lui.

CONTESTO MERCATO (usa per calibrare le risposte):
- Giacomini awareness: ~70% Nord Italia, ~40% Sud Italia
- Utilizzo nell'ultimo anno: ~38% degli installatori
- NPS Giacomini: promotori 9-10 (25%), passivi 7-8 (30%), neutrali 5-6 (25%), detrattori 0-4 (20%)
- Competitor principali: Caleffi (leader di mercato), FAR, Ivar, Herz, Oventrop, Danfoss, WATTS
- Il brand Giacomini è percepito come qualità premium ma con distribuzione migliorabile al Sud

REGOLE DI COERENZA OBBLIGATORIE (violazioni = errore grave):
1. uso_prodotti="Sì" → valutazioni 1-5 TUTTE non null; nps 0-10 non null; barriera_non_utilizzo=null; leva_attivazione=null
2. uso_prodotti="No" → valutazioni TUTTE null; nps=null; barriera_non_utilizzo non null; leva_attivazione non null; prodotti_usati=null
3. prima_associazione="Non la conosco bene" → uso_prodotti="No" SEMPRE
4. prima_associazione="Qualità e affidabilità" → nps≥7 in 80% dei casi
5. prima_associazione="Prezzo elevato / premium" → valutazione_prezzo≤3
6. regione="Sud e Isole" → uso_prodotti="No" almeno nel 55% dei profili Sud
7. Installatori giovani (<35 anni) → più probabilità di non conoscere Giacomini
8. Installatori senior (>50 anni, >20 anni attività) → più probabilità di usare Giacomini

VALORI ESATTI AMMESSI (usa SOLO questi, rispetta maiuscole/minuscole):
prima_associazione: "Qualità e affidabilità"|"Made in Italy / tradizione"|"Prezzo elevato / premium"|"Innovazione e tecnologia"|"Difficile da reperire"|"Non la conosco bene"
uso_prodotti: "Sì"|"No"
driver_scelta: lista separata da virgole, scegli tra: "Affidabilità nel tempo","Disponibilità immediata","Prezzo competitivo","Supporto tecnico","Familiarità col brand","Consiglio del fornitore" (max 3)
canali_informazione: lista separata da virgole, scegli tra: "Rappresentanti commerciali","Fiere di settore","Riviste specializzate","YouTube e social","Colleghi e passaparola","Sito del produttore" (max 3)
contenuto_preferito: "Video installazione"|"Schede tecniche PDF"|"Corsi di formazione"|"Post social"|"Catalogo prodotti"|"Newsletter"

Rispondi ESCLUSIVAMENTE con array JSON valido. Zero testo fuori dal JSON.`;

// ── Routes ────────────────────────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
  const { objective, industry, targetAge, location } = req.body;
  if (!objective || objective.trim().length < 10) {
    return res.status(400).json({ error: 'Descrivi l\'obiettivo (min 10 caratteri)' });
  }

  try {
    // ── Call 1: Determine N and stratification ────────────────────────────────
    const analysisRaw = await groq(SYS_ANALYSIS,
      `Obiettivo: "${objective}"
Industry: ${industry || 'Installatori/Idraulici italiani'}
Target età: ${targetAge || 'Tutte le fasce'}
Localizzazione: ${location || 'Italia'}

JSON da restituire:
{"n":<20-30>,"rationale":"<2 frasi>","test_type":"<esplorativa|descrittiva>","stratification":{"geographic":{"Nord-Ovest":<pct>,"Nord-Est":<pct>,"Centro":<pct>,"Sud e Isole":<pct>},"specialty":{"Misto":<pct>,"Riscaldamento":<pct>,"Idrosanitario":<pct>,"Climatizzazione":<pct>},"age":{"<30":<pct>,"30-44":<pct>,"45-59":<pct>,"60+":<pct>},"giacomini_users_pct":<25-50>}}`,
      600);

    let analysis;
    try { analysis = parseJSON(analysisRaw, false); }
    catch {
      analysis = {
        n: 24, rationale: 'Campione esplorativo n=24.', test_type: 'esplorativa',
        stratification: { geographic: { 'Nord-Ovest': 28, 'Nord-Est': 17, 'Centro': 25, 'Sud e Isole': 30 },
          specialty: { Misto: 40, Riscaldamento: 30, Idrosanitario: 20, Climatizzazione: 10 },
          age: { '<30': 12, '30-44': 38, '45-59': 36, '60+': 14 }, giacomini_users_pct: 38 },
      };
    }

    const n = Math.min(Math.max(parseInt(analysis.n) || 24, 20), 30);
    const strat = analysis.stratification || {};
    const stratStr = JSON.stringify(strat);

    const sess = db.prepare(
      'INSERT INTO dtwin_sessions (objective,industry,target_age,location,rationale,stratification) VALUES (?,?,?,?,?,?)'
    ).run(objective, industry || '', targetAge || '', location || '', analysis.rationale || '', stratStr);
    const sessionId = sess.lastInsertRowid;

    // ── Call 2: Generate demographic personas (simple flat JSON) ──────────────
    const personasPrompt = `Obiettivo analisi: "${objective}"
Localizzazione: ${location || 'Italia nazionale'}
Target età: ${targetAge || 'tutte'}
Stratificazione geografica: ${JSON.stringify(strat.geographic || {})}
Stratificazione specializzazione: ${JSON.stringify(strat.specialty || {})}

Genera ESATTAMENTE ${n} profili demografici (ID: DT_001…DT_${String(n).padStart(3,'0')}).
Array JSON di ${n} oggetti PIATTI con SOLO questi campi:
[{"id":"DT_001","nome":"Marco","eta":42,"genere":"M","regione_it":"Bergamo","regione":"Nord-Ovest","tipo_installazioni":"Misto","anni_attivita":"Da 10 a 20 anni"}]

Valori ammessi regione: "Nord-Ovest"|"Nord-Est"|"Centro"|"Sud e Isole"
Valori ammessi tipo_installazioni: "Riscaldamento"|"Climatizzazione"|"Idrosanitario"|"Misto"
Valori ammessi anni_attivita: "Meno di 3 anni"|"Da 3 a 10 anni"|"Da 10 a 20 anni"|"Oltre 20 anni"`;

    const personasRaw = await groq(SYS_PERSONAS, personasPrompt, 2048);
    console.log('[dtwin] personasRaw[:400]:', personasRaw.substring(0, 400));

    let personas = [];
    try {
      const parsed = parseJSON(personasRaw, true);
      if (Array.isArray(parsed)) personas = parsed.slice(0, n);
    } catch (e) {
      console.error('[dtwin] personas parse error:', e.message, '\nraw[:500]:', personasRaw.substring(0, 500));
      db.prepare('DELETE FROM dtwin_sessions WHERE id=?').run(sessionId);
      return res.status(500).json({ error: 'Errore nella generazione dei profili demografici. Riprova.' });
    }

    if (personas.length < 5) {
      console.error('[dtwin] too few personas:', personas.length);
      db.prepare('DELETE FROM dtwin_sessions WHERE id=?').run(sessionId);
      return res.status(500).json({ error: `Solo ${personas.length} profili generati (minimo 5). Riprova.` });
    }

    console.log('[dtwin] personas generated:', personas.length, 'sample[0]:', JSON.stringify(personas[0]));

    // ── Call 3: Interview simulation — each twin answers the survey ───────────
    const personasSummary = personas.map(p =>
      `{"id":"${p.id}","eta":${p.eta || '?'},"regione":"${p.regione || '?'}","tipo_installazioni":"${p.tipo_installazioni || '?'}","anni_attivita":"${p.anni_attivita || '?'}"}`
    ).join(',\n');

    const interviewRaw = await groq(SYS_INTERVIEW,
      `Hai ${personas.length} installatori da intervistare sulla percezione del brand Giacomini.
Obiettivo ricerca: "${objective}"

PROFILI:
[${personasSummary}]

Per OGNUNO dei ${personas.length} profili, simula le sue risposte alla survey Giacomini.
Restituisci un array JSON di ESATTAMENTE ${personas.length} oggetti (uno per profilo, stesso ordine):
[{"id":"DT_001","prima_associazione":"Qualità e affidabilità","uso_prodotti":"Sì","prodotti_usati":"Valvole termostatiche, Collettori","valutazione_qualita":4,"valutazione_facilita":4,"valutazione_prezzo":3,"valutazione_disponibilita":3,"valutazione_assistenza":3,"valutazione_formazione":3,"nps":7,"competitor_usati":"Caleffi, Ivar","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Affidabilità nel tempo, Disponibilità immediata","canali_informazione":"Rappresentanti commerciali, Colleghi e passaparola","contenuto_preferito":"Video installazione"}]`,
      4096);
    console.log('[dtwin] interviewRaw[:400]:', interviewRaw.substring(0, 400));

    let responses = [];
    try {
      const parsed = parseJSON(interviewRaw, true);
      if (Array.isArray(parsed)) responses = parsed;
    } catch {
      console.error('[dtwin] interview parse error, raw[:400]:', interviewRaw.substring(0, 400));
      // Non bloccare: usa risposte vuote, verranno segnalate nella UI
    }

    console.log('[dtwin] responses generated:', responses.length);

    // Build response map by ID
    const responseMap = {};
    responses.forEach(r => { if (r && r.id) responseMap[r.id] = r; });

    // Merge personas + responses
    const profiles = personas.map(p => {
      const r = responseMap[p.id] || {};
      return {
        persona: {
          id: p.id,
          eta: p.eta,
          nome: p.nome,
          cognome: p.cognome,
          genere: p.genere || 'M',
          regione_it: p.regione_it,
          specializzazione: p.tipo_installazioni,
          anni_att: p.anni_attivita,
        },
        risposte: {
          tipo_installazioni: p.tipo_installazioni,
          prima_associazione: r.prima_associazione || null,
          uso_prodotti: r.uso_prodotti || null,
          prodotti_usati: r.prodotti_usati || null,
          valutazione_qualita: r.valutazione_qualita ?? null,
          valutazione_facilita: r.valutazione_facilita ?? null,
          valutazione_prezzo: r.valutazione_prezzo ?? null,
          valutazione_disponibilita: r.valutazione_disponibilita ?? null,
          valutazione_assistenza: r.valutazione_assistenza ?? null,
          valutazione_formazione: r.valutazione_formazione ?? null,
          nps: r.nps ?? null,
          competitor_usati: r.competitor_usati || null,
          barriera_non_utilizzo: r.barriera_non_utilizzo || null,
          leva_attivazione: r.leva_attivazione || null,
          driver_scelta: r.driver_scelta || null,
          canali_informazione: r.canali_informazione || null,
          contenuto_preferito: r.contenuto_preferito || null,
          anni_attivita: p.anni_attivita,
          regione: p.regione,
        },
      };
    });

    // ── Persist to DB ─────────────────────────────────────────────────────────
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
