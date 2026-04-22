const express = require('express');
const router = express.Router();
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

router.post('/', async (req, res) => {
  const { brandwatch, trends, survey } = req.body;
  const prompt = buildPrompt(brandwatch, trends, survey);
  try {
    const response = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ synthesis: response.choices[0].message.content });
  } catch (err) {
    console.error('Synthesis error:', err);
    res.status(500).json({ error: 'Errore nella generazione della sintesi' });
  }
});

function buildPrompt(bw, trends, survey) {
  return 'Sei un analista di brand marketing specializzato nel settore idrotermosanitario italiano.\n' +
    'Analizza i seguenti dati raccolti su Giacomini e produci una sintesi professionale in italiano.\n\n' +
    '## DATI SOCIAL LISTENING (Brandwatch)\n' +
    JSON.stringify(bw, null, 2) + '\n\n' +
    '## DATI SEARCH DEMAND (Google Trends - ultimi 12 mesi, Italia)\n' +
    JSON.stringify(trends, null, 2) + '\n\n' +
    '## DATI SURVEY (risposte di installatori e idraulici)\n' +
    'Totale risposte: ' + (survey?.total || 0) + '\n' +
    'Completate: ' + (survey?.completed || 0) + '\n' +
    'Distribuzione per tipo installazioni: ' + JSON.stringify(survey?.byType || []) + '\n' +
    'Prima associazione con il brand: ' + JSON.stringify(survey?.byAssociation || []) + '\n' +
    'Valutazione vs competitor: ' + JSON.stringify(survey?.byRating || []) + '\n\n' +
    'Risposte qualitative recenti:\n' +
    (survey?.allCompleted || []).slice(0, 10).map(r =>
      '- Tipo: ' + r.tipo_installazioni + ' | Delusioni/miglioramenti: ' + (r.delusioni_miglioramenti || 'n.d.') + ' | Commento: ' + (r.commento_libero || 'n.d.')
    ).join('\n') + '\n\n' +
    '## ISTRUZIONI\n' +
    'Produci una sintesi strutturata con queste sezioni:\n\n' +
    '### 1. Percezione generale del brand\n' +
    'Come viene percepito Giacomini nel mercato italiano degli installatori.\n\n' +
    '### 2. Punti di forza emergenti\n' +
    'Cosa apprezzano gli installatori e dove Giacomini eccelle.\n\n' +
    '### 3. Aree di miglioramento\n' +
    'Criticità emerse dalle survey e dai social.\n\n' +
    '### 4. Posizionamento vs competitor\n' +
    'Confronto con Caleffi, Ivar, ICMA, FAR Rubinetterie, RBM basato sui dati disponibili.\n\n' +
    '### 5. Segnali di tendenza\n' +
    'Trend di ricerca e argomenti in crescita che Giacomini dovrebbe presidiare.\n\n' +
    '### 6. Raccomandazioni strategiche\n' +
    '3-5 azioni concrete basate sui dati.\n\n' +
    'Sii diretto, concreto e usa i dati numerici dove disponibili. Tono professionale ma accessibile.';
}

module.exports = router;

