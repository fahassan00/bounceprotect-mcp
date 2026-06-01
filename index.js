#!/usr/bin/env node

import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SITE_BASE_URL = "https://www.bounceprotect.com";
const API_BASE_URL = `${SITE_BASE_URL}/api/v1`;

function getApiKey() {
  const apiKey = process.env.BOUNCEPROTECT_API_KEY;
  if (!apiKey) {
    return null;
  }

  return apiKey;
}

function missingApiKeyText() {
  return "BOUNCEPROTECT_API_KEY environment variable is not set. Get your API key at https://bounceprotect.com/dashboard/api-keys";
}

function textResult(text) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

async function callBounceProtectUrl(url, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, message: missingApiKeyText() };
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.ok) {
      return { ok: true, data };
    }

    if (response.status === 402) {
      return {
        ok: false,
        message: "Insufficient credits. Upgrade at https://bounceprotect.com/dashboard/usage",
      };
    }

    if (response.status === 401) {
      return {
        ok: false,
        message: "Invalid API key. Get your key at https://bounceprotect.com/dashboard/api-keys",
      };
    }

    return {
      ok: false,
      message:
        (data && typeof data.error === "string" && data.error) ||
        `Request failed with status ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function callBounceProtect(path, options = {}) {
  return callBounceProtectUrl(`${API_BASE_URL}${path}`, options);
}

function formatResultLine(row) {
  const email = row.normalized_email ?? row.email ?? row.original_email ?? "unknown";
  const status = row.status ?? "unknown";
  const score = row.deliverability_score ?? row.score ?? "?";
  const recommendation = formatRecommendation(row.send_recommendation);
  const smtpResult = row.smtp_result ?? "not_checked";
  const smtpLabels = {
    accepted: "✓ Passed",
    rejected: "✗ Rejected — mailbox does not exist",
    error: "Unverifiable (provider blocks probing)",
    not_checked: "⏳ Pending",
  };
  const smtpDisplay = smtpLabels[smtpResult] ?? smtpResult;
  const icon =
    status === "valid" ? "✅" : status === "invalid" ? "❌" : status === "risky" ? "⚠️" : "❓";

  const explanation = row.status_explanation ?? "";
  const signals = [];
  if (row.is_role_account) signals.push("role account");
  if (row.is_catch_all) {
    signals.push(
      `catch-all${row.catch_all_confidence ? ` (${row.catch_all_confidence} confidence)` : ""}`,
    );
  }
  if (row.is_disposable) signals.push("disposable");
  if (row.is_free_email_provider) signals.push("free provider");
  if (row.is_possible_domain_typo && row.suggested_domain) {
    signals.push(`possible typo → ${row.suggested_domain}`);
  }

  const mainLine = `${icon} ${email} — ${status} | ${recommendation} | Score: ${score}/100 | SMTP: ${smtpDisplay}`;
  const detailLine = explanation
    ? `   ↳ ${explanation}${signals.length ? ` [${signals.join(", ")}]` : ""}`
    : signals.length
      ? `   ↳ ${signals.join(", ")}`
      : "";

  return detailLine ? `${mainLine}\n${detailLine}` : mainLine;
}

function formatRecommendation(recommendation) {
  if (!recommendation) return "unknown";
  if (recommendation === "SEND") return "SEND";
  if (recommendation === "SEND_WITH_CAUTION") return "SEND WITH CAUTION";
  if (recommendation === "REVIEW") return "REVIEW";
  if (recommendation === "DO_NOT_SEND") return "DO NOT SEND";
  return recommendation;
}

function formatBulkSummary(rows) {
  return {
    valid: rows.filter((row) => row.status === "valid").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
    risky: rows.filter((row) => row.status === "risky").length,
    unknown: rows.filter((row) => row.status === "unknown").length,
  };
}

async function fetchCompletedSmtpResults(uploadId, apiKey) {
  const rowsResult = await callBounceProtectUrl(
    `${SITE_BASE_URL}/api/uploads/${uploadId}/rows?page=0&page_size=500`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );

  if (!rowsResult.ok) {
    return textResult(rowsResult.message);
  }

  const rowsData = rowsResult.data ?? {};
  const rows = Array.isArray(rowsData.rows) ? rowsData.rows : [];
  const counts = formatBulkSummary(rows);
  const formattedRows = rows.map(formatResultLine);

  return textResult(
    [
      `Upload ID: ${uploadId}`,
      "",
      `SMTP verification complete for upload ${uploadId}.`,
      "",
      "Results:",
      ...formattedRows,
      "",
      `Summary: ${counts.valid} valid · ${counts.invalid} invalid · ${counts.risky} risky · ${counts.unknown} unknown`,
    ].join("\n"),
  );
}

async function pollSmtpStatus(uploadId, apiKey, maxWaitMs = 25 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 30000));

    const statusResult = await callBounceProtectUrl(
      `${SITE_BASE_URL}/api/uploads/${uploadId}/smtp-status`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    );

    if (!statusResult.ok) return textResult(statusResult.message);

    const status = statusResult.data ?? {};
    const done = status.smtp_done ?? 0;
    const total = status.total_eligible ?? 0;

    console.error(`[smtp-poll] ${done}/${total} checked...`);

    if (status.is_complete) {
      return fetchCompletedSmtpResults(uploadId, apiKey);
    }
  }

  return textResult(
    `SMTP verification is taking longer than expected (25+ min). ` +
    `Use get_smtp_status with upload_id ${uploadId} to check manually.`,
  );
}

async function validateEmail(email) {
  const result = await callBounceProtect("/validate/email", {
    method: "POST",
    body: JSON.stringify({ email }),
  });

  if (!result.ok) {
    return textResult(result.message);
  }

  const data = result.data ?? {};
  const signals = data.signals ?? {};
  const lines = [
    `Email: ${data.email ?? email}`,
    `Status: ${data.status ?? "unknown"} (${data.status_reason ?? "unknown"})`,
    `Recommendation: ${data.send_recommendation ?? "unknown"}`,
    `Deliverability score: ${data.deliverability_score ?? "unknown"}/100`,
    `Spam risk score: ${data.spam_score ?? "unknown"}/100`,
    `SMTP result: ${data.smtp_result ?? "not_checked"}`,
    "",
    "Signals:",
    `- Disposable domain: ${signals.is_disposable ?? false}`,
    `- Role account: ${signals.is_role_account ?? false}`,
    `- Free provider: ${signals.is_free_provider ?? false}`,
    `- Catch-all domain: ${signals.is_catch_all ?? false}`,
    `- Domain typo detected: ${signals.is_possible_typo ?? false}`,
    signals.suggested_domain
      ? `- Suggested correction: ${signals.suggested_domain}`
      : "",
    `- MX records found: ${signals.has_mx ?? false}`,
    `- SPF configured: ${signals.has_spf ?? false}`,
    `- DMARC configured: ${signals.has_dmarc ?? false}`,
    "",
    `Explanation: ${data.status_explanation ?? "No explanation provided."}`,
    `Credits remaining: ${data.credits_remaining ?? "unknown"}`,
  ].filter(Boolean);

  if (data.smtp_pending && data.smtp_upload_id) {
    const preliminaryOutput = [
      "⚠️ RESULTS INCOMPLETE — SMTP verification is running in the background.",
      "The recommendations below are preliminary. Final results follow automatically.",
      "",
      "--- PRELIMINARY RESULTS ---",
      "",
      ...lines,
      "",
      "Waiting for SMTP verification to complete...",
    ].join("\n");

    const finalResult = await pollSmtpStatus(data.smtp_upload_id, getApiKey());
    return textResult(
      preliminaryOutput +
        "\n\n--- FINAL RESULTS (SMTP complete) ---\n\n" +
        (finalResult.content?.[0]?.text ?? "SMTP results unavailable."),
    );
  }

  return textResult(lines.join("\n"));
}

async function validateEmailsBulk(emails) {
  const result = await callBounceProtect("/validate/bulk", {
    method: "POST",
    body: JSON.stringify({ emails }),
  });

  if (!result.ok) {
    return textResult(result.message);
  }

  const data = result.data ?? {};
  const rows = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.rows)
      ? data.rows
      : [];
  const counts = formatBulkSummary(rows);
  const formattedRows = rows.map(formatResultLine);

  const lines = [
    `Validated ${data.total ?? rows.length} emails — ${data.credits_used ?? rows.length} credits used, ${data.credits_remaining ?? "unknown"} remaining.`,
    "",
    "Results:",
    ...formattedRows,
    "",
    "Summary:",
    `- Valid: ${counts.valid}`,
    `- Invalid: ${counts.invalid}`,
    `- Risky: ${counts.risky}`,
    `- Unknown: ${counts.unknown}`,
  ];

  if (data.upload_id) {
    lines.push("", `upload_id: ${data.upload_id}`);
    lines.push("Use this upload_id with trigger_deep_analysis for domain-level intelligence.");
  }

  if (data.smtp_pending && data.smtp_upload_id) {
    const preliminaryOutput = [
      "⚠️ RESULTS INCOMPLETE — SMTP verification is running in the background.",
      "The recommendations below are preliminary. Final results follow automatically.",
      "",
      "--- PRELIMINARY RESULTS ---",
      "",
      ...formattedRows,
      "",
      `Summary (preliminary): ${counts.valid} valid · ${counts.invalid} invalid · ${counts.risky} risky · ${counts.unknown} unknown`,
      "",
      "Waiting for SMTP verification to complete...",
      `upload_id: ${data.smtp_upload_id}`,
    ].join("\n");

    const finalResult = await pollSmtpStatus(data.smtp_upload_id, getApiKey());

    return textResult(
      preliminaryOutput +
        "\n\n--- FINAL RESULTS (SMTP complete) ---\n\n" +
        (finalResult.content?.[0]?.text ?? "SMTP results unavailable."),
    );
  }

  return textResult(lines.join("\n"));
}

async function checkCredits() {
  const result = await callBounceProtect("/account/balance", {
    method: "GET",
  });

  if (!result.ok) {
    return textResult(result.message);
  }

  const data = result.data ?? {};
  return textResult(`Your BounceProtect credit balance: ${data.balance ?? "unknown"} credits remaining.`);
}

async function getSmtpStatus(uploadId) {
  const apiKey = process.env.BOUNCEPROTECT_API_KEY;
  const statusResult = await callBounceProtectUrl(`${SITE_BASE_URL}/api/uploads/${uploadId}/smtp-status`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!statusResult.ok) {
    return textResult(statusResult.message);
  }

  const status = statusResult.data ?? {};
  const done = status.smtp_done ?? 0;
  const total = status.total_eligible ?? 0;

  if (!status.is_complete) {
    return pollSmtpStatus(uploadId, apiKey);
  }

  return fetchCompletedSmtpResults(uploadId, apiKey);
}

function formatDeepAnalysisResults(data) {
  const domainResults = Array.isArray(data.domain_results) ? data.domain_results : [];
  const lines = [`Deep analysis complete. ${domainResults.length} domains analysed.`, ""];

  for (const row of domainResults) {
    lines.push(
      `🏢 ${row.domain ?? "unknown"} — Score: ${row.business_legitimacy_score ?? "?"}/100 | Website: ${row.has_website ?? false} | SSL: ${row.has_ssl ?? false} | Parked: ${row.is_parked ?? false}`,
    );
    const orgParts = [];
    if (row.org_name) orgParts.push(row.org_name);
    if (row.org_industry) orgParts.push(row.org_industry);
    if (row.org_employee_size) orgParts.push(`${row.org_employee_size} employees`);
    if (row.org_year_founded) orgParts.push(`founded ${row.org_year_founded}`);
    if (row.org_country) orgParts.push(row.org_country);
    if (orgParts.length > 0) {
      lines.push(`   Company: ${orgParts.join(" | ")}`);
    }
    if (row.org_linkedin_url) {
      lines.push(`   LinkedIn: ${row.org_linkedin_url}`);
    }
    if (row.mail_provider) {
      lines.push(`   Mail provider: ${row.mail_provider}`);
    }
  }

  return textResult(lines.join("\n"));
}

async function pollDeepAnalysis(uploadId, apiKey, maxWaitMs = 10 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 20000));

    const result = await callBounceProtectUrl(
      `${SITE_BASE_URL}/api/uploads/${uploadId}/deep-analysis`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    );

    if (!result.ok) return textResult(result.message);

    const job = result.data?.job ?? null;
    if (!job) return textResult("Deep analysis job not found.");

    if (job.status === "completed") {
      return formatDeepAnalysisResults(result.data);
    }
    if (job.status === "failed" || job.status === "stopped") {
      return textResult(`Deep analysis ${job.status}. Try trigger_deep_analysis again.`);
    }

    if (!job.domains_total) {
      console.error("Deep analysis is initialising — domain scan starting...");
    } else {
      console.error(
        `[deep-analysis] ${job.domains_checked ?? 0}/${job.domains_total ?? "?"} domains checked, waiting...`,
      );
    }
  }

  return textResult(
    `Deep analysis is taking longer than expected (10+ minutes). ` +
    `Use get_deep_analysis_status with upload_id ${uploadId} to check when it completes.`,
  );
}

async function triggerDeepAnalysis(uploadId) {
  const apiKey = process.env.BOUNCEPROTECT_API_KEY;
  const result = await callBounceProtectUrl(`${SITE_BASE_URL}/api/uploads/${uploadId}/deep-analysis`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!result.ok) {
    return textResult(result.message);
  }

  const data = result.data ?? {};

  if (data.already_exists) {
    if (data.status === "completed") {
      const completedResult = await callBounceProtectUrl(`${SITE_BASE_URL}/api/uploads/${uploadId}/deep-analysis`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!completedResult.ok) {
        return textResult(completedResult.message);
      }

      const completedText = formatDeepAnalysisResults(completedResult.data ?? {});
      return textResult(
        `Deep analysis already completed.\nupload_id: ${uploadId}\n\n${completedText.content?.[0]?.text ?? "Deep analysis results unavailable."}`,
      );
    }
  } else {
    console.error("Deep analysis started — monitoring progress (checks every 20s, up to 10 min)...");
  }

  if (data.already_exists && (data.status === "pending" || data.status === "running")) {
    console.error("Deep analysis started — monitoring progress (checks every 20s, up to 10 min)...");
  }

  const finalResult = await pollDeepAnalysis(uploadId, apiKey);
  return textResult(
    `Deep analysis started.\nupload_id: ${uploadId}\nJob ID: ${data.job_id ?? "unknown"}.\nUse get_deep_analysis_status with this upload_id to poll for results.\n\n${finalResult.content?.[0]?.text ?? "Deep analysis results unavailable."}`,
  );
}

async function getDeepAnalysisStatus(uploadId) {
  const apiKey = process.env.BOUNCEPROTECT_API_KEY;
  const result = await callBounceProtectUrl(`${SITE_BASE_URL}/api/uploads/${uploadId}/deep-analysis`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!result.ok) {
    return textResult(result.message);
  }

  const data = result.data ?? {};
  const job = data.job ?? null;

  if (!job) {
    return textResult("No deep analysis job found for this upload. Use trigger_deep_analysis first.");
  }

  if (job.status === "pending" || job.status === "running") {
    if (!job.domains_total) {
      return textResult("Deep analysis is initialising — domain scan starting...");
    }
    return textResult(
      `Deep analysis in progress: ${job.domains_checked ?? 0} of ${job.domains_total ?? 0} domains checked. Check back in 30 seconds.`,
    );
  }

  if (job.status === "failed" || job.status === "stopped") {
    return textResult(`Deep analysis job ${job.status}. Trigger a new one with trigger_deep_analysis.`);
  }

  return formatDeepAnalysisResults(data);
}

const server = new Server(
  {
    name: "bounceprotect",
    version: "1.2.6",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "validate_email",
        description:
          "Validate a single email address. Returns deliverability status, spam risk score, SMTP verification result, and a send recommendation.",
        inputSchema: {
          type: "object",
          properties: {
            email: {
              type: "string",
              description: "The email address to validate",
            },
          },
          required: ["email"],
        },
      },
      {
        name: "validate_emails_bulk",
        description:
          "Validate up to 100 email addresses at once. Returns validation results for each email including status, recommendation, and deliverability signals.",
        inputSchema: {
          type: "object",
          properties: {
            emails: {
              type: "array",
              items: { type: "string" },
              description: "Array of email addresses to validate (maximum 100)",
              maxItems: 100,
            },
          },
          required: ["emails"],
        },
      },
      {
        name: "check_credits",
        description: "Check your remaining BounceProtect credit balance.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get_smtp_status",
        description:
          "Check whether background SMTP verification has completed for an upload and return updated results when ready.",
        inputSchema: {
          type: "object",
          properties: {
            upload_id: {
              type: "string",
              description: "The upload_id returned by validate_email or validate_emails_bulk when SMTP is still pending.",
            },
          },
          required: ["upload_id"],
        },
      },
      {
        name: "trigger_deep_analysis",
        description:
          "Start deep analysis for an upload so you can inspect domain legitimacy, website/SSL signals, and matched organisation data.",
        inputSchema: {
          type: "object",
          properties: {
            upload_id: {
              type: "string",
              description: "The upload_id to analyse.",
            },
          },
          required: ["upload_id"],
        },
      },
      {
        name: "get_deep_analysis_status",
        description:
          "Check deep analysis progress for an upload and return full domain-level results when the job is complete.",
        inputSchema: {
          type: "object",
          properties: {
            upload_id: {
              type: "string",
              description: "The upload_id returned by a prior validation workflow.",
            },
          },
          required: ["upload_id"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "validate_email") {
    return validateEmail(args?.email);
  }

  if (name === "validate_emails_bulk") {
    return validateEmailsBulk(Array.isArray(args?.emails) ? args.emails : []);
  }

  if (name === "check_credits") {
    return checkCredits();
  }

  if (name === "get_smtp_status") {
    return getSmtpStatus(args?.upload_id);
  }

  if (name === "trigger_deep_analysis") {
    return triggerDeepAnalysis(args?.upload_id);
  }

  if (name === "get_deep_analysis_status") {
    return getDeepAnalysisStatus(args?.upload_id);
  }

  return textResult(`Unknown tool: ${name}`);
});

process.on("unhandledRejection", (error) => {
  console.error("[bounceprotect-mcp] Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("[bounceprotect-mcp] Uncaught exception:", error);
});

const transport = new StdioServerTransport();
await server.connect(transport);
