const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

if (!GEMINI_API_KEY) {
  console.error('[ERROR] Missing GEMINI_API_KEY environment variable.');
}

// ==========================================
// CONFIGURATION
// ==========================================

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path}`
  );
  next();
});

// ==========================================
// GEMINI MODEL CONFIGURATION
// ==========================================

// Strong reasoning models for images and complex STEM problems.

const REASONING_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite'
];

// Fast models for standard text questions.

const FAST_TEXT_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-27b-it',
  'gemma-3-27b-it',
  'gemini-3.8-flash',
  'gemini-3.6-flash'
];

// ==========================================
// CACHE AND COOLDOWN CONFIGURATION
// ==========================================

const modelCooldowns = new Map();

const responseCache = new Map();

const MAX_CACHE_SIZE = 500;
const CACHE_TTL = 5 * 60 * 1000;

const MAX_IMAGE_SIZE = 7 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp'
];

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isModelOnCooldown(model) {
  const until = modelCooldowns.get(model);

  if (!until) return false;

  if (Date.now() >= until) {
    modelCooldowns.delete(model);
    return false;
  }

  return true;
}

function setModelCooldown(model, seconds = 60) {
  modelCooldowns.set(
    model,
    Date.now() + seconds * 1000
  );

  console.log(
    `[Cooldown] ${model} disabled for ${seconds} seconds.`
  );
}

// ==========================================
// COMPLEX QUESTION DETECTION
// ==========================================

function isComplexProblem(question) {
  if (!question) return false;

  if (question.length > 180) return true;

  const complexKeywords =
    /(integral|integrate|derivative|differentiate|differential|limit|matrix|matrices|determinant|eigen|vector|prove|proof|theorem|kinematics|thermodynamics|quantum|circuit|organic|stoichiometry|equilibrium|polynomial|trigonometr|logarithm|probability|permutation|combination)/i;

  return complexKeywords.test(question);
}

// ==========================================
// PROMPT BUILDER
// ==========================================

function buildPrompt({ subject, question }) {
  const lines = [
    'You are an expert Math, Physics, and Chemistry tutor.',
    'Solve the given problem in the image or text with accurate, complete, step-by-step explanations.'
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
    '',
    '1. Do not wrap your entire response in a markdown code block.',
    '',
    '2. Use these exact section headings:',
    '### 1. Problem Summary',
    '### 2. Given Data & Formulas',
    '### 3. Step-by-Step Solution',
    '### 4. Final Answer',
    '### 5. Quick Concept Tip',
    '',
    '3. Under Final Answer, clearly highlight the final simplified answer in bold, including units where applicable.',
    '',
    '4. Use bold formatting for important formulas, laws and intermediate values.',
    '',
    '5. Explain calculations step by step. Do not skip important mathematical steps.',
    '',
    '6. If information is missing from the problem, clearly mention the assumption instead of inventing data.',
    '',
    '7. If an image is provided, carefully inspect the image before solving.'
  );

  return lines.join('\n');
}

// ==========================================
// GEMINI API CALL
// ==========================================

async function callGemini(model, requestBody) {

  const url =
    `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },

    body: JSON.stringify(requestBody),

    signal: AbortSignal.timeout(20000)
  });

  const responseText = await response.text();

  let data = null;

  try {
    data = JSON.parse(responseText);
  } catch (_) {}

  if (
    response.ok &&
    data &&
    Array.isArray(data.candidates) &&
    data.candidates.length > 0
  ) {

    const candidate = data.candidates[0];

    const parts =
      candidate?.content?.parts || [];

    const generatedText = parts
      .filter(part => typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');

    if (generatedText.trim()) {
      return {
        ok: true,
        text: generatedText
      };
    }
  }

  const message =
    data?.error?.message ||
    candidateErrorMessage(data) ||
    `Gemini API returned status ${response.status}`;

  return {
    ok: false,
    status: response.status,
    message
  };
}

