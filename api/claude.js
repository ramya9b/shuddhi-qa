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
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-2.0-flash',
  groq:   'llama-3.3-70b-versatile',
};

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
    const contents = [];
    if (system) contents.push({ role: 'user', parts: [{ text: `[SYSTEM INSTRUCTIONS]\n${system}\n[/SYSTEM INSTRUCTIONS]\n\n` }] });
    (messages || []).forEach(m => contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const geminiBody = {
      contents,
      generationConfig: { maxOutputTokens: max_tokens, temperature: 0.3 },
    };
    const alt = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:${alt}${stream?'&':'?'}key=${key}`,
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
      body: JSON.stringify({ model: MODELS.groq, messages: groqMessages, max_tokens, stream }),
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
            text = json.choices?.[0]?.delta?.content || '';
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
      let msg = `${provider} API error ${response.status}: ${detail || 'Unknown error'}`;
      if (response.status === 429) msg = `${provider} rate limit reached — try Gemini or Groq (free tier) in Settings.`;
      if (response.status === 401) msg = `${provider} API key invalid or expired — check ${provider.toUpperCase()}_API_KEY in Vercel.`;
      if (response.status === 404) msg = `${provider} model/endpoint not found. URL: ${upstream.url.substring(0, 80)}`;
      if (response.status === 403) msg = `${provider} API key does not have permission. Check key scopes.`;
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
