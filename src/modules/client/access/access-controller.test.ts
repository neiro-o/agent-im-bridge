import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTranslator } from "../../../i18n";
import { AccessController } from "./access-controller";
import { approveUser, denyUser, loadAccessFile, updateAccessFile } from "./access-store";

const t = getTranslator("zh-CN");

function makeController(filePath: string, now: () => number = Date.now) {
  return new AccessController({
    channelName: "feishu-main",
    t,
    filePath,
    replyThrottleMs: 60_000,
    pendingWriteThrottleMs: 60_000,
    now,
  });
}

const input = {
  chatId: "oc_1",
  chatType: "dm",
  senderId: "ou_alice",
  senderName: "Alice",
};

describe("AccessController", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-bridge-access-test-"));
    filePath = path.join(dir, "authz.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("blocks an unknown user, records the pending request and replies once", async () => {
    const controller = makeController(filePath);

    const first = await controller.check(input);
    expect(first.allowed).toBe(false);
    expect(first.allowed === false && first.reply).toContain("agent-bridge access approve ou_alice");

    // Throttled: the second message inside the window records nothing new and
    // sends no reply.
    const second = await controller.check(input);
    expect(second.allowed).toBe(false);
    expect(second.allowed === false && second.reply).toBeUndefined();

    const state = (await loadAccessFile(filePath)).channels["feishu-main"]!;
    expect(state.pending["ou_alice"]).toMatchObject({
      name: "Alice",
      chatId: "oc_1",
      requestCount: 1,
    });
  });

  it("refreshes the pending record after the write throttle window", async () => {
    let now = 1_000_000;
    const controller = makeController(filePath, () => now);

    await controller.check(input);
    now += 61_000;
    await controller.check(input);

    const pending = (await loadAccessFile(filePath)).channels["feishu-main"]!.pending["ou_alice"]!;
    expect(pending.requestCount).toBe(2);
  });

  it("allows an approved user immediately (fresh read, no restart)", async () => {
    const controller = makeController(filePath);
    expect((await controller.check(input)).allowed).toBe(false);

    await updateAccessFile(approveUser("feishu-main", "ou_alice", { grants: ["agent"] }), filePath);
    expect((await controller.check(input)).allowed).toBe(true);
  });

  it("drops denied users silently and stops recording them", async () => {
    const controller = makeController(filePath);
    await controller.check(input);
    await updateAccessFile(denyUser("feishu-main", "ou_alice"), filePath);

    const verdict = await controller.check(input);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reply).toBeUndefined();

    const state = (await loadAccessFile(filePath)).channels["feishu-main"]!;
    expect(state.pending["ou_alice"]).toBeUndefined();
    expect(state.denied["ou_alice"]).toBeTruthy();
  });

  it("fails closed when the sender id is missing", async () => {
    const controller = makeController(filePath);
    const verdict = await controller.check({ chatId: "oc_1", chatType: "dm" });
    expect(verdict.allowed).toBe(false);
    expect((await loadAccessFile(filePath)).channels["feishu-main"]).toBeUndefined();
  });

  it("checks elevated grants separately", async () => {
    const controller = makeController(filePath);
    await updateAccessFile(approveUser("feishu-main", "ou_alice", { grants: ["agent"] }), filePath);

    expect(await controller.hasGrant("ou_alice", "agent")).toBe(true);
    expect(await controller.hasGrant("ou_alice", "ssh")).toBe(false);
    expect(await controller.hasGrant(undefined, "agent")).toBe(false);

    await updateAccessFile(approveUser("feishu-main", "ou_alice", { grants: ["ssh"] }), filePath);
    expect(await controller.hasGrant("ou_alice", "ssh")).toBe(true);
  });

  it("lists un-notified approvals once and supports markNotified after delivery", async () => {
    const controller = makeController(filePath);
    await controller.check(input);
    await updateAccessFile(approveUser("feishu-main", "ou_alice", { grants: ["agent"] }), filePath);

    const notices = await controller.pollApprovalNotices();
    expect(notices).toEqual([
      { senderId: "ou_alice", name: "Alice", chatId: "oc_1", chatType: "dm" },
    ]);

    // Not marked yet: a second poll (for example after a failed send) repeats.
    expect(await controller.pollApprovalNotices()).toHaveLength(1);

    await controller.markNotified("ou_alice");
    expect(await controller.pollApprovalNotices()).toEqual([]);
  });
});
