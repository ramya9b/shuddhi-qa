/**
 * api/ado.js — Azure DevOps API Proxy
 *
 * Stores ADO_PAT as a Vercel environment variable.
 * The browser never sees or sends the PAT.
 *
 * Allowed domains:
 *   dev.azure.com                    — Projects, Test Plans, Work Items
 *   app.vssps.visualstudio.com       — connectionData (PAT validation), Accounts (org list)
 *   vsrm.visualstudio.com            — Release Management
 */

export default async function handler(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = origin.includes('localhost') || origin.includes('vercel.app') || origin === '';
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin',  origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const pat = process.env.ADO_PAT;
  if (!pat) {
    return res.status(500).json({
      error: 'ADO_PAT is not configured. Go to Vercel → Project Settings → Environment Variables and add ADO_PAT.'
    });
  }

  const { url, method: rawMethod = 'GET', body } = req.body || {};
  const method = rawMethod || 'GET';

  // ── Security: allowed Azure DevOps domains ─────────────────────
  const ALLOWED = [
    'https://dev.azure.com/',
    'https://app.vssps.visualstudio.com/',   // connectionData + accounts (org list)
    'https://vssps.visualstudio.com/',
    'https://vsrm.visualstudio.com/',
  ];
  if (!url || !ALLOWED.some(d => url.startsWith(d))) {
    return res.status(403).json({
      error: 'URL not permitted. Only Azure DevOps domains are allowed.'
    });
  }

  const isWorkItemCreate = method === 'POST' && url.includes('/wit/workitems');
  const contentType = isWorkItemCreate ? 'application/json-patch+json' : 'application/json';

  try {
    const adoRes = await fetch(url, {
      method,
      headers: {
        'Content-Type':  contentType,
        'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`
      },
      body: body !== null && body !== undefined ? JSON.stringify(body) : undefined
    });

    const data = await adoRes.json().catch(() => ({}));
    return res.status(adoRes.ok ? 200 : adoRes.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: `Proxy fetch failed: ${err.message}` });
  }
}
