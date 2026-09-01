import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientOutputEvent, FeishuInboundMessage } from "../../../../types";
import { createLogger } from "../../../../core/logger";
import { createInMemoryImClientSessionStateStore } from "../../utils/client-session-state";
import { approveUser, loadAccessFile, updateAccessFile } from "../../access/access-store";
import { FeishuIMAdapter } from "./feishu-im-adapter";

type FakeClientInstance = {
  setOnMessage: (handler: (message: FeishuInboundMessage) => Promise<void> | void) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendText: (chatId: string, text: string, replyToMessageId?: string) => Promise<void>;
  sendCard: (
    chatId: string,
    card: Record<string, unknown>,
    replyToMessageId?: string,
  ) => Promise<string | null>;
  updateCard: (messageId: string, card: Record<string, unknown>) => Promise<void>;
  startTyping: (chatId: string, messageId: string) => Promise<void>;
  stopTyping: (chatId: string) => Promise<void>;
  sendAttachment: (chatId: string, attachment: unknown, replyToMessageId?: string) => Promise<void>;
};

const fakeClientState: {
  onMessage: ((message: FeishuInboundMessage) => Promise<void> | void) | null;
  sendText: ReturnType<typeof vi.fn>;
  sendCard: ReturnType<typeof vi.fn>;
  updateCard: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  startTyping: ReturnType<typeof vi.fn>;
  stopTyping: ReturnType<typeof vi.fn>;
  sendAttachment: ReturnType<typeof vi.fn>;
} = {
  onMessage: null,
  sendText: vi.fn(async () => {}),
  sendCard: vi.fn(async () => "card-1"),
  updateCard: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  startTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
  sendAttachment: vi.fn(async () => {}),
};

vi.mock("./feishu-client", () => ({
  FeishuClient: vi.fn().mockImplementation(
    (): FakeClientInstance => ({
      setOnMessage(handler) {
        fakeClientState.onMessage = handler;
      },
      connect: fakeClientState.connect,
      disconnect: fakeClientState.disconnect,
      sendText: fakeClientState.sendText,
      sendCard: fakeClientState.sendCard,
      updateCard: fakeClientState.updateCard,
      startTyping: fakeClientState.startTyping,
      stopTyping: fakeClientState.stopTyping,
      sendAttachment: fakeClientState.sendAttachment,
    }),
  ),
}));

const CHANNEL = { channelName: "feishu-access", language: "zh-CN" as const };

function inbound(senderId: string, text: string, messageId = "msg-1"): FeishuInboundMessage {
  return {
    chatId: "oc_dm",
    chatType: "p2p",
    messageId,
    text,
    senderId,
    senderName: "Alice",
  };
}

