/**
 * api/claude.js — Claude API Proxy (Edge Function)
 *
 * Stores CLAUDE_API_KEY as a Vercel environment variable.
 * The browser never sees or sends the API key.
 *
 * Setup (Vercel Dashboard):
 *   Project → Settings → Environment Variables
 *   Name:  CLAUDE_API_KEY
 *   Value: sk-ant-api03-...
 *   Env:   Production (+ Preview if needed)
 *
 * Falls back to a user-supplied key in the request body
 * so local development still works without the env var.
 */

export const config = { runtime: 'edge' };

export default async function handler(req) {
  // ── CORS ─────────────────────────────────────────────────────
  const origin  = req.headers.get('origin') || '';
  const allowed = origin.includes('localhost') || origin.includes('vercel.app') || origin === '';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  allowed ? origin || '*' : '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST')   return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });

  const body = await req.json().catch(() => ({}));

  // ── Resolve API key: env var takes priority, user key is fallback ─
  const apiKey = process.env.CLAUDE_API_KEY || body.apiKey;
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: 'CLAUDE_API_KEY is not configured. Go to Vercel → Project Settings → Environment Variables and add CLAUDE_API_KEY.'
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // ── Strip apiKey from body before forwarding ──────────────────
  const { apiKey: _removed, ...forwardBody } = body;

  // ── Proxy to Anthropic ────────────────────────────────────────
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':       'application/json',
      'x-api-key':          apiKey,
      'anthropic-version':  '2023-06-01',
    },
    body: JSON.stringify(forwardBody),
  });

  // Forward the streaming response (or JSON error) directly back
  return new Response(upstream.body, {
    status:  upstream.status,
    headers: {
      ...corsHeaders,
      'Content-Type':  upstream.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
