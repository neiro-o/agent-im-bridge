import type { Translator } from "../../../i18n";
import type { AgentCommandDescriptor } from "../../../types";

interface HelpCommandRow {
  group: string;
  syntax: string;
  aliases?: string[];
  description: string;
}

export interface RenderHelpMarkdownOptions {
  agentCommands?: AgentCommandDescriptor[];
  includeLocalControl?: boolean;
}

function code(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function commonRows(t: Translator): HelpCommandRow[] {
  return [
    { group: t("client.helpGroupBridge"), syntax: "/new [path]", aliases: ["/n"], description: t("client.helpNew") },
    { group: t("client.helpGroupBridge"), syntax: "/compact [instructions]", aliases: ["/c"], description: t("client.helpCompact") },
    { group: t("client.helpGroupBridge"), syntax: "/stop", aliases: ["/s"], description: t("client.helpStop") },
    { group: t("client.helpGroupBridge"), syntax: "/status", aliases: ["/st"], description: t("client.helpStatus") },
    { group: t("client.helpGroupBridge"), syntax: "/model [provider/model]", aliases: ["/m"], description: t("client.helpModel") },
    { group: t("client.helpGroupAutomation"), syntax: "/schedule-run <task>", description: t("client.helpScheduleRun") },
    { group: t("client.helpGroupAutomation"), syntax: "/schedule-here <task>", description: t("client.helpScheduleHere") },
    { group: t("client.helpGroupAutomation"), syntax: "/queue-here <queue>", description: t("client.helpQueueHere") },
    { group: t("client.helpGroupBridge"), syntax: "/help", aliases: ["/h"], description: t("client.helpHelp") },
  ];
}

function localRows(t: Translator): HelpCommandRow[] {
  return [
    { group: t("client.helpGroupLocal"), syntax: "/agent", description: t("client.helpAgent") },
    { group: t("client.helpGroupLocal"), syntax: "/ssh", description: t("client.helpSsh") },
    { group: t("client.helpGroupLocal"), syntax: "/upload", description: t("client.helpUpload") },
    { group: t("client.helpGroupLocal"), syntax: "/upload-cancel", description: t("client.helpUploadCancel") },
    { group: t("client.helpGroupLocal"), syntax: "/download <path-or-pattern>", description: t("client.helpDownload") },
  ];
}

export function renderHelpMarkdown(t: Translator, options: RenderHelpMarkdownOptions = {}): string {
  const rows = commonRows(t);
  if (options.includeLocalControl) rows.push(...localRows(t));

  for (const descriptor of options.agentCommands ?? []) {
    rows.push({
      group: t("client.helpGroupAgent"),
      syntax: `/${descriptor.name}${descriptor.argumentHint ? ` ${descriptor.argumentHint}` : ""}`,
      aliases: descriptor.aliases?.map((alias) => `/${alias}`),
      description: descriptor.description,
    });
  }

  const header = `| ${t("client.helpColumnGroup")} | ${t("client.helpColumnCommand")} | ${t("client.helpColumnAliases")} | ${t("client.helpColumnDescription")} |`;
  const separator = "|---|---|---|---|";
  const body = rows.map((row) => {
    const aliases = row.aliases?.map(code).join(" ") ?? "—";
    return `| ${cell(row.group)} | ${cell(code(row.syntax))} | ${cell(aliases)} | ${cell(row.description)} |`;
  });

  return [`## ${t("client.helpTitle")}`, "", header, separator, ...body, "", t("client.helpCopyHint")].join("\n");
}
