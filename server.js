require('dotenv').config();
const express = require('express');
const path = require('path');

const surveyRouter = require('./routes/survey');
const brandwatchRouter = require('./routes/brandwatch');
const trendsRouter = require('./routes/trends');
const synthesisRouter = require('./routes/synthesis');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/survey', surveyRouter);
app.use('/api/brandwatch', brandwatchRouter);
app.use('/api/trends', trendsRouter);
app.use('/api/synthesis', synthesisRouter);

app.get('/survey', (req, res) => res.sendFile(path.join(__dirname, 'public', 'survey.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
