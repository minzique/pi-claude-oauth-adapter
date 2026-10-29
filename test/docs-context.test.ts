import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type BeforeAgentStartEventResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import adapter from "../extensions/index.ts";

const systemPrompt = "Stable instructions.\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- /pi/docs/extensions.md";
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness(session = SessionManager.inMemory("/tmp/pi-adapter-test"), oauth = true) {
  const handlers = new Map<string, Handler>();
  adapter({
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    registerProvider: vi.fn(),
  } as unknown as ExtensionAPI);
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: { isUsingOAuth: () => oauth },
    sessionManager: session,
    getSystemPrompt: () => systemPrompt,
    ui: { setStatus: vi.fn(), theme: { fg: (_color: string, value: string) => value } },
  } as unknown as ExtensionContext;
  const call = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  return {
    session,
    call,
    async prompt(prompt: string) {
      session.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
      const result = await call("before_agent_start", { messageType: "user", prompt, systemPrompt }) as BeforeAgentStartEventResult | undefined;
      // This is Pi's native before_agent_start.message persistence contract.
      if (result?.message) {
        const message = result.message;
        session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      }
      return result;
    },
    async context() {
      const messages = session.buildSessionContext().messages;
      const result = await call("context", { messages }) as { messages: AgentMessage[] } | undefined;
      return result?.messages ?? messages;
    },
  };
}

beforeEach(() => {
  vi.stubEnv("PI_CLAUDE_OAUTH_REINJECT_SCOPE", "pi-only");
  vi.stubEnv("PI_CLAUDE_OAUTH_REINJECT_MODE", "prepend-custom-message");
  vi.stubEnv("PI_CLAUDE_OAUTH_LOG_FILE", "");
});
afterEach(() => vi.unstubAllEnvs());

const docsMessages = (messages: AgentMessage[]) => messages.filter(
  (message) => message.role === "custom" && message.customType === "claude-oauth-docs-context",
);

describe("cache-stable Pi docs context", () => {
  it.each(["prepend-custom-message", "append-custom-message", "user-reminder"])(
    "persists docs without rewriting the old prefix in %s mode", async (mode) => {
      vi.stubEnv("PI_CLAUDE_OAUTH_REINJECT_MODE", mode);
      const host = harness();
      const result = await host.prompt("How do Pi extensions work?");
      const first = await host.context();
      expect(docsMessages(first)).toHaveLength(1);
      expect(result?.message?.display).toBe(false);
      expect(result?.systemPrompt).toBe("Stable instructions.");
      expect(host.session.buildSessionContext().messages).toEqual(first);
      expect(await host.context()).toEqual(first);

      await host.call("agent_end");
      await host.prompt("Now fix the stylesheet.");
      const second = await host.context();
      expect(second.slice(0, first.length)).toEqual(first);
      expect(docsMessages(second)).toHaveLength(1);

      await host.prompt("Which Pi themes are available?");
      const third = await host.context();
      expect(third.slice(0, second.length)).toEqual(second);
      expect(docsMessages(third)).toHaveLength(2);
      expect(third[0]).toMatchObject({ role: "user", content: "How do Pi extensions work?" });
    },
  );

  it("does not mistake clipboard filenames for a request about Pi", async () => {
    const host = harness();
    await host.prompt('Improve this sleeve: "/tmp/pi-clipboard-79265d57.png"');
    expect(docsMessages(await host.context())).toHaveLength(0);
    await host.prompt("How do I use Pi extensions with that image?");
    expect(docsMessages(await host.context())).toHaveLength(1);
  });

  it("retains the same prefix after runtime reload and disabling new injections", async () => {
    const host = harness();
    await host.prompt("Explain Pi skills.");
    const before = await host.context();
    await host.call("session_shutdown");
    vi.stubEnv("PI_CLAUDE_OAUTH_REINJECT_SCOPE", "never");
    const resumed = harness(host.session);
    expect(await resumed.context()).toEqual(before);
    await resumed.prompt("Continue the implementation.");
    expect((await resumed.context()).slice(0, before.length)).toEqual(before);
  });

  it.each(["none", "never"])("honors disabled injection (%s)", async (disabled) => {
    vi.stubEnv(disabled === "none" ? "PI_CLAUDE_OAUTH_REINJECT_MODE" : "PI_CLAUDE_OAUTH_REINJECT_SCOPE", disabled);
    const host = harness();
    await host.prompt("Explain Pi skills.");
    expect(docsMessages(await host.context())).toHaveLength(0);
  });

  it("leaves API-key sessions untouched", async () => {
    const host = harness(undefined, false);
    expect(await host.prompt("Explain Pi skills.")).toBeUndefined();
    expect(docsMessages(await host.context())).toHaveLength(0);
  });

  it("does not inject docs for a custom-message-triggered run", async () => {
    vi.stubEnv("PI_CLAUDE_OAUTH_REINJECT_SCOPE", "always");
    const host = harness();
    const result = await host.call("before_agent_start", {
      messageType: "custom", message: { customType: "notification", content: "Done" }, systemPrompt,
    }) as BeforeAgentStartEventResult | undefined;
    expect(result?.message).toBeUndefined();
    expect(docsMessages(await host.context())).toHaveLength(0);
  });
});
