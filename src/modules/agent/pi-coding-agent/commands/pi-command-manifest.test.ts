import { describe, expect, it } from "vitest";
import { getPiCommandManifest } from "./pi-command-manifest";

function names(language: "en-US" | "zh-CN") {
  return getPiCommandManifest({ channelName: "test", language }).flatMap((command) => [command.name, ...(command.aliases ?? [])]);
}

describe("getPiCommandManifest", () => {
  it("declares unique provider-scoped command names and aliases", () => {
    const all = names("en-US");
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(expect.arrayContaining([
      "effort", "thinking", "session", "name", "commands", "steer", "follow-up", "fu",
      "clone", "fork", "resume", "export", "last", "auto-compact", "retry", "retry-stop",
      "model-next", "thinking-next", "tree",
    ]));
  });

  it("does not claim bridge-reserved command names", () => {
    const reserved = new Set([
      "help", "new", "stop", "status", "model", "compact", "schedule-run", "schedule-here",
      "queue-here", "agent", "ssh", "upload", "upload-cancel", "download",
    ]);
    expect(names("en-US").filter((name) => reserved.has(name))).toEqual([]);
  });

  it("localizes descriptions without changing command identity", () => {
    expect(names("zh-CN")).toEqual(names("en-US"));
    expect(getPiCommandManifest({ channelName: "test", language: "zh-CN" })[0].description)
      .not.toBe(getPiCommandManifest({ channelName: "test", language: "en-US" })[0].description);
  });
});
