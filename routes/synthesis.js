const express = require('express');
const router = express.Router();
const { OpenAI } = require('openai');

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
    '## DATI SOCIAL LISTENING\n' + JSON.stringify(bw, null, 2) + '\n\n' +
    '## DATI GOOGLE TRENDS\n' + JSON.stringify(trends, null, 2) + '\n\n' +
    '## DATI SURVEY\n' +
    'Totale risposte: ' + (survey?.total || 0) + '\n' +
    'Completate: ' + (survey?.completed || 0) + '\n' +
    'Prima associazione: ' + JSON.stringify(survey?.byAssociation || []) + '\n' +
    'Valutazione vs competitor: ' + JSON.stringify(survey?.byRating || []) + '\n\n' +
    '## ISTRUZIONI\n' +
    'Produci una sintesi con:\n' +
    '### 1. Percezione generale del brand\n' +
    '### 2. Punti di forza emergenti\n' +
    '### 3. Aree di miglioramento\n' +
    '### 4. Posizionamento vs competitor\n' +
    '### 5. Segnali di tendenza\n' +
    '### 6. Raccomandazioni strategiche\n\n' +
    'Sii diretto, concreto, usa dati numerici. Tono professionale ma accessibile.';
}

module.exports = router;
