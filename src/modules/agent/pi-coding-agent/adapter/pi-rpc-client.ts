import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createLogger, type Logger } from "../../../../core/logger";
import { resolveMediaPromptExtensionPath } from "./pi-extension-path";

export type PiRpcCommand =
  | { id?: string; type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "abort" }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "get_available_thinking_levels" }
  | { id?: string; type: "set_thinking_level"; level: string }
  | { id?: string; type: "set_session_name"; name: string }
  | { id?: string; type: "get_commands" }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "follow_up"; message: string }
  | { id?: string; type: "clone" }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "get_tree" }
  | { id?: string; type: "get_entries"; since?: string };

export interface PiSessionState {
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  steeringMode?: string;
  followUpMode?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  model?: {
    provider?: string;
    id?: string;
    contextWindow?: number;
    maxTokens?: number;
  };
}

export interface PiSessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number | null;
    percent?: number | null;
  };
}

export interface PiDynamicCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

export interface PiSessionTreeNode {
  entry?: Record<string, unknown>;
  children?: PiSessionTreeNode[];
  label?: string;
}

export type PiRpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
};

export type PiRpcEvent = {
  type: string;
  [key: string]: unknown;
};

export interface PiRpcClientOptions {
  agentSessionId: string;
  piSessionId: string;
  /** Authoritative provider session file used after clone/fork/resume. */
  sessionPath?: string;
  cwd?: string;
  sessionDir?: string;
  bin?: string;
  model?: string;
  extraArgs?: string[];
  logger?: Logger;
}

type PendingRequest = {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
};

