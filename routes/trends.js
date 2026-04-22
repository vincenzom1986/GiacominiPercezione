const express = require('express');
const router = express.Router();
const googleTrends = require('google-trends-api');

router.get('/', async (req, res) => {
  try {
    const keywords = ['giacomini', 'caleffi', 'ivar valvole', 'far rubinetterie'];


    const [interestOverTime, relatedQueries] = await Promise.all([
      googleTrends.interestOverTime({
        keyword: keywords,
        startTime: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        geo: 'IT',
      }),
      googleTrends.relatedQueries({ keyword: 'giacomini', geo: 'IT' }),
    ]);

    const timelineData = JSON.parse(interestOverTime);
    const relatedData = JSON.parse(relatedQueries);

    const timeline = timelineData.default?.timelineData?.map(point => ({
      date: point.formattedTime,
      values: point.value,
    })) || [];

    const rising = relatedData.default?.rankedList?.[0]?.rankedKeyword?.slice(0, 5) || [];
    const top = relatedData.default?.rankedList?.[1]?.rankedKeyword?.slice(0, 5) || [];

    res.json({ mock: false, keywords, timeline, rising, top });
  } catch (err) {
    console.error('Google Trends error:', err.message);
    res.json({ mock: true, ...getMockTrends() });
  }
});

function getMockTrends() {
  const months = ['Apr 25','Mag 25','Giu 25','Lug 25','Ago 25','Set 25','Ott 25','Nov 25','Dic 25','Gen 26','Feb 26','Mar 26'];
  return {
    const keywords = ['giacomini', 'caleffi', 'ivar valvole', 'far rubinetterie'];

    timeline: months.map((m, i) => ({
      date: m,
      values: [
        20 + Math.round(Math.sin(i * 0.8) * 8 + Math.random() * 5),
        55 + Math.round(Math.sin(i * 0.6) * 10 + Math.random() * 5),
        30 + Math.round(Math.sin(i * 0.7) * 7 + Math.random() * 4),
        45 + Math.round(Math.sin(i * 0.5) * 12 + Math.random() * 5),
      ],
    })),
    rising: [
      { query: 'giacomini collettori', value: '+350%' },
      { query: 'giacomini pompe di calore', value: '+210%' },
      { query: 'giacomini distributori', value: '+180%' },
    ],
    top: [
      { query: 'giacomini raccordi', value: 100 },
      { query: 'giacomini collettori', value: 82 },
      { query: 'giacomini valvole', value: 71 },
    ],
  };
}

module.exports = router;
