import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveUser,
  decodeAccessFile,
  denyUser,
  emptyAccessFile,
  loadAccessFile,
  markApprovalNotified,
  recordPendingRequest,
  revokeUser,
  saveAccessFile,
  updateAccessFile,
  type AccessFile,
} from "./access-store";

describe("access-store", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-bridge-authz-test-"));
    filePath = path.join(dir, "authz.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a missing file as an empty document", async () => {
    expect(await loadAccessFile(filePath)).toEqual(emptyAccessFile());
  });

  it("loads a malformed file as an empty document", async () => {
    await saveAccessFile(emptyAccessFile(), filePath);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, "{not json", "utf8");
    expect(await loadAccessFile(filePath)).toEqual(emptyAccessFile());
  });

  it("records a pending request and refreshes it on repeat", async () => {
    await updateAccessFile(
      recordPendingRequest("feishu-main", "ou_a", { name: "Alice", chatId: "oc_1", chatType: "dm" }, new Date("2026-01-01T00:00:00Z")),
      filePath,
    );
    await updateAccessFile(
      recordPendingRequest("feishu-main", "ou_a", { chatId: "oc_1", chatType: "dm" }, new Date("2026-01-01T00:05:00Z")),
      filePath,
    );

    const file = await loadAccessFile(filePath);
    const pending = file.channels["feishu-main"]?.pending["ou_a"];
    expect(pending).toMatchObject({
      name: "Alice",
      chatId: "oc_1",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:05:00.000Z",
      requestCount: 2,
    });
  });

  it("approves a pending user, carrying chat coordinates and dropping pending", async () => {
    await updateAccessFile(
      recordPendingRequest("feishu-main", "ou_a", { name: "Alice", chatId: "oc_1", chatType: "dm" }),
      filePath,
    );
    await updateAccessFile(
      approveUser("feishu-main", "ou_a", { grants: ["agent", "ssh"] }),
      filePath,
    );

    const state = (await loadAccessFile(filePath)).channels["feishu-main"]!;
    expect(state.pending["ou_a"]).toBeUndefined();
    expect(state.users["ou_a"]).toMatchObject({
      grants: ["agent", "ssh"],
      name: "Alice",
      chatId: "oc_1",
      chatType: "dm",
    });
    expect(state.users["ou_a"]!.notifiedAt).toBeUndefined();
  });

  it("approves a pre-known user without a pending record", async () => {
    await updateAccessFile(approveUser("feishu-main", "ou_b", { grants: ["agent"] }), filePath);
    const state = (await loadAccessFile(filePath)).channels["feishu-main"]!;
    expect(state.users["ou_b"]?.grants).toEqual(["agent"]);
  });

  it("merges grants and re-arms the notice when approving again", async () => {
    await updateAccessFile(approveUser("feishu-main", "ou_a", { grants: ["agent"] }), filePath);
    await updateAccessFile(markApprovalNotified("feishu-main", "ou_a"), filePath);
    await updateAccessFile(approveUser("feishu-main", "ou_a", { grants: ["ssh"] }), filePath);

    const user = (await loadAccessFile(filePath)).channels["feishu-main"]!.users["ou_a"]!;
    expect(user.grants).toEqual(["agent", "ssh"]);
    expect(user.notifiedAt).toBeUndefined();
  });

  it("denies a pending user and blocks later pending records", async () => {
    await updateAccessFile(
      recordPendingRequest("feishu-main", "ou_c", { chatId: "oc_9", chatType: "dm" }),
      filePath,
    );
    await updateAccessFile(denyUser("feishu-main", "ou_c"), filePath);
    await updateAccessFile(
      recordPendingRequest("feishu-main", "ou_c", { chatId: "oc_9", chatType: "dm" }),
      filePath,
    );

    const state = (await loadAccessFile(filePath)).channels["feishu-main"]!;
    expect(state.pending["ou_c"]).toBeUndefined();
    expect(state.denied["ou_c"]?.deniedAt).toBeTruthy();
  });

  it("revokes an existing user and reports whether one existed", async () => {
    await updateAccessFile(approveUser("feishu-main", "ou_a", { grants: ["agent"] }), filePath);
    expect(await updateAccessFile(revokeUser("feishu-main", "ou_a"), filePath)).toBe(true);
    expect(await updateAccessFile(revokeUser("feishu-main", "ou_a"), filePath)).toBe(false);
  });

  it("serializes concurrent in-process updates without losing changes", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        updateAccessFile(
          recordPendingRequest("feishu-main", `ou_${index}`, { chatId: "oc_1", chatType: "dm" }),
          filePath,
        ),
      ),
    );
    const state = (await loadAccessFile(filePath)).channels["feishu-main"]!;
    expect(Object.keys(state.pending)).toHaveLength(10);
  });

  it("keeps channel states isolated", async () => {
    await updateAccessFile(approveUser("a", "ou_1", { grants: ["agent"] }), filePath);
    await updateAccessFile(
      recordPendingRequest("b", "ou_2", { chatId: "oc_2", chatType: "group" }),
      filePath,
    );
    const file = await loadAccessFile(filePath);
    expect(Object.keys(file.channels).sort()).toEqual(["a", "b"]);
    expect(file.channels["a"]!.pending).toEqual({});
    expect(file.channels["b"]!.users).toEqual({});
  });

  it("decodeAccessFile drops malformed records and defaults grants to agent", () => {
    const file: AccessFile = decodeAccessFile({
      channels: {
        c: {
          users: {
            ou_ok: { grants: ["ssh", "bogus"], approvedAt: "t" },
            ou_bad: { grants: [] },
            ou_junk: "nope",
          },
          pending: { ou_p: { chatId: "oc", firstSeenAt: "a", lastSeenAt: "b" } },
          denied: { ou_d: { deniedAt: "x" }, ou_junk: 1 },
        },
      },
    });
    expect(file.channels["c"]!.users["ou_ok"]?.grants).toEqual(["ssh"]);
    expect(file.channels["c"]!.users["ou_bad"]).toBeUndefined();
    expect(file.channels["c"]!.pending["ou_p"]?.requestCount).toBe(1);
    expect(Object.keys(file.channels["c"]!.denied)).toEqual(["ou_d"]);
  });

  it("saveAccessFile writes human-readable JSON", async () => {
    await updateAccessFile(approveUser("c", "ou_1", { grants: ["agent"] }), filePath);
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.channels.c.users["ou_1"].grants).toEqual(["agent"]);
  });
});