function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function attachStrictJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        onLine(line);
      }
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (tail.length > 0) {
      onLine(tail);
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

function defaultSessionDir(): string {
  return path.join(os.homedir(), ".config", "agent-bridge", "pi-sessions");
}

export class PiRpcClient {
  readonly #options: Required<Omit<PiRpcClientOptions, "model" | "sessionPath" | "extraArgs" | "logger">> & {
    model?: string;
    sessionPath?: string;
    extraArgs: string[];
  };
  readonly #logger: Logger;
  #process: ChildProcessWithoutNullStreams | null = null;
  #stderr = "";
  #requestId = 0;
  #pendingRequests = new Map<string, PendingRequest>();
  #detachStdoutReader: (() => void) | null = null;
  #settledWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  #started = false;
  #stopping = false;
  #exitError: Error | null = null;
  #eventListeners = new Set<(event: PiRpcEvent) => void>();

  constructor(options: PiRpcClientOptions) {
    this.#options = {
      agentSessionId: options.agentSessionId,
      piSessionId: options.piSessionId,
      sessionPath: options.sessionPath,
      cwd: options.cwd ?? process.cwd(),
      sessionDir: options.sessionDir ?? defaultSessionDir(),
      bin: options.bin ?? "pi",
      model: options.model,
      extraArgs: options.extraArgs ?? [],
    };
    this.#logger = options.logger ?? createLogger("pi-rpc");
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("PiRpcClient already started");
    }

    await mkdir(this.#options.sessionDir, { recursive: true });

    const sessionArgs = this.#options.sessionPath
      ? ["--session", this.#options.sessionPath]
      : ["--session-id", this.#options.piSessionId];
    const args = [
      "--mode",
      "rpc",
      ...sessionArgs,
      "--session-dir",
      this.#options.sessionDir,
      "--extension",
      resolveMediaPromptExtensionPath(),
      ...(this.#options.model ? ["--model", this.#options.model] : []),
      ...this.#options.extraArgs,
    ];

    const child = spawn(this.#options.bin, args, {
      cwd: this.#options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#logger.info(
      `spawned pi process (pid=${child.pid} bin=${this.#options.bin} args=${args.join(" ")} cwd=${this.#options.cwd})`,
    );

    this.#process = child;
    this.#started = true;
    this.#exitError = null;

    child.stderr.on("data", (chunk) => {
      this.#stderr += chunk.toString();
      this.#logger.debug(`pi stderr: ${chunk.toString().trimEnd()}`);
    });

    child.once("error", (error) => {
      const wrapped = new Error(`pi RPC process error: ${error.message}`);
      this.#handleExitError(wrapped);
    });

    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
      const stderr = this.#stderr.trim();
      const message = stderr
        ? `pi RPC process exited (${detail}): ${stderr}`
        : `pi RPC process exited (${detail})`;
      this.#handleExitError(new Error(message));
    });

    this.#detachStdoutReader = attachStrictJsonlReader(child.stdout, (line) => {
      this.#handleLine(line);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.#exitError) {
      throw this.#exitError;
    }

    const state = await this.getState();
    if (!state.sessionName) {
      await this.setSessionName(this.#options.agentSessionId);
    }
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child) return;

    this.#stopping = true;
    this.#detachStdoutReader?.();
    this.#detachStdoutReader = null;

    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve();
      };

      child.once("exit", () => done());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.#logger.warn("pi process did not exit after SIGTERM, sending SIGKILL");
          child.kill("SIGKILL");
        }
        done();
      }, 1000);
    });

    this.#process = null;
    this.#started = false;
    this.#rejectPending(new Error("pi RPC client stopped"));
  }

  async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.#send({ type: "prompt", message, streamingBehavior });
  }

  async abort(): Promise<void> {
    await this.#send({ type: "abort" });
  }

  async compact(customInstructions?: string): Promise<{ estimatedTokensAfter?: number; summary?: string }> {
    const response = await this.#send({ type: "compact", customInstructions });
    const data = response.data as { estimatedTokensAfter?: number; summary?: string } | undefined;
    return data ?? {};
  }

  async getState(): Promise<PiSessionState> {
    const response = await this.#send({ type: "get_state" });
    return this.#recordData(response, "get_state") as PiSessionState;
  }

  async getSessionStats(): Promise<PiSessionStats> {
    const response = await this.#send({ type: "get_session_stats" });
    return this.#recordData(response, "get_session_stats") as PiSessionStats;
  }

  async getAvailableModels(): Promise<Array<{ provider?: string; id?: string }>> {
    const response = await this.#send({ type: "get_available_models" });
    const data = response.data as { models?: Array<{ provider?: string; id?: string }> } | undefined;
    return data?.models ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<{ provider?: string; id?: string }> {
    const response = await this.#send({ type: "set_model", provider, modelId });
    return (response.data as { provider?: string; id?: string } | undefined) ?? {};
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    const response = await this.#send({ type: "get_available_thinking_levels" });
    const data = response.data;
    if (!data || typeof data !== "object") {
      throw new Error("Invalid get_available_thinking_levels response");
    }
    const levels = (data as { levels?: unknown }).levels;
    if (!Array.isArray(levels) || !levels.every((level): level is string => typeof level === "string")) {
      throw new Error("Invalid thinking levels returned by pi RPC");
    }
    return levels;
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.#send({ type: "set_thinking_level", level });
  }

  async setSessionName(name: string): Promise<void> {
    await this.#send({ type: "set_session_name", name });
  }

  async getCommands(): Promise<PiDynamicCommand[]> {
    const data = this.#recordData(await this.#send({ type: "get_commands" }), "get_commands");
    const commands = data.commands;
    if (!Array.isArray(commands)) throw new Error("Invalid get_commands response");
    return commands.filter((command): command is PiDynamicCommand => {
      if (!command || typeof command !== "object") return false;
      const item = command as Record<string, unknown>;
      return typeof item.name === "string" &&
        (item.source === "extension" || item.source === "prompt" || item.source === "skill");
    });
  }

  async steer(message: string): Promise<void> {
    await this.#send({ type: "steer", message });
  }

  async followUp(message: string): Promise<void> {
    await this.#send({ type: "follow_up", message });
  }

  async clone(): Promise<{ cancelled: boolean }> {
    const data = this.#recordData(await this.#send({ type: "clone" }), "clone");
    return { cancelled: data.cancelled === true };
  }

  async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const data = this.#recordData(await this.#send({ type: "get_fork_messages" }), "get_fork_messages");
    if (!Array.isArray(data.messages)) throw new Error("Invalid get_fork_messages response");
    return data.messages.filter((message): message is { entryId: string; text: string } => {
      if (!message || typeof message !== "object") return false;
      const item = message as Record<string, unknown>;
      return typeof item.entryId === "string" && typeof item.text === "string";
    });
  }

  async fork(entryId: string): Promise<{ cancelled: boolean; text?: string }> {
    const data = this.#recordData(await this.#send({ type: "fork", entryId }), "fork");
    return {
      cancelled: data.cancelled === true,
      ...(typeof data.text === "string" ? { text: data.text } : {}),
    };
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    const data = this.#recordData(
      await this.#send({ type: "switch_session", sessionPath }),
      "switch_session",
    );
    return { cancelled: data.cancelled === true };
  }

  async exportHtml(outputPath?: string): Promise<string> {
    const data = this.#recordData(await this.#send({ type: "export_html", outputPath }), "export_html");
    if (typeof data.path !== "string" || !data.path) throw new Error("Invalid export_html response");
    return data.path;
  }

  async getLastAssistantText(): Promise<string | null> {
    const data = this.#recordData(
      await this.#send({ type: "get_last_assistant_text" }),
      "get_last_assistant_text",
    );
    if (data.text !== null && typeof data.text !== "string") {
      throw new Error("Invalid get_last_assistant_text response");
    }
    return data.text as string | null;
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.#send({ type: "set_auto_compaction", enabled });
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.#send({ type: "set_auto_retry", enabled });
  }

  async abortRetry(): Promise<void> {
    await this.#send({ type: "abort_retry" });
  }

  async cycleModel(): Promise<{ model: { provider: string; id: string }; thinkingLevel?: string; isScoped?: boolean } | null> {
    const response = await this.#send({ type: "cycle_model" });
    if (response.data === null) return null;
    const data = this.#recordData(response, "cycle_model");
    const model = data.model;
    if (!model || typeof model !== "object") throw new Error("Invalid cycle_model response");
    const candidate = model as Record<string, unknown>;
    if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") {
      throw new Error("Invalid cycle_model response");
    }
    return {
      model: { provider: candidate.provider, id: candidate.id },
      ...(typeof data.thinkingLevel === "string" ? { thinkingLevel: data.thinkingLevel } : {}),
      ...(typeof data.isScoped === "boolean" ? { isScoped: data.isScoped } : {}),
    };
  }

  async cycleThinkingLevel(): Promise<string | null> {
    const response = await this.#send({ type: "cycle_thinking_level" });
    if (response.data === null) return null;
    const data = this.#recordData(response, "cycle_thinking_level");
    if (typeof data.level !== "string") throw new Error("Invalid cycle_thinking_level response");
    return data.level;
  }

  async getTree(): Promise<{ tree: PiSessionTreeNode[]; leafId: string | null }> {
    const data = this.#recordData(await this.#send({ type: "get_tree" }), "get_tree");
    if (!Array.isArray(data.tree)) throw new Error("Invalid get_tree response");
    return {
      tree: data.tree as PiSessionTreeNode[],
      leafId: typeof data.leafId === "string" ? data.leafId : null,
    };
  }

  cancelExtensionUiRequest(id: string): void {
    if (!this.#process?.stdin.writable) return;
    this.#process.stdin.write(serializeJsonLine({ type: "extension_ui_response", id, cancelled: true }));
  }

  #recordData(response: PiRpcResponse, command: string): Record<string, unknown> {
    if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
      throw new Error(`Invalid ${command} response`);
    }
    return response.data as Record<string, unknown>;
  }

  async #send(command: PiRpcCommand): Promise<PiRpcResponse> {
    if (!this.#process?.stdin.writable) {
      throw this.#exitError ?? new Error("pi RPC process is not writable");
    }

    const id = `req-${++this.#requestId}`;
    const payload = { ...command, id };
    this.#logger.debug(`sending command (id=${id} type=${command.type})`);

    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.#pendingRequests.set(id, { resolve, reject });

      this.#process!.stdin.write(serializeJsonLine(payload), (error) => {
        if (!error) return;
        this.#pendingRequests.delete(id);
        this.#logger.error(`failed to write command to pi RPC stdin (id=${id}):`, error);
        reject(new Error(`Failed to write to pi RPC stdin: ${error.message}`));
      });
    }).then((response) => {
      this.#logger.debug(`received response (id=${id} type=${command.type} success=${response.success})`);
      if (!response.success) {
        this.#logger.error(
          `pi RPC command failed (id=${id} type=${response.command}): ${response.error ?? "unknown error"}`,
        );
        throw new Error(response.error ?? `pi RPC command failed: ${response.command}`);
      }
      return response;
    });
  }

  #handleLine(line: string): void {
    let payload: PiRpcResponse | PiRpcEvent;
    try {
      payload = JSON.parse(line) as PiRpcResponse | PiRpcEvent;
    } catch (error) {
      this.#logger.error("failed to parse line:", error);
      return;
    }

    if (payload.type === "response") {
      const response = payload as PiRpcResponse;
      const id = response.id;
      if (!id) {
        this.#logger.warn("ignoring RPC response without id:", JSON.stringify(response).slice(0, 500));
        return;
      }
      const pending = this.#pendingRequests.get(id);
      if (!pending) {
        this.#logger.warn(`ignoring RPC response with unknown id (id=${id})`);
        return;
      }
      this.#pendingRequests.delete(id);
      pending.resolve(response);
      return;
    }

    const event = payload as PiRpcEvent;
    this.#logger.debug(`received event (type=${event.type})`);
    for (const listener of this.#eventListeners) {
      listener(event);
    }

    if (event.type === "agent_settled") {
      const waiters = this.#settledWaiters.splice(0);
      for (const waiter of waiters) {
        waiter.resolve();
      }
    }
  }

  #handleExitError(error: Error): void {
    if (this.#stopping) {
      this.#logger.debug(`pi process exited during stop: ${error.message}`);
    } else {
      this.#logger.error(error.message);
    }
    this.#stopping = false;
    this.#exitError = error;
    this.#process = null;
    this.#started = false;
    this.#detachStdoutReader?.();
    this.#detachStdoutReader = null;
    this.#rejectPending(error);
  }

  #rejectPending(error: Error): void {
    for (const [id, pending] of this.#pendingRequests) {
      this.#pendingRequests.delete(id);
      pending.reject(error);
    }

    const waiters = this.#settledWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
}
