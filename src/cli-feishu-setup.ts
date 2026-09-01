import type { AgentConfig, ChannelConfig, ClientConfig, FeishuClientConfig } from "./types";
import { createPromptContext } from "./config/prompt";
import { getConfigPath, loadConfig, saveConfig } from "./config/store";
import { getAgentModule, listAgentModules } from "./modules/agent";
import { approveUser, updateAccessFile } from "./modules/client/access/access-store";
import {
  FEISHU_CONSOLE_STEPS,
  FEISHU_REQUIRED_SCOPES,
  createDefaultProbeClient,
  feishuAppConsoleUrl,
  feishuCreateAppUrl,
  probeFixHint,
  renderTerminalQr,
  runFeishuProbe,
  verifyFeishuCredentials,
  type FeishuProbeReport,
} from "./modules/client/feishu/setup/feishu-setup";

/**
 * `agent-bridge feishu setup`: guided Feishu bot onboarding.
 *
 * Feishu has no OpenAPI for creating a custom app / granting its scopes /
 * publishing a version (console UI + tenant admin review only), so this
 * wizard guides the human through those console steps with exact checklists
 * and QR codes, then verifies everything it can: credentials via a token
 * request, and every capability via a live WebSocket probe. The first person
 * to message the bot during the probe is captured as the admin and can be
 * seeded as the first authorized user.
 */
export async function setupFeishuChannel(): Promise<void> {
  const ctx = createPromptContext();
  try {
    console.log("Feishu bot guided setup.");
    console.log(
      "Feishu requires app creation / permission grants / version publish in the developer console",
    );
    console.log("(no API exists for them) — this wizard walks you through, then verifies live.\n");

    const domain = (await ctx.select("Feishu domain", [
      { label: "Feishu (default)", value: "feishu" },
      { label: "Lark (international)", value: "lark" },
    ])) as FeishuClientConfig["domain"];

    const hasApp = await ctx.confirm("Do you already have a Feishu custom app (App ID + App Secret)?", true);
    if (!hasApp) {
      const createUrl = feishuCreateAppUrl(domain);
      console.log("\nOpen the developer console and click 创建企业自建应用:");
      console.log(`   ${createUrl}`);
      if (await renderTerminalQr(createUrl)) {
        console.log("(or scan the QR code above with your phone)");
      }
      await ctx.confirm("App created — continue?", true);
    }

    let appId = "";
    let appSecret = "";
    for (;;) {
      appId = await ctx.input("Feishu App ID", {
        required: true,
        ...(appId !== "" ? { defaultValue: appId } : {}),
        validate: (value) => (value ? null : "App ID is required"),
      });
      appSecret = await ctx.input("Feishu App Secret", {
        required: true,
        secret: true,
        validate: (value) => (value ? null : "App Secret is required"),
      });

      if (appId !== "") printConsoleChecklist(domain ?? "feishu", appId);
      await ctx.confirm(
        "All console steps above are done (scopes granted, bot enabled, event subscribed, version published)?",
        true,
      );

      const check = await verifyFeishuCredentials(appId, appSecret, domain);
      if (check.ok) {
        console.log("Credential check passed (tenant_access_token acquired).");
        break;
      }
      console.log(`Credential check failed: ${check.detail}`);
      if (!(await ctx.confirm("Re-enter App ID / App Secret and retry?", true))) {
        throw new Error("Feishu setup aborted: invalid credentials");
      }
    }

    let report: FeishuProbeReport;
    for (;;) {
      report = await runFeishuProbe({
        createClient: () => createDefaultProbeClient({ appId, appSecret, domain }),
        announce: (text) => console.log(`\n>> ${text}`),
      });
      printProbeReport(report, domain ?? "feishu", appId);
      if (!report.probes.some((probe) => probe.status === "fail")) break;
      if (!(await ctx.confirm("Fix the failed items in the console, then re-run the probe?", true))) break;
    }

    const requireMentionInGroup = await ctx.confirm("Require @mention in group chats?", true);
    const admin = report.admin && report.admin.openId !== "" ? report.admin : undefined;
    const enableAccessControl = await ctx.confirm(
      admin
        ? `Enable user access control? Other users will need your CLI approval; you (${admin.name ?? admin.openId}) become the first authorized user.`
        : "Enable user access control? Users will need CLI approval before they can use the bot.",
      Boolean(admin),
    );

    const clientConfig: FeishuClientConfig = {
      appId,
      appSecret,
      domain,
      requireMentionInGroup,
      ...(enableAccessControl ? { accessControl: { enabled: true } } : {}),
    };

    if (!(await ctx.confirm("Create a bridge channel with this Feishu config now?", true))) {
      console.log("Skipped channel creation. Run `agent-bridge add` later with these credentials.");
      return;
    }

    const config = await loadConfig();
    const channelName = await ctx.input("Channel name", {
      required: true,
      validate: (value) => {
        if (!value) return "Channel name is required";
        if (config.channels[value]) return "Channel name already exists";
        return null;
      },
    });

    const language = await ctx.select("Channel language", [
      { label: "English (en-US)", value: "en-US" },
      { label: "中文 (zh-CN)", value: "zh-CN" },
    ]);

    const agentType = await ctx.select(
      "Select agent module",
      listAgentModules().map((module) => ({ label: module.type, value: module.type })),
    );
    const agentModule = getAgentModule(agentType);
    if (!agentModule) throw new Error(`No agent module for type: ${agentType}`);
    const agentCollector = agentModule.createConfigCollector?.();
    const agentConfig = agentCollector ? await agentCollector.collect(ctx) : {};
    if (agentCollector) await agentCollector.validate(agentConfig);

    config.channels[channelName] = {
      common: { language: language as ChannelConfig["common"]["language"] },
      client: { type: "feishu", config: clientConfig } as ClientConfig,
      agent: { type: agentType, config: agentConfig } as AgentConfig,
    } satisfies ChannelConfig;
    await saveConfig(config);
    console.log(`Saved channel ${channelName} to ${getConfigPath()}`);

    if (enableAccessControl && admin) {
      await updateAccessFile(
        approveUser(channelName, admin.openId, {
          grants: ["agent"],
          ...(admin.name !== undefined ? { name: admin.name } : {}),
        }),
      );
      console.log(
        `Seeded ${admin.name ?? admin.openId} (${admin.openId}) as the first authorized user.`,
      );
    }

    printNextSteps(
      channelName,
      enableAccessControl,
      report.probes.some((probe) => probe.status === "fail"),
    );
  } finally {
    ctx.close();
  }
}