function candidateErrorMessage(data) {
  const reason = data?.promptFeedback?.blockReason;

  if (reason) {
    return `Request blocked by Gemini safety filters: ${reason}`;
  }

  return 'Gemini returned no usable response.';
}

// ==========================================
// MODEL AVAILABILITY VERIFICATION
// ==========================================

async function verifyAvailableModels() {

  if (!GEMINI_API_KEY) return;

  console.log('[Startup Check] Checking available Gemini models...');

  try {

    let pageToken = null;

    const available = new Set();

    // Retrieve model catalogue, including additional pages.

    do {

      const url = new URL(
        `${GEMINI_BASE_URL}`
      );

      // Correct endpoint is /v1beta/models.
      const listUrl = new URL(
        'https://generativelanguage.googleapis.com/v1beta/models'
      );

      listUrl.searchParams.set('pageSize', '100');

      if (pageToken) {
        listUrl.searchParams.set('pageToken', pageToken);
      }

      const res = await fetch(listUrl.toString(), {

        headers: {
          'x-goog-api-key': GEMINI_API_KEY
        },

        signal: AbortSignal.timeout(10000)

      });

      if (!res.ok) {

        console.log(
          '[Startup Check] Verification failed:',
          res.status
        );

        return;
      }

      const data = await res.json();

      if (!Array.isArray(data.models)) return;

      for (const model of data.models) {

        const name = (model.name || '')
          .replace(/^models\//, '');

        const supportsGenerate =
          (model.supportedGenerationMethods || [])
            .includes('generateContent');

        if (name && supportsGenerate) {
          available.add(name);
        }
      }

      pageToken = data.nextPageToken || null;

    } while (pageToken);

    const allConfigured = new Set([
      ...REASONING_MODELS,
      ...FAST_TEXT_MODELS
    ]);

    for (const model of allConfigured) {

      if (!available.has(model)) {

        console.log(
          `[Startup Check] Unavailable model: ${model}`
        );

        setModelCooldown(model, 86400);

      } else {

        modelCooldowns.delete(model);

        console.log(
          `[Startup Check] Available: ${model}`
        );
      }
    }

    console.log('[Startup Check] Model verification complete.');

  } catch (err) {

    console.log(
      '[Startup Check] Verification skipped:',
      err.message
    );

  }
}

// ==========================================
// RESPONSE CACHE
// ==========================================

function getCachedResponse(key) {

  const entry = responseCache.get(key);

  if (!entry) return null;

  if (Date.now() - entry.timestamp > CACHE_TTL) {

    responseCache.delete(key);

    return null;
  }

  // Refresh insertion order for basic LRU behavior.

  responseCache.delete(key);

  responseCache.set(key, entry);

  return entry.solution;
}

function saveCachedResponse(key, solution) {

  if (responseCache.size >= MAX_CACHE_SIZE) {

    const oldestKey =
      responseCache.keys().next().value;

    responseCache.delete(oldestKey);
  }

  responseCache.set(key, {
    solution,
    timestamp: Date.now()
  });
}

// ==========================================
// IMAGE VALIDATION
// ==========================================

function validateImage(imageBase64, mimeType) {

  if (!imageBase64) {
    return {
      ok: true,
      data: null
    };
  }

  // Accept raw base64 or a data URL.

  let cleanBase64 = imageBase64;

  const dataUrlMatch = imageBase64.match(
    /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
  );

  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1];
    cleanBase64 = dataUrlMatch[2];
  }

  if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {

    return {
      ok: false,
      error: 'Unsupported image format. Use JPEG, PNG or WebP.'
    };
  }

  cleanBase64 = cleanBase64.replace(/\s/g, '');

  if (
    !cleanBase64 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64) ||
    cleanBase64.length % 4 !== 0
  ) {

    return {
      ok: false,
      error: 'Invalid image data.'
    };
  }

  const estimatedSize =
    Math.floor(cleanBase64.length * 3 / 4) -
    (cleanBase64.endsWith('==') ? 2 :
      cleanBase64.endsWith('=') ? 1 : 0);

  if (estimatedSize > MAX_IMAGE_SIZE) {

    return {
      ok: false,
      error: 'Image is too large. Maximum size is 7 MB.'
    };
  }

  return {
    ok: true,
    data: cleanBase64,
    mimeType
  };
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/health', (_req, res) => {

  res.json({

    ok: true,

    service: 'SmartCalc AI Backend',

    configured: Boolean(GEMINI_API_KEY),

    timestamp: new Date().toISOString()

  });

});

