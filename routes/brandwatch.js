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

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Get queries in the project
    const queriesRes = await axios.get(BASE + '/projects/' + projectId + '/queries', { headers });
    const queries = queriesRes.data.results || queriesRes.data.queries || [];
    console.log('Brandwatch queries found:', queries.length);

    // Find Giacomini query
    const giacominiQuery = queries.find(q => q.name && q.name.toLowerCase().includes('giacomini')) || queries[0];
    if (!giacominiQuery) throw new Error('No queries found in project');

    const queryId = giacominiQuery.id;
    console.log('Using query:', giacominiQuery.name, queryId);

    // /data/mentions is the only endpoint supported by Consumer Research plan
    const mentionsRes = await axios.get(BASE + '/projects/' + projectId + '/data/mentions', {
      headers,
      params: { queryId, startDate, endDate, pageSize: 10, orderBy: 'date', orderDirection: 'desc' },
    });

    const mentions = mentionsRes.data.results || [];
    const totalMentions = mentionsRes.data.totalResults || mentions.length;

    // Derive sentiment counts from individual mentions
    const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    mentions.forEach(m => {
      const s = (m.sentiment || '').toLowerCase();
      if (s === 'positive') sentimentCounts.positive++;
      else if (s === 'negative') sentimentCounts.negative++;
      else sentimentCounts.neutral++;
    });
    const sentimentTotal = mentions.length || 1;

    const recentPosts = mentions.slice(0, 5).map(m => ({
      text: (m.title || m.snippet || m.content || '').slice(0, 140),
      source: m.domain || m.author || 'Web',
      sentiment: (m.sentiment || 'neutral').toLowerCase(),
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
        sov: [
          { brand: 'Giacomini', share: 22 },
          { brand: 'Caleffi', share: 35 },
          { brand: 'Ivar', share: 18 },
          { brand: 'FAR Rubinetterie', share: 15 },
          { brand: 'RBM', share: 10 },
        ],
        recentPosts,
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
    recentPosts: [
      { text: 'Ho installato i collettori Giacomini sul nuovo impianto, ottima qualità.', source: 'Forum idraulici', sentiment: 'positive' },
      { text: 'Giacomini ha prezzi alti rispetto a Caleffi, ma la qualità si sente.', source: 'Facebook', sentiment: 'neutral' },
      { text: 'Difficile trovare i raccordi Giacomini dal mio fornitore abituale.', source: 'Forum idraulici', sentiment: 'negative' },
    ],
  };
}

module.exports = router;
