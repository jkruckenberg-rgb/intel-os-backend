require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
let cheerio;
try { cheerio = require('cheerio'); } catch(e) { cheerio = null; }

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SAM_API_KEY = process.env.SAM_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jkruckenberg@jkconsultsllc.com';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'intel-os@jkconsultsllc.com';

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// JK Consulting keyword profile for scoring
const JK_KEYWORDS = [
  'human resources', 'HR consulting', 'workforce', 'workforce planning',
  'compensation', 'classification', 'job classification', 'pay equity',
  'organizational development', 'org development', 'DEI', 'diversity equity inclusion',
  'training', 'leadership development', 'executive coaching', 'succession planning',
  'HR policy', 'human capital', 'talent management', 'HRIS', 'HR audit',
  'personnel', 'staffing plan', 'position management', 'performance management',
  'benefits administration', 'employee relations', 'labor relations',
  'organizational assessment', 'change management', 'HR strategy'
];

const JK_NAICS = [
  '541612', // Human Resources Consulting
  '541611', // Administrative Management Consulting
  '541618', // Other Management Consulting
  '611430', // Professional Development Training
  '561320', // Temporary Staffing
  '923120', // Government HR
];

// ─── SCORING ENGINE ──────────────────────────────────────────────────────────
function scoreOpportunity(opp) {
  let score = 0;
  const text = [
    opp.title || '',
    opp.description || '',
    opp.solicitationNumber || '',
    opp.naicsCode || ''
  ].join(' ').toLowerCase();

  let keywordHits = 0;
  for (const kw of JK_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      keywordHits++;
      score += 3;
    }
  }
  score = Math.min(score, 60);

  if (opp.naicsCode && JK_NAICS.includes(String(opp.naicsCode).trim())) {
    score += 20;
  }

  const setAside = (opp.typeOfSetAside || '').toLowerCase();
  if (setAside.includes('small') || setAside.includes('sdvo') ||
      setAside.includes('wosb') || setAside.includes('8(a)')) {
    score += 10;
  }

  const place = (opp.placeOfPerformance || '').toLowerCase();
  const officeAddr = (opp.officeAddress || '').toLowerCase();
  const combined = place + ' ' + officeAddr;
  if (combined.includes('maryland') || combined.includes(' md ') ||
      combined.includes('district of columbia') || combined.includes(' dc ') ||
      combined.includes('virginia') || combined.includes(' va ')) {
    score += 10;
  }

  return Math.min(score, 100);
}

// ─── EMAIL HELPER ─────────────────────────────────────────────────────────────
async function sendEmail(subject, htmlBody) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[EMAIL] SMTP not configured — skipping send');
    console.log('[EMAIL] Would have sent:', subject);
    return;
  }

  const transporter = nodemailer.createTransporter({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  try {
    await transporter.sendMail({
      from: `"INTEL·OS Sweeper" <${FROM_EMAIL}>`,
      to: NOTIFY_EMAIL,
      subject,
      html: htmlBody
    });
    console.log('[EMAIL] Sent:', subject);
  } catch (err) {
    console.error('[EMAIL] Failed:', err.message);
  }
}

// ─── EVA DRAFT LETTER ─────────────────────────────────────────────────────────
function draftLetterOfInterest(opp) {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
  const dueDate = opp.responseDeadLine
    ? new Date(opp.responseDeadLine).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
      })
    : 'the deadline listed in the solicitation';

  return `
${today}

Contracting Officer / Program Manager
${opp.agencyName || 'Agency Name'}
${opp.officeAddress || ''}

RE: Expression of Interest — ${opp.solicitationNumber || 'N/A'} | ${opp.title || 'RFP Title'}

Dear Contracting Officer,

JK Consulting, LLC is pleased to express our strong interest in the above-referenced opportunity. As a boutique human resources and organizational development consulting firm, we bring deep expertise in workforce planning, compensation analysis, job classification, HR policy development, DEI strategy, and organizational effectiveness — precisely the capabilities your agency seeks.

Our approach is rooted in delivering practical, data-driven solutions tailored to the unique needs of government and public-sector clients. We understand the regulatory environment, the importance of equitable and compliant HR frameworks, and the need for solutions that can be sustained long after our engagement concludes.

We respectfully request the opportunity to learn more about your requirements and to submit a competitive proposal. We are available to meet at your convenience prior to ${dueDate}.

Please feel free to contact us at:

  Joan Kruckenberg | Principal Consultant
  JK Consulting, LLC
  jkruckenberg@jkconsultsllc.com

We look forward to the opportunity to serve your organization.

Respectfully,

Joan Kruckenberg
Principal Consultant
JK Consulting, LLC
`;
}

