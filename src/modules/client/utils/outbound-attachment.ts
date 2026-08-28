import { rm } from "node:fs/promises";
import type { OutboundAttachment } from "../../../types";

/** Sends an attachment and removes only bridge-declared temporary files afterward. */
export async function sendOutboundAttachment(
  attachment: OutboundAttachment,
  send: () => Promise<void>,
): Promise<void> {
  let sendError: unknown;
  try {
    await send();
  } catch (error) {
    sendError = error;
  }

  let cleanupError: unknown;
  if (attachment.cleanupAfterSend) {
    try {
      await rm(attachment.filePath, { force: true });
    } catch (error) {
      cleanupError = error;
    }
  }

  if (sendError !== undefined) throw sendError;
  if (cleanupError !== undefined) throw cleanupError;
}
