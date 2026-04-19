/**
 * api/status.js — Environment key configuration check
 *
 * Called once on page load. Returns which API keys are
 * configured as Vercel environment variables so the UI
 * can show/hide the corresponding input fields.
 *
 * Returns:
 *   { claudeKey: boolean, adoKey: boolean }
 */

export const config = { runtime: 'edge' };

export default function handler(req) {
  const origin  = req.headers.get('origin') || '';
  const allowed = origin.includes('localhost') || origin.includes('vercel.app') || origin === '';

  return new Response(JSON.stringify({
    claudeKey: !!process.env.CLAUDE_API_KEY,
    adoKey:    !!process.env.ADO_PAT,
  }), {
    status: 200,
    headers: {
      'Content-Type':               'application/json',
      'Cache-Control':              'no-store',
      'Access-Control-Allow-Origin': allowed ? origin || '*' : '',
    },
  });
}
