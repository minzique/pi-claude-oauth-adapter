import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import adapter from "../extensions/index.ts";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

function setup(oauth = true) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_CLAUDE_") || key.startsWith("CLAUDE_CODE_")) delete process.env[key];
  }
  const handlers = {};
  let provider;
  adapter({
    registerProvider: (_name, config) => { provider = config; },
    on: (event, handler) => { handlers[event] = handler; },
  });
  const model = {
    id: "claude-fable-5", name: "Fable 5", provider: "anthropic",
    api: "anthropic-messages", baseUrl: "https://api.anthropic.com",
    reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    headers: { "USER-AGENT": "stale-model-agent", "x-model-test": "preserved" },
  };
  const ctx = {
    model, modelRegistry: { isUsingOAuth: () => oauth },
    getSystemPrompt: () => "Test system prompt",
    ui: { setStatus() {}, theme: { fg: (_color, text) => text } },
  };
  return { handlers, provider, model, ctx };
}

for (const override of [undefined, "2.1.266"]) {
  test(`OAuth wire requests and billing agree (${override ?? "bundled version"})`, async () => {
    const { handlers, provider, model, ctx } = setup();
    const version = override ?? "2.1.265";
    if (override) process.env.PI_CLAUDE_CODE_VERSION = override;
    const requests = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ url: request.url, headers: request.headers, body });
      if (request.url.endsWith("/api/oauth/usage")) return Response.json({});
      if (body.model === "claude-haiku-4-5") return Response.json({});
      // Stop after capturing the outgoing model request, without real network I/O.
      return Response.json({ error: { type: "invalid_request_error", message: "mock response" } }, { status: 400 });
    };
    const options = {
      apiKey: `sk-ant-oat-test-${version}`, maxRetries: 0,
      headers: { "User-Agent": "stale-options-agent", "x-options-test": "preserved" },
      onPayload: (payload) => handlers.before_provider_request({ payload }, ctx),
    };
    const originalOptions = structuredClone({ headers: options.headers });
    const stream = provider.streamSimple(model, {
      systemPrompt: "Test system prompt",
      messages: [{ role: "user", content: "hello version regression", timestamp: 0 }],
    }, options);
    for await (const _event of stream) { /* drain mocked response */ }
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.headers.get("user-agent"), `claude-cli/${version} (external, pi)`);
      assert.equal(request.headers.get("x-options-test"), "preserved");
    }
    const modelRequest = requests[2];
    assert.equal(modelRequest.body.model, "claude-fable-5");
    assert.equal(modelRequest.headers.get("x-model-test"), "preserved");
    const text = "hello version regression";
    const sample = [4, 7, 20].map((i) => text[i] ?? "0").join("");
    const hash = createHash("sha256").update(`59cf53e54c78${sample}${version}`).digest("hex").slice(0, 3);
    assert.ok(modelRequest.body.system[0].text.startsWith(`x-anthropic-billing-header: cc_version=${version}.${hash};`));
    assert.ok(requests[1].headers.get("x-anthropic-billing-header").includes(`cc_version=${version}.`));
    assert.deepEqual(options.headers, originalOptions.headers);
    assert.equal(model.headers["USER-AGENT"], "stale-model-agent");
  });
}

test("API-key requests retain their headers and skip quota checks", async () => {
  const { handlers, provider, model, ctx } = setup(false);
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ error: { type: "invalid_request_error", message: "mock response" } }, { status: 400 });
  };
  const payload = { system: [{ type: "text", text: "original" }] };
  assert.equal(handlers.before_provider_request({ payload }, ctx), undefined);
  assert.equal(payload.system[0].text, "original");
  const stream = provider.streamSimple({ ...model, headers: undefined }, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, { apiKey: "sk-ant-api-test", maxRetries: 0, headers: { "user-agent": "my-api-client" } });
  for await (const _event of stream) { /* drain */ }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.get("user-agent"), "my-api-client");
});

test("other providers are not normalized", () => {
  const { handlers, ctx } = setup();
  ctx.model = { ...ctx.model, provider: "other" };
  assert.equal(handlers.before_provider_request({ payload: { system: [] } }, ctx), undefined);
});
