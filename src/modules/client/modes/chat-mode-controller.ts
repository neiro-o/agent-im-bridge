import type { InboundAttachment } from "../../../types";
import { FileTransferService } from "./file-transfer-service";
import { PathPolicy } from "./path-policy";
import { ShellCommandRunner } from "./shell-command-runner";

export type ChatMode = "agent" | "ssh";

export interface ChatModeControllerConfig {
  enabled: boolean;
  allowedClientSessionIds: string[];
  allowGroupChats: boolean;
  defaultWorkingDirectory: string;
  allowedFileRoots: string[];
  shellTimeoutMs: number;
  maxShellOutputBytes: number;
  maxTransferBytes: number;
  overwriteUploads: boolean;
  uploadSingleShot: boolean;
}

export interface LocalMessage {
  clientSessionId: string;
  chatType: "p2p" | "group";
  text: string;
  attachments?: InboundAttachment[];
}

export type LocalAction =
  | { type: "reply"; text: string }
  | { type: "forward" }
  | { type: "attachment"; filePath: string; fileName?: string; cleanup?: () => Promise<void> };

interface ChatState {
  mode: ChatMode;
  cwd?: string;
  uploadTarget?: string;
}

export interface ChatModeControllerOptions {
  config: ChatModeControllerConfig;
  loadWorkingDirectory?: (clientSessionId: string) => Promise<string | undefined>;
  saveWorkingDirectory?: (clientSessionId: string, cwd: string) => Promise<void>;
}

