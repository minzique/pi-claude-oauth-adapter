import { describe, expect, it } from "vitest";
import {
  buildBillingHeader,
  compareVersions,
  extractRequiredClaudeCodeVersion,
  getClaudeFooterStatus,
  usageResponseToRateLimitHeaders,
  withFinalPayloadNormalization,
} from "../extensions/index.ts";

/** Shape of `GET /api/oauth/usage` for a healthy account that never bought extra usage. */
const healthyUsage = {
  five_hour: { utilization: 20.0, resets_at: "2026-09-14T07:30:00.913859+00:00", locked_reason: null },
  seven_day: { utilization: 45.0, resets_at: "2026-09-15T14:00:00.913887+00:00", locked_reason: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: 2000,
    used_credits: 0.0,
    utilization: 0.0,
    disabled_reason: "out_of_credits",
    user_disabled: false,
    spend_limit_reached: false,
  },
};

describe("usageResponseToRateLimitHeaders", () => {
  it("does not reject a healthy account that simply never enabled extra usage", () => {
    expect(usageResponseToRateLimitHeaders(healthyUsage)).toBeNull();
  });

  it("rejects once a primary limit is spent, and reports the credit state", () => {
    const headers = usageResponseToRateLimitHeaders({
      ...healthyUsage,
      five_hour: { utilization: 100.0, resets_at: "2026-09-14T07:30:00.000000+00:00", locked_reason: null },
    });

    expect(headers).toEqual({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-reset": String(Date.parse("2026-09-14T07:30:00.000Z") / 1000),
      "anthropic-ratelimit-unified-overage-status": "rejected",
      "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
    });
  });

  it("rejects a locked limit even below 100% utilization", () => {
    const headers = usageResponseToRateLimitHeaders({
      ...healthyUsage,
      seven_day: { utilization: 80.0, resets_at: null, locked_reason: "policy_violation" },
    });

    expect(headers?.["anthropic-ratelimit-unified-representative-claim"]).toBe("seven_day");
  });

  it("keeps enabled extra usage out of the rejection state", () => {
    const headers = usageResponseToRateLimitHeaders({
      ...healthyUsage,
      five_hour: { utilization: 100.0, resets_at: null, locked_reason: null },
      extra_usage: { is_enabled: true, disabled_reason: "out_of_credits" },
    });

    expect(headers?.["anthropic-ratelimit-unified-overage-status"]).toBeUndefined();
  });
});

describe("getClaudeFooterStatus", () => {
  it("stays silent on a live response that only advertises disabled extra usage", () => {
    expect(
      getClaudeFooterStatus(
        {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.19",
          "anthropic-ratelimit-unified-5h-reset": "1789371000",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-overage-status": "rejected",
          "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
        },
        200,
      ),
    ).toBeNull();
  });

  it("reports an error once the request is actually rejected", () => {
    const status = getClaudeFooterStatus(
      {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      },
      429,
    );

    expect(status?.severity).toBe("error");
    expect(status?.message).toContain("session limit");
  });
});

describe("claude code version handling", () => {
  it("orders versions numerically, not lexicographically", () => {
    expect(compareVersions("2.1.270", "2.1.98")).toBe(1);
    expect(compareVersions("2.1.226", "2.1.251")).toBe(-1);
    expect(compareVersions("2.1.270", "2.1.270")).toBe(0);
  });

  it("extracts the version Anthropic demands for a gated model", () => {
    expect(
      extractRequiredClaudeCodeVersion(
        "Claude Code 2.1.226 does not support this model; version 2.1.251 or newer is required. Run 'claude update'.",
      ),
    ).toBe("2.1.251");
    expect(extractRequiredClaudeCodeVersion("rate_limit_error")).toBeUndefined();
    expect(extractRequiredClaudeCodeVersion(undefined)).toBeUndefined();
  });
});

describe("buildBillingHeader", () => {
  it("samples the first user message and keeps Claude Code's field order", () => {
    expect(buildBillingHeader([{ role: "user", content: "hi" }], "pi", true)).toMatch(
      /^x-anthropic-billing-header: cc_version=\d+(?:\.\d+)+\.[0-9a-f]{3}; cc_entrypoint=pi; cch=00000;$/,
    );
  });

  it("omits cch for non first-party endpoints", () => {
    expect(buildBillingHeader([{ role: "user", content: "hi" }], "pi", false)).not.toContain("cch=");
  });
});

describe("withFinalPayloadNormalization", () => {
  const model = { baseUrl: "https://api.anthropic.com" } as Parameters<typeof withFinalPayloadNormalization>[1];
  const context = { systemPrompt: "You are Pi.", messages: [] } as unknown as Parameters<typeof withFinalPayloadNormalization>[2];
  const system = (payload: unknown) => (payload as { system: { text: string }[] }).system.map((block) => block.text);

  it("normalizes the payload a caller without onPayload sends", async () => {
    const wrapped = withFinalPayloadNormalization(undefined, model, context);
    const payload = { system: [{ type: "text", text: "You are Pi." }], messages: [{ role: "user", content: "hi" }] };
    const sent = await wrapped.onPayload!(payload, model);
    expect(system(sent)[0]).toBe(buildBillingHeader(payload.messages, "pi", true));
    expect(system(sent).slice(1)).toEqual(["You are Pi."]);
  });

  it("runs the caller's onPayload first and normalizes what it returns", async () => {
    const seen: unknown[] = [];
    const wrapped = withFinalPayloadNormalization(
      {
        onPayload: (payload) => {
          seen.push(payload);
          // A nested caller (compaction, summaries) rewrites the transcript after the host hooks ran.
          return { ...(payload as object), messages: [{ role: "user", content: "rewritten" }] };
        },
      },
      model,
      context,
    );
    const payload = { system: [{ type: "text", text: "You are Pi." }], messages: [{ role: "user", content: "hi" }] };
    const sent = (await wrapped.onPayload!(payload, model)) as { messages: unknown };
    expect(seen).toEqual([payload]);
    expect(sent.messages).toEqual([{ role: "user", content: "rewritten" }]);
    // The billing header samples the message that is actually sent, not the pre-rewrite one.
    expect(system(sent)[0]).toBe(buildBillingHeader(sent.messages, "pi", true));
    expect(system(sent)[0]).not.toBe(buildBillingHeader(payload.messages, "pi", true));
  });

  it("keeps the original payload when the caller's onPayload returns undefined", async () => {
    const wrapped = withFinalPayloadNormalization({ onPayload: () => undefined }, model, context);
    const payload = { system: [{ type: "text", text: "You are Pi." }], messages: [{ role: "user", content: "hi" }] };
    const sent = (await wrapped.onPayload!(payload, model)) as { messages: unknown };
    expect(sent.messages).toBe(payload.messages);
    expect(system(sent)[0]).toBe(buildBillingHeader(payload.messages, "pi", true));
  });
});
