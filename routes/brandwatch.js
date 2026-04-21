const express = require('express');
const router = express.Router();
const axios = require('axios');

const BASE = 'https://api.brandwatch.com';
let cachedToken = null;
let tokenExpiry = 0;

async function getBearerToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const { BRANDWATCH_USERNAME, BRANDWATCH_PASSWORD } = process.env;
  const params = new URLSearchParams();
  params.append('grant_type', 'api-password');
  params.append('username', BRANDWATCH_USERNAME);
  params.append('password', BRANDWATCH_PASSWORD);
  params.append('client_id', 'brandwatch-api-client');

  const res = await axios.post(`${BASE}/oauth/token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

router.get('/', async (req, res) => {
  const { BRANDWATCH_USERNAME, BRANDWATCH_PASSWORD, BRANDWATCH_PROJECT_ID } = process.env;

  if (!BRANDWATCH_USERNAME || !BRANDWATCH_PASSWORD || !BRANDWATCH_PROJECT_ID) {
    return res.json({ mock: true, data: getMockData() });
  }

  try {
    const token = await getBearerToken();
    const headers = { Authorization: 'Bearer ' + token };
    const projectId = BRANDWATCH_PROJECT_ID;

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [mentionsRes, sentimentRes, mentionsDetailRes] = await Promise.all([
      axios.get(BASE + '/projects/' + projectId + '/data/volume', {
        headers,
        params: { startDate, endDate, granularity: 'days' },
      }),
      axios.get(BASE + '/projects/' + projectId + '/data/sentiment', {
        headers,
        params: { startDate, endDate },
      }),
      axios.get(BASE + '/projects/' + projectId + '/data/mentions', {
        headers,
        params: { startDate, endDate, pageSize: 5, orderBy: 'date', orderDirection: 'desc' },
      }),
    ]);

    const volumeData = mentionsRes.data;
    const sentimentData = sentimentRes.data;
    const mentionsData = mentionsDetailRes.data;

    const totalMentions = volumeData.dailyData
      ? volumeData.dailyData.reduce((sum, d) => sum + (d.numberOfMentions || 0), 0)
      : (volumeData.totalVolume || 0);

    const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    if (sentimentData.sentiments) {
      sentimentData.sentiments.forEach(s => {
        if (s.name === 'positive') sentimentCounts.positive = s.numberOfMentions || 0;
        else if (s.name === 'neutral') sentimentCounts.neutral = s.numberOfMentions || 0;
        else if (s.name === 'negative') sentimentCounts.negative = s.numberOfMentions || 0;
      });
    }
    const sentimentTotal = sentimentCounts.positive + sentimentCounts.neutral + sentimentCounts.negative || 1;

    const recentPosts = (mentionsData.results || []).slice(0, 5).map(m => ({
      text: m.snippet || m.title || '',
      source: m.domain || m.authorName || 'Web',
      sentiment: m.sentiment || 'neutral',
      url: m.url || '',
    }));

    res.json({
      mock: false,
      data: {
        totalMentions,
        sentiment: {
          positive: Math.round((sentimentCounts.positive / sentimentTotal) * 100),
          neutral: Math.round((sentimentCounts.neutral / sentimentTotal) * 100),
          negative: Math.round((sentimentCounts.negative / sentimentTotal) * 100),
        },
        sov: getMockData().sov,
        topSources: getMockData().topSources,
        recentPosts,
      },
    });
  } catch (err) {
    console.error('Brandwatch error:', err.response ? JSON.stringify(err.response.data) : err.message);
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
      { text: 'Ho installato i collettori Giacomini sul nuovo impianto, ottima qualità.', source: 'Forum idraulici', sentiment: 'positive' },
      { text: 'Giacomini ha prezzi alti rispetto a Caleffi, ma la qualità si sente.', source: 'Facebook', sentiment: 'neutral' },
      { text: 'Difficile trovare i raccordi Giacomini dal mio fornitore abituale.', source: 'Forum idraulici', sentiment: 'negative' },
    ],
  };
}

module.exports = router;