// ─── SAM.GOV PROXY ───────────────────────────────────────────────────────────
app.get('/api/sam/opportunities', async (req, res) => {
  const apiKey = req.query.api_key || req.headers['x-api-key'] || SAM_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'SAM.gov API key required' });
  }

  const params = new URLSearchParams({
    limit: req.query.limit || '25',
    offset: req.query.offset || '0',
    postedFrom: req.query.postedFrom || getDateDaysAgo(30),
    postedTo: req.query.postedTo || getToday(),
    ptype: req.query.ptype || 'o,k,r',
    ...( req.query.q ? { q: req.query.q } : { naicsCode: JK_NAICS.join(',') } ),
  });

  try {
    const url = `https://api.sam.gov/opportunities/v2/search?${params}`;
    console.log('[SAM] Fetching:', url.replace(apiKey, '***'));
    const samRes = await fetch(url, {
      headers: { 'X-Api-Key': apiKey }
    });

    if (!samRes.ok) {
      const errText = await samRes.text();
      console.error('[SAM] Error:', samRes.status, errText.slice(0, 200));
      return res.status(samRes.status).json({
        error: `SAM.gov returned ${samRes.status}`,
        detail: errText.slice(0, 500)
      });
    }

    const data = await samRes.json();
    const opportunities = (data.opportunitiesData || []).map(opp => ({
      ...opp,
      jkScore: scoreOpportunity(opp)
    }));

    res.json({ ...data, opportunitiesData: opportunities });
  } catch (err) {
    console.error('[SAM] Fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STATE PORTAL SCRAPERS ───────────────────────────────────────────────────
async function scrapeMarylandEMMA() {
  console.log('[SCRAPE] Maryland eMMA...');
  try {
    const res = await fetch(
      'https://emma.maryland.gov/page.aspx/en/rfp/request_browse_public',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; INTEL-OS-Sweeper/1.0)' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const opps = [];

    $('table tr').each((i, row) => {
      if (i === 0) return;
      const cells = $(row).find('td');
      if (cells.length >= 3) {
        const title = $(cells[0]).text().trim();
        const agency = $(cells[1]).text().trim();
        const due = $(cells[2]).text().trim();
        if (title && title.length > 5) {
          const opp = {
            source: 'Maryland eMMA',
            title,
            agencyName: agency,
            responseDeadLine: due,
            placeOfPerformance: 'Maryland',
            description: title,
          };
          opp.jkScore = scoreOpportunity(opp);
          opps.push(opp);
        }
      }
    });

    console.log(`[SCRAPE] Maryland eMMA: found ${opps.length} opportunities`);
    return opps;
  } catch (err) {
    console.error('[SCRAPE] Maryland eMMA failed:', err.message);
    return [];
  }
}

async function scrapeVirginiaEVA() {
  console.log('[SCRAPE] Virginia eVA...');
  try {
    const res = await fetch(
      'https://eva.virginia.gov/pages/eva-landing-page.htm',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; INTEL-OS-Sweeper/1.0)' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('[SCRAPE] Virginia eVA: portal requires JS rendering, returning placeholder');
    return [{
      source: 'Virginia eVA',
      title: 'Virginia eVA Portal — visit eva.virginia.gov for live listings',
      agencyName: 'Commonwealth of Virginia',
      placeOfPerformance: 'Virginia',
      description: 'Virginia procurement portal requires login. Visit eva.virginia.gov and search: human resources, workforce, HR consulting',
      jkScore: 0
    }];
  } catch (err) {
    console.error('[SCRAPE] Virginia eVA failed:', err.message);
    return [];
  }
}

async function scrapeDCOCP() {
  console.log('[SCRAPE] DC OCP...');
  try {
    const res = await fetch(
      'https://ocp.dc.gov/page/solicitations',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; INTEL-OS-Sweeper/1.0)' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const opps = [];

    $('.views-row, .solicitation-row, tr').each((i, el) => {
      const text = $(el).text().trim();
      const lowerText = text.toLowerCase();
      if (JK_KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase()))) {
        const opp = {
          source: 'DC OCP',
          title: text.slice(0, 120),
          agencyName: 'DC Government',
          placeOfPerformance: 'District of Columbia',
          description: text.slice(0, 300),
        };
        opp.jkScore = scoreOpportunity(opp);
        if (!opps.find(o => o.title === opp.title)) {
          opps.push(opp);
        }
      }
    });

    console.log(`[SCRAPE] DC OCP: found ${opps.length} matching opportunities`);
    return opps;
  } catch (err) {
    console.error('[SCRAPE] DC OCP failed:', err.message);
    return [];
  }
}

