import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FeishuClientConfig, FeishuInboundMessage, OutboundAttachment } from "../../../../types";
import { createLogger } from "../../../../core/logger";
import { FeishuClient } from "../adapter/feishu-client";

/**
 * Guided Feishu bot setup.
 *
 * Feishu does not expose OpenAPIs to create a custom app, configure its
 * scopes, or publish a version — those steps only exist in the developer
 * console UI (and version publish additionally needs a tenant admin review).
 * What a CLI CAN do, and this module does:
 *
 *   1. print the exact scope/event/capability checklist with console links
 *      and terminal QR codes (scan with a phone to open the console page);
 *   2. verify the app credentials by requesting a tenant_access_token;
 *   3. run a live probe over a temporary WebSocket connection that verifies
 *      each capability end to end (receive event, send message, reaction,
 *      attachment download, attachment upload) and reports per-scope status
 *      with the console fix link;
 *   4. capture the admin's open_id from the first probe message so the CLI
 *      can seed them as the first authorized user.
 */

// ---------------------------------------------------------------------------
// Permission checklist
// ---------------------------------------------------------------------------

export interface FeishuScopeRequirement {
  scope: string;
  /** Console display name (Chinese, as shown in the developer console). */
  consoleName: string;
  /** What breaks in the bridge without it. */
  purpose: string;
}

export const FEISHU_REQUIRED_SCOPES: readonly FeishuScopeRequirement[] = [
  {
    scope: "im:message",
    consoleName: "获取与发送单聊、群组消息",
    purpose: "receive/send messages, progress cards, typing reactions, the receive-message event",
  },
  {
    scope: "im:message:readonly",
    consoleName: "读取用户发送的消息内容(资源文件)",
    purpose: "download message attachments (SSH /upload)",
  },
  {
    scope: "im:resource",
    consoleName: "上传消息资源文件",
    purpose: "send files/images back to the chat (SSH /download, /export)",
  },
];

export interface FeishuConsoleStep {
  title: string;
  detail: string;
  /** Console path relative to the app page, when a stable deep link exists. */
  page?: "auth";
}

export const FEISHU_CONSOLE_STEPS: readonly FeishuConsoleStep[] = [
  {
    title: "Enable the bot capability (应用能力 → 机器人)",
    detail: "Add features → Bot (应用能力 → 添加应用能力 → 机器人).",
  },
  {
    title: "Subscribe to the receive-message event (事件订阅)",
    detail:
      "Event subscriptions → use the long-connection (WebSocket) mode, add event im.message.receive_v1 (接收消息). No public callback URL is needed.",
  },
  {
    title: "Publish a version (版本管理与发布)",
    detail:
      "Create a version, set the availability range to include yourself, and submit; a tenant admin approves it (test tenants can be review-free).",
  },
];

export function feishuConsoleBase(domain: FeishuClientConfig["domain"]): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

/** Create-app page (the console has no create-app API). */
export function feishuCreateAppUrl(domain: FeishuClientConfig["domain"]): string {
  return `${feishuConsoleBase(domain)}/app`;
}

/** App console page; `page: "auth"` deep-links the permission manager. */
export function feishuAppConsoleUrl(
  domain: FeishuClientConfig["domain"],
  appId: string,
  page?: "auth",
): string {
  const base = `${feishuConsoleBase(domain)}/app/${appId}`;
  return page === "auth" ? `${base}/auth` : base;
}

// ---------------------------------------------------------------------------
// Terminal QR (same renderer as the Weixin QR login)
// ---------------------------------------------------------------------------

