
// ── Debug handler: GET /api/debug ────────────────────────────────
// Returns live status of each configured provider
export async function GET(req) {
  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const results = {};

  const providers = [
    { name: 'gemini', key: process.env.GEMINI_API_KEY, testUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=', model: 'gemini-2.0-flash-lite' },
    { name: 'groq',   key: process.env.GROQ_API_KEY,   testUrl: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' },
  ];

  for (const p of providers) {
    if (!p.key) { results[p.name] = { configured: false }; continue; }
    try {
      let res;
      if (p.name === 'gemini') {
        res = await fetch(p.testUrl + p.key, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents:[{role:'user',parts:[{text:'ping'}]}], generationConfig:{maxOutputTokens:5} })
        });
      } else {
        res = await fetch(p.testUrl, {
          method: 'POST',
          headers: { 'Content-Type':'application/json','Authorization':'Bearer '+p.key },
          body: JSON.stringify({ model:p.model, messages:[{role:'user',content:'ping'}], max_tokens:5 })
        });
      }
      const body = await res.text();
      let parsed = {};
      try { parsed = JSON.parse(body); } catch(e) {}
      results[p.name] = {
        configured: true,
        status: res.status,
        ok: res.ok,
        error: res.ok ? null : (parsed?.error?.message || parsed?.message || body.substring(0,150)),
        model: p.model
      };
    } catch(e) {
      results[p.name] = { configured: true, status: 'network-error', ok: false, error: e.message };
    }
  }

  return new Response(JSON.stringify(results, null, 2), { status: 200, headers: corsHeaders });
}
