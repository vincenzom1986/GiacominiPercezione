'use strict';

/**
 * Simula 10 rispondenti con diversi percorsi per verificare:
 * - Branching corretto Q3=Sì/No
 * - Parsing DATA block
 * - Salvataggio SQLite
 * - Regex robustezza
 *
 * Non chiama la vera API: usa risposte LLM pre-costruite
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Usa un DB di test separato
const TEST_DB_PATH = path.join(__dirname, 'db/survey_test.db');
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

const db = new Database(TEST_DB_PATH);

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

// ── Stessa logica di saveResponses da routes/survey.js ──
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

// ── Stessa logica di parsing da /message handler (FIXED regex) ──
function processLLMResponse(sessionId, assistantText) {
  const isComplete = assistantText.includes('[SURVEY_COMPLETE]');
  let parseError = null;
  let parsedData = null;

  if (isComplete) {
    const dataMatch = assistantText.match(/\[DATA:(\{[\s\S]*?\})\]/);
    if (dataMatch) {
      try {
        parsedData = JSON.parse(dataMatch[1]);
        saveResponses(sessionId, [], parsedData);
      } catch (e) {
        parseError = e.message;
      }
    } else {
      parseError = 'DATA block not found';
    }
  }

  const displayText = assistantText
    .replace('[SURVEY_COMPLETE]', '')
    .replace(/\[DATA:\{[\s\S]*?\}\]/, '')
    .trim();

  return { isComplete, parsedData, parseError, displayText };
}

// ── 10 RISPONDENTI SIMULATI ──
// Ogni scenario include il testo finale che l'LLM emetterebbe alla chiusura del questionario

const respondents = [
  // --- PERCORSO SÌ ---
  {
    id: 'R01',
    desc: 'Riscaldamento | Qualità e affidabilità | SÌ | alta soddisfazione | NPS 9',
    finalMessage: `Grazie mille per il tuo tempo e per le risposte preziose! Il tuo contributo ci aiuta davvero a capire meglio le esigenze dei professionisti.

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Riscaldamento","prima_associazione":"Qualità e affidabilità","uso_prodotti":"si","prodotti_usati":"Valvole e detentori, Collettori","valutazione":"5,4,4,3,4,3","nps":9,"competitor_usati":"Caleffi","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Affidabilità nel tempo, Disponibilità immediata, Facilità installazione","canali_informazione":"Rappresentanti commerciali","contenuto_preferito":"Video montaggio collettore","anni_attivita":"Oltre 15 anni","regione":"Nord-Ovest"}]`,
  },
  {
    id: 'R02',
    desc: 'Climatizzazione | Made in Italy | SÌ | soddisfazione media | NPS 7 | 3 competitor',
    finalMessage: `Perfetto, grazie per la tua partecipazione!

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Climatizzazione","prima_associazione":"Made in Italy / tradizione","uso_prodotti":"si","prodotti_usati":"Sistemi radianti a pavimento","valutazione":"4,3,3,2,3,2","nps":7,"competitor_usati":"Caleffi, Ivar, Honeywell Resideo","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Prezzo, Disponibilità immediata, Assistenza post-vendita","canali_informazione":"YouTube / social media","contenuto_preferito":"Confronto diretto con Caleffi","anni_attivita":"Da 5 a 15 anni","regione":"Nord-Est"}]`,
  },
  {
    id: 'R03',
    desc: 'Idrosanitario | Prezzo elevato | SÌ | insoddisfatto | NPS 4 | Detrattore',
    finalMessage: `Grazie per la sincerità, le tue risposte sono fondamentali per migliorare.

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Idrosanitario","prima_associazione":"Prezzo elevato / premium","uso_prodotti":"si","prodotti_usati":"Valvole e detentori","valutazione":"3,3,2,2,2,1","nps":4,"competitor_usati":"Caleffi, Oventrop","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Prezzo, Affidabilità nel tempo, Disponibilità immediata","canali_informazione":"Colleghi e passaparola","contenuto_preferito":"Guida dimensionamento radiante","anni_attivita":"Oltre 15 anni","regione":"Centro"}]`,
  },
  {
    id: 'R04',
    desc: 'Misto | Innovazione | SÌ | soddisfazione alta | NPS 10 | massimo promotore',
    finalMessage: `Ottimo! Ti ringraziamo infinitamente per il tuo contributo così positivo!

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Misto","prima_associazione":"Innovazione e tecnologia","uso_prodotti":"si","prodotti_usati":"Collettori, Contabilizzazione calore, Regolazione","valutazione":"5,5,4,4,5,4","nps":10,"competitor_usati":"RBM","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Affidabilità nel tempo, Facilità installazione, Formazione","canali_informazione":"Fiere (MCE, Klimahouse…)","contenuto_preferito":"Casi reali di cantiere","anni_attivita":"Da 5 a 15 anni","regione":"Sud e Isole"}]`,
  },
  {
    id: 'R05',
    desc: 'Riscaldamento | Difficile da reperire | SÌ | frustrazione distribuzione | NPS 6 | 3 competitor',
    finalMessage: `Grazie per la tua risposta! Capire le difficoltà di reperibilità è molto importante per noi.

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Riscaldamento","prima_associazione":"Difficile da reperire","uso_prodotti":"si","prodotti_usati":"Valvole e detentori, Collettori, Sistemi radianti a pavimento","valutazione":"4,4,3,2,3,2","nps":6,"competitor_usati":"Danfoss, Herz, Oventrop","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Disponibilità immediata, Affidabilità nel tempo, Prezzo","canali_informazione":"Riviste specializzate","contenuto_preferito":"Novità normative","anni_attivita":"Oltre 15 anni","regione":"Nord-Est"}]`,
  },

  // --- PERCORSO NO ---
  {
    id: 'R06',
    desc: 'Climatizzazione | Non la conosco bene | NO | abituato ad altro brand | leva: kit prova',
    finalMessage: `Grazie per la disponibilità! Speriamo di poter essere utili in futuro.

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Climatizzazione","prima_associazione":"Non la conosco bene","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":"Sono abituato ad altro brand","leva_attivazione":"Kit prova gratuito","driver_scelta":"Prezzo, Disponibilità immediata, Facilità installazione","canali_informazione":"Colleghi e passaparola","contenuto_preferito":"Video montaggio collettore","anni_attivita":"Meno di 5 anni","regione":"Sud e Isole"}]`,
  },
  {
    id: 'R07',
    desc: 'Idrosanitario | Prezzo elevato | NO | prezzo percepito | leva: sconto primo ordine',
    finalMessage: `Capito, grazie per il tuo punto di vista! È esattamente il tipo di feedback di cui abbiamo bisogno.

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Idrosanitario","prima_associazione":"Prezzo elevato / premium","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":"Prezzo percepito alto","leva_attivazione":"Sconto primo ordine","driver_scelta":"Prezzo, Affidabilità nel tempo, Assistenza post-vendita","canali_informazione":"Sito produttore / catalogo","contenuto_preferito":"Confronto diretto con Caleffi","anni_attivita":"Da 5 a 15 anni","regione":"Centro"}]`,
  },
  {
    id: 'R08',
    desc: 'Misto | Non la conosco bene | NO | non reperibile dal grossista | leva: visita tecnica',
    finalMessage: `Grazie per la tua sincerità! Queste informazioni sono molto utili per migliorare la nostra rete distributiva.

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Misto","prima_associazione":"Non la conosco bene","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":"Non la trovo dal mio grossista","leva_attivazione":"Visita tecnico commerciale","driver_scelta":"Disponibilità immediata, Rapporto con il rappresentante, Formazione","canali_informazione":"Rappresentanti commerciali","contenuto_preferito":"Guida dimensionamento radiante","anni_attivita":"Oltre 15 anni","regione":"Nord-Ovest"}]`,
  },
  {
    id: 'R09',
    desc: 'Riscaldamento | Made in Italy | NO | nessun contatto commerciale | leva: corso online',
    finalMessage: `Grazie mille per aver partecipato! Il tuo contributo è prezioso.

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Riscaldamento","prima_associazione":"Made in Italy / tradizione","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":"Nessun contatto commerciale","leva_attivazione":"Corso online con attestato","driver_scelta":"Affidabilità nel tempo, Formazione, Assistenza post-vendita","canali_informazione":"Fiere (MCE, Klimahouse…)","contenuto_preferito":"Casi reali di cantiere","anni_attivita":"Da 5 a 15 anni","regione":"Nord-Est"}]`,
  },
  {
    id: 'R10',
    desc: 'Climatizzazione | Qualità e affidabilità | NO | esperienza negativa | leva: video YouTube',
    finalMessage: `Grazie per la tua onestà! Queste esperienze ci aiutano a capire dove migliorare.

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Climatizzazione","prima_associazione":"Qualità e affidabilità","uso_prodotti":"no","prodotti_usati":null,"valutazione":null,"nps":null,"competitor_usati":null,"barriera_non_utilizzo":"Esperienza negativa passata","leva_attivazione":"Video tutorial 2 min su YouTube","driver_scelta":"Affidabilità nel tempo, Disponibilità immediata, Prezzo","canali_informazione":"YouTube / social media","contenuto_preferito":"Novità normative","anni_attivita":"Meno di 5 anni","regione":"Centro"}]`,
  },

  // --- EDGE CASES ---
  {
    id: 'R11',
    desc: '[EDGE] LLM aggiunge testo dopo il blocco DATA — regex deve comunque parsare',
    finalMessage: `Un grazie speciale per il tuo contributo prezioso!

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Riscaldamento","prima_associazione":"Qualità e affidabilità","uso_prodotti":"si","prodotti_usati":"Collettori","valutazione":"4,4,4,4,4,4","nps":8,"competitor_usati":"Caleffi","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Affidabilità nel tempo, Facilità installazione","canali_informazione":"Colleghi e passaparola","contenuto_preferito":"Video montaggio collettore","anni_attivita":"Da 5 a 15 anni","regione":"Nord-Ovest"}]

Buona giornata e buon lavoro!`,
  },
  {
    id: 'R12',
    desc: '[EDGE] NPS=0 (detrattore estremo) — null handling corretto',
    finalMessage: `Grazie per la tua risposta.

[SURVEY_COMPLETE]
[DATA:{"tipo_installazioni":"Idrosanitario","prima_associazione":"Difficile da reperire","uso_prodotti":"si","prodotti_usati":"Valvole e detentori","valutazione":"2,2,1,1,1,1","nps":0,"competitor_usati":"Caleffi, Oventrop, Danfoss","barriera_non_utilizzo":null,"leva_attivazione":null,"driver_scelta":"Prezzo, Disponibilità immediata","canali_informazione":"Riviste specializzate","contenuto_preferito":"Confronto diretto con Caleffi","anni_attivita":"Oltre 15 anni","regione":"Sud e Isole"}]`,
  },
];

// ── COLORI TERMINALE ──
const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
};
const ok = msg => console.log(`  ${C.green}✓${C.reset} ${msg}`);
const fail = msg => console.log(`  ${C.red}✗${C.reset} ${msg}`);
const warn = msg => console.log(`  ${C.yellow}⚠${C.reset} ${msg}`);

// ── ESEGUI SIMULAZIONI ──
let totalPass = 0;
let totalFail = 0;
const issues = [];

console.log(`\n${C.bold}${C.cyan}═══ SIMULAZIONE SURVEY GIACOMINI — 10 rispondenti ═══${C.reset}\n`);

for (const r of respondents) {
  const sessionId = r.id;
  console.log(`${C.bold}[${r.id}]${C.reset} ${r.desc}`);

  // Inserisci session nel DB
  db.prepare('INSERT OR IGNORE INTO responses (session_id) VALUES (?)').run(sessionId);

  const { isComplete, parsedData, parseError, displayText } = processLLMResponse(sessionId, r.finalMessage);

  // Test 1: SURVEY_COMPLETE rilevato
  if (isComplete) { ok('SURVEY_COMPLETE rilevato'); totalPass++; }
  else { fail('SURVEY_COMPLETE NON rilevato'); totalFail++; issues.push(`${r.id}: SURVEY_COMPLETE non trovato`); }

  // Test 2: DATA block parsato senza errori
  if (!parseError) { ok('DATA block parsato correttamente'); totalPass++; }
  else { fail(`DATA parse error: ${parseError}`); totalFail++; issues.push(`${r.id}: ${parseError}`); }

  // Test 3: testo pulito non contiene blocchi tecnici
  if (parsedData && !displayText.includes('[DATA:') && !displayText.includes('[SURVEY_COMPLETE]')) {
    ok('displayText pulito (niente blocchi tecnici)'); totalPass++;
  } else {
    fail('displayText contiene ancora blocchi tecnici'); totalFail++;
    issues.push(`${r.id}: displayText contiene blocchi tecnici`);
  }

  if (!parsedData) { console.log(''); continue; }

  // Test 4: campi obbligatori sempre presenti
  const required = ['tipo_installazioni', 'prima_associazione', 'uso_prodotti',
    'driver_scelta', 'canali_informazione', 'contenuto_preferito', 'anni_attivita', 'regione'];
  const missingRequired = required.filter(f => !parsedData[f]);
  if (missingRequired.length === 0) { ok('Tutti i campi obbligatori presenti'); totalPass++; }
  else { fail(`Campi obbligatori mancanti: ${missingRequired.join(', ')}`); totalFail++; issues.push(`${r.id}: mancanti ${missingRequired}`); }

  // Test 5: branching corretto
  const isUser = parsedData.uso_prodotti === 'si';
  if (isUser) {
    const hasUserFields = parsedData.valutazione && parsedData.nps !== null;
    const noNonUserFields = !parsedData.barriera_non_utilizzo && !parsedData.leva_attivazione;
    if (hasUserFields && noNonUserFields) { ok('Branching UTILIZZATORE corretto'); totalPass++; }
    else {
      fail('Branching UTILIZZATORE errato');
      if (!hasUserFields) fail(`  → valutazione/nps mancanti: valutazione=${parsedData.valutazione}, nps=${parsedData.nps}`);
      if (!noNonUserFields) warn(`  → ha anche campi non-utilizzatore: barriera=${parsedData.barriera_non_utilizzo}`);
      totalFail++; issues.push(`${r.id}: branching utilizzatore errato`);
    }
  } else {
    const hasNonUserFields = parsedData.barriera_non_utilizzo && parsedData.leva_attivazione;
    const noUserFields = !parsedData.valutazione && parsedData.nps === null;
    if (hasNonUserFields && noUserFields) { ok('Branching NON UTILIZZATORE corretto'); totalPass++; }
    else {
      fail('Branching NON UTILIZZATORE errato');
      if (!hasNonUserFields) fail(`  → barriera/leva mancanti`);
      if (!noUserFields) warn(`  → ha campi utilizzatore: valutazione=${parsedData.valutazione}, nps=${parsedData.nps}`);
      totalFail++; issues.push(`${r.id}: branching non-utilizzatore errato`);
    }
  }

  // Test 6: verifica dato in SQLite
  const saved = db.prepare('SELECT * FROM responses WHERE session_id = ?').get(sessionId);
  if (saved && saved.completed === 1) { ok('Dato salvato in SQLite (completed=1)'); totalPass++; }
  else { fail('Dato NON salvato correttamente in SQLite'); totalFail++; issues.push(`${r.id}: SQLite save fallito`); }

  // Test 7: valori numerici corretti per utilizzatori
  if (isUser && parsedData.valutazione) {
    const vals = parsedData.valutazione.split(',').map(v => parseInt(v.trim()));
    const allValid = vals.length === 6 && vals.every(v => v >= 1 && v <= 5);
    if (allValid) { ok(`Valutazioni 6 dimensioni valide: ${vals.join(',')}`); totalPass++; }
    else { fail(`Valutazioni non valide: ${parsedData.valutazione} (attesi 6 numeri 1-5)`); totalFail++; issues.push(`${r.id}: valutazioni non valide`); }

    const npsNum = Number(parsedData.nps);
    if (!isNaN(npsNum) && npsNum >= 0 && npsNum <= 10) {
      ok(`NPS valido: ${npsNum}`); totalPass++;
    } else {
      fail(`NPS non valido: ${parsedData.nps}`); totalFail++; issues.push(`${r.id}: NPS non valido`);
    }
  }

  // Test 8: verifica saved SQLite fields specifici
  if (isUser) {
    const qaFields = ['valutazione_qualita','valutazione_facilita','valutazione_prezzo',
      'valutazione_disponibilita','valutazione_assistenza','valutazione_formazione','nps'];
    const missingInDb = qaFields.filter(f => saved[f] === null || saved[f] === undefined);
    if (missingInDb.length === 0) { ok('Tutti i campi dimensionali salvati in SQLite'); totalPass++; }
    else { fail(`Campi mancanti in SQLite: ${missingInDb.join(', ')}`); totalFail++; issues.push(`${r.id}: SQLite mancanti ${missingInDb}`); }
  } else {
    if (saved.barriera_non_utilizzo && saved.leva_attivazione) {
      ok(`Barriera e leva salvate in SQLite`); totalPass++;
    } else {
      fail(`Barriera/leva mancanti in SQLite: barriera=${saved.barriera_non_utilizzo}, leva=${saved.leva_attivazione}`);
      totalFail++; issues.push(`${r.id}: barriera/leva mancanti SQLite`);
    }
  }

  console.log('');
}

// ── RISULTATI AGGREGATI DB ──
console.log(`${C.bold}${C.cyan}═══ VERIFICA DATI AGGREGATI ═══${C.reset}\n`);

const total = db.prepare('SELECT COUNT(*) as c FROM responses').get().c;
const completed = db.prepare('SELECT COUNT(*) as c FROM responses WHERE completed = 1').get().c;
const avgNps = db.prepare('SELECT ROUND(AVG(nps),1) as avg FROM responses WHERE completed=1 AND nps IS NOT NULL').get().avg;
const avgVals = db.prepare(`
  SELECT ROUND(AVG(valutazione_qualita),1) as q, ROUND(AVG(valutazione_facilita),1) as f,
         ROUND(AVG(valutazione_prezzo),1) as p, ROUND(AVG(valutazione_disponibilita),1) as d,
         ROUND(AVG(valutazione_assistenza),1) as a, ROUND(AVG(valutazione_formazione),1) as fo
  FROM responses WHERE completed=1
`).get();

const byType = db.prepare('SELECT tipo_installazioni, COUNT(*) as c FROM responses WHERE completed=1 GROUP BY 1').all();
const byRegione = db.prepare('SELECT regione, COUNT(*) as c FROM responses WHERE completed=1 GROUP BY 1').all();
const byPercorso = db.prepare('SELECT uso_prodotti, COUNT(*) as c FROM responses WHERE completed=1 GROUP BY 1').all();
const byBarriera = db.prepare('SELECT barriera_non_utilizzo, COUNT(*) as c FROM responses WHERE completed=1 AND barriera_non_utilizzo IS NOT NULL GROUP BY 1').all();

console.log(`  Totale sessioni: ${total}`);
console.log(`  Completate: ${completed}`);
console.log(`  Percorsi: ${JSON.stringify(byPercorso)}`);
console.log(`  NPS medio: ${avgNps}`);
console.log(`  Valutazioni medie: Q=${avgVals.q} F=${avgVals.f} P=${avgVals.p} D=${avgVals.d} A=${avgVals.a} Fo=${avgVals.fo}`);
console.log(`  Distribuzione per tipo: ${JSON.stringify(byType)}`);
console.log(`  Distribuzione per regione: ${JSON.stringify(byRegione)}`);
console.log(`  Barriere non utilizzatori: ${JSON.stringify(byBarriera)}`);

const expectedCompleted = respondents.length;
if (completed === expectedCompleted) { ok(`Tutte e ${expectedCompleted} le sessioni marcate completed`); totalPass++; }
else { fail(`Solo ${completed}/${expectedCompleted} completate`); totalFail++; }

if (avgNps !== null) { ok(`NPS medio calcolato: ${avgNps}`); totalPass++; }
else { fail('NPS medio è null'); totalFail++; }

if (avgVals.q !== null) { ok('Valutazioni medie calcolate'); totalPass++; }
else { fail('Valutazioni medie sono null'); totalFail++; }

// ── RIEPILOGO FINALE ──
console.log(`\n${C.bold}${C.cyan}═══ RIEPILOGO ═══${C.reset}`);
console.log(`${C.green}PASS: ${totalPass}${C.reset}  ${C.red}FAIL: ${totalFail}${C.reset}\n`);

if (issues.length > 0) {
  console.log(`${C.red}PROBLEMI TROVATI:${C.reset}`);
  issues.forEach(i => console.log(`  - ${i}`));
} else {
  console.log(`${C.green}Nessun problema trovato. Tutti i flussi funzionano correttamente.${C.reset}`);
}

// Cleanup
db.close();
fs.unlinkSync(TEST_DB_PATH);
