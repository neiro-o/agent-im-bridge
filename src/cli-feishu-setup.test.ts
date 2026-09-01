import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccessFile } from "./modules/client/access/access-store";
import type { FeishuProbeReport } from "./modules/client/feishu/setup/feishu-setup";

// --- Scripted prompt context ------------------------------------------------

const promptCalls: string[] = [];
const confirmAnswers: Array<{ match: RegExp; value: boolean }> = [];
const inputAnswers: Record<string, string> = {};
const selectAnswers: Record<string, string> = {};

const input = vi.fn(async (label: string, opts?: { defaultValue?: string }) => {
  promptCalls.push(`input:${label}`);
  const answer = inputAnswers[label];
  if (answer !== undefined) return answer;
  if (opts?.defaultValue !== undefined) return opts.defaultValue;
  throw new Error(`unexpected input prompt: ${label}`);
});
const select = vi.fn(async (label: string) => {
  promptCalls.push(`select:${label}`);
  const answer = selectAnswers[label];
  if (answer !== undefined) return answer;
  throw new Error(`unexpected select prompt: ${label}`);
});
const confirm = vi.fn(async (label: string, defaultValue = false) => {
  promptCalls.push(`confirm:${label}`);
  const rule = confirmAnswers.find((candidate) => candidate.match.test(label));
  return rule ? rule.value : defaultValue;
});

vi.mock("./config/prompt", () => ({
  createPromptContext: () => ({ input, select, confirm, close: vi.fn() }),
}));

// --- Config store + agent registry -------------------------------------------

const loadConfig = vi.fn(async () => ({ channels: {}, defaults: { agentIdleTimeoutMs: 60_000 } }));
const saveConfig = vi.fn(async () => {});

vi.mock("./config/store", () => ({
  getConfigPath: () => "/tmp/agent-bridge-config.json",
  loadConfig,
  saveConfig,
}));

vi.mock("./modules/agent", () => ({
  listAgentModules: () => [{ type: "fake-agent" }],
  getAgentModule: (type: string) =>
    type === "fake-agent"
      ? {
          type: "fake-agent",
          createConfigCollector: () => ({
            collect: async () => ({ model: "demo" }),
            validate: async () => {},
          }),
        }
      : undefined,
}));

// --- feishu-setup module: keep the real data, stub the network/probe ---------

const verifyFeishuCredentials = vi.fn(async () => ({ ok: true as boolean, detail: undefined as string | undefined }));
const renderTerminalQr = vi.fn(async () => true);
const runFeishuProbe = vi.fn(
  async (): Promise<FeishuProbeReport> => ({
    connected: true,
    admin: { openId: "ou_admin", name: "Boss", chatId: "oc_admin" },
    probes: [
      { key: "receive", status: "ok" },
      { key: "send", status: "ok" },
      { key: "reaction", status: "ok" },
      { key: "download", status: "ok" },
      { key: "upload", status: "ok" },
    ],
  }),
);

vi.mock("./modules/client/feishu/setup/feishu-setup", async (importOriginal) => {
  const original = await importOriginal<typeof import("./modules/client/feishu/setup/feishu-setup")>();
  return {
    ...original,
    verifyFeishuCredentials,
    renderTerminalQr,
    runFeishuProbe,
    createDefaultProbeClient: vi.fn(),
  };
});