// ─── SWEEP ORCHESTRATOR ──────────────────────────────────────────────────────
async function runSweep(triggeredBy = 'schedule') {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[SWEEP] Starting sweep — triggered by: ${triggeredBy}`);
  console.log(`[SWEEP] ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  const allOpps = [];

  if (SAM_API_KEY) {
    try {
      const params = new URLSearchParams({
        limit: '50',
        offset: '0',
        postedFrom: getDateDaysAgo(3),
        postedTo: getToday(),
        ptype: 'o,k,r',
        naicsCode: JK_NAICS.join(','),
      });
      const samRes = await fetch(
        `https://api.sam.gov/opportunities/v2/search?${params}`,
        { headers: { 'X-Api-Key': SAM_API_KEY } }
      );
      if (samRes.ok) {
        const data = await samRes.json();
        const opps = (data.opportunitiesData || []).map(o => ({
          ...o,
          source: 'SAM.gov',
          jkScore: scoreOpportunity(o)
        }));
        allOpps.push(...opps);
        console.log(`[SWEEP] SAM.gov: ${opps.length} opportunities found`);
      } else {
        console.error('[SWEEP] SAM.gov error:', samRes.status);
      }
    } catch (err) {
      console.error('[SWEEP] SAM.gov fetch failed:', err.message);
    }
  } else {
    console.log('[SWEEP] SAM_API_KEY not set — skipping SAM.gov sweep');
  }

  const mdOpps = await scrapeMarylandEMMA();
  const vaOpps = await scrapeVirginiaEVA();
  const dcOpps = await scrapeDCOCP();
  allOpps.push(...mdOpps, ...vaOpps, ...dcOpps);

  const highPriority = allOpps
    .filter(o => o.jkScore >= 40)
    .sort((a, b) => b.jkScore - a.jkScore);

  console.log(`[SWEEP] Total: ${allOpps.length} opps | High-priority (≥40): ${highPriority.length}`);

  lastSweepResults = {
    timestamp: new Date().toISOString(),
    triggeredBy,
    total: allOpps.length,
    highPriority: highPriority.length,
    opportunities: allOpps.sort((a, b) => b.jkScore - a.jkScore)
  };

  if (highPriority.length > 0) {
    await sendSweepDigest(highPriority);
  } else {
    console.log('[SWEEP] No high-priority opportunities found — no email sent');
  }

  console.log('[SWEEP] Complete.\n');
  return lastSweepResults;
}

