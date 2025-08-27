const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
require("dotenv").config();

const app = express();

// ✅ Handle both JSON and x-www-form-urlencoded (Freshdesk default)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ✅ Sanitize domain env (expect hostname only)
function normalizeDomain(d) {
  if (!d) return "";
  return d.replace(/^https?:\/\//i, "").replace(/\/+$/,"");
}

const {
  FRESHDESK_DOMAIN: RAW_DOMAIN,
  FRESHDESK_API_KEY,
  BOT_SHARED_SECRET
} = process.env;

const FRESHDESK_DOMAIN = normalizeDomain(RAW_DOMAIN);

if (!FRESHDESK_DOMAIN || !FRESHDESK_API_KEY) {
  console.error("Missing FRESHDESK_DOMAIN or FRESHDESK_API_KEY in env.");
}

const fd = axios.create({
  baseURL: `https://${FRESHDESK_DOMAIN}/api/v2`,
  auth: { username: FRESHDESK_API_KEY, password: "X" },
  timeout: 15000
});

// Safely merge tags
async function mergeTags(ticketId, tagsToAdd = []) {
  const resp = await fd.get(`/tickets/${ticketId}`);
  const t = resp.data || {};
  const merged = Array.from(new Set([...(t.tags || []), ...tagsToAdd]));
  await fd.put(`/tickets/${ticketId}`, { tags: merged });
}

// Small helper for shared-secret check
function getSharedSecret(req) {
  const h1 = req.get("X-Shared-Secret");
  const h2 = req.get("x-shared-secret");
  return (h1 || h2 || "").trim();
}

// Resolve template path from repo root
function resolveTemplate() {
  const candidates = [
    path.resolve(process.cwd(), "Payoff_Letter_Template_Fill.docx"),
    path.resolve(__dirname, "Payoff_Letter_Template_Fill.docx")
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

app.get("/healthz", (req, res) => res.send("ok"));

app.post("/freshdesk/webhook", async (req, res) => {
  const start = Date.now();
  try {
    // ✅ Shared-secret guard (trim + dual header)
    const incomingSecret = getSharedSecret(req);
    if (!BOT_SHARED_SECRET || incomingSecret !== BOT_SHARED_SECRET.trim()) {
      console.warn("Shared secret mismatch or missing header.");
      return res.status(401).send("bad secret");
    }

    // ✅ Accept both JSON and form-encoded payloads
    const payload = req.body || {};
    const ticket_id = payload.ticket_id || payload.id || payload.ticket?.id;
    const requester = payload.requester || payload.ticket?.requester || {};
    const requesterName =
      (requester && (requester.name || requester.requester_name)) ||
      "{{requester.name}}";

    if (!ticket_id) {
      console.warn("Webhook missing ticket_id. Body:", JSON.stringify(payload).slice(0, 1000));
      return res.status(400).send("missing ticket_id");
    }

    const draft = `
— DRAFT for Agent —
Subject: Payoff Letter (Ticket {{ticket.id}})
Hi ${requesterName},

Attached is the payoff letter template for [BUSINESS_NAME], reflecting an outstanding purchased amount of [OUTSTANDING_AMOUNT] as of [AS_OF_DATE].

(Agent checklist)
1) Open attached DOCX template.
2) Replace tokens: {{BUSINESS_NAME}}, {{CONTACT_NAME}}, {{ADDRESS_LINE}}, {{DEAL_ID}}, {{OUTSTANDING_AMOUNT}}, {{AGREEMENT_DATE}}, {{AS_OF_DATE}}
3) Export to PDF & attach in public reply.
4) Replace [BRACKETS] in the email body, then send.
— End Draft —`;

    const filePath = resolveTemplate();

    if (!filePath) {
      console.error("Template not found in repo. Looked in CWD and __dirname.");
      // Post a PRIVATE note so agents aren’t blocked
      await fd.post(`/tickets/${ticket_id}/notes`, { body: draft, private: true });
      await mergeTags(ticket_id, ["AI-Draft-Pending", "Intent:Payoff", "Template:Missing"]);
      return res.status(206).send("draft posted (template missing)");
    }

    // ✅ Multipart with attachment
    const form = new FormData();
    form.append("body", draft);
    form.append("private", "true"); // Freshdesk accepts string "true" here
    form.append("attachments[]", fs.createReadStream(filePath));

    await fd.post(`/tickets/${ticket_id}/notes`, form, {
      headers: form.getHeaders()
    });

    await mergeTags(ticket_id, ["AI-Draft-Pending", "Intent:Payoff", "Template:Attached"]);

    const ms = Date.now() - start;
    res.send(`draft + template attached in ${ms}ms`);
  } catch (err) {
    // ✅ Better debug logging
    const resp = err?.response;
    console.error("Freshdesk API error:", {
      status: resp?.status,
      statusText: resp?.statusText,
      url: resp?.config?.url,
      method: resp?.config?.method,
      data: resp?.data,
      message: err?.message
    });
    res.status(500).send("error");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Webhook running on port ${port}`));


