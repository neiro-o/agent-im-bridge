import { FeishuIMAdapter } from "./adapter/feishu-im-adapter";
import { parseFeishuSessionId } from "./adapter/feishu-session";
import type { ClientModule, ConfigAdapter, FeishuClientConfig } from "../../../types";
import {
  imClientSessionStateCodec,
  type ImClientSessionStateV1,
} from "../utils/client-session-state";

function createFeishuConfigCollector(): ConfigAdapter<FeishuClientConfig> {
  return {
    async collect(ctx) {
      const appId = await ctx.input("Feishu App ID", {
        required: true,
        validate: (value) => (value ? null : "App ID is required"),
      });

      const appSecret = await ctx.input("Feishu App Secret", {
        required: true,
        secret: true,
        validate: (value) => (value ? null : "App Secret is required"),
      });

      const domain = await ctx.select("Feishu domain", [
        { label: "Feishu (default)", value: "feishu" },
        { label: "Lark", value: "lark" },
      ]);

      const requireMentionInGroup = await ctx.confirm("Require @mention in group chats", true);

      return {
        appId,
        appSecret,
        domain: domain as FeishuClientConfig["domain"],
        requireMentionInGroup,
      };
    },

    validate(config) {
      if (!config.appId.trim()) {
        throw new Error("Feishu appId is required");
      }
      if (!config.appSecret.trim()) {
        throw new Error("Feishu appSecret is required");
      }
      if (config.domain && !["feishu", "lark"].includes(config.domain)) {
        throw new Error("Feishu domain must be feishu or lark");
      }
      const localControl = config.localControl;
      if (localControl?.enabled) {
        if (!Array.isArray(localControl.allowedClientSessionIds) || localControl.allowedClientSessionIds.length === 0) {
          throw new Error("Feishu localControl requires a non-empty allowedClientSessionIds allowlist");
        }
        for (const sessionId of localControl.allowedClientSessionIds) {
          parseFeishuSessionId(sessionId);
        }
        if (!localControl.defaultWorkingDirectory?.trim()) {
          throw new Error("Feishu localControl defaultWorkingDirectory is required");
        }
        if (!Array.isArray(localControl.allowedFileRoots) || localControl.allowedFileRoots.length === 0) {
          throw new Error("Feishu localControl requires at least one allowedFileRoot");
        }
        for (const [name, value] of [
          ["shellTimeoutMs", localControl.shellTimeoutMs],
          ["maxShellOutputBytes", localControl.maxShellOutputBytes],
          ["maxTransferBytes", localControl.maxTransferBytes],
        ] as const) {
          if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
            throw new Error(`Feishu localControl ${name} must be a positive integer`);
          }
        }
      }
    },

    summarize(config) {
      const masked =
        config.appId.length > 8 ? `${config.appId.slice(0, 4)}****${config.appId.slice(-4)}` : "****";

      return `type=feishu appId=${masked} domain=${config.domain ?? "feishu"} requireMentionInGroup=${config.requireMentionInGroup ?? true}`;
    },
  };
}

export const feishuClientModule: ClientModule<FeishuClientConfig, ImClientSessionStateV1> = {
  type: "feishu",
  sessionStateCodec: imClientSessionStateCodec,
  validateSessionId(clientSessionId) {
    try {
      parseFeishuSessionId(clientSessionId);
      return true;
    } catch {
      return false;
    }
  },
  createConfigCollector: createFeishuConfigCollector,
  createClientAdapter({ config, common, sessionState, onScheduleRun, onScheduleHere, agentCommands }) {
    return new FeishuIMAdapter(
      config,
      undefined,
      common,
      sessionState,
      onScheduleRun,
      onScheduleHere,
      agentCommands,
    );
  },
};
