/**
 * api/ado.js — Single-Org Azure DevOps Proxy
 * Reads org from DEVOPS_ORG (or ADO_ORG) env var
 * Reads PAT from DEVOPS_PAT (or ADO_PAT) env var
 * PAT never reaches the browser.
 */
export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin.includes('localhost') || origin.includes('vercel.app') || origin === '') {
    res.setHeader('Access-Control-Allow-Origin',  origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Read PAT from env — supports both naming conventions
  const pat = process.env.DEVOPS_PAT || process.env.ADO_PAT;
  if (!pat) {
    return res.status(500).json({
      error: 'PAT not configured. Add DEVOPS_PAT (or ADO_PAT) to Vercel Environment Variables.'
    });
  }

  const { url, method: rawMethod = 'GET', body } = req.body || {};
  const method = rawMethod || (body != null ? 'POST' : 'GET');

  // URL allowlist — only Azure DevOps endpoints permitted
  const ALLOWED = ['https://dev.azure.com/', 'https://vsrm.visualstudio.com/'];
  if (!url || !ALLOWED.some(d => url.startsWith(d))) {
    return res.status(403).json({ error: 'URL not permitted. Only dev.azure.com is allowed.' });
  }

  const isWorkItemCreate = method === 'POST' && url.includes('/wit/workitems');
  const contentType = isWorkItemCreate ? 'application/json-patch+json' : 'application/json';

  try {
    const r = await fetch(url, {
      method,
      headers: {
        'Content-Type':  contentType,
        'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`
      },
      body: body != null ? JSON.stringify(body) : undefined
    });

    if (r.status === 401) return res.status(401).json({ error: 'PAT is invalid or expired. Renew it in Azure DevOps → User Settings → Personal Access Tokens.' });
    if (r.status === 404) return res.status(404).json({ error: 'Resource not found. Check the organisation name in DEVOPS_ORG.' });
    if (r.status === 403) return res.status(403).json({ error: 'Access denied. Ensure PAT has required scopes: Test Management R/W, Work Items R/W, Project Read.' });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: `Proxy fetch failed: ${err.message}` });
  }
}
