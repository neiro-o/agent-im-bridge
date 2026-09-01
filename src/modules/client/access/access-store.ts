import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * User-level access authorization for IM channels.
 *
 * The state lives in a single JSON document shared between the long-running
 * bridge process (reads on every inbound message, writes pending requests)
 * and short-lived CLI processes (`agent-bridge access ...`, writes approvals).
 * Every write is atomic (same-directory temp file + rename), so readers never
 * observe a partial document even when the two processes race.
 */

export type AccessGrant = "agent" | "ssh";

export interface AccessUserRecord {
  grants: AccessGrant[];
  name?: string;
  /** Chat the user last requested from — the approval notice is sent here. */
  chatId?: string;
  chatType?: string;
  approvedAt: string;
  /** Set once the bridge has delivered the "approved" notice to the user. */
  notifiedAt?: string;
}

export interface AccessPendingRecord {
  name?: string;
  chatId: string;
  chatType: string;
  firstSeenAt: string;
  lastSeenAt: string;
  requestCount: number;
}

export interface AccessDeniedRecord {
  name?: string;
  deniedAt: string;
}

export interface AccessChannelState {
  users: Record<string, AccessUserRecord>;
  pending: Record<string, AccessPendingRecord>;
  denied: Record<string, AccessDeniedRecord>;
}

export interface AccessFile {
  version: 1;
  channels: Record<string, AccessChannelState>;
}

export function getAccessFilePath(): string {
  // Env override exists for tests and for side-by-side installs; production
  // deployments leave it unset and share the standard config directory.
  const override = process.env.AGENT_BRIDGE_AUTHZ_PATH;
  return override && override.trim() !== ""
    ? override
    : path.join(os.homedir(), ".config", "agent-bridge", "authz.json");
}

export function emptyAccessFile(): AccessFile {
  return { version: 1, channels: {} };
}

function emptyChannelState(): AccessChannelState {
  return { users: {}, pending: {}, denied: {} };
}

function normalizeGrants(raw: unknown): AccessGrant[] {
  if (!Array.isArray(raw)) return ["agent"];
  const grants = raw.filter((grant): grant is AccessGrant => grant === "agent" || grant === "ssh");
  return grants.length > 0 ? [...new Set(grants)] : ["agent"];
}

/** Validates and normalizes a parsed document; corrupt shapes fail closed. */
export function decodeAccessFile(raw: unknown): AccessFile {
  if (!raw || typeof raw !== "object") return emptyAccessFile();
  const channelsRaw = (raw as { channels?: unknown }).channels;
  const channels: Record<string, AccessChannelState> = {};
  if (channelsRaw && typeof channelsRaw === "object") {
    for (const [name, value] of Object.entries(channelsRaw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const state = value as Partial<AccessChannelState>;
      const users: Record<string, AccessUserRecord> = {};
      for (const [openId, record] of Object.entries(state.users ?? {})) {
        if (!record || typeof record !== "object" || typeof record.approvedAt !== "string") continue;
        users[openId] = {
          grants: normalizeGrants(record.grants),
          ...(typeof record.name === "string" ? { name: record.name } : {}),
          ...(typeof record.chatId === "string" ? { chatId: record.chatId } : {}),
          ...(typeof record.chatType === "string" ? { chatType: record.chatType } : {}),
          approvedAt: record.approvedAt,
          ...(typeof record.notifiedAt === "string" ? { notifiedAt: record.notifiedAt } : {}),
        };
      }
      const pending: Record<string, AccessPendingRecord> = {};
      for (const [openId, record] of Object.entries(state.pending ?? {})) {
        if (
          !record ||
          typeof record !== "object" ||
          typeof record.chatId !== "string" ||
          typeof record.firstSeenAt !== "string" ||
          typeof record.lastSeenAt !== "string"
        ) {
          continue;
        }
        pending[openId] = {
          ...(typeof record.name === "string" ? { name: record.name } : {}),
          chatId: record.chatId,
          chatType: typeof record.chatType === "string" ? record.chatType : "dm",
          firstSeenAt: record.firstSeenAt,
          lastSeenAt: record.lastSeenAt,
          requestCount: typeof record.requestCount === "number" ? record.requestCount : 1,
        };
      }
      const denied: Record<string, AccessDeniedRecord> = {};
      for (const [openId, record] of Object.entries(state.denied ?? {})) {
        if (!record || typeof record !== "object" || typeof record.deniedAt !== "string") continue;
        denied[openId] = {
          ...(typeof record.name === "string" ? { name: record.name } : {}),
          deniedAt: record.deniedAt,
        };
      }
      channels[name] = { users, pending, denied };
    }
  }
  return { version: 1, channels };
}

/** Missing file → empty document; malformed JSON → empty document (callers log). */
export async function loadAccessFile(filePath = getAccessFilePath()): Promise<AccessFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyAccessFile();
    throw error;
  }
  try {
    return decodeAccessFile(JSON.parse(raw));
  } catch {
    return emptyAccessFile();
  }
}

