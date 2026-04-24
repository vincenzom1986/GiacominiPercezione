'use strict';

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

router.post('/', async (req, res) => {
  const { brandwatch, survey, dtwin } = req.body;

  if (!brandwatch && !survey && !dtwin) {
    return res.status(400).json({ error: 'Nessuna fonte di dati fornita.' });
  }

  const prompt = buildPrompt(brandwatch, survey, dtwin);

  for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });
      return res.json({ synthesis: response.choices[0].message.content });
    } catch (err) {
      if (err.status === 429 && model !== 'llama-3.1-8b-instant') continue;
      console.error('Synthesis error:', err);
      return res.status(500).json({ error: 'Errore nella generazione della sintesi' });
    }
  }
});

function buildPrompt(bw, survey, dtwin) {
  const sections = [];

  sections.push(`Sei un analista di brand marketing specializzato nel settore idrotermosanitario italiano.
Analizza i dati disponibili su Giacomini e produci una sintesi professionale in italiano.
Usa solo le sezioni per le quali hai dati reali. Sii diretto e usa i numeri dove disponibili.`);

  if (survey) {
    sections.push(`## DATI SURVEY CAWI (installatori reali)
Totale risposte: ${survey.total || 0} | Completate: ${survey.completed || 0}
NPS medio: ${survey.avgNps ?? 'n.d.'}
Prima associazione: ${JSON.stringify(survey.byAssociation || [])}
Regioni: ${JSON.stringify(survey.byRegione || [])}
Anni attività: ${JSON.stringify(survey.byAnni || [])}
Barriere non utilizzo: ${JSON.stringify(survey.byBarriera || [])}
Leve attivazione: ${JSON.stringify(survey.byLeva || [])}
Competitor usati: ${JSON.stringify(survey.byCompetitor || [])}
Driver di scelta: ${JSON.stringify(survey.byDriver || [])}
Risposte recenti:
${(survey.allCompleted || survey.recent || []).slice(0, 8).map(r =>
  `- Tipo: ${r.tipo_installazioni || '?'} | Uso Giacomini: ${r.uso_prodotti || '?'} | Barriera: ${r.barriera_non_utilizzo || '–'} | Leva: ${r.leva_attivazione || '–'}`
).join('\n')}`);
  }

  if (dtwin) {
    const profiles = dtwin.profiles || [];
    const sess = dtwin.session || {};
    const users = profiles.filter(p => (p.uso_prodotti || p.risposte?.uso_prodotti) === 'Sì');
    const npsList = profiles.map(p => p.nps ?? p.risposte?.nps).filter(n => n != null);
    const avgNps = npsList.length ? (npsList.reduce((a, b) => a + b, 0) / npsList.length).toFixed(1) : 'n.d.';
    sections.push(`## DATI DIGITAL TWIN (campione sintetico AI, n=${profiles.length})
Obiettivo sessione: ${sess.objective || 'n.d.'}
Profili utilizzatori Giacomini: ${users.length} su ${profiles.length} (${profiles.length ? Math.round(users.length/profiles.length*100) : 0}%)
NPS medio: ${avgNps}
Promotori (≥9): ${npsList.filter(n => n >= 9).length} | Passivi (7-8): ${npsList.filter(n => n >= 7 && n <= 8).length} | Detrattori (<7): ${npsList.filter(n => n < 7).length}`);
  }

  if (bw) {
    const data = bw.data || bw;
    sections.push(`## DATI SOCIAL LISTENING (Brandwatch${bw.mock ? ' — DATI DEMO' : ''})
Mention 30gg: ${data.totalMentions || 0}
Sentiment: ${JSON.stringify(data.sentiment || {})}
Share of Voice: ${JSON.stringify(data.sov || [])}
Post rilevanti: ${(data.recentPosts || []).slice(0, 3).map(p => `[${p.sentiment}] ${p.text}`).join(' | ')}`);
  }

  sections.push(`## ISTRUZIONI OUTPUT
Produci una sintesi con le sezioni pertinenti ai dati disponibili:

### 1. Percezione generale del brand
### 2. Punti di forza emergenti
### 3. Aree di miglioramento
### 4. Posizionamento vs competitor
### 5. Raccomandazioni strategiche (3-5 azioni concrete)

Tono professionale. Se una fonte manca, non inventare dati — limitati a quelle disponibili.`);

  return sections.join('\n\n');
}

module.exports = router;
