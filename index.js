const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
require("dotenv").config();

const app = express();
app.use(express.json());

const { FRESHDESK_DOMAIN, FRESHDESK_API_KEY, BOT_SHARED_SECRET } = process.env;

const fd = axios.create({
  baseURL: `https://${FRESHDESK_DOMAIN}/api/v2`,
  auth: { username: FRESHDESK_API_KEY, password: "X" }
});

// Safely merge tags
async function mergeTags(ticketId, tagsToAdd = []) {
  const { data: t } = await fd.get(`/tickets/${ticketId}`);
  const merged = Array.from(new Set([...(t.tags || []), ...tagsToAdd]));
  await fd.put(`/tickets/${ticketId}`, { tags: merged });
}

app.post("/freshdesk/webhook", async (req, res) => {
  try {
    // Shared-secret guard
    if (req.get("X-Shared-Secret") !== BOT_SHARED_SECRET) {
      return res.status(401).send("bad secret");
    }

    const { ticket_id, requester } = req.body || {};
    if (!ticket_id) return res.status(400).send("missing ticket_id");

    const requesterName = (requester && requester.name) || "{{requester.name}}";

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

    // Resolve the DOCX path from the repo root
    const filePath = path.join(__dirname, "Payoff_Letter_Template_Fill.docx");
    if (!fs.existsSync(filePath)) {
      console.error("Template not found at:", filePath);
      // Still post the draft note without attachment so agents aren't blocked
      await fd.post(`/tickets/${ticket_id}/notes`, { body: draft, private: true });
      await mergeTags(ticket_id, ["AI-Draft-Pending", "Intent:Payoff"]);
      return res.status(206).send("draft posted (template missing)");
    }

    // Create a multipart note WITH the attachment
    const form = new FormData();
    form.append("body", draft);
    form.append("private", "true");
    form.append("attachments[]", fs.createReadStream(filePath));

    await fd.post(`/tickets/${ticket_id}/notes`, form, {
      headers: form.getHeaders()
    });

    await mergeTags(ticket_id, ["AI-Draft-Pending", "Intent:Payoff"]);

    res.send("draft + template attached");
  } catch (err) {
    console.error("Freshdesk API error:", err?.response?.data || err.message);
    res.status(500).send("error");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Webhook running on port ${port}`));

