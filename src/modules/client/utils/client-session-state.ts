import type { ClientSessionStateCodec, ClientSessionStateStore } from "../../../types";
import { createInMemoryChannelStateStore } from "../../../config/channel-state";
import { createClientSessionStateStore } from "../../../config/client-session-state";

/**
 * Versioned per-chat state shared by all built-in IM client modules
 * (feishu/wecom/weixin). Currently it carries only the remembered `/new`
 * working directory; new fields must be added as optional with a decode-time
 * default so older records keep decoding.
 */
export interface ImClientSessionStateV1 {
  version: 1;
  /**
   * Last working directory the user explicitly passed to `/new <path>` in
   * this chat. Used as the default for a later bare `/new`.
   */
  defaultWorkingDirectory?: string;
  /** Last canonical cwd used by the authorized Feishu SSH mode. */
  sshWorkingDirectory?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates and encodes the shared IM client session state. `stateVersion`
 * is strictly validated: any version other than the current one fails decode
 * (fail-safe) instead of being silently coerced.
 */
export const imClientSessionStateCodec: ClientSessionStateCodec<ImClientSessionStateV1> = {
  currentVersion: 1,

  decode(raw, stateVersion, _context) {
    if (!isRecord(raw)) {
      throw new Error("invalid IM client session state: expected a state document");
    }
    if (raw.version !== 1) {
      throw new Error("invalid IM client session state: expected a versioned state document");
    }
    if (stateVersion !== 1) {
      throw new Error(`unsupported IM client session state version ${stateVersion}`);
    }
    if (
      raw.defaultWorkingDirectory !== undefined &&
      (typeof raw.defaultWorkingDirectory !== "string" || raw.defaultWorkingDirectory.length === 0)
    ) {
      throw new Error(
        "invalid IM client session state: defaultWorkingDirectory must be a non-empty string when present",
      );
    }
    if (
      raw.sshWorkingDirectory !== undefined &&
      (typeof raw.sshWorkingDirectory !== "string" || raw.sshWorkingDirectory.length === 0)
    ) {
      throw new Error(
        "invalid IM client session state: sshWorkingDirectory must be a non-empty string when present",
      );
    }
    return {
      version: 1,
      ...(typeof raw.defaultWorkingDirectory === "string"
        ? { defaultWorkingDirectory: raw.defaultWorkingDirectory }
        : {}),
      ...(typeof raw.sshWorkingDirectory === "string"
        ? { sshWorkingDirectory: raw.sshWorkingDirectory }
        : {}),
    };
  },

  encode(state) {
    // Validate before persisting: a forged state must fail here, while the
    // writer still owns the failure, never on the next decode.
    if (state.version !== 1) {
      throw new Error("invalid IM client session state: version must be 1");
    }
    if (
      state.defaultWorkingDirectory !== undefined &&
      (typeof state.defaultWorkingDirectory !== "string" || state.defaultWorkingDirectory.length === 0)
    ) {
      throw new Error(
        "invalid IM client session state: defaultWorkingDirectory must be a non-empty string when present",
      );
    }
    if (
      state.sshWorkingDirectory !== undefined &&
      (typeof state.sshWorkingDirectory !== "string" || state.sshWorkingDirectory.length === 0)
    ) {
      throw new Error(
        "invalid IM client session state: sshWorkingDirectory must be a non-empty string when present",
      );
    }
    return {
      version: 1,
      ...(state.defaultWorkingDirectory !== undefined
        ? { defaultWorkingDirectory: state.defaultWorkingDirectory }
        : {}),
      ...(state.sshWorkingDirectory !== undefined
        ? { sshWorkingDirectory: state.sshWorkingDirectory }
        : {}),
    };
  },
};

/**
 * Non-durable store used as the default when an adapter is constructed
 * without an injected store (for example in unit tests): the remembered `/new`
 * default still works within the adapter's lifetime, but nothing persists.
 */
export function createInMemoryImClientSessionStateStore(
  clientType: string,
): ClientSessionStateStore<ImClientSessionStateV1> {
  return createClientSessionStateStore({
    channelStateStore: createInMemoryChannelStateStore(),
    clientType,
    codec: imClientSessionStateCodec,
  });
}