describe("FeishuIMAdapter access control", () => {
  let dir: string;
  let authzPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-feishu-access-"));
    authzPath = path.join(dir, "authz.json");
    process.env.AGENT_BRIDGE_AUTHZ_PATH = authzPath;
  });

  afterEach(async () => {
    delete process.env.AGENT_BRIDGE_AUTHZ_PATH;
    fakeClientState.onMessage = null;
    for (const fn of Object.values(fakeClientState)) {
      if (typeof fn === "function" && "mockReset" in fn) {
        (fn as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    fakeClientState.sendText.mockImplementation(async () => {});
    fakeClientState.sendCard.mockImplementation(async () => "card-1");
    fakeClientState.connect.mockImplementation(async () => {});
    fakeClientState.disconnect.mockImplementation(async () => {});
    await rm(dir, { recursive: true, force: true });
  });

  function makeAdapter(extra?: Record<string, unknown>, accessNoticePollMs = 3000) {
    return new FeishuIMAdapter(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        accessControl: { enabled: true },
        ...extra,
      } as never,
      createLogger("test"),
      CHANNEL,
      createInMemoryImClientSessionStateStore(),
      undefined,
      undefined,
      [],
      { accessNoticePollMs },
    );
  }

  async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("condition not met in time");
  }

  it("blocks an unknown user, records the pending request and replies with the approve command", async () => {
    const adapter = makeAdapter();
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});
    await adapter.start(onOutput);

    await fakeClientState.onMessage?.(inbound("ou_new", "hello"));

    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.startTyping).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "oc_dm",
      expect.stringContaining("agent-bridge access approve ou_new"),
      "msg-1",
    );

    const state = (await loadAccessFile(authzPath)).channels[CHANNEL.channelName]!;
    expect(state.pending["ou_new"]).toMatchObject({
      name: "Alice",
      chatId: "oc_dm",
      requestCount: 1,
    });
    await adapter.stop();
  });

  it("lets an approved user through without restarting the adapter", async () => {
    const adapter = makeAdapter();
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});
    await adapter.start(onOutput);

    await fakeClientState.onMessage?.(inbound("ou_new", "hello"));
    expect(onOutput).not.toHaveBeenCalled();

    await updateAccessFile(
      approveUser(CHANNEL.channelName, "ou_new", { grants: ["agent"] }),
      authzPath,
    );

    await fakeClientState.onMessage?.(inbound("ou_new", "hello again", "msg-2"));
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user.message", text: "hello again" }),
    );
    await adapter.stop();
  });

  it("requires the ssh grant on top of the chat allowlist for SSH mode", async () => {
    const adapter = makeAdapter({
      localControl: {
        enabled: true,
        allowedClientSessionIds: ["feishu:dm:oc_dm"],
        defaultWorkingDirectory: ".",
        allowedFileRoots: ["."],
      },
    });
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});
    await adapter.start(onOutput);

    // Agent grant only: chat allowlist passes, ssh grant missing.
    await updateAccessFile(
      approveUser(CHANNEL.channelName, "ou_new", { grants: ["agent"] }),
      authzPath,
    );
    await fakeClientState.onMessage?.(inbound("ou_new", "/ssh"));
    expect(fakeClientState.sendText).toHaveBeenLastCalledWith(
      "oc_dm",
      expect.stringContaining("access approve ou_new --ssh"),
      "msg-1",
    );

    // With the ssh grant the mode switch succeeds.
    await updateAccessFile(
      approveUser(CHANNEL.channelName, "ou_new", { grants: ["ssh"] }),
      authzPath,
    );
    await fakeClientState.onMessage?.(inbound("ou_new", "/ssh", "msg-2"));
    expect(fakeClientState.sendText).toHaveBeenLastCalledWith(
      "oc_dm",
      expect.stringContaining("SSH"),
      "msg-2",
    );
    await adapter.stop();
  });

  it("delivers the approval notice to the requesting chat after a CLI approval", async () => {
    const adapter = makeAdapter(undefined, 20);
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});
    await adapter.start(onOutput);

    await fakeClientState.onMessage?.(inbound("ou_new", "hello"));
    await updateAccessFile(
      approveUser(CHANNEL.channelName, "ou_new", { grants: ["agent"] }),
      authzPath,
    );

    await waitFor(() =>
      fakeClientState.sendText.mock.calls.some(([, text]) =>
        String(text).includes("已通过管理员授权"),
      ),
    );
    const noticeCalls = fakeClientState.sendText.mock.calls.filter(([, text]) =>
      String(text).includes("已通过管理员授权"),
    );
    expect(noticeCalls).toHaveLength(1);
    expect(noticeCalls[0]![0]).toBe("oc_dm");

    // Marked as notified: later ticks must not repeat the notice.
    fakeClientState.sendText.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      fakeClientState.sendText.mock.calls.some(([, text]) =>
        String(text).includes("已通过管理员授权"),
      ),
    ).toBe(false);
    await adapter.stop();
  });

  it("leaves the gate open when access control is disabled", async () => {
    const adapter = new FeishuIMAdapter(
      { appId: "cli_xxx", appSecret: "secret" },
      createLogger("test"),
      CHANNEL,
      createInMemoryImClientSessionStateStore(),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});
    await adapter.start(onOutput);

    await fakeClientState.onMessage?.(inbound("ou_stranger", "hello"));
    expect(onOutput).toHaveBeenCalledWith(expect.objectContaining({ type: "user.message" }));
    expect(await loadAccessFile(authzPath)).toEqual({ version: 1, channels: {} });
    await adapter.stop();
  });
});
