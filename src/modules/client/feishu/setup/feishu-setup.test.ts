import { describe, expect, it, vi } from "vitest";
import type { FeishuInboundMessage } from "../../../../types";
import {
  FEISHU_REQUIRED_SCOPES,
  feishuAppConsoleUrl,
  feishuConsoleBase,
  feishuCreateAppUrl,
  probeFixHint,
  runFeishuProbe,
  verifyFeishuCredentials,
  type SetupProbeClient,
} from "./feishu-setup";

describe("feishu-setup urls", () => {
  it("builds console urls for feishu and lark", () => {
    expect(feishuConsoleBase("feishu")).toBe("https://open.feishu.cn");
    expect(feishuConsoleBase("lark")).toBe("https://open.larksuite.com");
    expect(feishuConsoleBase(undefined)).toBe("https://open.feishu.cn");
    expect(feishuCreateAppUrl("feishu")).toBe("https://open.feishu.cn/app");
    expect(feishuAppConsoleUrl("feishu", "cli_x")).toBe("https://open.feishu.cn/app/cli_x");
    expect(feishuAppConsoleUrl("feishu", "cli_x", "auth")).toBe("https://open.feishu.cn/app/cli_x/auth");
  });

  it("requires the three scopes the bridge uses", () => {
    expect(FEISHU_REQUIRED_SCOPES.map((scope) => scope.scope)).toEqual([
      "im:message",
      "im:message:readonly",
      "im:resource",
    ]);
  });
});

describe("verifyFeishuCredentials", () => {
  it("reports ok on code 0 without exposing the token", async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ code: 0, tenant_access_token: "t-secret" }),
    }));
    const result = await verifyFeishuCredentials("cli_x", "secret", "feishu", fetchImpl);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("t-secret");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reports the platform error code on failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ code: 10003, msg: "invalid app_id" }),
    }));
    const result = await verifyFeishuCredentials("bad", "secret", "feishu", fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("10003");
  });

  it("reports network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await verifyFeishuCredentials("cli_x", "secret", "feishu", fetchImpl);
    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain("ECONNREFUSED");
  });
});

class FakeProbeClient implements SetupProbeClient {
  handler: ((message: FeishuInboundMessage) => Promise<void> | void) | null = null;
  failConnect = false;
  failSend = false;
  failReaction = false;
  failUpload = false;
  sentTexts: Array<{ chatId: string; text: string }> = [];
  sentAttachments: Array<{ chatId: string; filePath: string }> = [];
  reactions = 0;
  disconnected = false;

