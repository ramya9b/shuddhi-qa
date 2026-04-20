/**
 * api/ado.js — Azure DevOps API Proxy
 *
 * Stores ADO_PAT as a Vercel environment variable.
 * The browser never sees or sends the PAT.
 *
 * Setup (Vercel Dashboard):
 *   Project → Settings → Environment Variables
 *   Name:  ADO_PAT
 *   Value: <your Personal Access Token>
 *   Env:   Production (+ Preview if needed)
 *
 * PAT scopes required:
 *   - Test Management: Read & Write
 *   - Work Items: Read & Write
 *
 * Allowed domains:
 *   - dev.azure.com          — Test Plans, Projects, Work Items
 *   - app.vssps.visualstudio.com — User Profile, Organisations list
 *   - vsrm.visualstudio.com  — Release Management (optional)
 */

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────
  const origin  = req.headers.origin || '';
  const allowed = origin.includes('localhost') || origin.includes('vercel.app') || origin === '';
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin',  origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── Read PAT from Vercel environment ─────────────────────────
  const pat = process.env.ADO_PAT;
  if (!pat) {
    return res.status(500).json({
      error: 'ADO_PAT is not configured. Go to Vercel → Project Settings → Environment Variables and add ADO_PAT.'
    });
  }

  const { url, method: rawMethod = 'GET', body } = req.body || {};
  const method = rawMethod || 'GET'; // normalise empty string → GET

  // ── Security: only allow known Azure DevOps / VSTS domains ───
  const ALLOWED_DOMAINS = [
    'https://dev.azure.com/',                         // Projects, Test Plans, Work Items
    'https://app.vssps.visualstudio.com/',            // User Profile, Organisations
    'https://vsrm.visualstudio.com/',                 // Release Management
    'https://vssps.visualstudio.com/',                // Legacy VSTS profile
  ];

  const isAllowed = ALLOWED_DOMAINS.some(domain => url && url.startsWith(domain));
  if (!isAllowed) {
    return res.status(403).json({
      error: 'URL not permitted. Only Azure DevOps and Visual Studio services are allowed.'
    });
  }

  // ── Content-Type: JSON Patch for Work Item creation ──────────
  const isWorkItemCreate = method === 'POST' && url.includes('/wit/workitems');
  const contentType = isWorkItemCreate
    ? 'application/json-patch+json'
    : 'application/json';

  try {
    const adoResponse = await fetch(url, {
      method,
      headers: {
        'Content-Type':  contentType,
        'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`
      },
      body: body !== null && body !== undefined ? JSON.stringify(body) : undefined
    });

    const responseData = await adoResponse.json().catch(() => ({}));
    return res.status(adoResponse.ok ? 200 : adoResponse.status).json(responseData);

  } catch (err) {
    return res.status(500).json({ error: `Proxy fetch failed: ${err.message}` });
  }
}