export async function saveAccessFile(file: AccessFile, filePath = getAccessFilePath()): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function channelOf(file: AccessFile, channel: string): AccessChannelState {
  return (file.channels[channel] ??= emptyChannelState());
}

/**
 * Atomic load-modify-save behind a per-process FIFO queue. Two writers in the
 * same process (adapter pending writes, approval notices) can never clobber
 * each other; the CLI is a separate short-lived process whose writes land
 * between bridge reads thanks to the atomic rename.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export async function updateAccessFile<T>(
  updater: (file: AccessFile) => T,
  filePath = getAccessFilePath(),
): Promise<T> {
  const run = writeQueue.then(async () => {
    const file = await loadAccessFile(filePath);
    const result = updater(file);
    await saveAccessFile(file, filePath);
    return result;
  });
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface PendingRequestInfo {
  name?: string;
  chatId: string;
  chatType: string;
}

/** Records (or refreshes) a pending authorization request. */
export function recordPendingRequest(
  channel: string,
  openId: string,
  info: PendingRequestInfo,
  now: Date = new Date(),
): (file: AccessFile) => void {
  return (file) => {
    const state = channelOf(file, channel);
    if (state.users[openId] || state.denied[openId]) return;
    const existing = state.pending[openId];
    const name = info.name ?? existing?.name;
    state.pending[openId] = {
      ...(name !== undefined ? { name } : {}),
      chatId: info.chatId,
      chatType: info.chatType,
      firstSeenAt: existing?.firstSeenAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
      requestCount: (existing?.requestCount ?? 0) + 1,
    };
  };
}

/**
 * Grants access. Carries the pending record's chat coordinates onto the user
 * record so the bridge can deliver the approval notice, then clears pending.
 */
export function approveUser(
  channel: string,
  openId: string,
  options: { grants: AccessGrant[]; name?: string },
  now: Date = new Date(),
): (file: AccessFile) => void {
  return (file) => {
    const state = channelOf(file, channel);
    const pending = state.pending[openId];
    delete state.pending[openId];
    delete state.denied[openId];
    const existing = state.users[openId];
    const name = options.name ?? pending?.name ?? existing?.name;
    const chatId = pending?.chatId ?? existing?.chatId;
    const chatType = pending?.chatType ?? existing?.chatType;
    state.users[openId] = {
      grants: [...new Set([...(existing?.grants ?? []), ...options.grants])],
      ...(name !== undefined ? { name } : {}),
      ...(chatId !== undefined ? { chatId } : {}),
      ...(chatType !== undefined ? { chatType } : {}),
      approvedAt: existing?.approvedAt ?? now.toISOString(),
    };
    // Re-arm the one-shot notice so a grant change (for example adding "ssh")
    // is announced to the user as well.
    delete state.users[openId].notifiedAt;
  };
}

/** Moves a pending user to the denied list (silent drop afterwards). */
export function denyUser(
  channel: string,
  openId: string,
  now: Date = new Date(),
): (file: AccessFile) => void {
  return (file) => {
    const state = channelOf(file, channel);
    const pending = state.pending[openId];
    delete state.pending[openId];
    delete state.users[openId];
    state.denied[openId] = {
      ...(pending?.name !== undefined ? { name: pending.name } : {}),
      deniedAt: now.toISOString(),
    };
  };
}

/** Removes an authorization entirely. Returns whether a record existed. */
export function revokeUser(channel: string, openId: string): (file: AccessFile) => boolean {
  return (file) => {
    const state = file.channels[channel];
    if (!state || !state.users[openId]) return false;
    delete state.users[openId];
    return true;
  };
}

/** Marks the approval notice as delivered so it is sent exactly once. */
export function markApprovalNotified(
  channel: string,
  openId: string,
  now: Date = new Date(),
): (file: AccessFile) => void {
  return (file) => {
    const user = file.channels[channel]?.users[openId];
    if (user) user.notifiedAt = now.toISOString();
  };
}