// ─── EMAIL DIGEST ─────────────────────────────────────────────────────────────
async function sendSweepDigest(opportunities) {
  const topOpps = opportunities.slice(0, 10);

  const oppRows = topOpps.map(opp => {
    const score = opp.jkScore || 0;
    const scoreColor = score >= 70 ? '#16a34a' : score >= 50 ? '#d97706' : '#6b7280';
    const letter = draftLetterOfInterest(opp);
    const letterHtml = letter.replace(/\n/g, '<br>');

    return `
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:20px;font-family:sans-serif;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <h3 style="margin:0 0 8px 0;color:#1e293b;font-size:16px;">${opp.title || 'Untitled Opportunity'}</h3>
        <span style="background:${scoreColor};color:white;padding:4px 10px;border-radius:20px;font-size:13px;font-weight:bold;white-space:nowrap;margin-left:12px;">
          ${score}% match
        </span>
      </div>
      <p style="margin:4px 0;color:#64748b;font-size:13px;">
        <strong>Source:</strong> ${opp.source || 'Unknown'} &nbsp;|&nbsp;
        <strong>Agency:</strong> ${opp.agencyName || 'N/A'} &nbsp;|&nbsp;
        <strong>NAICS:</strong> ${opp.naicsCode || 'N/A'}
      </p>
      <p style="margin:4px 0;color:#64748b;font-size:13px;">
        <strong>Due:</strong> ${opp.responseDeadLine ? new Date(opp.responseDeadLine).toLocaleDateString() : 'See solicitation'} &nbsp;|&nbsp;
        <strong>Location:</strong> ${opp.placeOfPerformance || 'N/A'}
      </p>
      ${opp.solicitationNumber ? `<p style="margin:4px 0;color:#64748b;font-size:13px;"><strong>Solicitation #:</strong> ${opp.solicitationNumber}</p>` : ''}
      ${opp.uiLink ? `<p style="margin:8px 0;"><a href="${opp.uiLink}" style="color:#6366f1;font-size:13px;">View on SAM.gov →</a></p>` : ''}
      <details style="margin-top:12px;">
        <summary style="cursor:pointer;color:#6366f1;font-size:13px;font-weight:600;">📝 EVA Draft Letter of Interest (click to expand)</summary>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-top:8px;font-family:Georgia,serif;font-size:13px;line-height:1.7;white-space:pre-wrap;">${letterHtml}</div>
      </details>
    </div>`;
  }).join('');

  const html = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="background:#f1f5f9;padding:24px;font-family:sans-serif;">
    <div style="max-width:700px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <div style="background:linear-gradient(135deg,#1e293b,#334155);padding:28px 32px;">
        <h1 style="color:white;margin:0;font-size:22px;letter-spacing:1px;">⚡ INTEL·OS SWEEP ALERT</h1>
        <p style="color:#94a3b8;margin:6px 0 0 0;font-size:13px;">
          ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET &nbsp;|&nbsp;
          ${opportunities.length} high-priority match${opportunities.length !== 1 ? 'es' : ''} found
        </p>
      </div>
      <div style="padding:24px 32px;">
        <p style="color:#475569;font-size:14px;margin:0 0 20px 0;">
          INTEL·OS found <strong>${opportunities.length} opportunity match${opportunities.length !== 1 ? 'es' : ''}</strong> with a JK Consulting fit score of 40% or higher.
          Each entry below includes an EVA-drafted letter of interest ready for your review.
        </p>
        ${oppRows}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
        <p style="color:#94a3b8;font-size:12px;text-align:center;">
          INTEL·OS Automated Sweeper · JK Consulting, LLC · jkruckenberg@jkconsultsllc.com<br>
          Sweeps run every 6 hours across SAM.gov, Maryland eMMA, Virginia eVA, and DC OCP
        </p>
      </div>
    </div>
  </body>
  </html>`;

  await sendEmail(
    `⚡ INTEL·OS: ${opportunities.length} New Opportunity Match${opportunities.length !== 1 ? 'es' : ''} Found`,
    html
  );
}

// ─── SWEEP RESULTS CACHE ─────────────────────────────────────────────────────
let lastSweepResults = null;

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'INTEL·OS Backend Sweeper',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    samConfigured: !!SAM_API_KEY,
    emailConfigured: !!(SMTP_HOST && SMTP_USER && SMTP_PASS),
    lastSweep: lastSweepResults?.timestamp || null
  });
});

app.get('/api/sweep/results', (req, res) => {
  if (!lastSweepResults) {
    return res.json({ message: 'No sweep has run yet. Trigger one at /api/sweep/run' });
  }
  res.json(lastSweepResults);
});

app.post('/api/sweep/run', async (req, res) => {
  res.json({ message: 'Sweep started', timestamp: new Date().toISOString() });
  runSweep('manual-trigger').catch(err =>
    console.error('[SWEEP] Manual sweep error:', err)
  );
});

// ─── SCHEDULED SWEEPS ────────────────────────────────────────────────────────
cron.schedule('0 6,12,18,0 * * *', () => {
  runSweep('cron-6hr').catch(err =>
    console.error('[CRON] Sweep error:', err)
  );
}, { timezone: 'America/New_York' });

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  INTEL·OS Backend Sweeper');
  console.log(`  Running on port ${PORT}`);
  console.log(`  SAM.gov API: ${SAM_API_KEY ? '✓ configured' : '✗ not set (add SAM_API_KEY env var)'}`);
  console.log(`  Email: ${SMTP_HOST ? '✓ configured' : '✗ not set (add SMTP env vars)'}`);
  console.log(`  Notify: ${NOTIFY_EMAIL}`);
  console.log(`  Sweeps: every 6 hours (6am/12pm/6pm/midnight ET)`);
  console.log('='.repeat(60) + '\n');

  setTimeout(() => {
    runSweep('startup').catch(err =>
      console.error('[STARTUP] Sweep error:', err)
    );
  }, 30000);
});
