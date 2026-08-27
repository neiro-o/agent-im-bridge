import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PathPolicy } from "./path-policy";
import { ShellCommandRunner } from "./shell-command-runner";

const linuxOnly = process.platform === "win32" ? it.skip : it;

describe("ShellCommandRunner", () => {
  linuxOnly("captures output, status, and changed cwd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "shell-runner-test-"));
    await mkdir(path.join(root, "next"));
    try {
      const runner = new ShellCommandRunner({ pathPolicy: new PathPolicy([root]) });
      const first = await runner.run("printf out; printf err >&2; cd next; exit 7", root);
      expect(first.exitCode).toBe(7); expect(first.stdout).toContain("out"); expect(first.stderr).toContain("err");
      expect(first.cwd).toBe(path.join(root, "next"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  linuxOnly("times out and truncates output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "shell-runner-test-"));
    try {
      const runner = new ShellCommandRunner({ timeoutMs: 30, maxOutputBytes: 10 });
      const result = await runner.run("printf 123456789012345; sleep 2", root);
      expect(result.timedOut).toBe(true); expect(result.truncated).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "win32")("does not assume bash exists on Windows", async () => {
    const runner = new ShellCommandRunner();
    await expect(runner.run("dir", process.cwd())).rejects.toThrow();
  });
});