// ==========================================
// MAIN SOLVER API
// ==========================================

app.post('/solve', async (req, res) => {

  try {

    // --------------------------------------
    // API KEY CHECK
    // --------------------------------------

    if (!GEMINI_API_KEY) {

      return res.status(500).json({

        error: 'AI solver is not configured on the server.'

      });

    }

    // --------------------------------------
    // INPUT VALIDATION
    // --------------------------------------

    const {
      subject,
      question,
      imageBase64,
      mimeType
    } = req.body || {};

    if (
      question !== undefined &&
      typeof question !== 'string'
    ) {

      return res.status(400).json({

        error: 'Question must be a text string.'

      });

    }

    if (
      subject !== undefined &&
      typeof subject !== 'string'
    ) {

      return res.status(400).json({

        error: 'Subject must be a text string.'

      });

    }

    if (
      imageBase64 !== undefined &&
      typeof imageBase64 !== 'string'
    ) {

      return res.status(400).json({

        error: 'Invalid image data.'

      });

    }

    const cleanQuestion = (question || '').trim();

    const cleanSubject = subject || 'Auto Detect';

    const hasImage = Boolean(imageBase64);

    if (!hasImage && !cleanQuestion) {

      return res.status(400).json({

        error: 'Please provide a question or image.'

      });

    }

    if (cleanQuestion.length > 20000) {

      return res.status(400).json({

        error: 'Question is too long.'

      });

    }

    // --------------------------------------
    // IMAGE VALIDATION
    // --------------------------------------

    let validatedImage = null;

    if (hasImage) {

      validatedImage = validateImage(
        imageBase64,
        mimeType || 'image/jpeg'
      );

      if (!validatedImage.ok) {

        return res.status(400).json({

          error: validatedImage.error

        });

      }
    }

    // --------------------------------------
    // CACHE CHECK
    // --------------------------------------

    let cacheKey = null;

    if (!hasImage) {

      cacheKey = crypto
        .createHash('sha256')
        .update(
          `${cleanSubject}::${cleanQuestion.toLowerCase()}`
        )
        .digest('hex');

      const cached = getCachedResponse(cacheKey);

      if (cached) {

        return res.json({

          solution: cached,

          cached: true

        });

      }
    }

    // --------------------------------------
    // BUILD GEMINI REQUEST
    // --------------------------------------

    const parts = [

      {
        text: buildPrompt({

          subject: cleanSubject,

          question: cleanQuestion

        })
      }

    ];

    if (hasImage) {

      parts.push({

        inlineData: {

          mimeType: validatedImage.mimeType,

          data: validatedImage.data

        }

      });

    }

    const requestBody = {

      contents: [

        {

          role: 'user',

          parts

        }

      ],

      generationConfig: {

        temperature: 0.1,

        maxOutputTokens: 4096

      }

    };

    // --------------------------------------
    // SELECT MODEL POOL
    // --------------------------------------

    const useReasoningFirst =
      hasImage || isComplexProblem(cleanQuestion);

    const basePool = useReasoningFirst
      ? REASONING_MODELS
      : FAST_TEXT_MODELS;

    const orderedModels = basePool.filter(
      model => !isModelOnCooldown(model)
    );

    if (orderedModels.length === 0) {

      return res.status(503).json({

        error: 'All AI models are temporarily unavailable. Please try again shortly.'

      });

    }

    console.log(
      `[SmartCalc] Using ${useReasoningFirst ? 'Reasoning' : 'Fast Text'} pool.`
    );

    // --------------------------------------
    // MODEL FALLBACK SYSTEM
    // --------------------------------------

    let lastError = null;

    for (const model of orderedModels) {

      try {

        console.log(`[SmartCalc] Trying model: ${model}`);

        const result = await callGemini(
          model,
          requestBody
        );

        // ----------------------------------
        // SUCCESS
        // ----------------------------------

        if (result.ok) {

          if (cacheKey) {

            saveCachedResponse(
              cacheKey,
              result.text
            );

          }

          console.log(
            `[SmartCalc] Success using ${model}`
          );

          return res.json({

            solution: result.text,

            modelUsed: model,

            cached: false

          });

        }

        lastError = result.message;

        const lower = result.message.toLowerCase();

        // ----------------------------------
        // INVALID API KEY
        // ----------------------------------

        if (
          result.status === 401 ||
          result.status === 403 ||
          lower.includes('api key') ||
          lower.includes('api_key_invalid')
        ) {

          console.error('[SmartCalc] API authentication failed.');

          return res.status(502).json({

            error: 'Gemini API authentication failed. Please check the server API key.'

          });

        }

        // ----------------------------------
        // INVALID / UNSUPPORTED MODEL
        // ----------------------------------

        if (
          result.status === 404 ||
          lower.includes('model not found') ||
          lower.includes('deprecated') ||
          lower.includes('not supported')
        ) {

          setModelCooldown(model, 86400);

          continue;

        }

        // ----------------------------------
        // RATE LIMIT / QUOTA
        // ----------------------------------

        if (
          result.status === 429 ||
          lower.includes('quota') ||
          lower.includes('rate limit')
        ) {

          setModelCooldown(model, 60);

          continue;

        }

        // ----------------------------------
        // TEMPORARY SERVER ERRORS
        // ----------------------------------

        if (
          result.status === 500 ||
          result.status === 503 ||
          result.status === 504
        ) {

          console.log(
            `[SmartCalc] Temporary error on ${model}. Retrying once...`
          );

          await sleep(350);

          const retry = await callGemini(
            model,
            requestBody
          );

          if (retry.ok) {

            if (cacheKey) {

              saveCachedResponse(
                cacheKey,
                retry.text
              );

            }

            console.log(
              `[SmartCalc] Retry successful using ${model}`
            );

            return res.json({

              solution: retry.text,

              modelUsed: model,

              cached: false

            });

          }

          lastError = retry.message;

          setModelCooldown(model, 30);

          continue;

        }

        // ----------------------------------
        // OTHER MODEL ERRORS
        // ----------------------------------

        console.error(
          `[SmartCalc] ${model} failed: ${result.message}`
        );

      } catch (error) {

        lastError =
          error?.message || String(error);

        console.error(
          `[SmartCalc] Error with ${model}:`,
          lastError
        );

        setModelCooldown(model, 30);

      }

    }

    // --------------------------------------
    // ALL MODELS FAILED
    // --------------------------------------

    return res.status(502).json({

      error:
        lastError ||
        'All AI models are currently busy. Please try again shortly.'

    });

  } catch (error) {

    console.error('[SmartCalc] Server error:', error);

    return res.status(500).json({

      error: 'Unexpected server error.'

    });

  }

});

// ==========================================
// INVALID JSON ERROR HANDLER
// ==========================================

app.use((err, req, res, next) => {

  if (err instanceof SyntaxError && err.status === 400) {

    return res.status(400).json({

      error: 'Invalid JSON request.'

    });

  }

  if (err.type === 'entity.too.large') {

    return res.status(413).json({

      error: 'Request payload is too large.'

    });

  }

  next(err);

});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {

  console.log('====================================');

  console.log('SmartCalc AI Backend Started');

  console.log(`Port: ${PORT}`);

  console.log(`API Configured: ${Boolean(GEMINI_API_KEY)}`);

  console.log('====================================');

  verifyAvailableModels();

});
