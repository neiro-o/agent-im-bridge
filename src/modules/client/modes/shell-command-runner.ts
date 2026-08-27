import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PathPolicy } from "./path-policy";

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_SHELL_OUTPUT_BYTES = 64 * 1024;

export interface ShellRunResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  cwd: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface ShellCommandRunnerOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  pathPolicy?: PathPolicy;
  bashPath?: string;
}

/** Runs one command in a fresh, non-interactive bash process. */
export class ShellCommandRunner {
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #pathPolicy?: PathPolicy;
  readonly #bashPath: string;
  readonly #children = new Set<ChildProcess>();

  constructor(options: ShellCommandRunnerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_SHELL_OUTPUT_BYTES;
    this.#pathPolicy = options.pathPolicy;
    this.#bashPath = options.bashPath ?? "/bin/bash";
  }

  async run(command: string, cwd: string, signal?: AbortSignal): Promise<ShellRunResult> {
    if (process.platform === "win32" && this.#bashPath === "/bin/bash") {
      throw new Error("non-interactive bash shell mode is unavailable on Windows");
    }
    if (signal?.aborted) return abortedResult(cwd);
    const initialCwd = this.#pathPolicy
      ? await this.#pathPolicy.resolveDirectory(".", cwd)
      : cwd;
    const marker = `__AGENT_BRIDGE_${randomUUID()}__`;
    // The command is intentionally the script body (this is the remote shell
    // feature), but it is not interpolated into an additional shell command.
    const script = `trap '__agent_bridge_status=$?; printf '\\n${marker}%s:%s\\n' "$__agent_bridge_status" "$PWD"' EXIT\n${command}`;

    return new Promise<ShellRunResult>((resolve) => {
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let truncated = false;
      let markerTail = "";

      const append = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (kind === "stdout") {
          markerTail = (markerTail + text).slice(-(marker.length + 4096));
        }
        const remaining = this.#maxOutputBytes - outputBytes;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const bytes = Buffer.byteLength(text);
        const kept = bytes <= remaining ? text : Buffer.from(text).subarray(0, remaining).toString("utf8");
        if (bytes > remaining) truncated = true;
        outputBytes += Buffer.byteLength(kept);
        if (kind === "stdout") stdout += kept;
        else stderr += kept;
      };

      const finish = (error: NodeJS.ErrnoException | null, child: ChildProcess) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.#children.delete(child);
        const markerPattern = new RegExp(`${escapeRegExp(marker)}(-?\\d+):(.*)`);
        const found = markerPattern.exec(markerTail);
        let exitCode: number | null = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? null : child.exitCode;
        let finalCwd = initialCwd;
        const errorSignal = (error as NodeJS.ErrnoException & { signal?: string } | null)?.signal;
        if (found) {
          exitCode = Number(found[1]);
          const candidate = found[2].trim();
          // Remove the private trailer from the captured user output.
          stdout = stdout.replace(new RegExp(`\\n?${escapeRegExp(marker)}-?\\d+:.*?\\n?`), "");
          if (this.#pathPolicy) {
            void this.#pathPolicy.resolveDirectory(candidate, initialCwd).then((canonical) => {
              finalCwd = canonical;
              resolve({ exitCode, signal: errorSignal, stdout, stderr, cwd: finalCwd, timedOut, truncated });
            }).catch(() => resolve({ exitCode, signal: errorSignal, stdout, stderr, cwd: initialCwd, timedOut, truncated }));
            return;
          }
          finalCwd = candidate;
        }
        resolve({ exitCode, signal: errorSignal, stdout, stderr, cwd: finalCwd, timedOut, truncated });
      };

      const child = execFile(
        this.#bashPath,
        ["-lc", script],
        {
          cwd: initialCwd,
          windowsHide: true,
          maxBuffer: this.#maxOutputBytes + 4096,
          encoding: "utf8",
          ...(process.platform !== "win32" ? { detached: true } : {}),
        } as Parameters<typeof execFile>[2],
        (error: Error | null) => finish(error as NodeJS.ErrnoException | null, child),
      );
      this.#children.add(child);
      child.stdout?.on("data", (chunk) => append("stdout", chunk));
      child.stderr?.on("data", (chunk) => append("stderr", chunk));
      const kill = () => {
        if (child.killed || child.exitCode !== null) return;
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
          setTimeout(() => {
            if (child.exitCode === null) {
              try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
            }
          }, 250).unref();
        } else child.kill();
      };
      timer = setTimeout(() => { timedOut = true; kill(); }, this.#timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", () => { aborted = true; kill(); }, { once: true });
      // Keep the variable meaningful for debugging without ever logging a
      // command or its environment; aborted runs are represented by signal.
      void aborted;
    });
  }

  async stop(): Promise<void> {
    for (const child of this.#children) {
      if (child.exitCode === null) {
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        } else child.kill();
      }
    }
  }
}

function abortedResult(cwd: string): ShellRunResult {
  return { exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", cwd, timedOut: false, truncated: false };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
