const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY environment variable.');
}

app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});
const candidateModels = [
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPrompt({ subject, question }) {
  const lines = [];
  lines.push('You are an expert Math, Physics, and Chemistry tutor.');
  lines.push('Solve the problem in the image or text with complete step-by-step mathematical & scientific rigor.');
  if (subject && subject !== 'Auto Detect') {
    lines.push(`Subject context: ${subject}.`);
  }
  if (question && question.trim()) {
    lines.push(`User question/notes: ${question.trim()}`);
  }
  lines.push('');
  lines.push('IMPORTANT FORMATTING INSTRUCTIONS:');
  lines.push('1. Do NOT wrap your whole response in a markdown code block.');
  lines.push('2. Use these exact section headings:');
  lines.push('   ### 1. Problem Summary');
  lines.push('   ### 2. Given Data & Formulas');
  lines.push('   ### 3. Step-by-Step Solution');
  lines.push('   ### 4. Final Answer');
  lines.push('   ### 5. Quick Concept Tip');
  lines.push('3. Under ### 4. Final Answer, clearly highlight the final simplified answer with units in bold (e.g. **42 m/s**).');
  lines.push('4. Use bold (**text**) for formulas, critical intermediate values, and laws.');
  return lines.join('\n');
}

async function callGemini(model, requestBody) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(requestBody),
  signal: AbortSignal.timeout(20000),
});

  const responseText = await response.text();
  let data = null;
  try { data = JSON.parse(responseText); } catch (_) {}

  if (response.status === 200) {
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (text) return { ok: true, text };
  }

  let message = `Status ${response.status}`;
  if (data?.error?.message) message = data.error.message;
  return { ok: false, status: response.status, message };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/solve', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'AI solver is not configured on the server.' });
    }

    const { subject, question, imageBase64, mimeType } = req.body || {};

    if (!imageBase64 && !(question && question.trim())) {
      return res.status(400).json({
        error: 'Please provide a question or image.',
      });
    }

    const parts = [{ text: buildPrompt({ subject, question }) }];

    if (imageBase64) {
      parts.push({
        inlineData: {
          mimeType: mimeType || 'image/jpeg',
          data: imageBase64,
        },
      });
    }

    const requestBody = {
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
      },
    };

    let lastError = null;

    for (const model of candidateModels) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await sleep(1200);

        try {
          const result = await callGemini(model, requestBody);
          if (result.ok) {
            return res.json({ solution: result.text });
          }

          lastError = result.message;
          const lower = result.message.toLowerCase();

          if (
            lower.includes('no longer available') ||
            lower.includes('not found') ||
            lower.includes('deprecated') ||
            result.status === 404
          ) {
            break;
          }

          if (
            result.status === 503 ||
            result.status === 429 ||
            lower.includes('demand') ||
            lower.includes('busy') ||
            lower.includes('spike') ||
            lower.includes('quota') ||
            lower.includes('temporarily unavailable')
          ) {
            if (attempt === 0) continue;
            break;
          }

          if (
            result.status === 401 ||
            result.status === 403 ||
            lower.includes('api key')
          ) {
            return res.status(502).json({ error: result.message });
          }

          break;
        } catch (error) {
          lastError = error?.message || String(error);
          if (attempt === 0) continue;
          break;
        }
      }
    }

    return res.status(502).json({
      error: lastError || 'Unable to solve problem right now. Please try again.',
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
});

app.listen(PORT, () => {
  console.log(`SmartCalc AI backend listening on port ${PORT}`);
});
