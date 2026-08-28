import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTransferService, type ArchiveFile } from "./file-transfer-service";
import { PathPolicy } from "./path-policy";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function rootFixture() { const root = await mkdtemp(path.join(os.tmpdir(), "transfer-test-")); dirs.push(root); return root; }

describe("FileTransferService", () => {
  it("copies uploads, sanitizes names, and avoids collisions", async () => {
    const root = await rootFixture(); const incoming = await rootFixture();
    const source = path.join(incoming, "source"); await writeFile(source, "hello");
    const service = new FileTransferService({ pathPolicy: new PathPolicy([root]) });
    await writeFile(path.join(root, "note.txt"), "old");
    const [result] = await service.saveInboundAttachments([{ kind: "file", localPath: source, fileName: "../../note.txt" }], root);
    expect(path.basename(result.path)).toBe("note (1).txt"); expect(await readFile(source, "utf8")).toBe("hello");
  });

  it("overwrites uploads only when explicitly enabled", async () => {
    const root = await rootFixture();
    const incoming = await rootFixture();
    const source = path.join(incoming, "source");
    await writeFile(source, "new");
    await writeFile(path.join(root, "note.txt"), "old");
    const service = new FileTransferService({
      pathPolicy: new PathPolicy([root]),
      overwriteUploads: true,
    });

    const [result] = await service.saveInboundAttachments([
      { kind: "file", localPath: source, fileName: "note.txt" },
    ], root);

    expect(path.basename(result.path)).toBe("note.txt");
    expect(await readFile(result.path, "utf8")).toBe("new");
  });

  it("creates an archive plan and cleanup only removes its temp directory", async () => {
    const root = await rootFixture(); await mkdir(path.join(root, "folder"));
    const original = path.join(root, "folder", "a.txt"); await writeFile(original, "archive me");
    const service = new FileTransferService({ pathPolicy: new PathPolicy([root]), createArchive: async (files, output) => {
      expect(files.every((file) => !path.isAbsolute(file.entryName) && !file.entryName.includes(".."))).toBe(true);
      await writeFile(output, "fake archive");
    } });
    const plan = await service.prepareDownload("folder", root);
    expect(plan.archive?.path).toBeTruthy(); expect(await stat(original)).toBeTruthy();
    const archive = plan.archive!.path; await plan.archive!.cleanup();
    await expect(stat(archive)).rejects.toThrow(); expect(await readFile(original, "utf8")).toBe("archive me");
  });

  it("expands glob expressions without shell interpolation", async () => {
    const root = await rootFixture(); await writeFile(path.join(root, "a one.txt"), "a"); await writeFile(path.join(root, "b.txt"), "b");
    const service = new FileTransferService({ pathPolicy: new PathPolicy([root]), createArchive: async (files, output) => writeFile(output, files.map((f) => f.entryName).join("\n")) });
    const plan = await service.prepareDownload("*.txt", root);
    expect(plan.archive).toBeDefined(); expect(await readFile(plan.archive!.path, "utf8")).toContain("a one.txt"); await plan.archive!.cleanup();
  });
});
