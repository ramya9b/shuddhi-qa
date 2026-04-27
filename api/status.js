/**
 * api/status.js — Environment key configuration check
 *
 * Called once on page load. Returns which API keys are
 * configured as Vercel environment variables so the UI
 * can show/hide the corresponding input fields.
 *
 * Environment Variables:
 *   CLAUDE_API_KEY  — Claude AI key
 *   DEVOPS_PAT / ADO_PAT    — Azure DevOps Personal Access Token
 *   DEVOPS_ORG / ADO_ORG   — Azure DevOps Organisation name
 *   ADO_PROJECT     — Azure DevOps Project name (optional, e.g. DMCI-D365)
 *
 * Returns:
 *   { claudeKey, adoKey, adoOrg, adoProject }
 */

export const config = { runtime: 'edge' };

export default function handler(req) {
  const origin  = req.headers.get('origin') || '';
  const allowed = origin.includes('localhost') || origin.includes('vercel.app') || origin === '';

  // Resolve active AI provider
  const preferred = (process.env.AI_PROVIDER || '').toLowerCase();
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasGroq   = !!process.env.GROQ_API_KEY;
  const hasClaude = !!process.env.CLAUDE_API_KEY;
  const activeProvider = preferred ||
    (hasClaude ? 'claude' : hasGemini ? 'gemini' : hasGroq ? 'groq' : 'none');

  return new Response(JSON.stringify({
    claudeKey:  hasClaude,
    geminiKey:  hasGemini,
    groqKey:    hasGroq,
    aiProvider: activeProvider,
    jiraConfigured: !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN),
    adoKey:     !!(process.env.DEVOPS_PAT || process.env.ADO_PAT),
    adoOrg:     process.env.DEVOPS_ORG  || process.env.ADO_ORG  || '',
    adoProject: process.env.DEVOPS_PROJECT || process.env.ADO_PROJECT || '',
  }), {
    status: 200,
    headers: {
      'Content-Type':                'application/json',
      'Cache-Control':               'no-store',
      'Access-Control-Allow-Origin': allowed ? origin || '*' : '',
    },
  });
}
