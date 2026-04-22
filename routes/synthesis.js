const express = require('express');
const router = express.Router();
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

router.post('/', async (req, res) => {
  const { brandwatch, survey } = req.body;

  const prompt = buildPrompt(brandwatch, survey);

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

function buildPrompt(bw, survey) {
  return `Sei un analista di brand marketing specializzato nel settore idrotermosanitario italiano.
Analizza i seguenti dati raccolti su Giacomini e produci una sintesi professionale in italiano.

## DATI SOCIAL LISTENING (Brandwatch)
${JSON.stringify(bw, null, 2)}

## DATI SURVEY (risposte di installatori e idraulici)
Totale risposte: ${survey?.total || 0}
Completate: ${survey?.completed || 0}
Distribuzione per tipo installazioni: ${JSON.stringify(survey?.byType || [])}
Prima associazione con il brand: ${JSON.stringify(survey?.byAssociation || [])}
Valutazione vs competitor: ${JSON.stringify(survey?.byRating || [])}

Risposte qualitative recenti:
${(survey?.allCompleted || []).slice(0, 10).map(r => `- Tipo: ${r.tipo_installazioni} | Delusioni/miglioramenti: ${r.delusioni_miglioramenti || 'n.d.'} | Commento: ${r.commento_libero || 'n.d.'}`).join('\n')}

## ISTRUZIONI
Produci una sintesi strutturata con queste sezioni:

### 1. Percezione generale del brand
Come viene percepito Giacomini nel mercato italiano degli installatori.

### 2. Punti di forza emergenti
Cosa apprezzano gli installatori e dove Giacomini eccelle.

### 3. Aree di miglioramento
Criticità emerse dalle survey e dai social.

### 4. Posizionamento vs competitor
Confronto con Caleffi, Ivar, ICMA, FAR Rubinetterie, RBM basato sui dati disponibili.

### 5. Raccomandazioni strategiche
3-5 azioni concrete basate sui dati.

Sii diretto, concreto e usa i dati numerici dove disponibili. Tono professionale ma accessibile.`;
}

module.exports = router;
