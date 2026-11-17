const express = require('express');
const crypto = require('crypto');

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

// Strong reasoning models (for images & complex STEM problems)
const REASONING_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
];

// Fast high-volume models (for standard text questions)
const FAST_TEXT_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-27b-it',
  'gemma-3-27b-it',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
];

const modelCooldowns = new Map();
const responseCache = new Map();
const MAX_CACHE_SIZE = 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isModelOnCooldown(model) {
  const until = modelCooldowns.get(model);
  if (!until) return false;
  if (Date.now() > until) {
    modelCooldowns.delete(model);
    return false;
  }
  return true;
}

function setModelCooldown(model, seconds = 60) {
  modelCooldowns.set(model, Date.now() + seconds * 1000);
}

function isComplexProblem(question) {
  if (!question) return false;
  if (question.length > 180) return true;
  const complexKeywords =
    /(integral|integrate|derivative|differentiate|differential|limit|matrix|matrices|determinant|eigen|vector|prove|proof|theorem|kinematics|thermodynamics|quantum|circuit|organic|stoichiometry|equilibrium|polynomial|trigonometr|logarithm|probability|permutation|combination)/i;
  return complexKeywords.test(question);
}

function buildPrompt({ subject, question }) {
  const lines = [
    'You are an expert Math, Physics, and Chemistry tutor.',
    'Solve the problem in the image or text with complete step-by-step mathematical & scientific rigor.',
  ];
  if (subject && subject !== 'Auto Detect') {
    lines.push(`Subject context: ${subject}.`);
  }
  if (question && question.trim()) {
    lines.push(`User question/notes: ${question.trim()}`);
  }
  lines.push(
    '',
    'IMPORTANT FORMATTING INSTRUCTIONS:',
    '1. Do NOT wrap your whole response in a markdown code block.',
    '2. Use these exact section headings:',
    '   ### 1. Problem Summary',
    '   ### 2. Given Data & Formulas',
    '   ### 3. Step-by-Step Solution',
    '   ### 4. Final Answer',
    '   ### 5. Quick Concept Tip',
    '3. Under ### 4. Final Answer, clearly highlight the final simplified answer with units in bold (e.g. **42 m/s**).',
    '4. Use bold (**text**) for formulas, critical intermediate values, and laws.'
  );
  return lines.join('\n');
}

async function callGemini(model, requestBody) {
  const url = `https://googleapis.com{encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(20000),
  });

  const responseText = await response.text();
  let data = null;
  try {
    data = JSON.parse(responseText);
  } catch (_) {}

  if (response.status === 200 && data && Array.isArray(data.candidates) && data.candidates.length > 0) {
    const firstCandidate = data.candidates.at(0);
    const parts = firstCandidate && firstCandidate.content && firstCandidate.content.parts;
    if (Array.isArray(parts) && parts.length > 0 && parts.at(0).text) {
      return { ok: true, text: parts.at(0).text };
    }
  }

  let message = `Status ${response.status}`;
  if (data && data.error && data.error.message) {
    message = data.error.message;
  }
  return { ok: false, status: response.status, message };
}

async function verifyAvailableModels() {
  if (!GEMINI_API_KEY) return;
  try {
    const res = await fetch(
      `https://googleapis.com{encodeURIComponent(GEMINI_API_KEY)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.models)) return;

    const available = new Set(
      data.models.map(m => (m.name || '').replace(/^models\//, ''))
    );

    const allConfigured = new Set([...REASONING_MODELS, ...FAST_TEXT_MODELS]);
    for (const model of allConfigured) {
      if (!available.has(model)) {
        console.log(`[Startup Check] Disabling unavailable model: ${model}`);
        setModelCooldown(model, 86400);
      }
    }
    console.log('[Startup Check] Model verification complete.');
  } catch (err) {
    console.log('[Startup Check] Skipped model verification:', err.message);
  }
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
    const hasImage = Boolean(imageBase64);
    const cleanQuestion = (question || '').trim();

    if (!hasImage && !cleanQuestion) {
      return res.status(400).json({ error: 'Please provide a question or image.' });
    }

    let cacheKey = null;
    if (!hasImage) {
      cacheKey = crypto
        .createHash('sha256')
        .update(`${subject || 'Auto Detect'}::${cleanQuestion.toLowerCase()}`)
        .digest('hex');

      if (responseCache.has(cacheKey)) {
        return res.json({ solution: responseCache.get(cacheKey), cached: true });
      }
    }

    const parts = [{ text: buildPrompt({ subject, question: cleanQuestion }) }];
    if (hasImage) {
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

    const useReasoningFirst = hasImage || isComplexProblem(cleanQuestion);
    const basePool = useReasoningFirst ? REASONING_MODELS : FAST_TEXT_MODELS;

    const orderedModels = [
      ...basePool.filter(m => !isModelOnCooldown(m)),
      ...basePool.filter(m => isModelOnCooldown(m)),
    ];

    let lastError = null;

    for (const model of orderedModels) {
      try {
        const result = await callGemini(model, requestBody);
        if (result.ok) {
          if (cacheKey) {
            if (responseCache.size >= MAX_CACHE_SIZE) {
              const oldestKey = responseCache.keys().next().value;
              responseCache.delete(oldestKey);
            }
            responseCache.set(cacheKey, result.text);
          }
          return res.json({ solution: result.text, modelUsed: model });
        }

        lastError = result.message;
        const lower = result.message.toLowerCase();

        if (result.status === 401 || result.status === 403 || lower.includes('api key')) {
          return res.status(502).json({ error: result.message });
        }

        if (
          result.status === 404 ||
          lower.includes('not found') ||
          lower.includes('deprecated') ||
          lower.includes('no longer available') ||
          lower.includes('not supported')
        ) {
          setModelCooldown(model, 86400);
          continue;
        }

        if (result.status === 429 || lower.includes('quota') || lower.includes('rate limit')) {
          setModelCooldown(model, 60);
          continue;
        }

        if (
          result.status === 503 ||
          result.status === 500 ||
          lower.includes('busy') ||
          lower.includes('spike') ||
          lower.includes('overloaded') ||
          lower.includes('demand')
        ) {
          await sleep(350);
          const retry = await callGemini(model, requestBody);
          if (retry.ok) {
            return res.json({ solution: retry.text, modelUsed: model });
          }
          setModelCooldown(model, 30);
          continue;
        }
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        setModelCooldown(model, 30);
      }
    }

    return res.status(502).json({
      error: lastError || 'All AI models are currently busy. Please try again in a moment.',
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
});

app.listen(PORT, () => {
  console.log(`SmartCalc AI backend listening on port ${PORT}`);
  verifyAvailableModels();
});