/** Per-chat state machine for the privileged, authorized local-control mode. */
export class ChatModeController {
  readonly #config: ChatModeControllerConfig;
  readonly #policy: PathPolicy;
  readonly #runner: ShellCommandRunner;
  readonly #transfer: FileTransferService;
  readonly #loadWorkingDirectory?: ChatModeControllerOptions["loadWorkingDirectory"];
  readonly #saveWorkingDirectory?: ChatModeControllerOptions["saveWorkingDirectory"];
  readonly #states = new Map<string, ChatState>();
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: ChatModeControllerOptions) {
    this.#config = options.config;
    this.#policy = new PathPolicy(options.config.allowedFileRoots);
    this.#runner = new ShellCommandRunner({
      timeoutMs: options.config.shellTimeoutMs,
      maxOutputBytes: options.config.maxShellOutputBytes,
      pathPolicy: this.#policy,
    });
    this.#transfer = new FileTransferService({
      pathPolicy: this.#policy,
      maxTransferBytes: options.config.maxTransferBytes,
    });
    this.#loadWorkingDirectory = options.loadWorkingDirectory;
    this.#saveWorkingDirectory = options.saveWorkingDirectory;
  }

  handle(message: LocalMessage): Promise<LocalAction[]> {
    const previous = this.#queues.get(message.clientSessionId) ?? Promise.resolve();
    const current = previous.then(() => this.#handle(message), () => this.#handle(message));
    this.#queues.set(message.clientSessionId, current);
    return current.finally(() => {
      if (this.#queues.get(message.clientSessionId) === current) {
        this.#queues.delete(message.clientSessionId);
      }
    });
  }

  async stop(): Promise<void> {
    await this.#runner.stop();
    await Promise.allSettled(this.#queues.values());
    this.#states.clear();
    this.#queues.clear();
  }

  async #handle(message: LocalMessage): Promise<LocalAction[]> {
    const text = message.text.trim();
    const state = this.#states.get(message.clientSessionId) ?? { mode: "agent" as const };
    this.#states.set(message.clientSessionId, state);

    if (/^\/agent$/i.test(text)) {
      state.mode = "agent";
      state.uploadTarget = undefined;
      return [{ type: "reply", text: "已切换到 Agent 模式。" }];
    }

    if (/^\/ssh$/i.test(text)) {
      if (!this.#isAuthorized(message)) {
        return [{ type: "reply", text: "当前聊天未获授权使用 SSH 模式。" }];
      }
      const remembered = state.cwd ?? await this.#loadWorkingDirectory?.(message.clientSessionId);
      state.cwd = await this.#policy.resolveDirectory(
        remembered ?? this.#config.defaultWorkingDirectory,
        process.cwd(),
      );
      state.mode = "ssh";
      state.uploadTarget = undefined;
      await this.#saveWorkingDirectory?.(message.clientSessionId, state.cwd);
      return [{
        type: "reply",
        text: `已切换到 SSH 模式。\n当前目录：${state.cwd}\n\n输入 Shell 命令执行；可使用：\n- /upload\n- /upload-cancel\n- /download <路径、目录或通配符>\n- /agent`,
      }];
    }

    if (state.mode !== "ssh") {
      return [{ type: "forward" }];
    }

    if (/^\/(effort|thinking)(?:\s|$)/i.test(text) || /^\/(help|status|st|model|m|new|n|compact|c)$/i.test(text)) {
      return [{ type: "forward" }];
    }

    if (/^\/upload$/i.test(text)) {
      state.uploadTarget = await this.#policy.resolveDirectory(".", state.cwd!);
      return [{ type: "reply", text: `请发送文件，文件将保存到：${state.uploadTarget}\n发送 /upload-cancel 取消。` }];
    }

    if (/^\/upload-cancel$/i.test(text)) {
      state.uploadTarget = undefined;
      return [{ type: "reply", text: "已取消上传。" }];
    }

    const download = /^\/download(?:\s+(.*))?$/i.exec(text);
    if (download) {
      const expression = download[1]?.trim();
      if (!expression) return [{ type: "reply", text: "用法：/download <路径、目录或通配符>" }];
      const plan = await this.#transfer.prepareDownload(expression, state.cwd!);
      if (plan.directFile) {
        return [{ type: "attachment", filePath: plan.directFile }];
      }
      if (plan.archive) {
        return [{
          type: "attachment",
          filePath: plan.archive.path,
          fileName: plan.archive.displayName,
          cleanup: plan.archive.cleanup,
        }];
      }
      return [{ type: "reply", text: `没有可发送的文件。${plan.skipped.length ? ` 已跳过 ${plan.skipped.length} 项。` : ""}` }];
    }

    if ((message.attachments?.length ?? 0) > 0) {
      if (!state.uploadTarget) {
        return [{ type: "reply", text: "请先发送 /upload，再发送附件。" }];
      }
      const failed = message.attachments!.filter((attachment) => attachment.downloadError);
      if (failed.length > 0) {
        return [{ type: "reply", text: failed.map((attachment) => attachment.downloadError!.message).join("\n") }];
      }
      const saved = await this.#transfer.saveInboundAttachments(message.attachments!, state.uploadTarget);
      if (this.#config.uploadSingleShot) state.uploadTarget = undefined;
      return [{
        type: "reply",
        text: `上传完成：\n${saved.map((item) => `- ${item.sourceName} → ${item.path}`).join("\n")}`,
      }];
    }

    if (!text) return [{ type: "reply", text: "请输入 Shell 命令。" }];
    const result = await this.#runner.run(message.text, state.cwd!);
    if (result.cwd !== state.cwd) {
      state.cwd = result.cwd;
      await this.#saveWorkingDirectory?.(message.clientSessionId, result.cwd);
    }
    const parts = [`exit ${result.exitCode ?? result.signal ?? "unknown"}`];
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    if (result.timedOut) parts.push("命令执行超时。已终止进程。");
    if (result.truncated) parts.push("输出超过限制，已截断。");
    parts.push(`当前目录：${state.cwd}`);
    return [{ type: "reply", text: parts.join("\n\n") }];
  }

  #isAuthorized(message: LocalMessage): boolean {
    return this.#config.enabled &&
      this.#config.allowedClientSessionIds.includes(message.clientSessionId) &&
      (message.chatType !== "group" || this.#config.allowGroupChats);
  }
}

export function normalizeChatModeConfig(config: Partial<ChatModeControllerConfig>): ChatModeControllerConfig {
  return {
    enabled: config.enabled ?? false,
    allowedClientSessionIds: config.allowedClientSessionIds ?? [],
    allowGroupChats: config.allowGroupChats ?? false,
    defaultWorkingDirectory: config.defaultWorkingDirectory ?? process.cwd(),
    allowedFileRoots: config.allowedFileRoots ?? [],
    shellTimeoutMs: config.shellTimeoutMs ?? 120_000,
    maxShellOutputBytes: config.maxShellOutputBytes ?? 64 * 1024,
    maxTransferBytes: config.maxTransferBytes ?? 100 * 1024 * 1024,
    overwriteUploads: config.overwriteUploads ?? false,
    uploadSingleShot: config.uploadSingleShot ?? false,
  };
}
