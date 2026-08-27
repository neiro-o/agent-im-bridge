import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatModeController, normalizeChatModeConfig } from "./chat-mode-controller";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "chat-mode-"));
  roots.push(root);
  const canonical = await realpath(root);
  return new ChatModeController({
    config: normalizeChatModeConfig({
      enabled: true,
      allowedClientSessionIds: ["feishu:dm:owner"],
      defaultWorkingDirectory: canonical,
      allowedFileRoots: [canonical],
    }),
  });
}

describe("ChatModeController", () => {
  it("fails closed for an unauthorized chat", async () => {
    const controller = await fixture();
    const actions = await controller.handle({
      clientSessionId: "feishu:dm:stranger",
      chatType: "p2p",
      text: "/ssh",
    });
    expect(actions).toEqual([{ type: "reply", text: "当前聊天未获授权使用 SSH 模式。" }]);
  });

  it("switches independently between agent and ssh modes", async () => {
    const controller = await fixture();
    const entered = await controller.handle({
      clientSessionId: "feishu:dm:owner",
      chatType: "p2p",
      text: "/ssh",
    });
    expect(entered[0]).toMatchObject({ type: "reply" });
    expect((entered[0] as { text: string }).text).toContain("已切换到 SSH 模式");

    expect(await controller.handle({
      clientSessionId: "feishu:dm:owner",
      chatType: "p2p",
      text: "/effort high",
    })).toEqual([{ type: "forward" }]);

    expect(await controller.handle({
      clientSessionId: "feishu:dm:owner",
      chatType: "p2p",
      text: "/agent",
    })).toEqual([{ type: "reply", text: "已切换到 Agent 模式。" }]);
    expect(await controller.handle({
      clientSessionId: "feishu:dm:owner",
      chatType: "p2p",
      text: "hello agent",
    })).toEqual([{ type: "forward" }]);
  });

  it("requires /upload before consuming attachments", async () => {
    const controller = await fixture();
    await controller.handle({ clientSessionId: "feishu:dm:owner", chatType: "p2p", text: "/ssh" });
    expect(await controller.handle({
      clientSessionId: "feishu:dm:owner",
      chatType: "p2p",
      text: "",
      attachments: [{ kind: "file", localPath: "missing", fileName: "a.txt" }],
    })).toEqual([{ type: "reply", text: "请先发送 /upload，再发送附件。" }]);
  });

  it("returns a direct attachment plan for one allowed file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chat-mode-download-"));
    roots.push(root);
    await writeFile(path.join(root, "report.txt"), "ok");
    const controller = new ChatModeController({
      config: normalizeChatModeConfig({
        enabled: true,
        allowedClientSessionIds: ["feishu:dm:owner"],
        defaultWorkingDirectory: root,
        allowedFileRoots: [root],
      }),
    });
    await controller.handle({ clientSessionId: "feishu:dm:owner", chatType: "p2p", text: "/ssh" });
    expect(await controller.handle({
      clientSessionId: "feishu:dm:owner",
      chatType: "p2p",
      text: "/download report.txt",
    })).toEqual([{ type: "attachment", filePath: await realpath(path.join(root, "report.txt")) }]);
  });
});
