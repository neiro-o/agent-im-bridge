import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendOutboundAttachment } from "./outbound-attachment";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sendOutboundAttachment", () => {
  it("deletes bridge temporary files after successful and failed sends", async () => {
    for (const fail of [false, true]) {
      const root = await mkdtemp(path.join(os.tmpdir(), "outbound-cleanup-"));
      roots.push(root);
      const filePath = path.join(root, "result.txt");
      await writeFile(filePath, "result");
      const send = vi.fn(async () => {
        if (fail) throw new Error("upload failed");
      });
      const operation = sendOutboundAttachment(
        { kind: "file", filePath, cleanupAfterSend: true },
        send,
      );
      if (fail) await expect(operation).rejects.toThrow("upload failed");
      else await operation;
      await expect(access(filePath)).rejects.toThrow();
    }
  });

  it("preserves ordinary source files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "outbound-source-"));
    roots.push(root);
    const filePath = path.join(root, "source.txt");
    await writeFile(filePath, "source");
    await sendOutboundAttachment({ kind: "file", filePath }, async () => {});
    await expect(access(filePath)).resolves.toBeUndefined();
  });
});
