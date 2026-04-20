/**
 * api/status.js — Environment key configuration check
 *
 * Called once on page load. Returns which API keys are
 * configured as Vercel environment variables so the UI
 * can show/hide the corresponding input fields.
 *
 * Environment Variables:
 *   CLAUDE_API_KEY  — Claude AI key
 *   ADO_PAT         — Azure DevOps Personal Access Token
 *   ADO_ORG         — Azure DevOps Organisation name (e.g. AlphaVarianceSolutions)
 *   ADO_PROJECT     — Azure DevOps Project name (optional, e.g. DMCI-D365)
 *
 * Returns:
 *   { claudeKey, adoKey, adoOrg, adoProject }
 */

export const config = { runtime: 'edge' };

export default function handler(req) {
  const origin  = req.headers.get('origin') || '';
  const allowed = origin.includes('localhost') || origin.includes('vercel.app') || origin === '';

  return new Response(JSON.stringify({
    claudeKey:  !!process.env.CLAUDE_API_KEY,
    adoKey:     !!process.env.ADO_PAT,
    adoOrg:     process.env.ADO_ORG     || '',   // org name if pre-configured
    adoProject: process.env.ADO_PROJECT || '',   // project name if pre-configured
  }), {
    status: 200,
    headers: {
      'Content-Type':                'application/json',
      'Cache-Control':               'no-store',
      'Access-Control-Allow-Origin': allowed ? origin || '*' : '',
    },
  });
}