function captureLogs() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("setupFeishuChannel", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-bridge-feishu-setup-"));
    process.env.AGENT_BRIDGE_AUTHZ_PATH = path.join(dir, "authz.json");

    promptCalls.length = 0;
    confirmAnswers.length = 0;
    for (const key of Object.keys(inputAnswers)) delete inputAnswers[key];
    for (const key of Object.keys(selectAnswers)) delete selectAnswers[key];

    inputAnswers["Feishu App ID"] = "cli_test";
    inputAnswers["Feishu App Secret"] = "secret";
    inputAnswers["Channel name"] = "main";
    selectAnswers["Feishu domain"] = "feishu";
    selectAnswers["Channel language"] = "zh-CN";
    selectAnswers["Select agent module"] = "fake-agent";

    verifyFeishuCredentials.mockClear();
    verifyFeishuCredentials.mockResolvedValue({ ok: true, detail: undefined });
    runFeishuProbe.mockClear();
    runFeishuProbe.mockResolvedValue({
      connected: true,
      admin: { openId: "ou_admin", name: "Boss", chatId: "oc_admin" },
      probes: [
        { key: "receive", status: "ok" },
        { key: "send", status: "ok" },
        { key: "reaction", status: "ok" },
        { key: "download", status: "ok" },
        { key: "upload", status: "ok" },
      ],
    });
    saveConfig.mockClear();
  });

  afterEach(async () => {
    delete process.env.AGENT_BRIDGE_AUTHZ_PATH;
    await rm(dir, { recursive: true, force: true });
  });

  it("walks the happy path: verifies, probes, saves the channel and seeds the admin", async () => {
    const { setupFeishuChannel } = await import("./cli-feishu-setup");
    const logs = captureLogs();
    try {
      await setupFeishuChannel();
    } finally {
      logs.restore();
    }

    expect(verifyFeishuCredentials).toHaveBeenCalledWith("cli_test", "secret", "feishu");
    expect(runFeishuProbe).toHaveBeenCalledTimes(1);

    expect(saveConfig).toHaveBeenCalledTimes(1);
    const saved = saveConfig.mock.calls[0]![0] as {
      channels: Record<string, { client: { type: string; config: Record<string, unknown> } }>;
    };
    expect(saved.channels["main"]?.client.type).toBe("feishu");
    expect(saved.channels["main"]?.client.config).toMatchObject({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      requireMentionInGroup: true,
      accessControl: { enabled: true },
    });

    const authz = await loadAccessFile(process.env.AGENT_BRIDGE_AUTHZ_PATH);
    expect(authz.channels["main"]?.users["ou_admin"]).toMatchObject({
      grants: ["agent"],
      name: "Boss",
    });

    const out = logs.lines.join("\n");
    expect(out).toContain("im:message");
    expect(out).toContain("im:message:readonly");
    expect(out).toContain("im:resource");
    expect(out).toContain("agent-bridge start main");
    expect(out).toContain("access approve");
  });

  it("shows the create-app QR guidance when the user has no app yet", async () => {
    confirmAnswers.push({ match: /already have a Feishu custom app/, value: false });
    const { setupFeishuChannel } = await import("./cli-feishu-setup");
    const logs = captureLogs();
    try {
      await setupFeishuChannel();
    } finally {
      logs.restore();
    }
    expect(renderTerminalQr).toHaveBeenCalledWith("https://open.feishu.cn/app");
    expect(logs.lines.join("\n")).toContain("创建企业自建应用");
  });

  it("retries the probe after failures when the user agrees", async () => {
    runFeishuProbe
      .mockResolvedValueOnce({
        connected: true,
        admin: { openId: "ou_admin", name: "Boss", chatId: "oc_admin" },
        probes: [
          { key: "receive", status: "ok" },
          { key: "send", status: "fail", detail: "99991672" },
        ],
      })
      .mockResolvedValueOnce({
        connected: true,
        admin: { openId: "ou_admin", name: "Boss", chatId: "oc_admin" },
        probes: [
          { key: "receive", status: "ok" },
          { key: "send", status: "ok" },
        ],
      });
    const { setupFeishuChannel } = await import("./cli-feishu-setup");
    const logs = captureLogs();
    try {
      await setupFeishuChannel();
    } finally {
      logs.restore();
    }
    expect(runFeishuProbe).toHaveBeenCalledTimes(2);
    expect(logs.lines.join("\n")).toContain("[FAIL] send messages");
  });

  it("aborts when credentials are invalid and the user declines a retry", async () => {
    verifyFeishuCredentials.mockResolvedValue({ ok: false, detail: "code=10003 invalid app_id" });
    confirmAnswers.push({ match: /Re-enter App ID/, value: false });
    const { setupFeishuChannel } = await import("./cli-feishu-setup");
    const logs = captureLogs();
    try {
      await expect(setupFeishuChannel()).rejects.toThrow("invalid credentials");
    } finally {
      logs.restore();
    }
    expect(runFeishuProbe).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("skips channel creation and authz seeding when the user declines", async () => {
    confirmAnswers.push({ match: /Create a bridge channel/, value: false });
    const { setupFeishuChannel } = await import("./cli-feishu-setup");
    const logs = captureLogs();
    try {
      await setupFeishuChannel();
    } finally {
      logs.restore();
    }
    expect(saveConfig).not.toHaveBeenCalled();
    expect(logs.lines.join("\n")).toContain("agent-bridge add");
  });

  it("does not seed an admin when access control is disabled", async () => {
    confirmAnswers.push({ match: /Enable user access control/, value: false });
    const { setupFeishuChannel } = await import("./cli-feishu-setup");
    await setupFeishuChannel();

    const saved = saveConfig.mock.calls[0]![0] as {
      channels: Record<string, { client: { config: Record<string, unknown> } }>;
    };
    expect(saved.channels["main"]?.client.config.accessControl).toBeUndefined();
    expect(await loadAccessFile(process.env.AGENT_BRIDGE_AUTHZ_PATH)).toEqual({
      version: 1,
      channels: {},
    });
  });
});
