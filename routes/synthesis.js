const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

router.post('/', async (req, res) => {
  const { brandwatch, trends, survey } = req.body;

  const prompt = buildPrompt(brandwatch, trends, survey);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    res.json({ synthesis: response.content[0].text });
  } catch (err) {
    console.error('Synthesis error:', err);
    res.status(500).json({ error: 'Errore nella generazione della sintesi' });
  }
});

function buildPrompt(bw, trends, survey) {
  return `Sei un analista di brand marketing specializzato nel settore idrotermosanitario italiano.
Analizza i seguenti dati raccolti su Giacomini e produci una sintesi professionale in italiano.

## DATI SOCIAL LISTENING (Brandwatch)
${JSON.stringify(bw, null, 2)}

## DATI SEARCH DEMAND (Google Trends - ultimi 12 mesi, Italia)
${JSON.stringify(trends, null, 2)}

## DATI SURVEY (risposte di installatori e idraulici)
Totale risposte: ${survey?.total || 0}
Completate: ${survey?.completed || 0}
Distribuzione per tipo installazioni: ${JSON.stringify(survey?.byType || [])}
Prima associazione con il brand: ${JSON.stringify(survey?.byAssociation || [])}
Valutazione vs competitor: ${JSON.stringify(survey?.byRating || [])}

Risposte qualitative recenti:
${(survey?.allCompleted || []).slice(0, 10).map(r => `- Tipo: ${r.tipo_installazioni} | Delusioni: ${r.delusioni_miglioramenti || 'n.d.'} | Commento: ${r.commento_libero || 'n.d.'}`).join('\n')}

## ISTRUZIONI
Produci una sintesi strutturata con queste sezioni:
### 1. Percezione generale del brand
### 2. Punti di forza emergenti
### 3. Aree di miglioramento
### 4. Posizionamento vs competitor
### 5. Segnali di tendenza
### 6. Raccomandazioni strategiche

Sii diretto, concreto, usa i dati numerici dove disponibili. Tono professionale ma accessibile.`;
}

module.exports = router;
