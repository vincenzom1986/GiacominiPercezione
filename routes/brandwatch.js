const express = require('express');
const router = express.Router();
const axios = require('axios');

const BASE = 'https://api.brandwatch.com';
let cachedToken = null;
let tokenExpiry = 0;

async function getBearerToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const { BRANDWATCH_USERNAME, BRANDWATCH_PASSWORD } = process.env;
  const params = new URLSearchParams({
    grant_type: 'api-password',
    client_id: BRANDWATCH_USERNAME,
    username: BRANDWATCH_USERNAME,
    password: BRANDWATCH_PASSWORD,
  });
  const res = await axios.post(BASE + '/oauth/token', params.toString(), {
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

    const endDate = new Date().toISOString().slice(0, 19);
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);

    const queriesRes = await axios.get(BASE + '/projects/' + projectId + '/queries', { headers });
    const queries = queriesRes.data.results || [];
    const firstQueryId = queries[0]?.id;
    console.log('Using query:', queries[0]?.name, firstQueryId);

    const [mentionsRes, sentimentRes] = await Promise.all([
      axios.get(BASE + '/projects/' + projectId + '/data/mentions', {
        headers,
        params: { queryId: firstQueryId, startDate, endDate, pageSize: 5, page: 0, orderBy: 'date', orderDirection: 'desc' },
      }),
      axios.get(BASE + '/projects/' + projectId + '/data/volume/queries/compare', {
        headers,
        params: { queryId: firstQueryId, startDate, endDate, groupBy: 'sentiment' },
      }),
    ]);

    const mentions = mentionsRes.data.results || [];
    const totalMentions = mentionsRes.data.totalResults || mentions.length;

    const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    const sentimentResults = sentimentRes.data.results || [];
    sentimentResults.forEach(r => {
      if (r.name === 'positive') sentimentCounts.positive = r.volume || 0;
      else if (r.name === 'neutral') sentimentCounts.neutral = r.volume || 0;
      else if (r.name === 'negative') sentimentCounts.negative = r.volume || 0;
    });
    const sentimentTotal = sentimentCounts.positive + sentimentCounts.neutral + sentimentCounts.negative || 1;

    const recentPosts = mentions.slice(0, 5).map(m => ({
      text: m.snippet || m.title || '',
      source: m.domain || 'Web',
      sentiment: m.sentiment || 'neutral',
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
        recentPosts: recentPosts.length ? recentPosts : getMockData().recentPosts,
      },
    });
  } catch (err) {
    const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('Brandwatch error:', errMsg);
    res.json({ mock: true, error: errMsg, data: getMockData() });
  }
});

function getMockData() {
  return {
    totalMentions: 1240,
    sentiment: { positive: 42, neutral: 38, negative: 20 },
    sov: [
      { brand: 'Giacomini', share: 22 },
      { brand: 'Caleffi', share: 35 },
      { brand: 'Ivar', share: 18 },
      { brand: 'FAR Rubinetterie', share: 15 },
      { brand: 'RBM', share: 10 },
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

