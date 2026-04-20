// api/scrape.js
// Fetches REAL active licensed real estate agents from state licensing boards.
// These are government databases — free, public, no API key needed.

const https = require("https");
const http  = require("http");

// ── Simple HTTP request helper ────────────────────────────────────────────────
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https");
    const lib = isHttps ? https : http;

    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (isHttps ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   options.method || "GET",
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        "Accept":          options.accept || "application/json, text/html, */*",
        "Accept-Language": "en-US,en;q=0.9",
        ...(options.headers || {}),
      },
      timeout: 20000,
    };

    if (options.body) {
      reqOptions.headers["Content-Type"]   = options.contentType || "application/json";
      reqOptions.headers["Content-Length"] = Buffer.byteLength(options.body);
    }

    const req = lib.request(reqOptions, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const newUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : urlObj.origin + res.headers.location;
        return resolve(fetch(newUrl, options));
      }

      let data = "";
      res.on("data",  (chunk) => { data += chunk; if (data.length > 2000000) res.destroy(); });
      res.on("end",   ()      => resolve({ status: res.statusCode, body: data }));
      res.on("close", ()      => resolve({ status: res.statusCode, body: data }));
    });

    req.on("error",   (e) => reject(e));
    req.on("timeout", ()  => { req.destroy(); reject(new Error("Request timed out after 20s")); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── Score a lead 0–10 ─────────────────────────────────────────────────────────
function scoreLead(lead) {
  let s = 0;
  if (lead.email)          s += 3;
  if (lead.phone)          s += 3;
  if (lead.website)        s += 2;
  if (lead.license_number) s += 1;
  if (lead.broker_name)    s += 1;
  return Math.min(10, s);
}

// ── Extract emails from HTML ───────────────────────────────────────────────────
function extractEmail(html) {
  if (!html) return null;
  const matches = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  const skip = ["noreply", "no-reply", "example", "sentry", "w3.org", "schema", "privacy", "support@wordpress"];
  const valid = matches.filter(e => !skip.some(s => e.toLowerCase().includes(s)));
  return valid[0] || null;
}

// ── Try to get email from agent website ──────────────────────────────────────
async function getEmailFromWebsite(website) {
  if (!website) return null;
  try {
    const url = website.startsWith("http") ? website : "https://" + website;
    const res = await fetch(url, { accept: "text/html", timeout: 8000 });
    if (res.status !== 200) return null;
    return extractEmail(res.body);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEXAS — TREC has a real public JSON API
// https://www.trec.texas.gov/apps/license-holder-search/
// ═══════════════════════════════════════════════════════════════════════════════
async function scrapeTXTREC(city, limit) {
  const url = `https://www.trec.texas.gov/apps/license-holder-search/api/search?licenseType=SAL&status=A&city=${encodeURIComponent(city)}&page=1&pageSize=${limit}`;
  console.log("[TX TREC]", url);

  const res = await fetch(url);
  if (res.status !== 200) throw new Error(`TREC API returned ${res.status}`);

  let data;
  try { data = JSON.parse(res.body); }
  catch { throw new Error("TREC API returned invalid JSON"); }

  const items = data.results || data.data || data.items || data || [];
  if (!Array.isArray(items)) throw new Error("Unexpected TREC API format");

  const leads = [];
  for (const item of items.slice(0, limit)) {
    const first  = item.firstName  || item.first_name  || "";
    const last   = item.lastName   || item.last_name   || "";
    const middle = item.middleName || item.middle_name || "";
    const name   = [first, middle, last].filter(Boolean).join(" ").trim();
    if (!name || name.length < 3) continue;

    const phone   = item.phone || item.phoneNumber || item.phone_number || null;
    const website = item.website || item.websiteUrl || item.website_url || null;
    const licNum  = item.licenseNumber || item.license_number || item.licenseNum || null;
    const broker  = item.sponsorName  || item.brokerName || item.broker_name || null;

    let email = item.email || null;
    if (!email && website) {
      email = await getEmailFromWebsite(website);
    }

    const lead = {
      name,
      email,
      phone:          formatPhone(phone),
      city:           item.city || city,
      state:          "TX",
      website,
      license_number: licNum,
      license_status: "Active",
      broker_name:    broker,
      source:         "Texas TREC License Database",
      source_url:     "https://www.trec.texas.gov/apps/license-holder-search/",
      created:        new Date().toISOString().slice(0, 10),
    };
    lead.score   = scoreLead(lead);
    lead.summary = buildSummary(lead);
    leads.push(lead);
  }
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FLORIDA — DBPR public license search (HTML scrape)
// https://www.myfloridalicense.com
// ═══════════════════════════════════════════════════════════════════════════════
async function scrapeFLDBPR(city, limit) {
  const url = `https://www.myfloridalicense.com/wl11.asp?mode=0&SID=&brd=0801&typ=&bureau=&sch=&cit=${encodeURIComponent(city)}&cou=&zipcode=&lic=&ste=Active&nme=&app=`;
  console.log("[FL DBPR]", url);

  const res = await fetch(url, { accept: "text/html" });
  if (res.status !== 200) throw new Error(`FL DBPR returned ${res.status}`);

  const html  = res.body;
  const leads = [];

  // Parse HTML table — each row is a licensee
  const tableMatch = html.match(/<table[^>]*id="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
    || html.match(/<table[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
    || html.match(/<table[^>]*>([\s\S]*?)<\/table>/gi);

  const tableHtml = Array.isArray(tableMatch) ? tableMatch.join("") : (tableMatch?.[1] || html);

  const rowMatches = tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  let count = 0;

  for (const row of rowMatches) {
    if (count >= limit) break;
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim());

    if (cells.length < 2) continue;
    const name = cells[0];
    if (!name || name.length < 4 || /name|licensee|header/i.test(name)) continue;
    if (!/[A-Z]/.test(name[0])) continue; // Must start with capital letter

    const lead = {
      name,
      email:          null,
      phone:          null,
      city,
      state:          "FL",
      website:        null,
      license_number: cells[1] || null,
      license_status: "Active",
      broker_name:    cells[3] || null,
      source:         "Florida DBPR License Database",
      source_url:     url,
      created:        new Date().toISOString().slice(0, 10),
    };
    lead.score   = scoreLead(lead);
    lead.summary = buildSummary(lead);
    leads.push(lead);
    count++;
  }
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NORTH CAROLINA — NCREC public search
// https://ncrec.gov
// ═══════════════════════════════════════════════════════════════════════════════
async function scrapeNCREC(city, limit) {
  // POST form search
  const formData = `LicenseeType=I&Status=A&FirstName=&LastName=&City=${encodeURIComponent(city)}&State=NC`;
  const url = "https://ncrec.gov/find-agent";
  console.log("[NC NCREC]", url);

  const res = await fetch(url, {
    method:      "POST",
    body:        formData,
    contentType: "application/x-www-form-urlencoded",
    accept:      "text/html",
  });

  if (res.status !== 200) throw new Error(`NC NCREC returned ${res.status}`);

  const html  = res.body;
  const leads = [];

  const rowMatches = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  let count = 0;

  for (const row of rowMatches) {
    if (count >= limit) break;
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim());

    if (cells.length < 2) continue;
    const name = cells[0];
    if (!name || name.length < 4 || /name|header/i.test(name)) continue;
    if (!/[A-Za-z]/.test(name)) continue;

    const phone = cells.find(c => /\(?\d{3}\)?[\s\-]\d{3}[\s\-]\d{4}/.test(c)) || null;

    const lead = {
      name,
      email:          null,
      phone:          formatPhone(phone),
      city,
      state:          "NC",
      website:        null,
      license_number: cells[1] || null,
      license_status: "Active",
      broker_name:    cells[2] || null,
      source:         "NC Real Estate Commission",
      source_url:     url,
      created:        new Date().toISOString().slice(0, 10),
    };
    lead.score   = scoreLead(lead);
    lead.summary = buildSummary(lead);
    leads.push(lead);
    count++;
  }
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GEORGIA — SOS license verification
// ═══════════════════════════════════════════════════════════════════════════════
async function scrapeGASOS(city, limit) {
  const url = `https://verify.sos.ga.gov/verification/Details.aspx?city=${encodeURIComponent(city)}&profession=RE&status=Active`;
  console.log("[GA SOS]", url);

  const res = await fetch(url, { accept: "text/html" });
  if (res.status !== 200) throw new Error(`GA SOS returned ${res.status}`);

  const html  = res.body;
  const leads = [];
  const rows  = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  let count = 0;

  for (const row of rows) {
    if (count >= limit) break;
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim());

    if (cells.length < 2) continue;
    const name = cells[0];
    if (!name || name.length < 4 || /name|header/i.test(name)) continue;
    if (!/[A-Za-z]/.test(name[0])) continue;

    const lead = {
      name,
      email:          null,
      phone:          null,
      city,
      state:          "GA",
      website:        null,
      license_number: cells[1] || null,
      license_status: "Active",
      broker_name:    cells[2] || null,
      source:         "Georgia SOS License Verification",
      source_url:     url,
      created:        new Date().toISOString().slice(0, 10),
    };
    lead.score   = scoreLead(lead);
    lead.summary = buildSummary(lead);
    leads.push(lead);
    count++;
  }
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === "1") return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  if (digits.length >= 10) return raw.trim();
  return null;
}

function buildSummary(lead) {
  const loc   = [lead.city, lead.state].filter(Boolean).join(", ");
  const parts = [`ACTIVE licensed real estate agent in ${loc || "their market"}.`];
  if (lead.license_number) parts.push(`License #${lead.license_number} — verified active.`);
  if (lead.broker_name)    parts.push(`Affiliated with ${lead.broker_name}.`);
  const contacts = [lead.email && "email", lead.phone && "phone", lead.website && "website"].filter(Boolean);
  if (contacts.length) parts.push(`Contact available: ${contacts.join(", ")}.`);
  else                 parts.push("Reach via phone directory or broker office.");
  return parts.join(" ");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN VERCEL HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Use POST" });

  const body  = req.body || {};
  const city  = (body.city  || "Houston").trim();
  const state = (body.state || "TX").toUpperCase().trim();
  const limit = Math.min(parseInt(body.limit) || 15, 25);

  const scrapers = {
    TX: () => scrapeTXTREC(city, limit),
    FL: () => scrapeFLDBPR(city, limit),
    NC: () => scrapeNCREC(city, limit),
    GA: () => scrapeGASOS(city, limit),
  };

  const supported = Object.keys(scrapers);

  if (!scrapers[state]) {
    return res.status(200).json({
      success:           false,
      error:             `${state} is not yet supported.`,
      supported_states:  supported,
      message:           `Please choose from: ${supported.join(", ")}. More states being added.`,
      leads:             [],
    });
  }

  console.log(`[SCRAPE] ${city}, ${state} — limit ${limit}`);

  try {
    const raw  = await scrapers[state]();

    // Deduplicate by name
    const seen   = new Set();
    const unique = raw.filter(lead => {
      if (!lead.name) return false;
      const key = lead.name.toLowerCase().replace(/\s+/g, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[SCRAPE] Returning ${unique.length} leads`);
    return res.status(200).json({
      success: true,
      count:   unique.length,
      city,
      state,
      source:  "State Real Estate Licensing Board — Public Government Record",
      leads:   unique,
    });

  } catch (err) {
    console.error("[SCRAPE ERROR]", err.message);
    return res.status(200).json({
      success: false,
      error:   err.message,
      city,
      state,
      leads:   [],
    });
  }
};
