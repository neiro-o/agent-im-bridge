import { randomUUID } from "node:crypto";
import { open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentAdapter,
  AgentAvailableModel,
  AgentCommandContext,
  AgentCommandDescriptor,
  AgentCommandInvocation,
  AgentCommandProvider,
  AgentCommandResult,
  AgentInputEvent,
  AgentOutputEvent,
  AgentSessionStatus,
  AgentSessionStateApi,
  NewAgentSessionStateApi,
  OutboundAttachment,
  LocaleCode,
} from "../../../../types";
import { createLogger, type Logger } from "../../../../core/logger";
import { extractMediaMarkers } from "../../media-convention";
import { PiRpcClient, type PiSessionTreeNode } from "./pi-rpc-client";
import { getPiCommandManifest } from "../commands/pi-command-manifest";
import { toPiSessionId } from "./pi-session-id";
import { resolveWorkingDirectory } from "../working-directory";
import type { PiCodingAgentSessionStateV1 } from "../index";

class PiModelCommandError extends Error {
  readonly kind: "agent.model.invalid" | "agent.model.set.unavailable";

  constructor(kind: "agent.model.invalid" | "agent.model.set.unavailable", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface PiCodingAgentAdapterOptions {
  agentSessionId: string;
  /**
   * Lifecycle phase. `create` initializes the reserved handle with the
   * resolved working directory; `resume` reads, re-validates and rewrites the
   * opened handle. The module passes the phase and the matching handle kind.
   */
  mode: "create" | "resume";
  /** Session-scoped state handle injected by the gateway (reserved in create, opened in resume). */
  sessionState:
    | NewAgentSessionStateApi<PiCodingAgentSessionStateV1>
    | AgentSessionStateApi<PiCodingAgentSessionStateV1>;
  /**
   * Raw user-requested working directory for a brand-new session. Absent (or
   * empty) only for implicitly created sessions (first user message): a `/new`
   * command always carries a concrete directory resolved by the client side.
   */
  workingDirectory?: string;
  /**
   * Trust classification of `workingDirectory` as decided by the client
   * adapter. When absent it is derived from whether a directory was supplied
   * (legacy behavior for direct constructor callers).
   */
  workingDirectorySource?: "user" | "default";
  /**
   * Optional allowlist of allowed working-directory roots. Enforced for
   * user-supplied directories only (`workingDirectorySource === "user"`); a
   * bare `/new` default is never checked.
   */
  allowedWorkingDirectoryRoots?: string[];
  sessionDir?: string;
  bin?: string;
  model?: string;
  extraArgs?: string[];
  language?: LocaleCode;
  logger?: Logger;
}

export class PiCodingAgentAdapter implements AgentAdapter {
  readonly #agentSessionId: string;
  readonly #piSessionId: string;
  readonly #handle:
    | { mode: "create"; sessionState: NewAgentSessionStateApi<PiCodingAgentSessionStateV1> }
    | { mode: "resume"; sessionState: AgentSessionStateApi<PiCodingAgentSessionStateV1> };
  readonly #sessionDir?: string;
  readonly #bin: string;
  readonly #model?: string;
  readonly #extraArgs: string[];
  readonly #workingDirectory?: string;
  readonly #workingDirectorySource?: "user" | "default";
  readonly #allowedWorkingDirectoryRoots?: string[];
  readonly #language: LocaleCode;
  readonly #logger: Logger;
  #currentWorkingDirectory = process.cwd();
  #client: PiRpcClient | null = null;
  #onOutput: ((event: AgentOutputEvent) => Promise<void> | void) | null = null;
  #activeRun = false;
  #toolLabelByCallId = new Map<string, string>();
  #toolInputByCallId = new Map<string, unknown>();

  constructor(options: PiCodingAgentAdapterOptions) {
    this.#agentSessionId = options.agentSessionId;
    this.#piSessionId = toPiSessionId(options.agentSessionId);
    // The module guarantees the pairing: a reserved handle in create mode, an
    // opened handle in resume mode. The branch narrows the union for the rest
    // of the class while keeping the handle truly scoped.
    this.#handle =
      options.mode === "create"
        ? {
            mode: "create",
            sessionState: options.sessionState as NewAgentSessionStateApi<PiCodingAgentSessionStateV1>,
          }
        : {
            mode: "resume",
            sessionState: options.sessionState as AgentSessionStateApi<PiCodingAgentSessionStateV1>,
          };
    this.#workingDirectory = options.workingDirectory;
    this.#workingDirectorySource = options.workingDirectorySource;
    this.#allowedWorkingDirectoryRoots = options.allowedWorkingDirectoryRoots;
    this.#sessionDir = options.sessionDir;
    this.#bin = options.bin ?? "pi";
    this.#model = options.model;
    this.#extraArgs = options.extraArgs ?? [];
    this.#language = options.language ?? "en-US";
    this.#logger = options.logger ?? createLogger("pi-coding-agent");
  }

  async start(onOutput: (event: AgentOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;

    // Resolve and persist the session working directory before anything can
    // spawn: creation failures (missing/invalid/unallowed path, revoke) must
    // never reach the process spawn step.
    const cwd = await this.#prepareWorkingDirectory();
    this.#currentWorkingDirectory = cwd;
    const persistedState = await this.#handle.sessionState.read();

    this.#client = new PiRpcClient({
      agentSessionId: this.#agentSessionId,
      piSessionId: persistedState.providerSessionId ?? this.#piSessionId,
      sessionPath: persistedState.providerSessionFile,
      cwd,
      sessionDir: this.#sessionDir,
      bin: this.#bin,
      model: this.#model,
      extraArgs: this.#extraArgs,
      logger: this.#logger,
    });
    this.#client.onEvent((rpcEvent) => {
      void this.#handleRpcEvent(rpcEvent);
      if (rpcEvent.type === "extension_error") {
        this.#logger.error(`extension_error for ${this.#agentSessionId}:`, rpcEvent);
      }
    });
    this.#logger.info(`starting agent instance (bin=${this.#bin} cwd=${cwd})`);
    await this.#client.start();
    await this.#syncProviderSessionState();
    this.#logger.info(`session ${this.#agentSessionId} started (piSessionId=${this.#piSessionId})`);
  }

  /**
   * Resolves the canonical working directory and persists the session state
   * before the Pi process is spawned.
   *
   * Create mode: canonicalizes the requested path (or the default cwd for a
   * bare `/new`), enforces the user-path allowlist, then initializes the
   * persisted record with the canonical directory and its source.
   *
   * Resume mode: reads the persisted directory, re-validates it (the user-path
   * allowlist is enforced only for user-supplied directories), and rewrites
   * legacy binding-migrated records or drifted canonical paths into the
   * canonical V1 shape.
   */
  async #prepareWorkingDirectory(): Promise<string> {
    if (this.#handle.mode === "create") {
      const { sessionState } = this.#handle;
      const requested = this.#workingDirectory;
      const source: "user" | "default" =
        this.#workingDirectorySource ??
        (requested !== undefined && requested.trim() !== "" ? "user" : "default");

      if (source === "user") {
        if (requested === undefined || requested.trim() === "") {
          throw new Error('working directory source "user" requires a non-empty workingDirectory');
        }
        // resolveWorkingDirectory already canonicalizes with realpath and
        // enforces the allowlist on that canonical result. Re-resolving the
        // returned path would reopen a TOCTOU window: a swapped symlink could
        // yield a different, un-checked path that gets persisted and spawned.
        // Persist and spawn the checked result directly.
        const canonical = await resolveWorkingDirectory(requested, {
          allowedWorkingDirectoryRoots: this.#allowedWorkingDirectoryRoots,
        });
        await sessionState.initialize({
          version: 1,
          workingDirectory: canonical,
          workingDirectorySource: "user",
        });
        return canonical;
      }

      // Default directory: either the client-side fallback path (trusted, so
      // never allowlist-checked) or the process cwd for implicitly created
      // sessions. The helper already canonicalizes a supplied path with
      // realpath; the extra realpath keeps the bare-cwd result stable across
      // restarts even when the process cwd is a symlinked path.
      const resolved = await resolveWorkingDirectory(requested, {});
      const canonical = await realpath(resolved);
      await sessionState.initialize({
        version: 1,
        workingDirectory: canonical,
        workingDirectorySource: "default",
      });
      return canonical;
    }

    const { sessionState } = this.#handle;
    const state = await sessionState.read();
    const roots =
      state.workingDirectorySource === "user" ? this.#allowedWorkingDirectoryRoots : undefined;
    const canonical = await resolveWorkingDirectory(state.workingDirectory, {
      allowedWorkingDirectoryRoots: roots,
    });
    if (state.migratedFromBinding || state.workingDirectory !== canonical) {
      await sessionState.update((current) => ({
        ...current,
        version: 1,
        workingDirectory: canonical,
        workingDirectorySource: current.workingDirectorySource,
      }));
    }
    return canonical;
  }

  async stop(): Promise<void> {
    this.#toolLabelByCallId.clear();
    this.#toolInputByCallId.clear();
    await this.#client?.stop();
    this.#client = null;
    this.#activeRun = false;
    this.#onOutput = null;
    this.#logger.info(`session ${this.#agentSessionId} stopped`);
  }

  async abort(): Promise<void> {
    // T1: idle-abort is a no-op; the core may call abort unconditionally.
    if (!this.#activeRun) {
      return;
    }
    this.#logger.info(`aborting agent turn (session=${this.#agentSessionId})`);
    await this.#client?.abort();
  }

  async input(event: AgentInputEvent): Promise<void> {
    if (!this.#client || !this.#onOutput) {
      throw new Error("PiCodingAgentAdapter is not started");
    }

    await this.#processEvent(event);
  }

  getCommandProvider(): AgentCommandProvider {
    return {
      listCommands: () => this.#commandManifest(),
      executeCommand: (invocation, context) => this.#executeAgentCommand(invocation, context),
    };
  }

  async getStatus(): Promise<AgentSessionStatus> {
    if (!this.#client) {
      throw new Error("PiCodingAgentAdapter is not started");
    }

    const [state, stats] = await Promise.all([this.#client.getState(), this.#client.getSessionStats()]);
    const contextUsage = stats.contextUsage;

    return {
      sessionId: state.sessionId ?? this.#agentSessionId,
      provider: state.model?.provider,
      modelId: state.model?.id,
      thinkingLevel: state.thinkingLevel,
      context: contextUsage
        ? {
            tokens: contextUsage.tokens ?? null,
            contextWindow: contextUsage.contextWindow ?? null,
            percent: contextUsage.percent ?? null,
          }
        : undefined,
    };
  }

  async getAvailableModels(): Promise<AgentAvailableModel[]> {
    if (!this.#client) {
      throw new Error("PiCodingAgentAdapter is not started");
    }

    const [state, models] = await Promise.all([this.#client.getState(), this.#client.getAvailableModels()]);
    return models
      .filter((model): model is { provider: string; id: string } => typeof model.provider === "string" && typeof model.id === "string")
      .map((model) => ({
        provider: model.provider,
        modelId: model.id,
        isCurrent: state.model?.provider === model.provider && state.model?.id === model.id,
      }));
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (!this.#client) {
      throw new Error("PiCodingAgentAdapter is not started");
    }
    await this.#client.setThinkingLevel(level);
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    if (!this.#client) {
      throw new Error("PiCodingAgentAdapter is not started");
    }
    return this.#client.getAvailableThinkingLevels();
  }

  async setModel(target: string): Promise<{ provider: string; modelId: string }> {
    if (!this.#client) {
      throw new PiModelCommandError("agent.model.set.unavailable", "PiCodingAgentAdapter is not started");
    }

    const parsed = this.#parseModelTarget(target);
    // T1: no busy precheck — pi's own RPC answers mid-run switches (its
    // `set_model` has no busy gate) and errors are mapped below as today.
    try {
      const result = await this.#client.setModel(parsed.provider, parsed.modelId);
      return {
        provider: result.provider ?? parsed.provider,
        modelId: result.id ?? parsed.modelId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Model not found:/i.test(message)) {
        throw new PiModelCommandError("agent.model.invalid", message);
      }
      throw new PiModelCommandError("agent.model.set.unavailable", message);
    }
  }

  #parseModelTarget(target: string): { provider: string; modelId: string } {
    const trimmed = target.trim();
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
      throw new PiModelCommandError("agent.model.invalid", `Invalid model target: ${target}`);
    }

    const provider = trimmed.slice(0, slashIndex).trim();
    const modelId = trimmed.slice(slashIndex + 1).trim();
    if (!provider || !modelId) {
      throw new PiModelCommandError("agent.model.invalid", `Invalid model target: ${target}`);
    }

    return { provider, modelId };
  }

  #commandManifest(): AgentCommandDescriptor[] {
    return getPiCommandManifest({ channelName: "", language: this.#language });
  }

  async #executeAgentCommand(
    invocation: AgentCommandInvocation,
    _context: AgentCommandContext,
  ): Promise<AgentCommandResult> {
    const client = this.#client;
    if (!client) throw new Error("PiCodingAgentAdapter is not started");
    const name = invocation.name === "fu" ? "follow-up" : invocation.name;
    const args = invocation.rawArgs.trim();

    switch (name) {
      case "session": {
        const [state, stats] = await Promise.all([client.getState(), client.getSessionStats()]);
        const rows: Array<[string, unknown]> = [
          [this.#l("Name", "名称"), state.sessionName],
          ["Session ID", state.sessionId],
          [this.#l("Session file", "会话文件"), state.sessionFile ?? stats.sessionFile],
          [this.#l("Model", "模型"), state.model?.provider && state.model.id ? `${state.model.provider}/${state.model.id}` : undefined],
          [this.#l("Thinking", "思考等级"), state.thinkingLevel],
          [this.#l("Messages", "消息数"), stats.totalMessages ?? state.messageCount],
          [this.#l("Pending", "待处理消息"), state.pendingMessageCount],
          [this.#l("Tokens", "Token"), stats.tokens?.total],
          [this.#l("Input / output", "输入 / 输出"), stats.tokens ? `${stats.tokens.input ?? 0} / ${stats.tokens.output ?? 0}` : undefined],
          [this.#l("Cache read / write", "缓存读取 / 写入"), stats.tokens ? `${stats.tokens.cacheRead ?? 0} / ${stats.tokens.cacheWrite ?? 0}` : undefined],
          [this.#l("Cost", "费用"), typeof stats.cost === "number" ? `$${stats.cost.toFixed(6)}` : undefined],
          [this.#l("Context", "上下文"), stats.contextUsage ? `${stats.contextUsage.tokens ?? "?"} / ${stats.contextUsage.contextWindow ?? "?"} (${stats.contextUsage.percent ?? "?"}%)` : undefined],
          [this.#l("Auto compaction", "自动压缩"), state.autoCompactionEnabled],
          [this.#l("Queue modes", "队列模式"), `${state.steeringMode ?? "?"} / ${state.followUpMode ?? "?"}`],
        ];
        return this.#message(this.#renderKeyValueTable(this.#l("Pi session", "Pi 会话"), rows));
      }
      case "name": {
        if (!args) return this.#usage("/name <name>");
        if (args === "-") return this.#message(this.#l("Pi does not support clearing a session name.", "Pi 当前不支持清空会话名称。"));
        if (args.length > 200 || /[ -]/.test(args)) {
          return this.#message(this.#l("Session names must be 1–200 characters without control characters.", "会话名称须为 1–200 个字符，且不能包含控制字符。"));
        }
        await client.setSessionName(args);
        return this.#message(this.#l(`Session renamed to **${this.#escape(args)}**.`, `会话已重命名为 **${this.#escape(args)}**。`));
      }
      case "commands": {
        const dynamic = await client.getCommands();
        const lines = [
          `## ${this.#l("Pi control commands", "Pi 控制命令")}`,
          "",
          ...this.#commandManifest().map((command) => `- \`/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}\` — ${command.description}`),
        ];
        for (const source of ["extension", "prompt", "skill"] as const) {
          const entries = dynamic.filter((command) => command.source === source);
          if (!entries.length) continue;
          lines.push("", `## ${source === "extension" ? "Extensions" : source === "prompt" ? "Prompt templates" : "Skills"}`, "");
          lines.push(...entries.map((command) => `- \`/${command.name}\`${command.description ? ` — ${command.description}` : ""}`));
        }
        return this.#message(lines.join("\n"));
      }
      case "steer":
      case "follow-up": {
        if (!args) return this.#usage(`/${name} <message>`);
        if (!this.#activeRun) {
          return this.#message(this.#l("This command requires an active Pi run.", "此命令需要当前存在正在运行的 Pi 任务。"));
        }
        if (name === "steer") await client.steer(args);
        else await client.followUp(args);
        return this.#message(name === "steer"
          ? this.#l("Steering message queued.", "Steer 消息已入队。")
          : this.#l("Follow-up message queued.", "Follow-up 消息已入队。"));
      }
      case "clone": {
        if (this.#activeRun) return this.#busySessionSwitchMessage();
        const result = await client.clone();
        if (result.cancelled) return this.#message(this.#l("Clone cancelled.", "克隆已取消。"));
        const state = await this.#syncProviderSessionState(true);
        return this.#message(this.#l(`Cloned to Pi session \`${state.sessionId ?? "unknown"}\`.`, `已克隆到 Pi 会话 \`${state.sessionId ?? "unknown"}\`。`));
      }
      case "fork": {
        if (!args) {
          const messages = await client.getForkMessages();
          if (!messages.length) return this.#message(this.#l("No fork points are available.", "当前没有可用的分叉节点。"));
          const lines = messages.slice(-20).reverse().map((item, index) => `${index + 1}. \`${item.entryId}\` ${this.#shorten(item.text.replace(/\s+/g, " "), 100)}`);
          return this.#message([`## ${this.#l("Fork points", "可分叉节点")}`, "", ...lines, "", this.#l("Use `/fork <entry-id>`.", "使用 `/fork <entry-id>` 执行分叉。")].join("\n"));
        }
        if (this.#activeRun) return this.#busySessionSwitchMessage();
        const result = await client.fork(args);
        if (result.cancelled) return this.#message(this.#l("Fork cancelled.", "分叉已取消。"));
        const state = await this.#syncProviderSessionState(true);
        return this.#message(this.#l(`Forked to Pi session \`${state.sessionId ?? "unknown"}\`.`, `已分叉到 Pi 会话 \`${state.sessionId ?? "unknown"}\`。`));
      }
      case "resume": {
        if (!args) return this.#message(await this.#renderResumeList());
        if (this.#activeRun) return this.#busySessionSwitchMessage();
        const sessionPath = await this.#resolveSessionSelection(args);
        const selectedHeader = await this.#readSessionHeader(sessionPath);
        const result = await client.switchSession(sessionPath);
        if (result.cancelled) return this.#message(this.#l("Session switch cancelled.", "会话切换已取消。"));
        this.#currentWorkingDirectory = await realpath(selectedHeader.cwd);
        await this.#handle.sessionState.update((current) => ({
          ...current,
          version: 1,
          workingDirectory: this.#currentWorkingDirectory,
          workingDirectorySource: "user",
        }));
        const state = await this.#syncProviderSessionState(true);
        return this.#message(this.#l(`Resumed Pi session \`${state.sessionId ?? "unknown"}\`.`, `已恢复 Pi 会话 \`${state.sessionId ?? "unknown"}\`。`));
      }
      case "export": {
        const temporary = !args;
        let outputPath: string;
        if (temporary) {
          outputPath = path.join(tmpdir(), `agent-bridge-pi-export-${randomUUID()}.html`);
        } else {
          outputPath = await this.#resolveWritablePath(args);
        }
        try {
          const exported = await client.exportHtml(outputPath);
          return {
            handled: true,
            messages: [{
              text: this.#l("Pi session exported.", "Pi 会话已导出。"),
              attachments: [{ kind: "file", filePath: exported, fileName: path.basename(exported), cleanupAfterSend: temporary }],
            }],
          };
        } catch (error) {
          if (temporary) await rm(outputPath, { force: true });
          throw error;
        }
      }
      case "last": {
        if (args && args !== "file") return this.#usage("/last [file]");
        const text = await client.getLastAssistantText();
        if (!text) return this.#message(this.#l("There is no assistant message yet.", "当前还没有助手消息。"));
        if (!args) return this.#message(text);
        const filePath = path.join(tmpdir(), `agent-bridge-pi-last-${randomUUID()}.txt`);
        await writeFile(filePath, text, "utf8");
        return {
          handled: true,
          messages: [{
            text: this.#l("Last assistant message attached.", "最后一条助手消息已作为附件发送。"),
            attachments: [{ kind: "file", filePath, fileName: path.basename(filePath), cleanupAfterSend: true }],
          }],
        };
      }
      case "auto-compact": {
        if (!args) {
          const state = await client.getState();
          return this.#message(this.#l(`Auto compaction: **${state.autoCompactionEnabled ? "on" : "off"}**.`, `自动压缩：**${state.autoCompactionEnabled ? "开启" : "关闭"}**。`));
        }
        const enabled = this.#parseOnOff(args);
        if (enabled === null) return this.#usage("/auto-compact [on|off]");
        await client.setAutoCompaction(enabled);
        return this.#message(this.#l(`Auto compaction turned **${enabled ? "on" : "off"}**.`, `自动压缩已**${enabled ? "开启" : "关闭"}**。`));
      }
      case "retry": {
        const enabled = this.#parseOnOff(args);
        if (enabled === null) return this.#usage("/retry <on|off>");
        await client.setAutoRetry(enabled);
        return this.#message(this.#l(`Automatic retry turned **${enabled ? "on" : "off"}**.`, `自动重试已**${enabled ? "开启" : "关闭"}**。`));
      }
      case "retry-stop":
        await client.abortRetry();
        return this.#message(this.#l("Automatic retry wait aborted.", "已终止自动重试等待。"));
      case "model-next": {
        const result = await client.cycleModel();
        if (!result) return this.#message(this.#l("No alternate Pi model is available.", "没有可切换的其他 Pi 模型。"));
        return this.#message(this.#l(`Model: \`${result.model.provider}/${result.model.id}\`${result.thinkingLevel ? ` · thinking: \`${result.thinkingLevel}\`` : ""}.`, `模型：\`${result.model.provider}/${result.model.id}\`${result.thinkingLevel ? ` · 思考等级：\`${result.thinkingLevel}\`` : ""}。`));
      }
      case "thinking-next": {
        const level = await client.cycleThinkingLevel();
        return this.#message(level
          ? this.#l(`Thinking level: \`${level}\`.`, `思考等级：\`${level}\`。`)
          : this.#l("The current model has no alternate thinking level.", "当前模型没有可切换的思考等级。"));
      }
      case "tree": {
        const page = args ? Number(args) : 1;
        if (!Number.isInteger(page) || page < 1) return this.#usage("/tree [page]");
        const result = await client.getTree();
        return this.#message(this.#renderTree(result.tree, result.leafId, page));
      }
      default:
        return { handled: false };
    }
  }

  #message(text: string): AgentCommandResult {
    return { handled: true, messages: [{ text }] };
  }

  #usage(syntax: string): AgentCommandResult {
    return this.#message(this.#l(`Usage: \`${syntax}\``, `用法：\`${syntax}\``));
  }

  #busySessionSwitchMessage(): AgentCommandResult {
    return this.#message(this.#l("The current Pi run is busy. Use `/stop` before switching sessions.", "当前 Pi 任务正在运行。切换会话前请先使用 `/stop`。"));
  }

  #l(en: string, zh: string): string {
    return this.#language === "zh-CN" ? zh : en;
  }

  #escape(value: string): string {
    return value.replace(/[\\`*_{}\[\]()#+.!|>-]/g, "\\$&");
  }

  #shorten(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
  }

  #parseOnOff(value: string): boolean | null {
    if (value.toLowerCase() === "on") return true;
    if (value.toLowerCase() === "off") return false;
    return null;
  }

  #renderKeyValueTable(title: string, rows: Array<[string, unknown]>): string {
    const visible = rows.filter(([, value]) => value !== undefined && value !== null);
    return [
      `## ${title}`,
      "",
      `| ${this.#l("Field", "字段")} | ${this.#l("Value", "值")} |`,
      "|---|---|",
      ...visible.map(([key, value]) => `| ${this.#escape(key)} | ${this.#escape(String(value))} |`),
    ].join("\n");
  }

  async #syncProviderSessionState(requireFile = false) {
    if (!this.#client) throw new Error("PiCodingAgentAdapter is not started");
    const state = await this.#client.getState();
    if (!state.sessionId || !state.sessionFile) {
      if (requireFile) throw new Error("Pi did not return the active session ID and file");
      return state;
    }
    const sessionFile = await this.#assertSessionFileAllowed(state.sessionFile);
    await this.#handle.sessionState.update((current) => ({
      ...current,
      version: 1,
      providerSessionId: state.sessionId,
      providerSessionFile: sessionFile,
    }));
    return state;
  }

  #effectiveSessionDir(): string {
    return this.#sessionDir ?? path.join(homedir(), ".config", "agent-bridge", "pi-sessions");
  }

  async #assertSessionFileAllowed(candidate: string): Promise<string> {
    const root = await realpath(this.#effectiveSessionDir());
    const resolved = await realpath(candidate);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(resolved) !== ".jsonl") {
      throw new Error("Pi session path is outside the configured session directory");
    }
    return resolved;
  }

  async #readSessionHeader(filePath: string): Promise<{ id: string; cwd: string; name?: string }> {
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
      const header = JSON.parse(firstLine) as Record<string, unknown>;
      if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
        throw new Error("Invalid Pi session header");
      }
      await resolveWorkingDirectory(header.cwd, {
        allowedWorkingDirectoryRoots: this.#allowedWorkingDirectoryRoots,
      });
      return {
        id: header.id,
        cwd: header.cwd,
        ...(typeof header.name === "string" ? { name: header.name } : {}),
      };
    } finally {
      await handle.close();
    }
  }

  async #listSessionFiles(): Promise<Array<{ path: string; id: string; cwd: string; modified: number }>> {
    const root = await realpath(this.#effectiveSessionDir());
    const entries = await readdir(root, { withFileTypes: true });
    const sessions: Array<{ path: string; id: string; cwd: string; modified: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = await this.#assertSessionFileAllowed(path.join(root, entry.name));
      try {
        const [header, info] = await Promise.all([this.#readSessionHeader(filePath), stat(filePath)]);
        sessions.push({ path: filePath, id: header.id, cwd: header.cwd, modified: info.mtimeMs });
      } catch (error) {
        this.#logger.debug(`ignoring invalid Pi session file ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return sessions.sort((a, b) => b.modified - a.modified);
  }

  async #renderResumeList(): Promise<string> {
    const sessions = await this.#listSessionFiles();
    if (!sessions.length) return this.#l("No resumable Pi sessions were found.", "未找到可恢复的 Pi 会话。");
    return [
      `## ${this.#l("Recent Pi sessions", "最近的 Pi 会话")}`,
      "",
      ...sessions.slice(0, 20).map((session) => `- \`${session.id}\` — ${this.#escape(session.cwd)}`),
      "",
      this.#l("Use `/resume <session-id>`.", "使用 `/resume <session-id>` 恢复。"),
    ].join("\n");
  }

  async #resolveSessionSelection(selection: string): Promise<string> {
    if (path.isAbsolute(selection)) {
      const resolved = await this.#assertSessionFileAllowed(selection);
      await this.#readSessionHeader(resolved);
      return resolved;
    }
    const matches = (await this.#listSessionFiles()).filter((session) => session.id.startsWith(selection));
    if (matches.length === 0) throw new Error(`Pi session not found: ${selection}`);
    if (matches.length > 1) throw new Error(`Pi session ID is ambiguous: ${selection}`);
    return matches[0].path;
  }

  async #resolveWritablePath(input: string): Promise<string> {
    const target = path.resolve(this.#currentWorkingDirectory, input);
    const parent = await realpath(path.dirname(target));
    if (this.#allowedWorkingDirectoryRoots?.length) {
      const allowed = await Promise.all(this.#allowedWorkingDirectoryRoots.map((root) => realpath(root)));
      const inside = allowed.some((root) => {
        const relative = path.relative(root, parent);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      });
      if (!inside) throw new Error("Export path is outside the allowed working-directory roots");
    }
    return path.join(parent, path.basename(target));
  }

  #renderTree(tree: PiSessionTreeNode[], leafId: string | null, page: number): string {
    const rows: Array<{ depth: number; id: string; text: string }> = [];
    const visit = (nodes: PiSessionTreeNode[], depth: number) => {
      for (const node of nodes) {
        const entry = node.entry ?? {};
        const id = typeof entry.id === "string" ? entry.id : "?";
        const textCandidate = typeof node.label === "string"
          ? node.label
          : typeof entry.text === "string"
            ? entry.text
            : typeof entry.type === "string"
              ? entry.type
              : "entry";
        rows.push({ depth, id, text: this.#shorten(textCandidate.replace(/\s+/g, " "), 100) });
        visit(node.children ?? [], depth + 1);
      }
    };
    visit(tree, 0);
    const pageSize = 30;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (page > pages) return this.#l(`Tree has ${pages} page(s).`, `会话树共 ${pages} 页。`);
    const visible = rows.slice((page - 1) * pageSize, page * pageSize);
    return [
      `## ${this.#l("Pi session tree", "Pi 会话树")} (${page}/${pages})`,
      "",
      ...visible.map((row) => `${"  ".repeat(row.depth)}- ${row.id === leafId ? "**→** " : ""}\`${row.id}\` ${this.#escape(row.text)}`),
      ...(page < pages ? ["", this.#l(`Use \`/tree ${page + 1}\` for the next page.`, `使用 \`/tree ${page + 1}\` 查看下一页。`)] : []),
    ].join("\n");
  }

  async #processEvent(event: AgentInputEvent): Promise<void> {
    if (!this.#client) {
      throw new Error("PiCodingAgentAdapter is not started");
    }

    try {
      if (event.type === "user.message") {
        this.#logger.info(`sending prompt to agent (session=${this.#agentSessionId})`);
        await this.#emitProgress({
          type: "assistant.thinking",
          agentSessionId: this.#agentSessionId,
          text: "Processing request",
        });
        // Let Pi atomically decide whether this starts a new run or steers the
        // current one. This avoids duplicating Pi's message queue in the adapter.
        const wasActive = this.#activeRun;
        this.#activeRun = true;
        try {
          await this.#client.prompt(event.text, "steer");
        } catch (error) {
          this.#activeRun = wasActive;
          throw error;
        }
        return;
      }

      this.#logger.info(`compacting context (session=${this.#agentSessionId})`);
      await this.#emitProgress({
        type: "session.compacting",
        agentSessionId: this.#agentSessionId,
        text: "Compacting context",
      });
      const result = await this.#client.compact(event.customInstructions);
      this.#logger.debug(
        `compact finished (session=${this.#agentSessionId} estimatedTokensAfter=${result.estimatedTokensAfter ?? "unknown"})`,
      );
      const suffix =
        typeof result.estimatedTokensAfter === "number"
          ? ` Estimated tokens after: ${result.estimatedTokensAfter}.`
          : "";
      await this.#emitAssistant(`Context compacted.${suffix}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error(
        `event processing failed (session=${this.#agentSessionId} type=${event.type}):`,
        error,
      );
      await this.#emitAssistant(`[pi-coding-agent error] ${message}`);
    }
  }

  async #emitAssistant(text: string, attachments?: OutboundAttachment[]): Promise<void> {
    if (!this.#onOutput) {
      this.#logger.error(`dropped assistant output for stopped session ${this.#agentSessionId}`);
      return;
    }

    await this.#onOutput({
      type: "assistant.message",
      agentSessionId: this.#agentSessionId,
      text,
      attachments,
    });
  }

  async #emitProgress(event: Exclude<AgentOutputEvent, { type: "assistant.message" }>): Promise<void> {
    if (!this.#onOutput) {
      return;
    }
    await this.#onOutput(event);
  }

  async #emitRunFailed(detail: string): Promise<void> {
    await this.#emitProgress({
      type: "error",
      agentSessionId: this.#agentSessionId,
      kind: "agent.run.failed",
      detail,
    });
  }

  async #handleRpcEvent(rpcEvent: { type: string; [key: string]: unknown }): Promise<void> {
    if (!this.#onOutput) {
      return;
    }

    if (rpcEvent.type === "extension_ui_request") {
      const requestId = typeof rpcEvent.id === "string" ? rpcEvent.id : undefined;
      if (requestId) {
        this.#client?.cancelExtensionUiRequest(requestId);
      }
      await this.#emitAssistant(this.#l(
        "This Pi extension requested an interactive UI that is not supported in chat; the request was cancelled.",
        "该 Pi 扩展请求了聊天端暂不支持的交互界面；请求已取消。",
      ));
      return;
    }

    if (rpcEvent.type === "agent_start") {
      this.#activeRun = true;
      return;
    }

    if (rpcEvent.type === "agent_settled") {
      this.#activeRun = false;
      this.#toolLabelByCallId.clear();
      this.#toolInputByCallId.clear();
      return;
    }

    if (rpcEvent.type === "message_end") {
      const message = rpcEvent.message;
      if (this.#isAssistantMessage(message)) {
        this.#logger.debug(`assistant message_end content shape (session=${this.#agentSessionId})`, {
          contentType: Array.isArray(message.content) ? "array" : typeof message.content,
          contentPreview: this.#summarizeContentShape(message.content),
        });

        if (message.stopReason === "error") {
          const detail =
            typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
              ? message.errorMessage.trim()
              : "The agent run failed without additional error details.";
          this.#logger.error(`agent run failed (session=${this.#agentSessionId})`, {
            errorMessage: detail,
            responseId: typeof message.responseId === "string" ? message.responseId : undefined,
            provider: typeof message.provider === "string" ? message.provider : undefined,
            model: typeof message.model === "string" ? message.model : undefined,
          });
          await this.#emitRunFailed(detail);
          return;
        }

        const rawText = this.#extractMessageText(message.content);
        const { text, attachments } = extractMediaMarkers(rawText);
        this.#logger.debug(
          `assistant message_end received (session=${this.#agentSessionId} textLength=${rawText.length} attachmentCount=${attachments.length})`,
        );
        if (!text.trim() && attachments.length === 0) {
          this.#logger.debug(
            `ignoring assistant message_end without visible content (session=${this.#agentSessionId})`,
          );
          return;
        }
        await this.#emitAssistant(text, attachments);
      }
      return;
    }

    if (rpcEvent.type === "tool_execution_start") {
      const toolName = typeof rpcEvent.toolName === "string" ? rpcEvent.toolName : "unknown";
      const toolCallId = typeof rpcEvent.toolCallId === "string" ? rpcEvent.toolCallId : undefined;
      const toolInput = "args" in rpcEvent ? rpcEvent.args : undefined;
      const toolLabel = this.#summarizeToolLabel(toolName, toolInput);
      if (toolCallId) {
        if (toolLabel) this.#toolLabelByCallId.set(toolCallId, toolLabel);
        if (toolInput !== undefined) this.#toolInputByCallId.set(toolCallId, toolInput);
      }
      await this.#emitProgress({
        type: "assistant.tool.running",
        agentSessionId: this.#agentSessionId,
        toolName,
        toolCallId,
        toolInput,
        toolLabel,
        text: undefined,
      });
      return;
    }

    if (rpcEvent.type === "tool_execution_update") {
      const toolName = typeof rpcEvent.toolName === "string" ? rpcEvent.toolName : "unknown";
      const toolCallId = typeof rpcEvent.toolCallId === "string" ? rpcEvent.toolCallId : undefined;
      const toolInput = "args" in rpcEvent ? rpcEvent.args : this.#toolInputForCall(toolCallId);
      const toolLabel = this.#toolLabelForCall(toolCallId, toolName, toolInput);
      if (toolCallId) {
        if (toolLabel) this.#toolLabelByCallId.set(toolCallId, toolLabel);
        if (toolInput !== undefined) this.#toolInputByCallId.set(toolCallId, toolInput);
      }
      await this.#emitProgress({
        type: "assistant.tool.update",
        agentSessionId: this.#agentSessionId,
        toolName,
        toolCallId,
        toolInput,
        toolLabel,
        partialResult: "partialResult" in rpcEvent ? rpcEvent.partialResult : undefined,
        text: undefined,
      });
      return;
    }

    if (rpcEvent.type === "tool_execution_end") {
      const toolName = typeof rpcEvent.toolName === "string" ? rpcEvent.toolName : "unknown";
      const toolCallId = typeof rpcEvent.toolCallId === "string" ? rpcEvent.toolCallId : undefined;
      const isError = Boolean(rpcEvent.isError);
      const toolInput = this.#toolInputForCall(toolCallId);
      const toolLabel = this.#toolLabelForCall(toolCallId, toolName, toolInput);
      await this.#emitProgress({
        type: isError ? "assistant.tool.error" : "assistant.tool.done",
        agentSessionId: this.#agentSessionId,
        toolName,
        toolCallId,
        toolInput,
        toolLabel,
        result: "result" in rpcEvent ? rpcEvent.result : undefined,
        text: undefined,
      });
      if (toolCallId) {
        this.#toolLabelByCallId.delete(toolCallId);
        this.#toolInputByCallId.delete(toolCallId);
      }
    }
  }

  #toolInputForCall(toolCallId: string | undefined): unknown {
    return toolCallId ? this.#toolInputByCallId.get(toolCallId) : undefined;
  }

  #toolLabelForCall(toolCallId: string | undefined, toolName: string, toolInput: unknown): string | undefined {
    return (toolCallId ? this.#toolLabelByCallId.get(toolCallId) : undefined) ?? this.#summarizeToolLabel(toolName, toolInput);
  }

  #summarizeToolLabel(toolName: string, toolInput: unknown): string | undefined {
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
      return undefined;
    }

    const input = toolInput as Record<string, unknown>;
    const stringField = (key: string): string | undefined => {
      const value = input[key];
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    };
    const stringArrayField = (key: string): string[] | undefined => {
      const value = input[key];
      if (!Array.isArray(value)) return undefined;
      const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      return items.length > 0 ? items.map((item) => item.trim()) : undefined;
    };

    switch (toolName) {
      case "bash":
        return stringField("command");
      case "read":
      case "write":
      case "edit":
      case "find":
      case "ls":
        return stringField("path");
      case "grep": {
        const pattern = stringField("pattern");
        const path = stringField("path");
        if (pattern && path) return `${pattern} in ${path}`;
        return pattern ?? path;
      }
      case "web_search": {
        const query = stringField("query");
        const queries = stringArrayField("queries");
        return query ?? (queries ? queries.join(" | ") : undefined);
      }
      case "fetch_content": {
        const url = stringField("url");
        const urls = stringArrayField("urls");
        return url ?? (urls ? urls.join(" | ") : undefined);
      }
      default:
        return this.#truncate(this.#safeJson(toolInput), 120);
    }
  }

  #safeJson(value: unknown): string | undefined {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }

  #truncate(value: string | undefined, maxLength: number): string | undefined {
    if (!value) return undefined;
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
  }

  #isAssistantMessage(value: unknown): value is {
    role: "assistant";
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    responseId?: unknown;
    provider?: unknown;
    model?: unknown;
  } {
    if (!value || typeof value !== "object") {
      return false;
    }

    return (value as { role?: unknown }).role === "assistant";
  }

  #extractMessageText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }

    if (this.#isTextBlock(content)) {
      return content.text;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const textParts: string[] = [];
    for (const block of content) {
      if (this.#isTextBlock(block)) {
        textParts.push(block.text);
        continue;
      }

      if (!block || typeof block !== "object") {
        continue;
      }

      const candidate = block as { content?: unknown };
      if (typeof candidate.content === "string") {
        textParts.push(candidate.content);
      }
    }

    return textParts.join("");
  }

  #isTextBlock(value: unknown): value is { type: "text"; text: string } {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string";
  }

  #summarizeContentShape(content: unknown): unknown {
    if (typeof content === "string") {
      return { kind: "string", length: content.length, preview: content.slice(0, 200) };
    }

    if (!Array.isArray(content)) {
      return { kind: typeof content };
    }

    return content.slice(0, 10).map((block) => {
      if (!block || typeof block !== "object") {
        return { kind: typeof block };
      }

      const candidate = block as { type?: unknown; text?: unknown; content?: unknown; mimeType?: unknown };
      return {
        type: candidate.type,
        textLength: typeof candidate.text === "string" ? candidate.text.length : undefined,
        contentType: Array.isArray(candidate.content) ? "array" : typeof candidate.content,
        mimeType: candidate.mimeType,
      };
    });
  }
}
