import type {
  AgentCommandDescriptor,
  ChannelCommonContext,
  ClientInputEvent,
  ClientOutputEvent,
  ClientSessionStateStore,
  FeishuClientConfig,
  IMAdapter,
  OnScheduleHere,
  OnScheduleRun,
} from "../../../../types";
import { formatSendFailureNotice, getTranslatorForCommon, type Translator } from "../../../../i18n";
import { createLogger, type Logger } from "../../../../core/logger";
import { isCompletedCommandResponse, isTerminalAgentError } from "../../utils/error-events";
import { ProgressRenderer } from "../../utils/progress-renderer";
import {
  formatScheduleHereReply,
  formatScheduleRunReply,
  parseSlashCommand,
  resolveHelpMarkdown,
  resolveSlashCommandEvent,
  type ScheduleHereCommand,
  type ScheduleHereUsageCommand,
  type ScheduleRunCommand,
  type ScheduleRunUsageCommand,
} from "../../utils/slash-commands";
import {
  createInMemoryImClientSessionStateStore,
  type ImClientSessionStateV1,
} from "../../utils/client-session-state";
import { renderStatusMarkdown } from "../../utils/status-markdown";
import { sendOutboundAttachment } from "../../utils/outbound-attachment";
import { ChatModeController, normalizeChatModeConfig, type LocalAction } from "../../modes/chat-mode-controller";
import { AccessController } from "../../access/access-controller";
import { FeishuClient } from "./feishu-client";
import { buildFeishuSessionId, parseFeishuSessionId } from "./feishu-session";

const MAX_TEXT_CHUNK = 4000;

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitPos = remaining.lastIndexOf("\n", maxLen);
    if (splitPos <= 0) {
      splitPos = remaining.lastIndexOf(" ", maxLen);
    }

    if (splitPos <= 0) {
      chunks.push(remaining.slice(0, maxLen));
      remaining = remaining.slice(maxLen);
      continue;
    }

    chunks.push(remaining.slice(0, splitPos + 1));
    remaining = remaining.slice(splitPos + 1);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

export class FeishuIMAdapter implements IMAdapter {
  readonly #config: FeishuClientConfig;
  readonly #logger: Logger;
  readonly #t: Translator;
  readonly #sessionState: ClientSessionStateStore<ImClientSessionStateV1>;
  readonly #onScheduleRun: OnScheduleRun | undefined;
  readonly #onScheduleHere: OnScheduleHere | undefined;
  readonly #agentCommands: AgentCommandDescriptor[];
  readonly #modeController: ChatModeController | null;
  readonly #accessController: AccessController | null;
  readonly #accessNoticePollMs: number;
  #onOutput: ((event: ClientOutputEvent) => Promise<void> | void) | null = null;
  #client: FeishuClient | null = null;
  #egressQueue: ClientInputEvent[] = [];
  #processing = false;
  #accessNoticeTimer: ReturnType<typeof setInterval> | null = null;
  #lastInboundMessageIdBySession = new Map<string, string>();
  #progressStateBySession = new Map<
    string,
    {
      renderer: ProgressRenderer;
      messageId: string | null;
      creating: boolean;
    }
  >();

  static buildProgressCard(markdown: string): Record<string, unknown> {
    return {
      schema: "2.0",
      body: {
        elements: [
          {
            tag: "markdown",
            content: markdown,
          },
        ],
      },
    };
  }

  async #notifySendFailure(chatId: string, error: unknown): Promise<void> {
    if (!this.#client) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const text = formatSendFailureNotice(this.#t, message);

    try {
      await this.#client.sendText(chatId, text);
    } catch (notifyError) {
      this.#logger.error("failed to notify send failure:", notifyError);
    }
  }

