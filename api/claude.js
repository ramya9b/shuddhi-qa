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
// ── Gemini 2.5 Flash model chain (current stable GA model) ──
// Older 1.x and 2.x models are deprecated for new accounts.
// Preview models still use v1beta API endpoint.
const MODELS = {
  claude:      'claude-sonnet-4-6',
  // Gemini stable models (April 2026)
  // gemini-2.0-flash is DEPRECATED — shuts down June 1 2026
  // gemini-3.1-pro-preview is expensive ($2/M) and overkill for test generation
  // gemini-2.5-flash is the recommended stable model: $0.30/M, best quality/cost ratio
  gemini:      'gemini-2.5-flash',              // PRIMARY: stable GA, $0.30/M input
  geminiLite:  'gemini-2.5-flash-lite-preview', // FALLBACK: cheaper, $0.10/M input
  geminiFlash: 'gemini-2.0-flash-lite',         // LAST RESORT: legacy, same endpoint format
  groq:        'llama-3.3-70b-versatile',
};

const GEMINI_API_VERSION = {
  'gemini-2.5-flash':              'v1beta',
  'gemini-2.5-flash-lite-preview': 'v1beta',
  'gemini-2.0-flash-lite':         'v1beta',
};

const GEMINI_MODEL_CHAIN = [
  MODELS.gemini,
  MODELS.geminiLite,
  MODELS.geminiFlash,
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
      // REGRESSION FIX: was Math.min(max_tokens, 8192) — this cap was never raised in earlier
      // sessions even though Groq and Gemini were. claude-sonnet-4-6 supports 64K output tokens.
      // 8192 tokens is only enough for the gap analysis + test summary + first table header row,
      // causing the "18 TCs in summary but empty E2E section" truncation shown in screenshot.
      body: JSON.stringify({ model: MODELS.claude, max_tokens: Math.min(max_tokens, 32768), stream, system, messages }),
    };
  }

  if (provider === 'gemini') {
    // Use systemInstruction field (not a user turn) to avoid consecutive-user-turn 400
    const contents = [];
    (messages || []).forEach(m => {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    });

    // ── TDZ FIX: declare geminiModel FIRST — it must be available inside geminiBody below.
    // (Session 1 fix accidentally left geminiModel declared after geminiBody, causing
    //  ReferenceError: Cannot access 'geminiModel' before initialization → HTTP 500)
    const geminiModel = body.geminiModel || MODELS.gemini;
    const apiVersion  = GEMINI_API_VERSION[geminiModel] || 'v1beta';
    const endpoint    = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const separator   = stream ? '&' : '?';

    // ── REGRESSION FIX (2025-04): gemini-2.5-flash has thinking enabled by default.
    // Thinking tokens count toward maxOutputTokens, exhausting the 8192 budget before
    // any real test case output is generated → empty or 1-TC responses.
    // Fix: (a) disable thinking via thinkingBudget:0, (b) raise ceiling to 32768.
    const geminiBody = {
      contents,
      generationConfig: {
        maxOutputTokens: Math.min(max_tokens, 32768), // raised from 8192; 2.5-flash supports 65K
        temperature: 0.3,
        // Disable thinking for 2.5 models — thinking tokens eat the output budget.
        // thinkingBudget:0 is valid for gemini-2.5-*; non-thinking models ignore it safely.
        ...(geminiModel.includes('2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    };
    // Add system instruction separately (supported in Gemini 1.5+)
    if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };

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
        // TOKEN CAP: llama-3.3-70b-versatile supports 32K output on Groq.
        // Frontend now sends up to 32768 for 'full' format runs.
        // Raise cap to 32768 so a full 18-TC / 7-section run is never truncated.
        max_tokens: Math.min(max_tokens, 32768), // raised from 16384
        temperature: 0.3,
        stream,
      }),
    };
  }
}

// ── Extract output text from Gemini response (defensive: skip thought parts) ──
// gemini-2.5-flash with thinking enabled returns parts like:
//   [{thought:true, text:"..."}, {text:"actual output"}]
// parts[0].text would return the thought, not the test cases.
// This helper always returns the first non-thought part's text.
function getGeminiText(json) {
  const parts = json.candidates?.[0]?.content?.parts || [];
  if (!parts.length) return '';
  const outputPart = parts.find(p => !p.thought) || parts[0];
  return outputPart?.text || '';
}

// ── Normalise from parsed JSON (for model chain fallback) ────────
function normalizeFromJson(provider, json, model) {
  if (provider === 'gemini') {
    const text = getGeminiText(json); // REGRESSION FIX: use helper to skip thought parts
    return { content:[{ type:'text', text }], stop_reason:'end_turn', model: model || MODELS.gemini };
  }
  return json;
}

