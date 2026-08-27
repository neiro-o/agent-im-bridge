import { realpath } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_TRANSFER_BYTES = 100 * 1024 * 1024;

export interface PathPolicyOptions {
  allowedRoots: string[];
}

export class PathPolicyError extends Error {
  override readonly name = "PathPolicyError";
}

/**
 * Canonicalizes paths before applying an allowlist. An empty allowlist is
 * intentionally deny-all; callers enabling a privileged mode must opt into
 * one or more roots explicitly.
 */
export class PathPolicy {
  readonly #allowedRoots: string[];
  #canonicalRoots: string[] | undefined;

  constructor(options: PathPolicyOptions | string[]) {
    this.#allowedRoots = Array.isArray(options) ? options : options.allowedRoots;
  }

  private async roots(): Promise<string[]> {
    if (!this.#canonicalRoots) {
      this.#canonicalRoots = await Promise.all(
        this.#allowedRoots.map(async (root) => realpath(path.resolve(root))),
      );
    }
    return this.#canonicalRoots;
  }

  private async assertCanonical(candidate: string): Promise<string> {
    const roots = await this.roots();
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      throw new PathPolicyError(`path does not exist: ${candidate}`, { cause: error });
    }
    if (!roots.some((root) => isWithin(root, canonical))) {
      throw new PathPolicyError(`path is outside the allowed roots: ${candidate}`);
    }
    return canonical;
  }

  async assertAllowed(realPath: string): Promise<void> {
    await this.assertCanonical(realPath);
  }

  async resolveExisting(input: string, cwd: string): Promise<string> {
    const resolved = path.isAbsolute(input) ? input : path.resolve(cwd, input);
    return this.assertCanonical(resolved);
  }

  async resolveDirectory(input: string, cwd: string): Promise<string> {
    const resolved = await this.resolveExisting(input, cwd);
    const { stat } = await import("node:fs/promises");
    if (!(await stat(resolved)).isDirectory()) {
      throw new PathPolicyError(`path is not a directory: ${input}`);
    }
    return resolved;
  }

  /** Resolve and authorize a directory whose child may not exist yet. */
  async resolveUploadDirectory(input: string, cwd = process.cwd()): Promise<string> {
    return this.resolveDirectory(input, cwd);
  }
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function sanitizeBasename(input: string): string {
  // Treat both separators as separators even when tests or an attachment came
  // from a different operating system.
  const basename = input.replace(/[\\/]+/g, "/").split("/").pop() ?? "";
  if (!basename || basename === "." || basename === ".." || basename.includes("\0")) {
    throw new PathPolicyError("attachment has no safe file name");
  }
  const safe = basename.replace(/[\0/\\]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new PathPolicyError("attachment has no safe file name");
  return safe;
}

export function assertSafeArchiveEntry(entry: string): void {
  const normalized = entry.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new PathPolicyError(`unsafe archive entry: ${entry}`);
  }
  if (normalized.split("/").some((part) => part === "..")) {
    throw new PathPolicyError(`unsafe archive entry: ${entry}`);
  }
}
