/**
 * api/claude.js — Multi-Provider AI Proxy (Edge Function)
 *
 * Supported providers (in order of priority):
 *   1. Claude   (Anthropic)  — CLAUDE_API_KEY
 *   2. Gemini   (Google)     — GEMINI_API_KEY
 *   3. Groq     (Meta/Llama) — GROQ_API_KEY
 *
 * Active provider is selected by AI_PROVIDER env var
 * (claude | gemini | groq). Falls back to whichever key exists.
 *
 * Frontend sends standard Anthropic message format.
 * This proxy translates to the target provider's format.
 */

export const config = { runtime: 'edge' };

// ── Model mapping per provider ──────────────────────────────────
const MODELS = {
  claude:      'claude-sonnet-4-6',
  gemini:      'gemini-2.0-flash',        // Primary (GA Jan 2025)
  geminiExp:   'gemini-2.0-flash-exp',    // Experimental (broader key support)
  geminiAlt:   'gemini-1.5-flash',        // Stable fallback (v1 API)
  geminiPro:   'gemini-1.5-pro',          // High quality fallback
  groq:        'llama-3.3-70b-versatile',
};

// Gemini API versions per model
const GEMINI_API_VERSION = {
  'gemini-2.0-flash':     'v1beta',
  'gemini-2.0-flash-exp': 'v1beta',
  'gemini-1.5-flash':     'v1',      // v1 is more stable for 1.5 models
  'gemini-1.5-pro':       'v1',
};

// Ordered list of Gemini models to try on failure
const GEMINI_MODEL_CHAIN = [
  MODELS.gemini,
  MODELS.geminiExp,
  MODELS.geminiAlt,
  MODELS.geminiPro,
];

// ── Resolve which provider + key to use ────────────────────────
function resolveProvider(requestedProvider) {
  const preferred = (requestedProvider || process.env.AI_PROVIDER || '').toLowerCase();
  const candidates = preferred
    ? [preferred, ...['claude','gemini','groq'].filter(p => p !== preferred)]
    : ['claude','gemini','groq'];

  for (const p of candidates) {
    const key = {
      claude: process.env.CLAUDE_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      groq:   process.env.GROQ_API_KEY,
    }[p];
    if (key) return { provider: p, key };
  }
  return null;
}

