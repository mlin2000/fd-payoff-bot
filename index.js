const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
require("dotenv").config();

const app = express();
app.use(express.json());

const { FRESHDESK_DOMAIN, FRESHDESK_API_KEY, BOT_SHARED_SECRET } = process.env;

// Freshdesk API client
const fd = axios.create({
  baseURL: `https://${FRESHDESK_DOMAIN}/api/v2`,
  auth: { username: FRESHDESK_API_KEY, password: "X" }
});

// Merge tags safely (keeps existing)
async function mergeTags(ticketId, tagsToAdd = []) {
  const { data: t } = await fd.get(`/tickets/${ticketId}`);
  const merged = Array.from(new Set([...(t.tags || []), ...tagsToAdd]));
  await fd.put(`/tickets/${ticketId}`, { tags: merged });
}

app.post("/freshdesk/webhook", async (req, res) => {
  try {
    // Simple shared-secret check
    if (req.get("X-Shared-Secret") !== BOT_SHARED_SECRET) {
      return res.status(401).send("bad secret");
    }

    const { ticket_id, requester } = req.body || {};
    if (!ticket_id) return res.status(400).send("missing ticket_id");

    const requesterName = (requester && requester.name) || "{{requester.name}}";

    // 1) Post a private draft note
    const draft = `
— DRAFT for Agent —
Subject: Payoff Letter (Ticket {{ticket.id}})
Hi ${requesterName},

Attached is the payoff letter template for [BUSINESS_NAME], reflecting an outstanding purchased amount of [OUTSTANDING_AMOUNT] as of [AS_OF_DATE].

(Agent checklist)
1) Open attached DOCX template.
2) Replace tokens: {{BUSINESS_NAME}}, {{CONTACT_NAME}}, {{ADDRESS_LINE}}, {{DEAL_ID}}, {{OUTSTANDING_AMOUNT}}, {{AGREEMENT_DATE}}, {{AS_OF_DATE}}
3) Export PDF & attach in public reply.
4) Replace [BRACKETS] in the email body, then send.
— End Draft —`;

    await fd.post(`/tickets/${ticket_id}/notes`, { body: draft, private: true });

    // 2) Attach the DOCX template to the ticket
    const filePath = "Payoff_Letter_Template_Fill.docx"; // must exist in repo root
    if (!fs.existsSync(filePath)) {
      throw new Error("Template DOCX not found in server (expected Payoff_Letter_Template_Fill.docx)");
    }
    const form = new FormData();
    form.append("attachments[]", fs.createReadStream(filePath));

    await fd.post(`/tickets/${ticket_id}/attachments`, form, {
      headers: form.getHeaders()
    });

    // 3) Tag for your View
    await mergeTags(ticket_id, ["AI-Draft-Pending", "Intent:Payoff"]);

    res.send("draft posted + template attached");
  } catch (err) {
    console.error("Freshdesk API error:", err?.response?.data || err.message);
    res.status(500).send("error");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Webhook running on port ${port}`));