export async function renderTerminalQr(data: string): Promise<boolean> {
  try {
    const mod = await import("qrcode-terminal");
    const api = (mod.default ?? mod) as {
      generate?: (value: string, opts?: { small?: boolean }) => void;
    };
    if (typeof api.generate !== "function") return false;
    api.generate(data, { small: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Credential verification
// ---------------------------------------------------------------------------

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ json: () => Promise<unknown> }>;

export interface CredentialCheckResult {
  ok: boolean;
  detail?: string;
}

/**
 * Verifies appId/appSecret by requesting a tenant_access_token. The token
 * itself is never returned or logged — only the success/failure outcome.
 */
export async function verifyFeishuCredentials(
  appId: string,
  appSecret: string,
  domain: FeishuClientConfig["domain"],
  fetchImpl: FetchLike = fetch,
): Promise<CredentialCheckResult> {
  const url = `${feishuConsoleBase(domain)}/open-apis/auth/v3/tenant_access_token/internal`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const body = (await response.json()) as { code?: number; msg?: string };
    if (body.code === 0) return { ok: true };
    return {
      ok: false,
      detail: `code=${body.code ?? "?"} msg=${body.msg ?? "unknown"} (check App ID / App Secret and that the app exists)`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Live capability probe
// ---------------------------------------------------------------------------

export type ProbeStatus = "ok" | "fail" | "skip";

export interface ProbeResult {
  key: "receive" | "send" | "reaction" | "download" | "upload";
  status: ProbeStatus;
  detail?: string;
}

export interface FeishuProbeReport {
  connected: boolean;
  admin?: { openId: string; name?: string; chatId: string };
  probes: ProbeResult[];
}

export interface SetupProbeClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  setOnMessage(handler: (message: FeishuInboundMessage) => Promise<void> | void): void;
  sendText(chatId: string, text: string, replyToMessageId?: string): Promise<void>;
  startTyping(chatId: string, messageId: string): Promise<void>;
  stopTyping(chatId: string): Promise<void>;
  sendAttachment(
    chatId: string,
    attachment: OutboundAttachment,
    replyToMessageId?: string,
  ): Promise<void>;
}

export interface FeishuProbeDeps {
  createClient: () => SetupProbeClient;
  /** Tells the human what to do next (printed to the terminal). */
  announce: (text: string) => void;
  /** Per-step wait budget for the human to act in Feishu (default 180s). */
  waitForHumanMs?: number;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the live probe. Receiving the first message already proves the bot
 * capability, the event subscription, the published version and the admin's
 * availability range; the follow-up probes then isolate each API scope.
 */
export async function runFeishuProbe(deps: FeishuProbeDeps): Promise<FeishuProbeReport> {
  const waitForHumanMs = deps.waitForHumanMs ?? 180_000;
  const probes: ProbeResult[] = [];
  const report: FeishuProbeReport = { connected: false, probes };
  const client = deps.createClient();

  const pending: FeishuInboundMessage[] = [];
  let waiter: ((message: FeishuInboundMessage) => void) | null = null;
  client.setOnMessage((message) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(message);
    } else {
      pending.push(message);
    }
  });

  const nextMessage = (timeoutMs: number): Promise<FeishuInboundMessage | null> => {
    const queued = pending.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiter = null;
        resolve(null);
      }, timeoutMs);
      waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  };

  const waitFor = async (
    predicate: (message: FeishuInboundMessage) => boolean,
    timeoutMs: number,
  ): Promise<FeishuInboundMessage | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const message = await nextMessage(remaining);
      if (message === null || predicate(message)) return message;
    }
  };

  const tempFiles: string[] = [];
  let tempDir: string | null = null;
  try {
    try {
      await client.connect();
      report.connected = true;
    } catch (error) {
      probes.push({ key: "receive", status: "fail", detail: `connect failed: ${detailOf(error)}` });
      return report;
    }

    deps.announce(
      "Now open Feishu and send ANY message to the bot (a DM works best). " +
        `Waiting up to ${Math.round(waitForHumanMs / 1000)}s…`,
    );
    const first = await waitFor(() => true, waitForHumanMs);
    if (!first) {
      probes.push({
        key: "receive",
        status: "fail",
        detail:
          "no message received — check: bot capability enabled, event im.message.receive_v1 subscribed in long-connection mode, version published and approved, and you are inside the availability range",
      });
      return report;
    }
    probes.push({ key: "receive", status: "ok" });
    report.admin = {
      openId: first.senderId ?? "",
      ...(first.senderName !== undefined ? { name: first.senderName } : {}),
      chatId: first.chatId,
    };

    try {
      await client.sendText(first.chatId, "✅ agent-bridge setup: message send works.", first.messageId);
      probes.push({ key: "send", status: "ok" });
    } catch (error) {
      probes.push({ key: "send", status: "fail", detail: detailOf(error) });
    }

    try {
      await client.startTyping(first.chatId, first.messageId);
      await client.stopTyping(first.chatId);
      probes.push({ key: "reaction", status: "ok" });
    } catch (error) {
      probes.push({ key: "reaction", status: "fail", detail: detailOf(error) });
    }

    deps.announce(
      "Send the bot one ATTACHMENT (any small file or image) to verify attachment download/upload…",
    );
    const withAttachment = await waitFor(
      (message) => (message.attachments?.length ?? 0) > 0,
      waitForHumanMs,
    );
    const attachment = withAttachment?.attachments?.[0];
    if (!withAttachment || !attachment) {
      probes.push({ key: "download", status: "skip", detail: "no attachment received in time" });
      probes.push({ key: "upload", status: "skip", detail: "no attachment received in time" });
      return report;
    }

    if (attachment.localPath) {
      probes.push({ key: "download", status: "ok" });
    } else {
      const downloadError = attachment.downloadError;
      probes.push({
        key: "download",
        status: "fail",
        detail:
          typeof downloadError === "string"
            ? downloadError
            : (downloadError?.message ?? "attachment download failed"),
      });
    }

    let uploadSource = attachment.localPath;
    if (!uploadSource) {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-setup-"));
      const probeFile = path.join(tempDir, "agent-bridge-probe.txt");
      await writeFile(probeFile, "agent-bridge setup probe\n", "utf8");
      tempFiles.push(probeFile);
      uploadSource = probeFile;
    }
    try {
      await client.sendAttachment(withAttachment.chatId, {
        kind: "file",
        filePath: uploadSource,
        fileName: path.basename(uploadSource),
      });
      probes.push({ key: "upload", status: "ok" });
    } catch (error) {
      probes.push({ key: "upload", status: "fail", detail: detailOf(error) });
    }
    return report;
  } finally {
    for (const file of tempFiles) {
      await unlink(file).catch(() => undefined);
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
}

/** Fix hint printed next to a failed probe entry. */
export function probeFixHint(result: ProbeResult, domain: FeishuClientConfig["domain"], appId: string): string | null {
  if (result.status !== "fail") return null;
  const authUrl = feishuAppConsoleUrl(domain, appId, "auth");
  switch (result.key) {
    case "receive":
      return `enable the bot capability, subscribe im.message.receive_v1 (long-connection) and publish a version: ${feishuAppConsoleUrl(domain, appId)}`;
    case "send":
    case "reaction":
      return `grant scope im:message (${FEISHU_REQUIRED_SCOPES[0]!.consoleName}): ${authUrl}`;
    case "download":
      return `grant scope im:message:readonly (${FEISHU_REQUIRED_SCOPES[1]!.consoleName}): ${authUrl}`;
    case "upload":
      return `grant scope im:resource (${FEISHU_REQUIRED_SCOPES[2]!.consoleName}): ${authUrl}`;
  }
}

// ---------------------------------------------------------------------------
// Default client factory
// ---------------------------------------------------------------------------

export function createDefaultProbeClient(config: {
  appId: string;
  appSecret: string;
  domain?: FeishuClientConfig["domain"];
}): SetupProbeClient {
  return new FeishuClient({ ...config }, createLogger("feishu-setup"));
}
