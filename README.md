# Shuddhi QA — v1.4
**ERP · Web App · Mobile QA Test Case Generator**

AI-powered QA test artifact generator for **Microsoft Dynamics 365**, **Salesforce**, and **General Web / Mobile Applications**, with full Azure DevOps Test Plan integration.

---

## 🚀 One-Command Deploy

```bash
vercel deploy --prod
```

Or connect your GitHub repo in the [Vercel Dashboard](https://vercel.com/dashboard).

---

## ⚙️ Environment Variables (Both Required for Full Security)

Go to **Vercel → Your Project → Settings → Environment Variables**:

| Name | Value | What it does |
|------|-------|-------------|
| `CLAUDE_API_KEY` | `sk-ant-api03-...` | Claude API key — stays server-side, never in browser. If not set, app shows manual input field and persists key in localStorage. |
| `ADO_PAT` | Your Azure DevOps PAT | ADO integration — stays server-side, never in browser |

Set both to **Production** and **Preview** environments.

### Creating the Claude API Key
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Click **API Keys** → **Create Key**
3. Copy the key → paste as `CLAUDE_API_KEY` in Vercel

### Creating the ADO PAT
1. Azure DevOps → avatar → **User Settings** → **Personal Access Tokens**
2. **New Token** → set scopes: **Test Management: Read & Write** + **Work Items: Read & Write**
3. Copy → paste as `ADO_PAT` in Vercel

After adding both variables:
```bash
vercel deploy --prod
```

---

## 📁 Package Contents

```
├── index.html          # Complete single-file app (4,100+ lines)
├── api/
│   ├── claude.js       # Edge function — proxies Claude API (reads CLAUDE_API_KEY)
│   ├── ado.js          # Serverless — proxies ADO REST API (reads ADO_PAT)
│   └── status.js       # Edge function — returns which env vars are configured
├── vercel.json         # Route config
└── README.md
```

---

## ⚙️ Settings Panel

Click **⚙️ Settings** in the app header to:

**Claude AI tab**
- See if `CLAUDE_API_KEY` is configured via Vercel
- Enter API key manually if no env var (saved in localStorage for convenience)
- **Test Connection** — sends a real ping to `/api/claude` and shows the response

**Azure DevOps tab**
- See if `ADO_PAT` is configured via Vercel
- Enter PAT manually for session use if env var not set
- Enter Org + Project → **Test ADO Connection** — hits real ADO endpoint
- Step-by-step PAT creation guide (with required scopes)

**About tab**
- Runtime status: both keys, proxy routes, model name

---

## 🔒 Security Architecture

```
Browser                    Vercel Edge / Serverless         External API
─────────────────────────────────────────────────────────────────────────
generate() click    →   /api/claude (reads CLAUDE_API_KEY)  →  Anthropic
                    ←   SSE stream forwarded back           ←

ADO Push button     →   /api/ado    (reads ADO_PAT)         →  Azure DevOps
                    ←   JSON response                       ←

Page load           →   /api/status (checks env vars)      →  (no external)
                    ←   { claudeKey: true, adoKey: true }  ←
                         ↓
                    UI hides both input fields, shows 🔐 badges
```

**Neither the Claude API key nor the ADO PAT ever appears in:**
- Browser source code
- Network requests from the browser
- localStorage or sessionStorage
- Console logs

---

## ✨ Supported Platforms

| Platform | Modules |
|----------|---------|
| D365 Finance & Operations | AP, AR, GL, Fixed Assets, Procurement, Inventory… |
| D365 CRM / CE | Leads, Opportunities, Cases, Activities… |
| D365 Business Central | Purchase, Sales, Finance, Manufacturing… |
| Salesforce Sales | Lead-to-Opportunity, CPQ, Forecasting… |
| Salesforce Service | Cases, Knowledge Base, SLAs, Omni-Channel… |
| Salesforce CPQ | Product Catalog, Pricing, Quotes, Contracts… |
| 🌐 General Web Application | Auth, Registration, Dashboard, API, RBAC, Payments (15 modules) |
| 📱 Mobile Application | Login/Biometric, Push, Offline, In-App Purchases, GPS (14 modules) |
| D365 CRM / CE | Leads, Opportunities, Cases, Activities… |
| D365 Business Central | Purchase, Sales, Finance, Manufacturing… |
| Salesforce Sales | Lead-to-Opportunity, CPQ, Forecasting… |
| Salesforce Service | Cases, Knowledge Base, SLAs, Omni-Channel… |
| Salesforce CPQ | Product Catalog, Pricing, Quotes, Contracts… |
| 🌐 General Web App | Auth, Registration, Dashboard, API, RBAC, Payments… |
| 📱 Mobile App | Login, Push Notifications, Offline, Biometrics… |

---

## 🛠 Local Development

```bash
# Install Vercel CLI
npm i -g vercel

# Create .env.local
echo "CLAUDE_API_KEY=sk-ant-api03-your-key-here" > .env.local
echo "ADO_PAT=your-ado-pat-here"               >> .env.local

# Run (serves app + all API routes with env vars)
vercel dev
```

Without env vars the app falls back to manual key entry in the UI.

---

## 📋 Bug Fix History

| Version | Changes |
|---------|---------|
| v1.4 | **CLAUDE_API_KEY moved to Vercel env var** · Settings panel (3-tab: Claude, ADO, About) · API key localStorage persistence · Manual ADO PAT fallback · Mobile hamburger menu · Web App + Mobile App platforms · App renamed to Shuddhi QA · ADO PAT was already secured · switchADOTab body fix · Bulk Stop button · 529/429/401 error messages · Web App + Mobile App platforms |
| v1.3 | ADO 3-step modal · Test Plan hierarchy · Suite grouping |
| v1.2 | Portuguese FP · clipboard crash · bulk platform validation · 7 bug fixes |
| v1.1 | Scanned PDF guard · ADO cancel flag · dynamic PDF row height |
