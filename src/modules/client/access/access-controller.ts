import type { Translator } from "../../../i18n";
import {
  loadAccessFile,
  markApprovalNotified,
  recordPendingRequest,
  updateAccessFile,
  type AccessGrant,
} from "./access-store";

export interface AccessCheckInput {
  chatId: string;
  chatType: string;
  senderId?: string;
  senderName?: string;
}

export type AccessVerdict =
  | { allowed: true }
  | { allowed: false; reply?: string };

export interface ApprovalNotice {
  senderId: string;
  name?: string;
  chatId: string;
  chatType: string;
}

export interface AccessControllerOptions {
  channelName: string;
  t: Translator;
  filePath?: string;
  /** Minimum interval between two "waiting for approval" replies per user. */
  replyThrottleMs?: number;
  /** Minimum interval between two persisted pending-record refreshes per user. */
  pendingWriteThrottleMs?: number;
  now?: () => number;
}

/**
 * Hot-path gate for inbound messages when a channel's user access control is
 * enabled. Approved users pass through; unknown users are recorded as pending
 * (for the CLI `access pending` list) and get a throttled "waiting for
 * approval" reply; denied users are dropped silently.
 *
 * The store file is re-read on every check so CLI approvals take effect
 * without a bridge restart; the atomic writer keeps reads consistent.
 */
export class AccessController {
  readonly #channelName: string;
  readonly #t: Translator;
  readonly #filePath?: string;
  readonly #replyThrottleMs: number;
  readonly #pendingWriteThrottleMs: number;
  readonly #now: () => number;
  readonly #lastReplyAt = new Map<string, number>();
  readonly #lastPendingWriteAt = new Map<string, number>();

  constructor(options: AccessControllerOptions) {
    this.#channelName = options.channelName;
    this.#t = options.t;
    this.#filePath = options.filePath;
    this.#replyThrottleMs = options.replyThrottleMs ?? 60_000;
    this.#pendingWriteThrottleMs = options.pendingWriteThrottleMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  async check(input: AccessCheckInput): Promise<AccessVerdict> {
    const file = await loadAccessFile(this.#filePath);
    const state = file.channels[this.#channelName];
    const senderId = input.senderId;

    if (senderId && state?.users[senderId]?.grants.includes("agent")) {
      return { allowed: true };
    }

    if (!senderId) {
      // An undentified sender can never be matched against the allowlist;
      // fail closed without creating a pending record.
      return { allowed: false, reply: this.#t("client.accessPendingReply") };
    }

    if (state?.denied[senderId]) {
      return { allowed: false };
    }

    await this.#recordPendingThrottled(input, senderId);
    return {
      allowed: false,
      reply: this.#shouldReply(senderId)
        ? this.#t("client.accessPendingReply", {
            command: `agent-bridge access approve ${senderId}`,
          })
        : undefined,
    };
  }

  /** Elevated-grant check used by privileged modes (for example `/ssh`). */
  async hasGrant(senderId: string | undefined, grant: AccessGrant): Promise<boolean> {
    if (!senderId) return false;
    const file = await loadAccessFile(this.#filePath);
    return file.channels[this.#channelName]?.users[senderId]?.grants.includes(grant) ?? false;
  }

  /**
   * Read-only list of approvals that still need a user-facing notice. The
   * caller delivers the message and then calls {@link markNotified}; a failed
   * delivery leaves the record un-notified so the next poll retries.
   */
  async pollApprovalNotices(): Promise<ApprovalNotice[]> {
    const file = await loadAccessFile(this.#filePath);
    const state = file.channels[this.#channelName];
    if (!state) return [];
    const notices: ApprovalNotice[] = [];
    for (const [senderId, user] of Object.entries(state.users)) {
      if (user.notifiedAt || !user.chatId) continue;
      notices.push({
        senderId,
        ...(user.name !== undefined ? { name: user.name } : {}),
        chatId: user.chatId,
        chatType: user.chatType ?? "dm",
      });
    }
    return notices;
  }

  async markNotified(senderId: string): Promise<void> {
    await updateAccessFile(markApprovalNotified(this.#channelName, senderId), this.#filePath);
  }

  async #recordPendingThrottled(input: AccessCheckInput, senderId: string): Promise<void> {
    const lastWrite = this.#lastPendingWriteAt.get(senderId) ?? 0;
    if (this.#now() - lastWrite < this.#pendingWriteThrottleMs) return;
    this.#lastPendingWriteAt.set(senderId, this.#now());
    await updateAccessFile(
      recordPendingRequest(this.#channelName, senderId, {
        ...(input.senderName !== undefined ? { name: input.senderName } : {}),
        chatId: input.chatId,
        chatType: input.chatType,
      }),
      this.#filePath,
    );
  }

  #shouldReply(senderId: string): boolean {
    const last = this.#lastReplyAt.get(senderId) ?? 0;
    if (this.#now() - last < this.#replyThrottleMs) return false;
    this.#lastReplyAt.set(senderId, this.#now());
    return true;
  }
}