  async connect(): Promise<void> {
    if (this.failConnect) throw new Error("ws handshake failed");
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
  setOnMessage(handler: (message: FeishuInboundMessage) => Promise<void> | void): void {
    this.handler = handler;
  }
  async sendText(chatId: string, text: string): Promise<void> {
    if (this.failSend) throw new Error("code=99991672 no im:message scope");
    this.sentTexts.push({ chatId, text });
  }
  async startTyping(): Promise<void> {
    if (this.failReaction) throw new Error("reaction denied");
    this.reactions += 1;
  }
  async stopTyping(): Promise<void> {}
  async sendAttachment(chatId: string, attachment: { filePath: string }): Promise<void> {
    if (this.failUpload) throw new Error("code=99991672 no im:resource scope");
    this.sentAttachments.push({ chatId, filePath: attachment.filePath });
  }

  emit(message: FeishuInboundMessage): void {
    void this.handler?.(message);
  }
}

function textMessage(overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return {
    chatId: "oc_admin",
    chatType: "p2p",
    messageId: "msg_1",
    text: "hi",
    senderId: "ou_admin",
    senderName: "Admin",
    ...overrides,
  };
}

function attachmentMessage(overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return textMessage({
    messageId: "msg_2",
    attachments: [
      { kind: "file", fileKey: "f1", name: "a.txt", localPath: "C:\\tmp\\a.txt" },
    ],
    ...overrides,
  });
}

describe("runFeishuProbe", () => {
  it("runs the full happy path and captures the admin identity", async () => {
    const client = new FakeProbeClient();
    const announcements: string[] = [];
    const probePromise = runFeishuProbe({
      createClient: () => client,
      announce: (text) => announcements.push(text),
      waitForHumanMs: 1000,
    });
    client.emit(textMessage());
    client.emit(attachmentMessage());

    const report = await probePromise;
    expect(report.connected).toBe(true);
    expect(report.admin).toEqual({ openId: "ou_admin", name: "Admin", chatId: "oc_admin" });
    expect(report.probes).toEqual([
      { key: "receive", status: "ok" },
      { key: "send", status: "ok" },
      { key: "reaction", status: "ok" },
      { key: "download", status: "ok" },
      { key: "upload", status: "ok" },
    ]);
    // The received attachment is sent back for the upload probe.
    expect(client.sentAttachments[0]?.filePath).toBe("C:\\tmp\\a.txt");
    expect(client.disconnected).toBe(true);
    expect(announcements.length).toBeGreaterThanOrEqual(2);
  });

  it("fails fast when the websocket connect fails", async () => {
    const client = new FakeProbeClient();
    client.failConnect = true;
    const report = await runFeishuProbe({
      createClient: () => client,
      announce: () => {},
      waitForHumanMs: 50,
    });
    expect(report.connected).toBe(false);
    expect(report.probes).toEqual([
      { key: "receive", status: "fail", detail: expect.stringContaining("connect failed") },
    ]);
    expect(client.disconnected).toBe(true);
  });

  it("reports a receive failure with console guidance when no message arrives", async () => {
    const client = new FakeProbeClient();
    const report = await runFeishuProbe({
      createClient: () => client,
      announce: () => {},
      waitForHumanMs: 30,
    });
    expect(report.connected).toBe(true);
    expect(report.probes[0]).toMatchObject({ key: "receive", status: "fail" });
    expect(report.probes[0]!.detail).toContain("im.message.receive_v1");
    expect(client.disconnected).toBe(true);
  });

  it("isolates a failed scope without aborting the remaining probes", async () => {
    const client = new FakeProbeClient();
    client.failSend = true;
    const probePromise = runFeishuProbe({
      createClient: () => client,
      announce: () => {},
      waitForHumanMs: 1000,
    });
    client.emit(textMessage());
    client.emit(attachmentMessage());

    const report = await probePromise;
    expect(report.probes.find((probe) => probe.key === "send")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("99991672"),
    });
    expect(report.probes.find((probe) => probe.key === "upload")?.status).toBe("ok");
  });

  it("marks attachment probes as skipped when no attachment arrives", async () => {
    const client = new FakeProbeClient();
    const probePromise = runFeishuProbe({
      createClient: () => client,
      announce: () => {},
      waitForHumanMs: 40,
    });
    client.emit(textMessage());

    const report = await probePromise;
    expect(report.probes.find((probe) => probe.key === "download")?.status).toBe("skip");
    expect(report.probes.find((probe) => probe.key === "upload")?.status).toBe("skip");
  });

  it("falls back to a temp file for the upload probe when download failed", async () => {
    const client = new FakeProbeClient();
    const probePromise = runFeishuProbe({
      createClient: () => client,
      announce: () => {},
      waitForHumanMs: 1000,
    });
    client.emit(textMessage());
    client.emit(
      attachmentMessage({
        attachments: [
          {
            kind: "file",
            fileKey: "f1",
            name: "a.txt",
            downloadError: { code: 99991672, message: "no scope" },
          },
        ],
      }),
    );

    const report = await probePromise;
    expect(report.probes.find((probe) => probe.key === "download")).toMatchObject({
      status: "fail",
      detail: "no scope",
    });
    const upload = report.probes.find((probe) => probe.key === "upload");
    expect(upload?.status).toBe("ok");
    expect(client.sentAttachments[0]?.filePath).toContain("agent-bridge-probe.txt");
  });
});

describe("probeFixHint", () => {
  it("maps each failure to a console fix link", () => {
    expect(probeFixHint({ key: "send", status: "fail" }, "feishu", "cli_x")).toContain(
      "https://open.feishu.cn/app/cli_x/auth",
    );
    expect(probeFixHint({ key: "download", status: "fail" }, "feishu", "cli_x")).toContain(
      "im:message:readonly",
    );
    expect(probeFixHint({ key: "upload", status: "fail" }, "feishu", "cli_x")).toContain(
      "im:resource",
    );
    expect(probeFixHint({ key: "receive", status: "fail" }, "feishu", "cli_x")).toContain(
      "im.message.receive_v1",
    );
    expect(probeFixHint({ key: "send", status: "ok" }, "feishu", "cli_x")).toBeNull();
  });
});
