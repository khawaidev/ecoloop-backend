require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS - allow frontend origins
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc)
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all in dev, restrict in production
    }
  }
}));

app.use(express.json({ limit: '10mb' })); // Large enough for base64 images

// ---- Multi-key Gemini API ----
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY1,
  process.env.GEMINI_API_KEY2,
].filter(Boolean);

const GEMINI_MODEL = 'gemini-2.0-flash';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ecoloop-backend' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', keys: GEMINI_KEYS.length });
});

// ---- Analyze Image Endpoint ----
app.post('/api/analyze', async (req, res) => {
  const { image_base64, time_spent_seconds } = req.body;

  if (!image_base64) {
    return res.status(400).json({ error: 'image_base64 is required' });
  }

  const timeSpent = time_spent_seconds || 0;
  const minutes = Math.floor(timeSpent / 60);
  const secs = timeSpent % 60;
  const timeStr = minutes > 0 ? `${minutes} minutes and ${secs} seconds` : `${secs} seconds`;

  const prompt = `Analyze this image of collected plastic waste.

Return a JSON object with these exact fields:
1. "types": array of plastic/trash item types found (e.g. ["bottle", "wrapper", "bag"])
2. "count": estimated total number of plastic items visible
3. "weight_kg": approximate total weight in kg (use a reasonable estimate)
4. "impact": a 2-3 sentence description of the positive environmental impact of collecting this waste. Include an estimate of pollution reduced.
5. "time_context": a motivational sentence about how collecting this amount in ${timeStr} is impressive and the difference it makes today

Respond ONLY with valid JSON, no markdown, no code fences, no explanation.`;

  let lastError = null;

  for (let keyIndex = 0; keyIndex < GEMINI_KEYS.length; keyIndex++) {
    const key = GEMINI_KEYS[keyIndex];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: prompt },
                  { inline_data: { mime_type: 'image/jpeg', data: image_base64 } }
                ]
              }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
            })
          }
        );

        if (response.status === 429) {
          console.warn(`Key ${keyIndex + 1} rate limited (attempt ${attempt + 1})`);
          if (attempt === 0) {
            await sleep(5000);
            continue;
          }
          lastError = new Error('Rate limited');
          break;
        }

        if (!response.ok) {
          const errText = await response.text();
          console.warn(`Key ${keyIndex + 1} error (${response.status}):`, errText);
          lastError = new Error(`API error ${response.status}`);
          break;
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          lastError = new Error('No JSON in response');
          break;
        }

        const parsed = JSON.parse(jsonMatch[0]);
        return res.json({
          types: parsed.types || [],
          count: parsed.count || 0,
          weight_kg: parsed.weight_kg || 0,
          impact: parsed.impact || 'Great work cleaning up!',
          time_context: parsed.time_context || `You spent ${timeStr} making a difference!`
        });
      } catch (err) {
        console.warn(`Key ${keyIndex + 1} attempt ${attempt + 1} failed:`, err.message);
        lastError = err;
        if (attempt === 0) {
          await sleep(2000);
          continue;
        }
        break;
      }
    }
  }

  res.status(500).json({
    error: 'All API keys exhausted. Please wait and try again.',
    details: lastError?.message
  });
});

app.listen(PORT, () => {
  console.log(`🌍 ecoloop backend running on port ${PORT}`);
  console.log(`   Gemini keys loaded: ${GEMINI_KEYS.length}`);
});