// ── Transform non-streaming response to Anthropic format ───────
async function normalizeResponse(provider, response) {
  const data = await response.json();

  if (provider === 'gemini') {
    const text = getGeminiText(data); // REGRESSION FIX: use helper to skip thought parts
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
            // REGRESSION FIX: skip thought parts (thought:true) — only emit actual output text.
            // gemini-2.5-flash with thinking may produce thought chunks before output chunks.
            const parts = json.candidates?.[0]?.content?.parts || [];
            const outputPart = parts.find(p => !p.thought) || parts[0];
            text = outputPart?.text || '';
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
      // ── GEMINI ERROR HANDLER with full diagnostics ─────────────────
      // Logs actual status + error body so we can diagnose the real cause
      // Tries every model in GEMINI_MODEL_CHAIN before switching to Groq

      if (provider === 'gemini') {
        console.error('[Gemini Debug] Status:', response.status,
          '| Model:', upstream.url.match(/models\/([^:]+)/)?.[1] || MODELS.gemini,
          '| Error:', detail.substring(0, 200),
          '| URL:', upstream.url.replace(/key=[^&?]+/, 'key=REDACTED')
        );

        // ── True rate limit or quota — do NOT try the model chain (waste quota).
        //    Return switchProvider immediately so the frontend tries Groq/Claude.
        const isTrueRateLimit = response.status === 429
          || (response.status === 400 && (detail.includes('quota') || detail.includes('RESOURCE_EXHAUSTED') || detail.includes('rate')));
        if (isTrueRateLimit) {
          const retryAfter = response.headers.get('retry-after') || '60';
          const waitSecs   = parseInt(retryAfter) || 60;
          console.warn('[Gemini] Rate limit / quota hit — switching to next provider immediately. Retry in ~' + waitSecs + 's');
          return new Response(JSON.stringify({
            error: 'Gemini free-tier rate limit reached (resets in ~' + waitSecs + 's) — switching to next provider',
            waitSecs,
            switchProvider: true,
            provider: 'gemini',
          }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // ── Model-not-found / API-disabled errors — try the model chain ──────
        const shouldTryChain = response.status === 404
          || response.status === 403
          || (response.status === 400 && !detail.includes('quota'))
          || response.status === 500;

        if (shouldTryChain) {
          for (const fallbackModel of GEMINI_MODEL_CHAIN.slice(1)) {
            const apiVer = GEMINI_API_VERSION[fallbackModel] || 'v1';
            const ep     = forwardBody.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
            const sep    = forwardBody.stream ? '&' : '?';
            const altUrl = `https://generativelanguage.googleapis.com/${apiVer}/models/${fallbackModel}:${ep}${sep}key=${key}`;
            console.log('[Gemini] Chain trying:', fallbackModel, '(' + apiVer + ')');
            const altResp = await fetch(altUrl, { method: 'POST', headers: upstream.headers, body: upstream.body });
            const altText = await altResp.text().catch(() => '');
            console.log('[Gemini] Chain result:', fallbackModel, '→ HTTP', altResp.status, altText.substring(0, 150));
            if (altResp.ok) {
              // Non-streaming: parse the text we already consumed
              if (forwardBody.stream !== true) {
                let altJson = {};
                try { altJson = JSON.parse(altText); } catch(e) {}
                const text = getGeminiText(altJson); // FIX: use helper to skip thought parts (was parts[0].text)
                return new Response(JSON.stringify({
                  content: [{ type: 'text', text }],
                  stop_reason: 'end_turn',
                  model: fallbackModel,
                  _provider: fallbackModel
                }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
              }
              // Streaming: fresh request (we consumed the body with text())
              const streamResp = await fetch(altUrl, { method: 'POST', headers: upstream.headers, body: upstream.body });
              return new Response(normalizeStream(provider, streamResp.body), {
                status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
              });
            }
          }
          // All models tried and failed → switch to next provider
          console.warn('[Gemini] All models exhausted. Switching to next provider.');
          return new Response(JSON.stringify({
            error: 'Gemini model unavailable — switching to next provider',
            detail: detail.substring(0, 200),
            switchProvider: true,
            provider: 'gemini',
          }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // 401 / other non-retryable — surface as switchable
        return new Response(JSON.stringify({
          error: `Gemini error ${response.status}: ${detail.substring(0, 150)}`,
          switchProvider: true,
          provider: 'gemini',
        }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
        const retryAfter = response.headers.get('retry-after') || response.headers.get('x-ratelimit-reset-requests');
        const waitSecs   = retryAfter ? parseInt(retryAfter) : 60;
        return new Response(JSON.stringify({
          error: provider + ' rate limited (resets in ~' + waitSecs + 's)',
          waitSecs,
          switchProvider: true
        }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (response.status === 413) {
        // Request too large — Groq 12k TPM limit hit. Switch to Gemini or Claude.
        console.warn('[' + provider + '] 413 Request too large — switching to next provider');
        return new Response(JSON.stringify({
          error: provider + ' token limit exceeded (document too large). Switching to next provider.',
          switchProvider: true,
          provider
        }), { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (response.status === 401) msg = `${provider} API key invalid or expired — check ${provider.toUpperCase()}_API_KEY in Vercel.`;
      if (response.status === 404) {
        // Non-Gemini 404 (Gemini handled above in model chain)
        msg = `${provider} endpoint not found (404). Check model name and API version.`;
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
