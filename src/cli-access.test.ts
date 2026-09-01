import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAccessFile,
  recordPendingRequest,
  updateAccessFile,
} from "./modules/client/access/access-store";

// Access commands talk to the real authz file (redirected to a temp dir via
// AGENT_BRIDGE_AUTHZ_PATH); only the app config is mocked.
const loadConfig = vi.fn(async () => ({
  channels: {
    demo: {
      common: { language: "zh-CN" as const },
      client: { type: "fake-client", config: {} },
      agent: { type: "fake-agent", config: {} },
    },
  },
  defaults: { agentIdleTimeoutMs: 60_000 },
}));

vi.mock("./config/store", () => ({
  getConfigPath: () => "/tmp/agent-bridge-config.json",
  loadConfig,
  saveConfig: vi.fn(async () => {}),
}));

function captureLogs() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("runCli access", () => {
  let dir: string;
  let authzPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-bridge-cli-access-"));
    authzPath = path.join(dir, "authz.json");
    process.env.AGENT_BRIDGE_AUTHZ_PATH = authzPath;
  });

  afterEach(async () => {
    delete process.env.AGENT_BRIDGE_AUTHZ_PATH;
    await rm(dir, { recursive: true, force: true });
  });

  async function seedPending(openId = "ou_alice", channel = "demo") {
    await updateAccessFile(
      recordPendingRequest(channel, openId, { name: "Alice", chatId: "oc_1", chatType: "dm" }),
      authzPath,
    );
  }

  it("prints an empty hint when nothing is pending", async () => {
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "access", "pending"]);
    } finally {
      logs.restore();
    }
    expect(logs.lines.join("\n")).toContain("No pending access requests.");
  });

  it("lists pending requests with the approve hint", async () => {
    await seedPending();
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "access", "pending"]);
    } finally {
      logs.restore();
    }
    const out = logs.lines.join("\n");
    expect(out).toContain("ou_alice");
    expect(out).toContain("Alice");
    expect(out).toContain("demo");
    expect(out).toContain("agent-bridge access approve <open-id>");
  });

  it("approves a pending user, inferring the single channel", async () => {
    await seedPending();
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "access", "approve", "ou_alice"]);
    } finally {
      logs.restore();
    }

    const state = (await loadAccessFile(authzPath)).channels["demo"]!;
    expect(state.pending["ou_alice"]).toBeUndefined();
    expect(state.users["ou_alice"]).toMatchObject({ grants: ["agent"], name: "Alice" });
    expect(logs.lines.join("\n")).toContain('Approved ou_alice on channel "demo"');
  });

  it("approves with --ssh granting both agent and ssh", async () => {
    await seedPending();
    const { runCli } = await import("./cli");
    await runCli(["node", "agent-bridge", "access", "approve", "ou_alice", "--ssh"]);

    const user = (await loadAccessFile(authzPath)).channels["demo"]!.users["ou_alice"]!;
    expect(user.grants).toEqual(["agent", "ssh"]);
  });

  it("pre-authorizes a known open id without a pending record", async () => {
    const { runCli } = await import("./cli");
    await runCli(["node", "agent-bridge", "access", "approve", "ou_boss"]);
    expect((await loadAccessFile(authzPath)).channels["demo"]!.users["ou_boss"]).toBeTruthy();
  });

  it("denies a pending user", async () => {
    await seedPending();
    const { runCli } = await import("./cli");
    await runCli(["node", "agent-bridge", "access", "deny", "ou_alice"]);

    const state = (await loadAccessFile(authzPath)).channels["demo"]!;
    expect(state.pending["ou_alice"]).toBeUndefined();
    expect(state.denied["ou_alice"]?.name).toBe("Alice");
  });

  it("revokes an authorized user and errors on a second revoke", async () => {
    const { runCli } = await import("./cli");
    await runCli(["node", "agent-bridge", "access", "approve", "ou_alice"]);
    await runCli(["node", "agent-bridge", "access", "revoke", "ou_alice"]);
    expect((await loadAccessFile(authzPath)).channels["demo"]!.users["ou_alice"]).toBeUndefined();

    await expect(
      runCli(["node", "agent-bridge", "access", "revoke", "ou_alice"]),
    ).rejects.toThrow('User ou_alice is not authorized on channel "demo".');
  });

  it("requires --channel when the user appears in multiple channels", async () => {
    await seedPending("ou_alice", "demo");
    await seedPending("ou_alice", "other");
    const { runCli } = await import("./cli");
    await expect(runCli(["node", "agent-bridge", "access", "approve", "ou_alice"])).rejects.toThrow(
      "Pass --channel",
    );

    await runCli(["node", "agent-bridge", "access", "approve", "ou_alice", "--channel", "other"]);
    const file = await loadAccessFile(authzPath);
    expect(file.channels["other"]!.users["ou_alice"]).toBeTruthy();
    expect(file.channels["demo"]!.pending["ou_alice"]).toBeTruthy();
  });

  it("lists authorized and denied users", async () => {
    const { runCli } = await import("./cli");
    await runCli(["node", "agent-bridge", "access", "approve", "ou_alice", "--ssh"]);
    await seedPending("ou_bob");
    await runCli(["node", "agent-bridge", "access", "deny", "ou_bob"]);

    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "access", "list"]);
    } finally {
      logs.restore();
    }
    const out = logs.lines.join("\n");
    expect(out).toContain("ou_alice");
    expect(out).toContain("agent,ssh");
    expect(out).toContain("Denied:");
    expect(out).toContain("ou_bob");
  });
});
