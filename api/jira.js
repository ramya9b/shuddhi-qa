/**
 * api/jira.js — Jira REST API Proxy
 * Reads ticket details server-side — credentials never exposed to browser.
 *
 * Required Vercel Environment Variables:
 *   JIRA_BASE_URL   — e.g. https://yourcompany.atlassian.net
 *   JIRA_EMAIL      — e.g. ramya@company.com (your Atlassian account email)
 *   JIRA_API_TOKEN  — Generate at: https://id.atlassian.com/manage/api-tokens
 *
 * Scopes needed: Read Jira Data (default for API tokens)
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

  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(404).json({
      error: 'Jira not configured. Add JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN to Vercel Environment Variables.'
    });
  }

  const { ticketId } = req.body || {};
  if (!ticketId || !ticketId.match(/^[A-Z][A-Z0-9]+-\d+$/)) {
    return res.status(400).json({ error: 'Invalid Jira ticket ID format (expected e.g. PROJ-1234)' });
  }

  const baseUrl = JIRA_BASE_URL.replace(/\/$/, '');
  const auth    = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

  try {
    const url  = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(ticketId)}?fields=summary,description,issuetype,priority,labels,status,customfield_10016,customfield_10014`;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept':        'application/json',
      }
    });

    if (resp.status === 401) return res.status(401).json({ error: 'Jira authentication failed — check JIRA_EMAIL and JIRA_API_TOKEN' });
    if (resp.status === 404) return res.status(404).json({ error: `Ticket ${ticketId} not found or no access` });
    if (!resp.ok)            return res.status(resp.status).json({ error: `Jira API error: HTTP ${resp.status}` });

    const data   = await resp.json();
    const fields = data.fields || {};

    // Extract description text (Atlassian Document Format → plain text)
    const extractText = (node) => {
      if (!node) return '';
      if (typeof node === 'string') return node;
      if (node.type === 'text') return node.text || '';
      if (node.content) return node.content.map(extractText).join(node.type === 'paragraph' ? '\n' : ' ');
      return '';
    };

    // Find acceptance criteria — often in a custom field or description section
    let description = extractText(fields.description).trim();
    let acceptanceCriteria = '';

    // Try to split AC from description if it contains "Acceptance Criteria"
    const acMatch = description.match(/acceptance criteria[\s\S]*/i);
    if (acMatch) {
      acceptanceCriteria = acMatch[0].replace(/^acceptance criteria:?\s*/i, '').trim();
      description = description.replace(/acceptance criteria[\s\S]*/i, '').trim();
    }

    // Try custom field 10016 (sprint) or 10014 (epic link) for extra context
    const sprintField = fields.customfield_10016;
    const sprintName  = Array.isArray(sprintField) && sprintField[0]?.name ? sprintField[0].name : null;

    return res.status(200).json({
      id:                 data.key,
      summary:            fields.summary || '',
      description:        description.substring(0, 2000),
      acceptanceCriteria: acceptanceCriteria.substring(0, 1000),
      type:               fields.issuetype?.name || 'Story',
      priority:           fields.priority?.name  || 'Medium',
      status:             fields.status?.name    || '',
      labels:             fields.labels          || [],
      sprint:             sprintName             || '',
    });

  } catch (err) {
    return res.status(500).json({ error: `Proxy fetch failed: ${err.message}` });
  }
}
