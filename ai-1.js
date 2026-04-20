// api/ai.js
// Proxies AI requests to Claude server-side (API key stays secret).
// If no ANTHROPIC_API_KEY is set, returns a well-written template instead.

const https = require("https");

// ── Call Claude API ───────────────────────────────────────────────────────────
function callClaude(system, userMessage, maxTokens) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model:      "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages:   [{ role: "user", content: userMessage }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      port:     443,
      path:     "/v1/messages",
      method:   "POST",
      headers:  {
        "Content-Type":       "application/json",
        "Content-Length":     Buffer.byteLength(payload),
        "x-api-key":          process.env.ANTHROPIC_API_KEY,
        "anthropic-version":  "2023-06-01",
      },
      timeout: 30000,
    }, (res) => {
      let data = "";
      res.on("data",  c => data += c);
      res.on("end",   ()  => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error)   return reject(new Error(parsed.error.message));
          if (!parsed.content) return reject(new Error("Empty response from Claude"));
          resolve(parsed.content[0].text.trim());
        } catch (e) {
          reject(new Error("Failed to parse Claude response"));
        }
      });
    });

    req.on("error",   e  => reject(e));
    req.on("timeout", () => { req.destroy(); reject(new Error("Claude API timed out")); });
    req.write(payload);
    req.end();
  });
}

// ── Template fallbacks (used when no API key is set) ─────────────────────────
function buildTemplate(type, lead, senderName, senderCompany) {
  const loc    = [lead.city, lead.state].filter(Boolean).join(", ") || "your area";
  const name   = lead.name || "there";
  const broker = lead.broker_name ? ` at ${lead.broker_name}` : "";

  if (type === "summary") {
    return `Active licensed real estate agent in ${loc}${broker}. License #${lead.license_number || "verified"} — confirmed active status through state board. ${lead.phone ? "Phone number available." : ""} ${lead.email ? "Email on file." : ""} Good outreach candidate.`;
  }

  if (type === "explain") {
    const has     = [lead.email && "email (+3)", lead.phone && "phone (+3)", lead.website && "website (+2)", lead.license_number && "verified license (+1)", lead.broker_name && "broker info (+1)"].filter(Boolean);
    const missing = [!lead.email && "no email (-3)", !lead.phone && "no phone (-3)", !lead.website && "no website (-2)"].filter(Boolean);
    return `This lead scored ${lead.score || 0}/10 based on: ${has.join(", ") || "license only"}. Missing: ${missing.join(", ") || "nothing critical"}.`;
  }

  if (type === "outreach") {
    return `Hi ${name},

I came across your active real estate license through the ${lead.state || "state"} licensing board and wanted to reach out directly.

I work with ${senderCompany || "our team"} and we specialize in connecting active agents like yourself with qualified buyer and seller leads in the ${loc} market. Many agents we partner with see new closings within their first 30 days.

Would you have 15 minutes this week for a quick call? I'd love to share what we're seeing in ${loc} and see if there's a fit.

Best,
${senderName || "Your Name"}`;
  }

  if (type === "subject") {
    return `Quick question about your ${loc} listings\nQualified buyers looking in ${loc} — let's connect\nRE: Active agents in ${loc} — partnership opportunity`;
  }

  return "Content unavailable.";
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Use POST" });

  const { type, lead, sender_name, sender_company } = req.body || {};

  if (!lead)  return res.status(400).json({ error: "lead object required" });
  if (!type)  return res.status(400).json({ error: "type required: summary, explain, outreach, or subject" });

  // If no API key — return a useful template instead of an error
  if (!process.env.ANTHROPIC_API_KEY) {
    const text = buildTemplate(type, lead, sender_name, sender_company);
    return res.status(200).json({ success: true, text, is_template: true });
  }

  // Build prompts for each type
  const loc  = [lead.city, lead.state].filter(Boolean).join(", ") || "their market";
  const sigs = [
    lead.email          && `email: ${lead.email}`,
    lead.phone          && `phone: ${lead.phone}`,
    lead.website        && `website: ${lead.website}`,
    lead.license_number && `license #${lead.license_number} (Active)`,
    lead.broker_name    && `brokerage: ${lead.broker_name}`,
  ].filter(Boolean);

  const prompts = {
    summary: {
      system: "You write 2-sentence CRM lead summaries for active licensed real estate agents. Be specific and professional. No markdown, no bullet points.",
      user:   `Agent: ${lead.name}\nLocation: ${loc}\nScore: ${lead.score || 0}/10\nData available: ${sigs.join(", ") || "license only"}\nSource: ${lead.source || "State Licensing Board"}`,
      tokens: 160,
    },
    explain: {
      system: "Explain this lead score in exactly 2 plain sentences. Say what signals are present and what's missing. No markdown.",
      user:   `Agent: ${lead.name}\nScore: ${lead.score || 0}/10\nHas: ${sigs.join(", ") || "license verification only"}\nMissing: ${["email","phone","website"].filter(k => !lead[k]).join(", ") || "nothing"}`,
      tokens: 130,
    },
    outreach: {
      system: "Write a short cold outreach email for a referral lead partnership with an active real estate agent. 3 short paragraphs. Warm, professional tone. No markdown. No subject line. Just the email body ending with a CTA for a 15-minute call.",
      user:   `Recipient: ${lead.name}, active agent in ${loc}${lead.broker_name ? " at " + lead.broker_name : ""}\nLicense: verified active\nSender: ${sender_name || "Your Name"} from ${sender_company || "Your Company"}`,
      tokens: 450,
    },
    subject: {
      system: "Write exactly 3 cold email subject lines, one per line. No numbers. No dashes. No markdown. Make them sound human and specific.",
      user:   `Reaching out to ${lead.name}, active licensed agent in ${loc}, about a referral lead partnership.`,
      tokens: 90,
    },
  };

  const prompt = prompts[type];
  if (!prompt) return res.status(400).json({ error: `Unknown type: ${type}. Use: summary, explain, outreach, subject` });

  try {
    const text = await callClaude(prompt.system, prompt.user, prompt.tokens);
    return res.status(200).json({ success: true, text, is_template: false });
  } catch (err) {
    console.error("[AI ERROR]", err.message);
    // Fall back to template on API error
    const text = buildTemplate(type, lead, sender_name, sender_company);
    return res.status(200).json({ success: true, text, is_template: true, error: err.message });
  }
};
