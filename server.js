const express = require('express');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

const UPDATE_NOTICE = [
  '### 🚀 Update Available!',
  '**Get better calculations & the all-new CricScore.**',
  '👉 https://play.google.com/store/apps/details?id=com.gatik.smartcalc'
].join('\n');

// ==========================================
// CONFIGURATION
// ==========================================

if (!GEMINI_API_KEY) {
  console.error('[ERROR] GEMINI_API_KEY is missing.');
}

app.use(express.json({
  limit: '12mb'
}));

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path}`
  );
  next();
});

// ==========================================
// GEMINI MODEL CONFIGURATION
// ==========================================

// Strong models for images and complex problems.

const REASONING_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash'
];

const FAST_TEXT_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-27b-it',
  'gemma-3-27b-it',
  'gemini-2.5-flash',
  'gemini-2.0-flash'
];


// ==========================================
// CACHE CONFIGURATION
// ==========================================

const modelCooldowns = new Map();
const responseCache = new Map();

const MAX_CACHE_SIZE = 500;
const CACHE_TTL = 5 * 60 * 1000;

const MAX_IMAGE_SIZE = 7 * 1024 * 1024;

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function withUpdateNotice(solution) {
  const cleanSolution =
    typeof solution === 'string'
      ? solution.trimStart()
      : '';

  if (cleanSolution.startsWith(UPDATE_NOTICE)) {
    return cleanSolution;
  }

  return `${UPDATE_NOTICE}\n\n${cleanSolution}`;
}

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
    `[Cooldown] ${model}: ${seconds}s`
  );
}

// ==========================================
// COMPLEX QUESTION DETECTION
// ==========================================

function isComplexProblem(question) {
  if (!question) return false;

  if (question.length > 180) return true;

  return /(integral|integrate|derivative|differentiate|differential|limit|matrix|matrices|determinant|eigen|vector|prove|proof|theorem|kinematics|thermodynamics|quantum|circuit|organic|stoichiometry|equilibrium|polynomial|trigonometr|logarithm|probability|permutation|combination)/i
    .test(question);
}

// ==========================================
// PROMPT BUILDER
// ==========================================

function buildPrompt({ subject, question }) {

  const lines = [
    'You are an expert Math, Physics, and Chemistry tutor.',
    'Solve the given problem accurately with complete step-by-step explanations.'
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
    '1. Do not wrap the entire response in a markdown code block.',
    '',
    '2. Use these exact section headings:',
    '### 1. Problem Summary',
    '### 2. Given Data & Formulas',
    '### 3. Step-by-Step Solution',
    '### 4. Final Answer',
    '### 5. Quick Concept Tip',
    '',
    '3. Highlight the final simplified answer in bold.',
    '',
    '4. Include units wherever applicable.',
    '',
    '5. Use bold formatting for important formulas, laws and intermediate values.',
    '',
    '6. Explain calculations step by step without skipping important steps.',
    '',
    '7. Never invent missing information.',
    '',
    '8. Carefully inspect the provided image before solving.'
  );

  return lines.join('\n');
}

// ==========================================
// IMAGE VALIDATION AND CONVERSION
// ==========================================

function validateImage(imageInput, mimeType) {

  try {

    if (
      !imageInput ||
      typeof imageInput !== 'string'
    ) {
      return {
        ok: false,
        error: 'No valid image data received.'
      };
    }

    let base64 = imageInput.trim();

    // Default MIME type.

    let detectedMime = mimeType || '';

    // --------------------------------------
    // HANDLE DATA URL
    // --------------------------------------

    if (/^data:/i.test(base64)) {

      const match = base64.match(
        /^data:([^;,]+);base64,([\s\S]*)$/i
      );

      if (!match) {
        return {
          ok: false,
          error: 'Invalid image Data URL.'
        };
      }

      detectedMime = match[1].toLowerCase();
      base64 = match[2];
    }

    // --------------------------------------
    // CLEAN BASE64
    // --------------------------------------

    base64 = base64.replace(/\s/g, '');

    // Support URL-safe Base64.

    base64 = base64
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    // Remove existing padding.

    base64 = base64.replace(/=+$/, '');

    if (!base64) {
      return {
        ok: false,
        error: 'Image data is empty.'
      };
    }

    // Validate Base64 characters.

    if (!/^[A-Za-z0-9+/]+$/.test(base64)) {
      return {
        ok: false,
        error: 'Invalid Base64 image data.'
      };
    }

    // Invalid Base64 length.

    if (base64.length % 4 === 1) {
      return {
        ok: false,
        error: 'Corrupted image data.'
      };
    }

    // Restore missing padding.

    base64 += '='.repeat(
      (4 - base64.length % 4) % 4
    );

    // --------------------------------------
    // DECODE BASE64
    // --------------------------------------

    const imageBuffer = Buffer.from(
      base64,
      'base64'
    );

    if (!imageBuffer.length) {
      return {
        ok: false,
        error: 'Unable to decode image.'
      };
    }

    // Check image size.

    if (imageBuffer.length > MAX_IMAGE_SIZE) {
      return {
        ok: false,
        error: 'Image exceeds the 7 MB limit.'
      };
    }

    // --------------------------------------
    // DETECT ACTUAL IMAGE FORMAT
    // --------------------------------------

    let actualMime = null;

    // JPEG

    if (
      imageBuffer.length >= 3 &&
      imageBuffer[0] === 0xFF &&
      imageBuffer[1] === 0xD8 &&
      imageBuffer[2] === 0xFF
    ) {

      actualMime = 'image/jpeg';

    }

    // PNG

    else if (
      imageBuffer.length >= 8 &&
      imageBuffer.subarray(0, 8).equals(
        Buffer.from([
          0x89, 0x50, 0x4E, 0x47,
          0x0D, 0x0A, 0x1A, 0x0A
        ])
      )
    ) {

      actualMime = 'image/png';

    }

    // WEBP

    else if (
      imageBuffer.length >= 12 &&
      imageBuffer.toString('ascii', 0, 4) === 'RIFF' &&
      imageBuffer.toString('ascii', 8, 12) === 'WEBP'
    ) {

      actualMime = 'image/webp';

    }

    // --------------------------------------
    // CHECK IMAGE FORMAT
    // --------------------------------------

    if (!actualMime) {

      return {
        ok: false,
        error: 'Unsupported image format. Please use JPEG, PNG or WebP.'
      };

    }

    console.log(
      `[Image] Valid image received: ${actualMime}, ${imageBuffer.length} bytes`
    );

    // Return normalized Base64.

    return {
      ok: true,
      data: base64,
      mimeType: actualMime
    };

  } catch (error) {

    console.error('[Image Error]', error);

    return {
      ok: false,
      error: 'Unable to process image.'
    };

  }
}

// ==========================================
// GEMINI API REQUEST
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

    signal: AbortSignal.timeout(30000)

  });

  const responseText = await response.text();

  let data = null;

  try {
    data = JSON.parse(responseText);
  } catch (_) {}

  // --------------------------------------
  // SUCCESS RESPONSE
  // --------------------------------------

  if (
    response.ok &&
    Array.isArray(data?.candidates) &&
    data.candidates.length > 0
  ) {

    const parts =
      data.candidates[0]?.content?.parts || [];

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

  // --------------------------------------
  // ERROR RESPONSE
  // --------------------------------------

  let message =
    data?.error?.message ||
    data?.promptFeedback?.blockReason ||
    'Gemini returned an empty response.';

  return {
    ok: false,
    status: response.status,
    message
  };
}

// ==========================================
// CACHE FUNCTIONS
// ==========================================

function getCachedResponse(key) {

  const entry = responseCache.get(key);

  if (!entry) return null;

  if (Date.now() - entry.timestamp > CACHE_TTL) {

    responseCache.delete(key);

    return null;
  }

  // Refresh insertion order.

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
// MODEL AVAILABILITY CHECK
// ==========================================

async function verifyAvailableModels() {

  if (!GEMINI_API_KEY) return;

  try {

    console.log('[Startup] Checking Gemini models...');

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',
      {
        headers: {
          'x-goog-api-key': GEMINI_API_KEY
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {

      console.log(
        '[Startup] Model verification skipped:',
        response.status
      );

      return;

    }

    const data = await response.json();

    if (!Array.isArray(data.models)) return;

    const available = new Set(

      data.models
        .filter(model =>
          (model.supportedGenerationMethods || [])
            .includes('generateContent')
        )
        .map(model =>
          (model.name || '').replace(/^models\//, '')
        )

    );

    const allModels = new Set([
      ...REASONING_MODELS,
      ...FAST_TEXT_MODELS
    ]);

    for (const model of allModels) {

      if (available.has(model)) {

        modelCooldowns.delete(model);

        console.log(`[Startup] Available: ${model}`);

      } else {

        setModelCooldown(model, 86400);

        console.log(`[Startup] Unavailable: ${model}`);

      }

    }

    console.log('[Startup] Model verification completed.');

  } catch (error) {

    console.log(
      '[Startup] Verification skipped:',
      error.message
    );

  }

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
// MAIN SOLVER ENDPOINT
// ==========================================

app.post('/solve', async (req, res) => {

  try {

    // --------------------------------------
    // API KEY CHECK
    // --------------------------------------

    if (!GEMINI_API_KEY) {

      return res.status(500).json({

        error: 'AI solver is not configured.'

      });

    }

    // --------------------------------------
    // RECEIVE INPUT
    // --------------------------------------

    const body = req.body || {};

    const subject = body.subject || 'Auto Detect';

    const question =
      typeof body.question === 'string'
        ? body.question.trim()
        : '';

    // Support common Android request field names.

    const imageBase64 =
      body.imageBase64 ||
      body.base64Image ||
      body.image ||
      null;

    const mimeType =
      body.mimeType ||
      body.imageMimeType ||
      'image/jpeg';

    const hasImage = Boolean(imageBase64);

    // --------------------------------------
    // VALIDATE INPUT
    // --------------------------------------

    if (
      body.question !== undefined &&
      typeof body.question !== 'string'
    ) {

      return res.status(400).json({

        error: 'Question must be a string.'

      });

    }

    if (
      body.subject !== undefined &&
      typeof body.subject !== 'string'
    ) {

      return res.status(400).json({

        error: 'Subject must be a string.'

      });

    }

    if (!hasImage && !question) {

      return res.status(400).json({

        error: 'Please provide a question or image.'

      });

    }

    if (question.length > 20000) {

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
        mimeType
      );

      if (!validatedImage.ok) {

        console.error(
          '[Image Validation Failed]',
          validatedImage.error
        );

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
          `${subject}::${question.toLowerCase()}`
        )
        .digest('hex');

      const cached = getCachedResponse(cacheKey);

      if (cached) {

        return res.json({

          solution: withUpdateNotice(cached),

          cached: true

        });

      }

    }

    // --------------------------------------
    // BUILD PROMPT
    // --------------------------------------

    const parts = [

      {
        text: buildPrompt({

          subject,

          question

        })
      }

    ];

    // --------------------------------------
    // ATTACH IMAGE
    // --------------------------------------

    if (hasImage) {

      parts.push({

        inlineData: {

          mimeType: validatedImage.mimeType,

          data: validatedImage.data

        }

      });

    }

    // --------------------------------------
    // GEMINI REQUEST BODY
    // --------------------------------------

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
      hasImage || isComplexProblem(question);

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
      `[SmartCalc] ${useReasoningFirst ? 'Reasoning' : 'Fast'} request`
    );

    // --------------------------------------
    // MODEL FALLBACK
    // --------------------------------------

    let lastError = null;

    for (const model of orderedModels) {

      try {

        console.log(`[SmartCalc] Trying ${model}`);

        let result = await callGemini(
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

          console.log(`[SmartCalc] Success: ${model}`);

          return res.json({

            solution: withUpdateNotice(result.text),

            modelUsed: model,

            cached: false

          });

        }

        lastError = result.message;

        const message = result.message.toLowerCase();

        // ----------------------------------
        // API KEY ERRORS
        // ----------------------------------

        if (
          result.status === 401 ||
          result.status === 403
        ) {

          return res.status(502).json({

            error: 'Gemini API authentication failed. Check your API key and permissions.'

          });

        }

        // ----------------------------------
        // MODEL NOT AVAILABLE
        // ----------------------------------

        if (result.status === 404) {

          setModelCooldown(model, 86400);

          continue;

        }

        // ----------------------------------
        // RATE LIMIT
        // ----------------------------------

        if (
          result.status === 429 ||
          message.includes('quota') ||
          message.includes('rate limit')
        ) {

          setModelCooldown(model, 60);

          continue;

        }

        // ----------------------------------
        // TEMPORARY SERVER ERROR
        // ----------------------------------

        if (
          [500, 502, 503, 504].includes(result.status)
        ) {

          console.log(`[SmartCalc] Retrying ${model}`);

          await sleep(500);

          result = await callGemini(
            model,
            requestBody
          );

          if (result.ok) {

            if (cacheKey) {

              saveCachedResponse(
                cacheKey,
                result.text
              );

            }

            return res.json({

              solution: withUpdateNotice(result.text),

              modelUsed: model,

              cached: false

            });

          }

          lastError = result.message;

          setModelCooldown(model, 30);

          continue;

        }

        // ----------------------------------
        // OTHER ERRORS
        // ----------------------------------

        console.error(
          `[SmartCalc] ${model}: ${result.message}`
        );

        // Do not retry malformed requests
        // against every model.

        if (
          result.status >= 400 &&
          result.status < 500
        ) {

          return res.status(502).json({

            error: result.message

          });

        }

      } catch (error) {

        lastError =
          error.message || String(error);

        console.error(
          `[SmartCalc] ${model} error:`,
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

    console.error('[SmartCalc Server Error]', error);

    return res.status(500).json({

      error: 'Unexpected server error.'

    });

  }

});

// ==========================================
// ERROR HANDLING
// ==========================================

app.use((err, req, res, next) => {

  if (err.type === 'entity.too.large') {

    return res.status(413).json({

      error: 'Request is too large. Please use a smaller image.'

    });

  }

  if (err instanceof SyntaxError && err.status === 400) {

    return res.status(400).json({

      error: 'Invalid JSON request.'

    });

  }

  console.error('[Express Error]', err);

  return res.status(500).json({

    error: 'Internal server error.'

  });

});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {

  console.log('===================================');

  console.log('SMARTCALC AI BACKEND');

  console.log('===================================');

  console.log(`Port: ${PORT}`);

  console.log(
    `Gemini API: ${GEMINI_API_KEY ? 'Configured' : 'Missing'}`
  );

  console.log('===================================');

  verifyAvailableModels();

});
