'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const OpenAI = require('openai');

const xmlParser = new XMLParser({ ignoreAttributes: false });

const groqClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// Cache results for 1 hour to avoid hammering Google News
let cache = null;
let cacheTs = 0;
const CACHE_TTL = 60 * 60 * 1000;

const BRANDS = [
  { name: 'Giacomini', query: 'Giacomini+valvole+idraulica' },
  { name: 'Caleffi',   query: 'Caleffi+idraulica+termosanitario' },
  { name: 'Ivar',      query: 'Ivar+rubinetteria+idraulica' },
  { name: 'FAR',       query: 'FAR+rubinetterie+idraulica' },
  { name: 'Herz',      query: 'Herz+valvole+riscaldamento' },
];

async function fetchRSS(query) {
  const url = `https://news.google.com/rss/search?q=${query}&hl=it&gl=IT&ceid=IT:it`;
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; brandmonitor/1.0)' },
    });
    const parsed = xmlParser.parse(res.data);
    const items = parsed?.rss?.channel?.item || [];
    return Array.isArray(items) ? items : [items];
  } catch {
    return [];
  }
}

function extractText(item) {
  const title = item.title || '';
  const desc  = item.description || '';
  // strip HTML tags
  return (title + ' ' + desc).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function analyzeSentiment(articles) {
  if (!articles.length) return { positive: 33, neutral: 40, negative: 27 };

  const texts = articles.slice(0, 12).map((a, i) => `${i + 1}. ${a.text.substring(0, 200)}`).join('\n');

  try {
    const r = await groqClient.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 200,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `Analizza il sentiment di questi titoli/articoli su Giacomini (brand idrotermosanitario italiano).
Rispondi SOLO con JSON: {"positive":<0-100>,"neutral":<0-100>,"negative":<0-100>,"summary":"<1 frase in italiano>"}
La somma deve fare 100.

${texts}`,
      }],
    });
    const raw = r.choices[0].message.content;
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch { /* use fallback */ }
  return { positive: 33, neutral: 40, negative: 27, summary: 'Analisi non disponibile.' };
}

router.get('/', async (req, res) => {
  // Serve from cache if fresh
  if (cache && Date.now() - cacheTs < CACHE_TTL) {
    return res.json(cache);
  }

  // If Brandwatch credentials configured, signal to use original logic
  // (kept for future: for now we always use Google News)
  const { BRANDWATCH_USERNAME, BRANDWATCH_PASSWORD, BRANDWATCH_PROJECT_ID } = process.env;
  if (BRANDWATCH_USERNAME && BRANDWATCH_PASSWORD && BRANDWATCH_PROJECT_ID) {
    // Fall through to Google News anyway — Brandwatch route kept in brandwatch_legacy.js
  }

  try {
    // ── Fetch RSS for Giacomini + competitors in parallel ─────────────────────
    const [giacominiItems, ...competitorItems] = await Promise.all(
      BRANDS.map(b => fetchRSS(b.query))
    );

    // ── Build Giacomini article list ──────────────────────────────────────────
    const giacArticles = giacominiItems.slice(0, 20).map(item => ({
      text: extractText(item),
      title: (item.title || '').replace(/<[^>]+>/g, '').trim(),
      source: item.source?.['#text'] || item.source || 'Web',
      link: item.link || '',
      pubDate: item.pubDate || '',
    }));

    // ── Sentiment analysis via Groq ───────────────────────────────────────────
    const sentiment = await analyzeSentiment(giacArticles);

    // ── Share of Voice (article count proxy) ─────────────────────────────────
    const counts = [giacominiItems.length, ...competitorItems.map(i => i.length)];
    const totalCount = counts.reduce((a, b) => a + b, 0) || 1;
    const sov = BRANDS.map((b, i) => ({
      brand: b.name,
      share: Math.round((counts[i] / totalCount) * 100),
    })).sort((a, b) => b.share - a.share);

    // ── Format recent posts ───────────────────────────────────────────────────
    const recentPosts = giacArticles.slice(0, 6).map(a => {
      const s = sentiment.positive > sentiment.negative ? 'positive'
        : sentiment.negative > sentiment.positive ? 'negative' : 'neutral';
      return { text: a.title || a.text.substring(0, 140), source: a.source, sentiment: s, link: a.link, pubDate: a.pubDate };
    });

    const result = {
      mock: false,
      source: 'Google News',
      updatedAt: new Date().toISOString(),
      data: {
        totalMentions: giacominiItems.length,
        sentiment: {
          positive: sentiment.positive || 33,
          neutral:  sentiment.neutral  || 40,
          negative: sentiment.negative || 27,
          summary:  sentiment.summary  || '',
        },
        sov,
        recentPosts,
      },
    };

    cache = result;
    cacheTs = Date.now();
    res.json(result);

  } catch (err) {
    console.error('Listening error:', err.message);
    res.json({ mock: true, source: 'fallback', data: getMockData() });
  }
});

function getMockData() {
  return {
    totalMentions: 1240,
    sentiment: { positive: 42, neutral: 38, negative: 20, summary: 'Dati demo — RSS non raggiungibile.' },
    sov: BRANDS.map((b, i) => ({ brand: b.name, share: [22, 35, 18, 15, 10][i] })),
    recentPosts: [
      { text: 'Ho installato i collettori Giacomini sul nuovo impianto, ottima qualità.', source: 'Forum idraulici', sentiment: 'positive' },
      { text: 'Giacomini ha prezzi alti rispetto a Caleffi, ma la qualità si sente.', source: 'Facebook', sentiment: 'neutral' },
      { text: 'Difficile trovare i raccordi Giacomini dal mio fornitore abituale.', source: 'Forum idraulici', sentiment: 'negative' },
    ],
  };
}

module.exports = router;