// ── Build upstream request per provider ────────────────────────
function buildUpstreamRequest(provider, key, body) {
  const { system, messages, max_tokens = 8192, stream = false } = body;
  const userMessage = messages?.[messages.length - 1]?.content || '';

  if (provider === 'claude') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODELS.claude, max_tokens, stream, system, messages }),
    };
  }

  if (provider === 'gemini') {
    // Use systemInstruction field (not a user turn) to avoid consecutive-user-turn 400
    const contents = [];
    (messages || []).forEach(m => {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    });
    const geminiBody = {
      contents,
      generationConfig: { maxOutputTokens: Math.min(max_tokens, 8192), temperature: 0.3 },
    };
    // Add system instruction separately (supported in Gemini 1.5+)
    if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };
    const geminiModel = body.geminiModel || MODELS.gemini;
    const apiVersion  = GEMINI_API_VERSION[geminiModel] || 'v1beta';
    const endpoint    = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const separator   = stream ? '&' : '?';
    return {
      url: `https://generativelanguage.googleapis.com/${apiVersion}/models/${geminiModel}:${endpoint}${separator}key=${key}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    };
  }

  if (provider === 'groq') {
    const groqMessages = [];
    if (system) groqMessages.push({ role: 'system', content: system });
    (messages || []).forEach(m => groqMessages.push({ role: m.role, content: m.content }));
    return {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODELS.groq,
        messages: groqMessages,
        max_tokens: Math.min(max_tokens, 4096), // Groq llama cap
        temperature: 0.3,
        stream,
      }),
    };
  }
}

// ── Transform non-streaming response to Anthropic format ───────
async function normalizeResponse(provider, response) {
  const data = await response.json();

  if (provider === 'gemini') {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { content: [{ type: 'text', text }], stop_reason: 'end_turn', model: MODELS.gemini };
  }
  if (provider === 'groq') {
    const text = data.choices?.[0]?.message?.content || '';
    return { content: [{ type: 'text', text }], stop_reason: 'stop', model: MODELS.groq };
  }
  return data; // Claude already in correct format
}

// ── Transform streaming response to Anthropic SSE format ───────
function normalizeStream(provider, upstreamBody) {
  if (provider === 'claude') return upstreamBody; // already correct

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const transform = new TransformStream({
    buffer: '',
    transform(chunk, controller) {
      this.buffer += decoder.decode(chunk, { stream: true });
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || line === 'data: [DONE]') continue;

        const dataLine = line.startsWith('data: ') ? line.slice(6) : line;
        try {
          const json = JSON.parse(dataLine);
          let text = '';

          if (provider === 'gemini') {
            text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          } else if (provider === 'groq') {
            // Handle both delta.content and direct content
            text = json.choices?.[0]?.delta?.content
                || json.choices?.[0]?.message?.content
                || '';
            // Skip empty deltas (e.g. finish_reason only)
            if (!text && json.choices?.[0]?.finish_reason) continue;
          }

          if (text) {
            // Emit in Anthropic streaming format
            const event = `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              delta: { type: 'text_delta', text }
            })}\n\n`;
            controller.enqueue(encoder.encode(event));
          }

          // Check for finish
          const isFinished = provider === 'gemini'
            ? json.candidates?.[0]?.finishReason
            : json.choices?.[0]?.finish_reason;

          if (isFinished) {
            controller.enqueue(encoder.encode(
              `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
            ));
          }
        } catch(e) { /* skip malformed lines */ }
      }
    },
    flush(controller) {
      controller.enqueue(encoder.encode(
        `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
      ));
    }
  });

  upstreamBody.pipeThrough(transform);
  return transform.readable;
}

// ── Main handler ────────────────────────────────────────────────
export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const allowed = origin.includes('localhost') || origin.includes('vercel.app') || origin === '';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  allowed ? origin || '*' : '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST')   return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });

  const body = await req.json().catch(() => ({}));
  const { apiKey: userKey, provider: requestedProvider, ...forwardBody } = body;

  // Resolve provider + key
  let resolved = resolveProvider(requestedProvider);

  // Fallback: user-supplied key (local dev)
  if (!resolved && userKey) resolved = { provider: 'claude', key: userKey };

  if (!resolved) {
    return new Response(JSON.stringify({
      error: 'No AI provider configured. Add CLAUDE_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY to Vercel Environment Variables.'
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const { provider, key } = resolved;
  const upstream = buildUpstreamRequest(provider, key, forwardBody);

  try {
    const response = await fetch(upstream.url, {
      method: 'POST',
      headers: upstream.headers,
      body: upstream.body,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let errJson = {};
      try { errJson = JSON.parse(errText); } catch(e) {}
      const detail = errJson?.error?.message || errJson?.message || errText.substring(0, 200);

      // Gemini model chain fallback — try each model in order on 404/quota errors
      const isModelError = provider === 'gemini' && (
        response.status === 404 ||
        (response.status === 400 && detail && (detail.includes('not found') || detail.includes('model'))) ||
        (response.status === 429 && detail && detail.includes('quota'))
      );

      if (isModelError) {
        // Walk the model chain until one works
        for (const fallbackModel of GEMINI_MODEL_CHAIN.slice(1)) {
          const apiVer  = GEMINI_API_VERSION[fallbackModel] || 'v1beta';
          const ep      = forwardBody.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
          const sep     = forwardBody.stream ? '&' : '?';
          const altUrl  = `https://generativelanguage.googleapis.com/${apiVer}/models/${fallbackModel}:${ep}${sep}key=${key}`;
          console.log('[Gemini] Model fallback: ' + fallbackModel + ' (' + apiVer + ')');
          const altResp = await fetch(altUrl, { method:'POST', headers:upstream.headers, body:upstream.body });
          if (altResp.ok) {
            const isStream = forwardBody.stream === true;
            if (isStream) {
              return new Response(normalizeStream(provider, altResp.body), {
                status: 200, headers: { ...corsHeaders, 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache' },
              });
            }
            const norm = await normalizeResponse(provider, altResp);
            return new Response(JSON.stringify({ ...norm, _provider: fallbackModel }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type':'application/json' },
            });
          }
          const altErr = await altResp.text().catch(()=>'');
          console.warn('[Gemini] ' + fallbackModel + ' also failed: HTTP ' + altResp.status + ' ' + altErr.substring(0,100));
        }
        // All models failed — fall through to normal error handling
      }

      let msg = `${provider} API error ${response.status}: ${detail || 'Unknown error'}`;
      if (response.status === 400) {
        // Detect Anthropic account usage cap — treat as switchable rate limit
        const isUsageCap = detail && (
          detail.includes('usage limits') ||
          detail.includes('regain access') ||
          detail.includes('API usage limits')
        );
        if (isUsageCap) {
          // Return 429 so the frontend auto-switches provider
          return new Response(JSON.stringify({
            error: `claude limit reached until May 1 — auto-switching to Groq/Gemini`,
            detail,
            switchProvider: true
          }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        msg = `${provider} 400 Bad Request: ${detail || 'Invalid payload'}`;
      }
      if (response.status === 429) {
        const nextMap = { claude:'Gemini', gemini:'Groq', groq:'Gemini' };
        const nextHint = nextMap[provider] || 'next provider';
        const retryAfter = response.headers.get('retry-after') || response.headers.get('x-ratelimit-reset-requests');
        const waitSecs = retryAfter ? parseInt(retryAfter) : 60;
        msg = `${provider} rate limit (resets in ~${waitSecs}s). Switching to ${nextHint}.`;
      }
      if (response.status === 401) msg = `${provider} API key invalid or expired — check ${provider.toUpperCase()}_API_KEY in Vercel.`;
      if (response.status === 404) {
        const isGeminiModel = provider === 'gemini' && detail && detail.includes('model');
        if (isGeminiModel) {
          msg = `Gemini model not found. Model tried: ${MODELS.gemini}. `
              + `This usually means the model is not available for your API key project. `
              + `Try: 1) Enable Gemini API at console.cloud.google.com, `
              + `2) Get a fresh key from aistudio.google.com, `
              + `3) The app will auto-try gemini-1.5-flash as fallback.`;
        } else {
          msg = `${provider} endpoint not found (404). Full URL: ${upstream.url}`;
        }
      }
      if (response.status === 403) {
        const isApiNotEnabled = detail && (detail.includes('API_NOT_ENABLED') || detail.includes('not been used') || detail.includes('disabled'));
        if (isApiNotEnabled) {
          // Treat as switchable — key exists but wrong Google Cloud project
          return new Response(JSON.stringify({
            error: `gemini API not enabled on this key's Google Cloud project. Go to console.cloud.google.com → APIs → Enable "Generative Language API". OR get a fresh key from aistudio.google.com.`,
            switchProvider: true
          }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        msg = `${provider} API key does not have permission (403): ${detail}`;
      }
      return new Response(JSON.stringify({ error: msg, detail }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const isStream = forwardBody.stream === true;

    if (isStream) {
      const streamBody = normalizeStream(provider, response.body);
      return new Response(streamBody, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      });
    } else {
      const normalized = await normalizeResponse(provider, response);
      return new Response(JSON.stringify({ ...normalized, _provider: provider }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

  } catch(err) {
    return new Response(JSON.stringify({ error: `Proxy error: ${err.message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
