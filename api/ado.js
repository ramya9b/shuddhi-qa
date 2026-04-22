/**
 * api/ado.js — Multi-Org Azure DevOps Proxy
 * PAT resolution: ADO_PAT_{ORG_UPPERCASE} → fallback ADO_PAT
 *
 * Vercel env var convention:
 *   ADO_PAT                 — default / single-org fallback
 *   ADO_PAT_RSATWITHAZURE   — PAT for RSATwithAzure
 *   ADO_PAT_ALPHAVARIANCE   — PAT for AlphaVariance
 *   ADO_ALLOWED_ORGS        — comma-separated allowlist (optional)
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

  const { url, method: rawMethod = 'GET', body, org = '' } = req.body || {};
  const method = rawMethod || (body != null ? 'POST' : 'GET');

  // 1. Validate org name
  if (org && !/^[a-zA-Z0-9][a-zA-Z0-9\-_. ]{0,62}$/.test(org)) {
    return res.status(400).json({ error: 'Invalid organisation name format' });
  }

  // 2. Allowlist check
  const allowedOrgs = (process.env.ADO_ALLOWED_ORGS || '')
    .split(',').map(o => o.trim().toLowerCase()).filter(Boolean);
  if (org && allowedOrgs.length > 0 && !allowedOrgs.includes(org.toLowerCase())) {
    return res.status(403).json({ error: `Organisation "${org}" is not in the allowed list` });
  }

  // 3. Resolve PAT: org-specific → fallback ADO_PAT
  const orgEnvKey = org
    ? `ADO_PAT_${org.toUpperCase().replace(/[\s\-_.]+/g, '_')}`
    : 'ADO_PAT';
  const pat = process.env[orgEnvKey] || process.env.ADO_PAT;

  if (!pat) {
    return res.status(500).json({
      error: `No PAT configured for "${org || 'default'}". Add ${orgEnvKey} to Vercel Environment Variables.`
    });
  }

  // 4. URL allowlist
  const ALLOWED = ['https://dev.azure.com/', 'https://vsrm.visualstudio.com/'];
  if (!url || !ALLOWED.some(d => url.startsWith(d))) {
    return res.status(403).json({ error: 'URL not permitted. Only dev.azure.com is allowed.' });
  }

  // 5. Proxy to Azure DevOps
  const isWI = method === 'POST' && url.includes('/wit/workitems');
  try {
    const r = await fetch(url, {
      method,
      headers: {
        'Content-Type':  isWI ? 'application/json-patch+json' : 'application/json',
        'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`
      },
      body: body != null ? JSON.stringify(body) : undefined
    });
    if (r.status === 401) return res.status(401).json({ error: `PAT for "${org || 'default'}" is invalid or expired. Renew it in Azure DevOps.` });
    if (r.status === 404) return res.status(404).json({ error: `Organisation "${org}" not found. Check the spelling.` });
    if (r.status === 403) return res.status(403).json({ error: `Access denied. Ensure PAT has "Project and Team: Read" scope.` });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: `Proxy fetch failed: ${err.message}` });
  }
}
