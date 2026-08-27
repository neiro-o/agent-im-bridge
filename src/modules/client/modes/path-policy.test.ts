import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathPolicy, PathPolicyError, assertSafeArchiveEntry, isWithin, sanitizeBasename } from "./path-policy";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "path-policy-test-"));
  dirs.push(root);
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "file.txt"), "ok");
  return root;
}

describe("PathPolicy", () => {
  it("uses canonical roots and path.relative boundaries", async () => {
    const root = await fixture();
    const policy = new PathPolicy({ allowedRoots: [root] });
    expect(await policy.resolveExisting("nested/file.txt", root)).toBe(await real(root, "nested/file.txt"));
    await expect(policy.resolveExisting("../outside", root)).rejects.toThrow(PathPolicyError);
    expect(isWithin(root, `${root}-sibling`)).toBe(false);
  });

  it("rejects symlink escapes", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "path-policy-outside-")); dirs.push(outside);
    await writeFile(path.join(outside, "secret"), "no");
    try { await symlink(outside, path.join(root, "escape"), "junction"); }
    catch { return; }
    await expect(new PathPolicy([root]).resolveExisting("escape/secret", root)).rejects.toThrow();
  });
});

describe("safe names", () => {
  it("strips foreign path separators and rejects dot names", () => {
    expect(sanitizeBasename("C:\\tmp\\note.txt")).toBe("note.txt");
    expect(sanitizeBasename("../../note.txt")).toBe("note.txt");
    expect(() => sanitizeBasename("..")).toThrow();
  });
  it("rejects absolute and traversal archive entries", () => {
    expect(() => assertSafeArchiveEntry("/etc/passwd")).toThrow();
    expect(() => assertSafeArchiveEntry("a/../secret")).toThrow();
    expect(() => assertSafeArchiveEntry("folder/file.txt")).not.toThrow();
  });
});

async function real(root: string, suffix: string) { return path.join(root, suffix); }
