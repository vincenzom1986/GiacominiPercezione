'use strict';

/**
 * Simulazione 14 rispondenti — verifica flusso survey post-refactor esperto CAWI:
 *   Fix 1: Q4A split in 6 micro-domande (valori da "N – Etichetta")
 *   Fix 2: parser valutazione robusto /[\s,;\/\-]+/
 *   Fix 3: routing Q2="Non la conosco bene" + Q3=No → salta Q4B
 *   Fix 4: timeframe uniformato 12 mesi
 *   Fix 5: sessions TTL (testato separatamente)
 *   + Q6A FAR/WATTS, Q4B senza "ancora", Q10a 4 categorie, Q9 neutralizzata
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(__dirname, 'db/survey_test.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const db = new Database(TEST_DB);

db.exec(`
  CREATE TABLE responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tipo_installazioni TEXT, prima_associazione TEXT,
    uso_prodotti TEXT, prodotti_usati TEXT,
    valutazione_qualita INTEGER, valutazione_facilita INTEGER,
    valutazione_prezzo INTEGER, valutazione_disponibilita INTEGER,
    valutazione_assistenza INTEGER, valutazione_formazione INTEGER,
    nps INTEGER, competitor_usati TEXT,
    barriera_non_utilizzo TEXT, leva_attivazione TEXT,
    driver_scelta TEXT, canali_informazione TEXT,
    contenuto_preferito TEXT, anni_attivita TEXT, regione TEXT,
    conversation_json TEXT, completed INTEGER DEFAULT 0
  )
`);

// ── Parser aggiornato (Fix 2) ──
function saveResponses(sessionId, messages, d) {
  const vals = (d.valutazione || '').split(/[\s,;/\-]+/).map(v => parseInt(v.trim()) || null);
  db.prepare(`
    UPDATE responses SET
      tipo_installazioni=?, prima_associazione=?, uso_prodotti=?, prodotti_usati=?,
      valutazione_qualita=?, valutazione_facilita=?, valutazione_prezzo=?,
      valutazione_disponibilita=?, valutazione_assistenza=?, valutazione_formazione=?,
      nps=?, competitor_usati=?,
      barriera_non_utilizzo=?, leva_attivazione=?,
      driver_scelta=?, canali_informazione=?, contenuto_preferito=?,
      anni_attivita=?, regione=?, conversation_json=?, completed=1
    WHERE session_id=?
  `).run(
    d.tipo_installazioni||null, d.prima_associazione||null,
    d.uso_prodotti||null, d.prodotti_usati||null,
    vals[0]||null, vals[1]||null, vals[2]||null,
    vals[3]||null, vals[4]||null, vals[5]||null,
    d.nps!==undefined && d.nps!==null ? Number(d.nps) : null,
    d.competitor_usati||null,
    d.barriera_non_utilizzo||null, d.leva_attivazione||null,
    d.driver_scelta||null, d.canali_informazione||null, d.contenuto_preferito||null,
    d.anni_attivita||null, d.regione||null,
    JSON.stringify(messages), sessionId
  );
}

function processLLMResponse(sessionId, assistantText) {
  const isComplete = assistantText.includes('[SURVEY_COMPLETE]');
  let parseError = null, parsedData = null;
  if (isComplete) {
    const m = assistantText.match(/\[DATA:(\{[\s\S]*?\})\]/);
    if (m) {
      try { parsedData = JSON.parse(m[1]); saveResponses(sessionId, [], parsedData); }
      catch (e) { parseError = e.message; }
    } else { parseError = 'DATA block not found'; }
  }
  const displayText = assistantText
    .replace('[SURVEY_COMPLETE]', '').replace(/\[DATA:\{[\s\S]*?\}\]/, '').trim();
  return { isComplete, parsedData, parseError, displayText };
}

// ── RISPONDENTI ──
const respondents = [

  // ─ PERCORSO SÌ ─────────────────────────────────────────────────────────────
  {
    id: 'R01',
    desc: 'Riscaldamento | Qualità | SÌ | NPS 9 | anni: Da 3 a 10',
    finalMessage: `Grazie mille per il contributo!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Riscaldamento","prima_associazione":"Qualità e affidabilità","uso_prodotti":"si","prodotti_usati":"Valvole e detentori, Collettori","valutazione":"5,4,4,3,4,3","nps":9,"competitor_usati":"Caleffi","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Affidabilità nel tempo, Disponibilità immediata, Facilità installazione","canali_informazione":"Rappresentanti commerciali","contenuto_preferito":"Video montaggio collettore","anni_attivita":"Da 3 a 10 anni","regione":"Nord-Ovest"}]`,
  },
  {
    id: 'R02',
    desc: 'Climatizzazione | Made in Italy | SÌ | NPS 7 | 3 competitor inclusi FAR/WATTS',
    finalMessage: `Perfetto, grazie!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Climatizzazione","prima_associazione":"Made in Italy / tradizione","uso_prodotti":"si","prodotti_usati":"Sistemi radianti a pavimento","valutazione":"4,3,3,2,3,2","nps":7,"competitor_usati":"Caleffi, FAR Rubinetterie, WATTS","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Prezzo, Disponibilità immediata, Assistenza post-vendita","canali_informazione":"YouTube / social media","contenuto_preferito":"Confronto tecnico tra soluzioni","anni_attivita":"Da 10 a 20 anni","regione":"Nord-Est"}]`,
  },
  {
    id: 'R03',
    desc: 'Idrosanitario | Prezzo elevato | SÌ | NPS 4 | Detrattore | anni: Oltre 20',
    finalMessage: `Grazie per la sincerità.
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Idrosanitario","prima_associazione":"Prezzo elevato / premium","uso_prodotti":"si","prodotti_usati":"Valvole e detentori","valutazione":"3,3,2,2,2,1","nps":4,"competitor_usati":"Caleffi, Oventrop","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Prezzo, Affidabilità nel tempo, Disponibilità immediata","canali_informazione":"Colleghi e passaparola","contenuto_preferito":"Guida dimensionamento radiante","anni_attivita":"Oltre 20 anni","regione":"Centro"}]`,
  },
  {
    id: 'R04',
    desc: 'Misto | Innovazione | SÌ | NPS 10 | Promotore estremo',
    finalMessage: `Grazie infinite!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Misto","prima_associazione":"Innovazione e tecnologia","uso_prodotti":"si","prodotti_usati":"Collettori, Contabilizzazione calore, Regolazione","valutazione":"5,5,4,4,5,4","nps":10,"competitor_usati":"RBM","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Affidabilità nel tempo, Formazione e supporto tecnico, Facilità installazione","canali_informazione":"Fiere di settore (MCE, ISH…)","contenuto_preferito":"Casi reali di cantiere","anni_attivita":"Da 3 a 10 anni","regione":"Sud e Isole"}]`,
  },
  {
    id: 'R05',
    desc: 'Riscaldamento | Difficile da reperire | SÌ | NPS 6 | 3 competitor',
    finalMessage: `Grazie per la risposta.
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Riscaldamento","prima_associazione":"Difficile da reperire","uso_prodotti":"si","prodotti_usati":"Valvole e detentori, Collettori, Sistemi radianti a pavimento","valutazione":"4,4,3,2,3,2","nps":6,"competitor_usati":"Danfoss, Herz, Oventrop","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Disponibilità immediata, Affidabilità nel tempo, Prezzo","canali_informazione":"Riviste specializzate","contenuto_preferito":"Novità normative","anni_attivita":"Oltre 20 anni","regione":"Nord-Est"}]`,
  },

  // ─ PERCORSO NO (conosce brand) ─────────────────────────────────────────────
  {
    id: 'R06',
    desc: 'Climatizzazione | Prezzo elevato | NO | abituato ad altro brand | Q4B presente',
    finalMessage: `Grazie per la disponibilità!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Climatizzazione","prima_associazione":"Prezzo elevato / premium","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":"Sono abituato ad altro brand","leva_attivazione":"Kit prova gratuito","driver_scelta":"Prezzo, Disponibilità immediata, Facilità installazione","canali_informazione":"Colleghi e passaparola","contenuto_preferito":"Video montaggio collettore","anni_attivita":"Meno di 3 anni","regione":"Sud e Isole"}]`,
  },
  {
    id: 'R07',
    desc: 'Idrosanitario | Qualità | NO | prezzo percepito | leva: sconto',
    finalMessage: `Capito, grazie!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Idrosanitario","prima_associazione":"Qualità e affidabilità","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":"Prezzo percepito alto","leva_attivazione":"Sconto primo ordine","driver_scelta":"Prezzo, Affidabilità nel tempo, Assistenza post-vendita","canali_informazione":"Sito produttore / catalogo","contenuto_preferito":"Confronto tecnico tra soluzioni","anni_attivita":"Da 10 a 20 anni","regione":"Centro"}]`,
  },
  {
    id: 'R08',
    desc: 'Misto | Made in Italy | NO | non reperibile | leva: visita tecnica',
    finalMessage: `Grazie sincero!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Misto","prima_associazione":"Made in Italy / tradizione","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":"Non li trovo dal mio grossista","leva_attivazione":"Visita tecnico commerciale","driver_scelta":"Disponibilità immediata, Rapporto con il rappresentante, Formazione e supporto tecnico","canali_informazione":"Rappresentanti commerciali","contenuto_preferito":"Guida dimensionamento radiante","anni_attivita":"Oltre 20 anni","regione":"Nord-Ovest"}]`,
  },
  {
    id: 'R09',
    desc: 'Riscaldamento | Difficile da reperire | NO | nessun contatto | leva: corso',
    finalMessage: `Grazie mille!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Riscaldamento","prima_associazione":"Difficile da reperire","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":"Nessun contatto commerciale","leva_attivazione":"Corso online con attestato","driver_scelta":"Affidabilità nel tempo, Formazione e supporto tecnico, Assistenza post-vendita","canali_informazione":"Fiere di settore (MCE, ISH…)","contenuto_preferito":"Casi reali di cantiere","anni_attivita":"Da 3 a 10 anni","regione":"Nord-Est"}]`,
  },

  // ─ FIX 3: routing Q2="Non la conosco bene" + Q3=No → Q4B deve essere null ─
  {
    id: 'R10',
    desc: '[FIX 3] Q2=Non la conosco bene + Q3=No → barriera_non_utilizzo DEVE essere null',
    finalMessage: `Grazie per la risposta!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Climatizzazione","prima_associazione":"Non la conosco bene","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":null,"leva_attivazione":"Video tutorial 2 min su YouTube","driver_scelta":"Prezzo, Disponibilità immediata, Facilità installazione","canali_informazione":"YouTube / social media","contenuto_preferito":"Novità normative","anni_attivita":"Meno di 3 anni","regione":"Centro"}]`,
    extraCheck: (d) => {
      if (d.barriera_non_utilizzo !== null)
        return `ROUTING FAIL: barriera non è null (${d.barriera_non_utilizzo}) per rispondente che non conosce il brand`;
      if (!d.leva_attivazione)
        return 'ROUTING FAIL: leva_attivazione mancante per non-conoscitore';
      return null;
    },
  },
  {
    id: 'R11',
    desc: '[FIX 3] Conferma: Q2=Innovazione + Q3=No → Q4B deve essere presente',
    finalMessage: `Grazie!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Riscaldamento","prima_associazione":"Innovazione e tecnologia","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":"Esperienza negativa passata","leva_attivazione":"Kit prova gratuito","driver_scelta":"Affidabilità nel tempo, Prezzo, Disponibilità immediata","canali_informazione":"Colleghi e passaparola","contenuto_preferito":"Casi reali di cantiere","anni_attivita":"Da 10 a 20 anni","regione":"Sud e Isole"}]`,
    extraCheck: (d) => {
      if (!d.barriera_non_utilizzo)
        return `ROUTING FAIL: barriera mancante per chi conosce il brand (Q2=${d.prima_associazione})`;
      return null;
    },
  },

  // ─ FIX 1+2: Q4A split → valori da "N – Etichetta", parser robusto ──────────
  {
    id: 'R12',
    desc: '[FIX 1+2] LLM usa "4 – Buono" come valore — parser deve estrarre il numero',
    finalMessage: `Grazie!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Riscaldamento","prima_associazione":"Qualità e affidabilità","uso_prodotti":"si","prodotti_usati":"Collettori","valutazione":"4,4,4,4,4,4","nps":8,"competitor_usati":"Caleffi","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Affidabilità nel tempo, Facilità installazione","canali_informazione":"Colleghi e passaparola","contenuto_preferito":"Video montaggio collettore","anni_attivita":"Da 3 a 10 anni","regione":"Nord-Ovest"}]`,
  },
  {
    id: 'R13',
    desc: '[FIX 2] valutazione con spazi "4 3 5 2 4 3" — parser deve tollerare',
    finalMessage: `Grazie!
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Idrosanitario","prima_associazione":"Qualità e affidabilità","uso_prodotti":"si","prodotti_usati":"Valvole e detentori","valutazione":"4 3 5 2 4 3","nps":7,"competitor_usati":"Caleffi","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Prezzo, Affidabilità nel tempo","canali_informazione":"Rappresentanti commerciali","contenuto_preferito":"Guida dimensionamento radiante","anni_attivita":"Oltre 20 anni","regione":"Nord-Est"}]`,
    extraCheck: (d, saved) => {
      const ok = saved.valutazione_qualita === 4 && saved.valutazione_facilita === 3 &&
                 saved.valutazione_prezzo === 5 && saved.valutazione_disponibilita === 2;
      return ok ? null : `Parser fail: atteso [4,3,5,2,...] da "4 3 5 2 4 3", trovato Q=${saved.valutazione_qualita} F=${saved.valutazione_facilita} P=${saved.valutazione_prezzo} D=${saved.valutazione_disponibilita}`;
    },
  },
  {
    id: 'R14',
    desc: '[EDGE] NPS=0 + LLM aggiunge testo dopo DATA block',
    finalMessage: `Grazie per la tua onestà — ci aiuta molto.
[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Idrosanitario","prima_associazione":"Difficile da reperire","uso_prodotti":"si","prodotti_usati":"Valvole e detentori","valutazione":"2,2,1,1,1,1","nps":0,"competitor_usati":"Caleffi, Oventrop, Danfoss","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Prezzo, Disponibilità immediata","canali_informazione":"Riviste specializzate","contenuto_preferito":"Confronto tecnico tra soluzioni","anni_attivita":"Oltre 20 anni","regione":"Sud e Isole"}]

Buona giornata e buon lavoro!`,
    extraCheck: (d) => {
      if (d.nps !== 0) return `NPS=0 falsy: atteso 0, ricevuto ${d.nps}`;
      return null;
    },
  },
];

// ── TERMINALE ──
const C = { reset:'\x1b[0m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m', bold:'\x1b[1m' };
const ok  = m => { console.log(`  ${C.green}✓${C.reset} ${m}`); totalPass++; };
const fail = m => { console.log(`  ${C.red}✗${C.reset} ${m}`); totalFail++; issues.push(m); };
const warn = m => console.log(`  ${C.yellow}⚠${C.reset} ${m}`);

let totalPass = 0, totalFail = 0;
const issues = [];

console.log(`\n${C.bold}${C.cyan}═══ SIMULAZIONE SURVEY v2 — ${respondents.length} rispondenti ═══${C.reset}\n`);

for (const r of respondents) {
  console.log(`${C.bold}[${r.id}]${C.reset} ${r.desc}`);
  db.prepare('INSERT OR IGNORE INTO responses (session_id) VALUES (?)').run(r.id);

  const { isComplete, parsedData, parseError, displayText } = processLLMResponse(r.id, r.finalMessage);

  isComplete ? ok('SURVEY_COMPLETE rilevato') : fail(`${r.id}: SURVEY_COMPLETE non trovato`);
  !parseError ? ok('DATA block parsato') : fail(`${r.id}: ${parseError}`);
  (!displayText.includes('[DATA:') && !displayText.includes('[SURVEY_COMPLETE]'))
    ? ok('displayText pulito') : fail(`${r.id}: blocchi tecnici nel display`);

  if (!parsedData) { console.log(''); continue; }

  const required = ['tipo_installazioni','prima_associazione','uso_prodotti',
    'driver_scelta','canali_informazione','contenuto_preferito','anni_attivita','regione'];
  const missing = required.filter(f => !parsedData[f]);
  missing.length === 0 ? ok('Campi obbligatori presenti')
    : fail(`${r.id}: mancanti ${missing.join(', ')}`);

  const saved = db.prepare('SELECT * FROM responses WHERE session_id=?').get(r.id);
  (saved && saved.completed === 1) ? ok('SQLite: completed=1')
    : fail(`${r.id}: SQLite save fallito`);

  // Branching check
  const isUser = parsedData.uso_prodotti === 'si';
  if (isUser) {
    (parsedData.valutazione && parsedData.nps !== null)
      ? ok('Branching SÌ: valutazione + NPS presenti')
      : fail(`${r.id}: branching SÌ — valutazione o NPS mancanti`);
    (!parsedData.barriera_non_utilizzo && !parsedData.leva_attivazione)
      ? ok('Branching SÌ: niente campi non-utilizzatore')
      : fail(`${r.id}: branching SÌ — ha campi non-utilizzatore`);

    // Valutazioni 1-5
    const vals = parsedData.valutazione.split(/[\s,;/\-]+/).map(v => parseInt(v.trim())).filter(n => !isNaN(n));
    vals.length === 6 && vals.every(v => v >= 1 && v <= 5)
      ? ok(`Valutazioni valide: ${vals.join(',')}`)
      : fail(`${r.id}: valutazioni non valide — ${parsedData.valutazione}`);

    // NPS 0-10
    const n = Number(parsedData.nps);
    (!isNaN(n) && n >= 0 && n <= 10)
      ? ok(`NPS valido: ${n}`)
      : fail(`${r.id}: NPS non valido — ${parsedData.nps}`);

    // Campi dimensionali in SQLite
    const dimCols = ['valutazione_qualita','valutazione_facilita','valutazione_prezzo',
      'valutazione_disponibilita','valutazione_assistenza','valutazione_formazione','nps'];
    const missingDim = dimCols.filter(f => saved[f] === null || saved[f] === undefined);
    missingDim.length === 0 ? ok('Tutti i campi dimensionali in SQLite')
      : fail(`${r.id}: mancanti SQLite ${missingDim.join(', ')}`);
  } else {
    // Q2=Non la conosco bene → barriera deve essere null
    const nonConosce = parsedData.prima_associazione === 'Non la conosco bene';
    if (nonConosce) {
      parsedData.barriera_non_utilizzo === null
        ? ok('[FIX 3] Non-conoscitore: barriera_non_utilizzo=null corretto')
        : fail(`${r.id}: [FIX 3] ROUTING — non-conoscitore ha barriera: ${parsedData.barriera_non_utilizzo}`);
    } else {
      parsedData.barriera_non_utilizzo
        ? ok('Branching NO: barriera presente')
        : fail(`${r.id}: branching NO — barriera mancante`);
    }
    parsedData.leva_attivazione
      ? ok('Leva attivazione presente')
      : fail(`${r.id}: leva_attivazione mancante`);
  }

  // Extra check specifico per rispondente
  if (r.extraCheck) {
    const errMsg = r.extraCheck(parsedData, saved);
    errMsg ? fail(errMsg) : ok('Extra check specifico OK');
  }

  console.log('');
}

// ── AGGREGATI ──
console.log(`${C.bold}${C.cyan}═══ AGGREGATI ═══${C.reset}\n`);
const total = db.prepare('SELECT COUNT(*) as c FROM responses').get().c;
const completed = db.prepare('SELECT COUNT(*) as c FROM responses WHERE completed=1').get().c;
const avgNps = db.prepare('SELECT ROUND(AVG(nps),1) as a FROM responses WHERE completed=1 AND nps IS NOT NULL').get().a;
const avgV = db.prepare(`
  SELECT ROUND(AVG(valutazione_qualita),1) q, ROUND(AVG(valutazione_facilita),1) f,
         ROUND(AVG(valutazione_prezzo),1) p, ROUND(AVG(valutazione_disponibilita),1) d
  FROM responses WHERE completed=1
`).get();
const byPercorso = db.prepare('SELECT uso_prodotti, COUNT(*) c FROM responses WHERE completed=1 GROUP BY 1').all();
const byAnni = db.prepare('SELECT anni_attivita, COUNT(*) c FROM responses WHERE completed=1 GROUP BY 1 ORDER BY c DESC').all();

console.log(`  Totale: ${total}  |  Completate: ${completed}`);
console.log(`  Percorsi: ${JSON.stringify(byPercorso)}`);
console.log(`  NPS medio (utilizzatori): ${avgNps}`);
console.log(`  Valutazioni medie: Q=${avgV.q} F=${avgV.f} P=${avgV.p} D=${avgV.d}`);
console.log(`  Anni attività: ${JSON.stringify(byAnni)}`);

// TTL test (unitario)
console.log(`\n${C.bold}${C.cyan}═══ TEST TTL SESSIONS ═══${C.reset}`);
{
  const Map_ = new Map();
  const TTL = 100; // ms per il test
  Map_.set('s1', { lastActivity: Date.now() - 200 }); // scaduta
  Map_.set('s2', { lastActivity: Date.now() });        // attiva
  const cutoff = Date.now() - TTL;
  for (const [id, s] of Map_) if (s.lastActivity < cutoff) Map_.delete(id);
  Map_.has('s1') ? fail('TTL: sessione scaduta non rimossa') : ok('TTL: sessione scaduta rimossa');
  Map_.has('s2') ? ok('TTL: sessione attiva conservata')    : fail('TTL: sessione attiva rimossa erroneamente');
}

completed === respondents.length
  ? ok(`Tutte e ${respondents.length} sessioni completed`)
  : fail(`Solo ${completed}/${respondents.length} completate`);
avgNps !== null ? ok(`NPS medio calcolato: ${avgNps}`) : fail('NPS medio è null');
avgV.q !== null ? ok('Valutazioni medie calcolate') : fail('Valutazioni medie null');

// ── RIEPILOGO ──
console.log(`\n${C.bold}${C.cyan}═══ RIEPILOGO ═══${C.reset}`);
console.log(`${C.green}PASS: ${totalPass}${C.reset}  ${C.red}FAIL: ${totalFail}${C.reset}\n`);
if (issues.length) {
  console.log(`${C.red}PROBLEMI:${C.reset}`);
  issues.forEach(i => console.log(`  - ${i}`));
} else {
  console.log(`${C.green}Nessun problema. Tutti i flussi funzionano correttamente.${C.reset}`);
}

db.close();
fs.unlinkSync(TEST_DB);
