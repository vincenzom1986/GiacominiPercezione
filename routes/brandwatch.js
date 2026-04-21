const express = require('express');
const router = express.Router();
const axios = require('axios');

const BASE = 'https://api.brandwatch.com';

router.get('/', async (req, res) => {
  const { BRANDWATCH_API_KEY, BRANDWATCH_PROJECT_ID } = process.env;

  if (!BRANDWATCH_API_KEY || !BRANDWATCH_PROJECT_ID) {
    return res.json({ mock: true, data: getMockData() });
  }

  try {
    const headers = { Authorization: `Bearer ${BRANDWATCH_API_KEY}` };
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [mentionsRes, sentimentRes] = await Promise.all([
      axios.get(`${BASE}/projects/${BRANDWATCH_PROJECT_ID}/data/volume`, {
        headers, params: { startDate, endDate, granularity: 'days' },
      }),
      axios.get(`${BASE}/projects/${BRANDWATCH_PROJECT_ID}/data/sentiment`, {
        headers, params: { startDate, endDate },
      }),
    ]);

    res.json({ mock: false, mentions: mentionsRes.data, sentiment: sentimentRes.data });
  } catch (err) {
    console.error('Brandwatch error:', err.message);
    res.json({ mock: true, error: err.message, data: getMockData() });
  }
});

function getMockData() {
  return {
    totalMentions: 1240,
    sentiment: { positive: 42, neutral: 38, negative: 20 },
    sov: [
      { brand: 'Giacomini', share: 18 },
      { brand: 'Caleffi', share: 31 },
      { brand: 'Watts', share: 24 },
      { brand: 'Honeywell', share: 27 },
    ],
    topSources: [
      { source: 'Forum idraulici', mentions: 312 },
      { source: 'Facebook groups', mentions: 287 },
      { source: 'YouTube', mentions: 201 },
      { source: 'Blog tecnici', mentions: 156 },
    ],
    recentPosts: [
      { text: 'Ho installato i collettori Giacomini sul nuovo impianto, ottima qualita.', source: 'Forum idraulici', sentiment: 'positive' },
      { text: 'Giacomini ha prezzi alti rispetto a Caleffi, ma la qualita si sente.', source: 'Facebook', sentiment: 'neutral' },
      { text: 'Difficile trovare i raccordi Giacomini dal mio fornitore abituale.', source: 'Forum idraulici', sentiment: 'negative' },
    ],
  };
}

module.exports = router;
