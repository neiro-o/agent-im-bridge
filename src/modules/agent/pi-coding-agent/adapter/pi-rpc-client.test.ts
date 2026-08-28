import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiRpcClient } from "./pi-rpc-client";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("./pi-extension-path", () => ({
  resolveMediaPromptExtensionPath: () => "/tmp/media-prompt.ts",
}));

import { spawn } from "node:child_process";

type FakeChild = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  stdin: {
    writable: boolean;
    write: (payload: string, cb?: (error?: Error | null) => void) => boolean;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createFakeChild(onCommand?: (command: Record<string, unknown>) => unknown): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    writable: true,
    write(payload: string, cb?: (error?: Error | null) => void) {
      const parsed = JSON.parse(payload) as Record<string, unknown> & { id?: string; type: string };
      const customData = onCommand?.(parsed);
      const response = {
        id: parsed.id,
        type: "response",
        command: parsed.type,
        success: true,
        data:
          customData ??
          (parsed.type === "get_state"
            ? { sessionId: "session-1", sessionName: "agent-1" }
            : {}),
      };
      setImmediate(() => {
        stdout.emit("data", Buffer.from(`${JSON.stringify(response)}\n`));
      });
      cb?.();
      return true;
    },
  };
  child.kill = vi.fn(() => true);
  return child;
}

describe("PiRpcClient", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(path.join(os.tmpdir(), "pi-rpc-test-"));
    vi.mocked(spawn).mockReset();
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("queries and updates the current thinking level", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const client = new PiRpcClient({ agentSessionId: "agent-1", piSessionId: "pi-agent-1", sessionDir });
    vi.mocked(spawn).mockReturnValue(
      createFakeChild((command) => {
        commands.push(command);
        if (command.type === "get_available_thinking_levels") {
          return { levels: ["off", "low", "medium", "high"] };
        }
        return undefined;
      }) as never,
    );

    await client.start();
    await expect(client.getAvailableThinkingLevels()).resolves.toEqual(["off", "low", "medium", "high"]);
    await client.setThinkingLevel("high");

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "get_available_thinking_levels" }),
        expect.objectContaining({ type: "set_thinking_level", level: "high" }),
      ]),
    );
  });

  it("rejects malformed thinking-level responses", async () => {
    const client = new PiRpcClient({ agentSessionId: "agent-1", piSessionId: "pi-agent-1", sessionDir });
    vi.mocked(spawn).mockReturnValue(
      createFakeChild((command) =>
        command.type === "get_available_thinking_levels" ? { levels: ["low", 42] } : undefined,
      ) as never,
    );

    await client.start();
    await expect(client.getAvailableThinkingLevels()).rejects.toThrow("Invalid thinking levels");
  });

  it("maps enhanced Pi control commands to their RPC protocol shapes", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const client = new PiRpcClient({ agentSessionId: "agent-1", piSessionId: "pi-agent-1", sessionDir });
    vi.mocked(spawn).mockReturnValue(
      createFakeChild((command) => {
        commands.push(command);
        switch (command.type) {
          case "get_commands": return { commands: [{ name: "review", source: "prompt", description: "Review" }] };
          case "get_fork_messages": return { messages: [{ entryId: "entry-1", text: "hello" }] };
          case "clone":
          case "fork":
          case "switch_session": return { cancelled: false };
          case "export_html": return { path: "/tmp/export.html" };
          case "get_last_assistant_text": return { text: "last" };
          case "cycle_model": return { model: { provider: "p", id: "m" }, thinkingLevel: "high" };
          case "cycle_thinking_level": return { level: "xhigh" };
          case "get_tree": return { tree: [], leafId: null };
          default: return undefined;
        }
      }) as never,
    );

    await client.start();
    await expect(client.getCommands()).resolves.toMatchObject([{ name: "review", source: "prompt" }]);
    await client.steer("now");
    await client.followUp("later");
    await expect(client.getForkMessages()).resolves.toEqual([{ entryId: "entry-1", text: "hello" }]);
    await expect(client.clone()).resolves.toEqual({ cancelled: false });
    await expect(client.fork("entry-1")).resolves.toMatchObject({ cancelled: false });
    await expect(client.switchSession("/tmp/session.jsonl")).resolves.toEqual({ cancelled: false });
    await expect(client.exportHtml()).resolves.toBe("/tmp/export.html");
    await expect(client.getLastAssistantText()).resolves.toBe("last");
    await client.setAutoCompaction(true);
    await client.setAutoRetry(false);
    await client.abortRetry();
    await expect(client.cycleModel()).resolves.toMatchObject({ model: { provider: "p", id: "m" } });
    await expect(client.cycleThinkingLevel()).resolves.toBe("xhigh");
    await expect(client.getTree()).resolves.toEqual({ tree: [], leafId: null });

    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "steer", message: "now" }),
      expect.objectContaining({ type: "follow_up", message: "later" }),
      expect.objectContaining({ type: "fork", entryId: "entry-1" }),
      expect.objectContaining({ type: "switch_session", sessionPath: "/tmp/session.jsonl" }),
      expect.objectContaining({ type: "set_auto_compaction", enabled: true }),
      expect.objectContaining({ type: "set_auto_retry", enabled: false }),
      expect.objectContaining({ type: "abort_retry" }),
    ]));
  });

  it("restores a provider session file with --session instead of --session-id", async () => {
    const sessionPath = path.join(sessionDir, "session.jsonl");
    const client = new PiRpcClient({
      agentSessionId: "agent-1",
      piSessionId: "pi-agent-1",
      sessionPath,
      sessionDir,
    });
    vi.mocked(spawn).mockReturnValue(createFakeChild() as never);

    await client.start();

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain("--session");
    expect(args).toContain(sessionPath);
    expect(args).not.toContain("--session-id");
  });

  it("spawns the pi process with the configured cwd", async () => {
    const cwd = "/tmp/normalized-workspace";
    const client = new PiRpcClient({
      agentSessionId: "agent-1",
      piSessionId: "pi-agent-1",
      cwd,
      sessionDir,
    });

    vi.mocked(spawn).mockReturnValue(createFakeChild() as never);
    await client.start();

    expect(spawn).toHaveBeenCalledWith(
      "pi",
      expect.any(Array),
      expect.objectContaining({ cwd }),
    );
  });
});