function printConsoleChecklist(domain: NonNullable<FeishuClientConfig["domain"]>, appId: string): void {
  const authUrl = feishuAppConsoleUrl(domain, appId, "auth");
  const appUrl = feishuAppConsoleUrl(domain, appId);
  console.log("\nComplete these steps in the developer console:");
  console.log("\n[1] Grant API scopes (开发配置 → 权限管理):");
  for (const scope of FEISHU_REQUIRED_SCOPES) {
    console.log(`    - ${scope.scope} (${scope.consoleName}) — ${scope.purpose}`);
  }
  console.log(`    Permission page: ${authUrl}`);
  console.log("\n[2] Other console steps:");
  for (const [index, step] of FEISHU_CONSOLE_STEPS.entries()) {
    console.log(`    ${index + 1}. ${step.title}`);
    console.log(`       ${step.detail}`);
  }
  console.log(`    App console: ${appUrl}`);
}

function printProbeReport(
  report: FeishuProbeReport,
  domain: NonNullable<FeishuClientConfig["domain"]>,
  appId: string,
): void {
  console.log("\nCapability probe result:");
  const labels: Record<string, string> = {
    receive: "receive messages (event subscription, bot capability, published version)",
    send: "send messages (im:message)",
    reaction: "typing reactions (im:message)",
    download: "download attachments (im:message:readonly)",
    upload: "send attachments (im:resource)",
  };
  for (const probe of report.probes) {
    const icon = probe.status === "ok" ? "PASS" : probe.status === "skip" ? "SKIP" : "FAIL";
    console.log(
      `  [${icon}] ${labels[probe.key] ?? probe.key}${probe.detail ? ` — ${probe.detail}` : ""}`,
    );
    const hint = probeFixHint(probe, domain, appId);
    if (hint) console.log(`        fix: ${hint}`);
  }
  if (report.admin) {
    console.log(
      `  Admin detected: ${report.admin.name ?? "?"} (${report.admin.openId}) in chat ${report.admin.chatId}`,
    );
  }
}

function printNextSteps(
  channelName: string,
  accessControl: boolean,
  probeHadFailures: boolean,
): void {
  console.log("\nNext steps:");
  if (probeHadFailures) {
    console.log("- Some probes failed or were skipped; re-run `agent-bridge feishu setup` after fixing them.");
  }
  console.log(`- Start the bridge: agent-bridge start ${channelName}`);
  if (accessControl) {
    console.log("- Approve users who message the bot:");
    console.log("    agent-bridge access pending");
    console.log("    agent-bridge access approve <open-id> [--ssh]");
  }
}