  constructor(
    config: FeishuClientConfig,
    logger: Logger = createLogger("feishu"),
    common?: ChannelCommonContext,
    sessionState: ClientSessionStateStore<ImClientSessionStateV1> = createInMemoryImClientSessionStateStore(
      "feishu",
    ),
    onScheduleRun?: OnScheduleRun,
    onScheduleHere?: OnScheduleHere,
    agentCommands: AgentCommandDescriptor[] = [],
    /** Test seam: overrides the approval-notice poll interval (default 3s). */
    options?: { accessNoticePollMs?: number },
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#t = getTranslatorForCommon(common);
    this.#sessionState = sessionState;
    this.#onScheduleRun = onScheduleRun;
    this.#onScheduleHere = onScheduleHere;
    this.#agentCommands = agentCommands;
    this.#accessNoticePollMs = options?.accessNoticePollMs ?? 3000;
    this.#accessController = config.accessControl?.enabled
      ? new AccessController({
          channelName: common?.channelName ?? "",
          t: this.#t,
        })
      : null;
    this.#modeController = config.localControl
      ? new ChatModeController({
          config: normalizeChatModeConfig(config.localControl),
          loadWorkingDirectory: async (clientSessionId) =>
            (await this.#sessionState.session(clientSessionId).read())?.sshWorkingDirectory,
          saveWorkingDirectory: async (clientSessionId, cwd) => {
            await this.#sessionState.session(clientSessionId).update((current) => ({
              version: 1,
              ...(current?.defaultWorkingDirectory
                ? { defaultWorkingDirectory: current.defaultWorkingDirectory }
                : {}),
              sshWorkingDirectory: cwd,
            }));
          },
          // When user access control is on, SSH additionally requires the
          // elevated "ssh" grant; the chat allowlist keeps applying on top.
          ...(this.#accessController
            ? {
                authorizeSsh: (message: { senderId?: string }) =>
                  this.#accessController!.hasGrant(message.senderId, "ssh"),
                sshDeniedText: (senderId?: string) =>
                  this.#t("client.accessSshDenied", {
                    command: `agent-bridge access approve ${senderId ?? "<open-id>"} --ssh`,
                  }),
              }
            : {}),
        })
      : null;
  }

  async start(onOutput: (event: ClientOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new FeishuClient(this.#config, this.#logger);
    this.#client.setOnMessage(async ({ chatId, chatType, text, messageId, mentionedBot, senderId, senderName, attachments }) => {
      if (!this.#onOutput) {
        this.#logger.warn(`dropping inbound message, adapter not ready (chatId=${chatId})`);
        return;
      }

      const clientSessionId = buildFeishuSessionId(chatType, chatId);

      if (chatType === "group" && (this.#config.requireMentionInGroup ?? true) && !mentionedBot) {
        this.#logger.debug(
          `ignoring group message without bot mention (session=${clientSessionId} messageId=${messageId})`,
        );
        return;
      }

      if (this.#accessController) {
        let verdict;
        try {
          verdict = await this.#accessController.check({
            chatId,
            chatType,
            senderId,
            ...(senderName !== undefined ? { senderName } : {}),
          });
        } catch (error) {
          // Fail closed: a broken authz store must never open the gate.
          this.#logger.error("access control check failed:", error);
          verdict = { allowed: false };
        }
        if (!verdict.allowed) {
          if (verdict.reply) {
            await this.#client?.sendText(chatId, verdict.reply, messageId);
          }
          return;
        }
      }

      const normalizedText = text.trim();
      this.#lastInboundMessageIdBySession.set(clientSessionId, messageId);
      this.#resetProgressState(clientSessionId);
      await this.#client?.startTyping(chatId, messageId);

      if (this.#modeController) {
        try {
          const actions = await this.#modeController.handle({
            clientSessionId,
            chatType,
            text,
            senderId,
            attachments,
          });
          if (!(actions.length === 1 && actions[0].type === "forward")) {
            for (const action of actions) {
              await this.#executeLocalAction(action, chatId, messageId);
            }
            await this.#client?.stopTyping(chatId);
            return;
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await this.#client?.sendText(chatId, `SSH 模式操作失败：${detail}`, messageId);
          await this.#client?.stopTyping(chatId);
          return;
        }
      }

      const helpMarkdown = resolveHelpMarkdown(normalizedText, this.#t, {
        agentCommands: this.#agentCommands,
        includeLocalControl: Boolean(
          this.#config.localControl?.enabled &&
          this.#config.localControl.allowedClientSessionIds?.includes(clientSessionId) &&
          (chatType !== "group" || this.#config.localControl.allowGroupChats),
        ),
      });
      if (helpMarkdown) {
        this.#logger.info(`received local help command ${normalizedText} (session=${clientSessionId})`);
        await this.#client?.sendText(chatId, helpMarkdown, messageId);
        await this.#client?.stopTyping(chatId);
        return;
      }

      const parsedCommand = parseSlashCommand(normalizedText, clientSessionId);
      if (parsedCommand) {
        if (parsedCommand.type === "schedule.run" || parsedCommand.type === "schedule.run.usage") {
          // Adapter-local manual trigger (spec D7a): never reaches the core.
          this.#logger.info(`received local schedule-run command ${normalizedText} (session=${clientSessionId})`);
          await this.#handleScheduleRun(parsedCommand, chatId, messageId);
          return;
        }
        if (parsedCommand.type === "schedule.here" || parsedCommand.type === "schedule.here.usage") {
          // Adapter-local target binding (spec D7): never reaches the core.
          this.#logger.info(`received local schedule-here command ${normalizedText} (session=${clientSessionId})`);
          await this.#handleScheduleHere(parsedCommand, chatId, messageId);
          return;
        }
        this.#logger.info(`received command ${normalizedText} (session=${clientSessionId})`);
        const resolved = await resolveSlashCommandEvent(parsedCommand, {
          sessionState: this.#sessionState.session(clientSessionId),
          onError: (error) =>
            this.#logger.error("failed to resolve the remembered /new working directory:", error),
        });
        // The adapter may have stopped while the store resolution was in
        // flight; never emit through a torn-down output handler.
        if (!this.#onOutput) return;
        if (resolved.type === "invalid-working-directory") {
          const text = resolved.remembered
            ? this.#t("client.invalidRememberedWorkingDirectory", {
                workingDirectory: resolved.workingDirectory,
                detail: resolved.detail,
              })
            : this.#t("client.invalidNewWorkingDirectory", {
                workingDirectory: resolved.workingDirectory,
                detail: resolved.detail,
              });
          await this.#client?.sendText(chatId, text, messageId);
          await this.#client?.stopTyping(chatId);
          return;
        }
        await this.#onOutput(resolved);
        return;
      }

      this.#logger.info(`received user message (session=${clientSessionId}): ${normalizedText}`);
      await this.#onOutput({
        type: "user.message",
        clientSessionId,
        text,
      });
    });

    await this.#client.connect();
    this.#logger.info(
      `adapter started (domain=${this.#config.domain ?? "feishu"}, accessControl=${this.#accessController ? "on" : "off"})`,
    );

    if (this.#accessController) {
      // Watches the authz file for CLI approvals and notifies each approved
      // user in the chat they last requested from.
      this.#accessNoticeTimer = setInterval(() => {
        void this.#deliverAccessNotices();
      }, this.#accessNoticePollMs);
      this.#accessNoticeTimer.unref?.();
    }
  }

  async #deliverAccessNotices(): Promise<void> {
    if (!this.#accessController || !this.#client) return;
    let notices;
    try {
      notices = await this.#accessController.pollApprovalNotices();
    } catch (error) {
      this.#logger.warn("failed to poll access approvals:", error);
      return;
    }
    for (const notice of notices) {
      try {
        await this.#client.sendText(notice.chatId, this.#t("client.accessApprovedNotice"));
        await this.#accessController.markNotified(notice.senderId);
      } catch (error) {
        this.#logger.warn(`failed to notify approved user ${notice.senderId}:`, error);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.#accessNoticeTimer) {
      clearInterval(this.#accessNoticeTimer);
      this.#accessNoticeTimer = null;
    }
    this.#egressQueue.length = 0;
    await this.#modeController?.stop();
    if (this.#client) {
      await this.#client.disconnect();
      this.#client = null;
    }
    this.#processing = false;
    this.#onOutput = null;
    this.#logger.info("adapter stopped");
  }

  async input(event: ClientInputEvent): Promise<void> {
    if (!this.#client) {
      throw new Error("FeishuIMAdapter is not started");
    }

    this.#egressQueue.push(event);
    this.#logger.debug(
      `egress event queued (session=${event.clientSessionId} queueDepth=${this.#egressQueue.length})`,
    );
    void this.#drainEgressQueue();
  }

  async isBusy(): Promise<boolean> {
    return this.#processing || this.#egressQueue.length > 0;
  }

  async #drainEgressQueue(): Promise<void> {
    if (this.#processing) {
      return;
    }

    this.#processing = true;
    try {
      while (this.#client && this.#egressQueue.length > 0) {
        const event = this.#egressQueue.shift();
        if (!event) continue;

        try {
          const target = parseFeishuSessionId(event.clientSessionId);

          if (event.type !== "assistant.message") {
            const statusMarkdown = renderStatusMarkdown(event, this.#t);
            if (statusMarkdown) {
const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
              if (isTerminalAgentError(event) || isCompletedCommandResponse(event)) {
                this.#progressStateBySession.delete(event.clientSessionId);
                await this.#client.stopTyping(target.chatId);
              }
              await this.#client.sendText(target.chatId, statusMarkdown, replyToMessageId);
              continue;
            }

            await this.#handleProgressEvent(target.chatId, event);
            continue;
          }

          const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
          this.#logger.info(`sending reply (session=${event.clientSessionId})`);
          if (event.text.trim().length > 0) {
            const chunks = chunkText(event.text, MAX_TEXT_CHUNK);
            for (const [index, chunk] of chunks.entries()) {
              await this.#client.sendText(target.chatId, chunk, index === 0 ? replyToMessageId : undefined);
            }
          }
          for (const attachment of event.attachments ?? []) {
            try {
              await sendOutboundAttachment(attachment, () =>
                this.#client!.sendAttachment(target.chatId, attachment, replyToMessageId),
              );
            } catch (attachmentError) {
              this.#logger.error("failed to send attachment:", attachmentError);
              await this.#notifySendFailure(target.chatId, attachmentError);
            }
          }
          await this.#client.stopTyping(target.chatId);
          this.#logger.debug(`reply sent (session=${event.clientSessionId})`);
        } catch (error) {
          this.#logger.error("failed to send egress event:", error);
          try {
            const target = parseFeishuSessionId(event.clientSessionId);
            await this.#client.stopTyping(target.chatId);
            await this.#notifySendFailure(target.chatId, error);
          } catch (notifyError) {
            this.#logger.error("failed to handle egress send failure:", notifyError);
          }
        }
      }
    } finally {
      this.#processing = false;
    }
  }

  async #executeLocalAction(action: LocalAction, chatId: string, messageId: string): Promise<void> {
    if (!this.#client) return;
    if (action.type === "reply") {
      await this.#client.sendText(chatId, action.text, messageId);
      return;
    }
    if (action.type === "attachment") {
      try {
        await this.#client.sendAttachment(chatId, {
          kind: action.kind ?? "file",
          filePath: action.filePath,
          fileName: action.fileName,
        }, messageId);
      } finally {
        await action.cleanup?.();
      }
    }
  }

  async #handleProgressEvent(
    chatId: string,
    event: Exclude<ClientInputEvent, { type: "assistant.message" }>,
  ): Promise<void> {
    if (!this.#client) {
      return;
    }

    const state = this.#progressStateBySession.get(event.clientSessionId) ?? {
      renderer: new ProgressRenderer({ t: this.#t }),
      messageId: null,
      creating: false,
    };
    this.#progressStateBySession.set(event.clientSessionId, state);

    if (!state.renderer.isProgressEvent(event)) {
      return;
    }
    state.renderer.takeProgressEvent(event);

    const card = FeishuIMAdapter.buildProgressCard(state.renderer.getCurrentProgress().markdown);
    if (state.messageId) {
      await this.#client.updateCard(state.messageId, card);
      return;
    }

    if (state.creating) {
      return;
    }

    state.creating = true;
    try {
      state.messageId = await this.#client.sendCard(
        chatId,
        card,
        this.#lastInboundMessageIdBySession.get(event.clientSessionId),
      );
    } finally {
      state.creating = false;
    }
  }

  #resetProgressState(clientSessionId: string): void {
    this.#progressStateBySession.set(clientSessionId, {
      renderer: new ProgressRenderer({ t: this.#t }),
      messageId: null,
      creating: false,
    });
  }

  async #handleScheduleRun(
    command: ScheduleRunCommand | ScheduleRunUsageCommand,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    if (command.type === "schedule.run.usage") {
      await this.#client?.sendText(chatId, this.#t("client.scheduleRunUsage"), messageId);
      await this.#client?.stopTyping(chatId);
      return;
    }

    if (!this.#onScheduleRun) {
      // The runner always injects the bridge (spec D7a); degrade gracefully
      // if it is ever absent: log, and reply nothing.
      this.#logger.warn(
        `onScheduleRun is not injected; dropping /schedule-run for task "${command.taskName}" (session=${command.clientSessionId})`,
      );
      await this.#client?.stopTyping(chatId);
      return;
    }

    const result = await this.#onScheduleRun(command.taskName, command.clientSessionId);
    const text = formatScheduleRunReply(result, command.taskName, this.#t);
    await this.#client?.sendText(chatId, text, messageId);
    await this.#client?.stopTyping(chatId);
  }

  async #handleScheduleHere(
    command: ScheduleHereCommand | ScheduleHereUsageCommand,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    if (command.type === "schedule.here.usage") {
      await this.#client?.sendText(chatId, this.#t("client.scheduleHereUsage"), messageId);
      await this.#client?.stopTyping(chatId);
      return;
    }

    if (!this.#onScheduleHere) {
      // The runner always injects the bridge (spec D7); degrade gracefully
      // if it is ever absent: log, and reply nothing.
      this.#logger.warn(
        `onScheduleHere is not injected; dropping /schedule-here for task "${command.taskName}" (session=${command.clientSessionId})`,
      );
      await this.#client?.stopTyping(chatId);
      return;
    }

    const result = await this.#onScheduleHere(command.taskName, command.clientSessionId);
    const text = formatScheduleHereReply(result, command.taskName, this.#t);
    await this.#client?.sendText(chatId, text, messageId);
    await this.#client?.stopTyping(chatId);
  }
}
