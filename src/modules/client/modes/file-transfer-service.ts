import { createWriteStream } from "node:fs";
import { copyFile, mkdtemp, readdir, realpath, rm, stat, lstat } from "node:fs/promises";
import { glob } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { PathPolicy, PathPolicyError, assertSafeArchiveEntry, DEFAULT_MAX_TRANSFER_BYTES, sanitizeBasename } from "./path-policy";

export interface InboundAttachment {
  kind: "image" | "file" | "audio" | "video";
  localPath?: string;
  fileName?: string;
  sizeBytes?: number;
  mimeType?: string;
  downloadError?: { code?: string | number; message: string };
}

export interface UploadResult {
  sourceName: string;
  path: string;
  sizeBytes: number;
}

export interface DownloadPlan {
  directFile?: string;
  archive?: { path: string; displayName: string; cleanup(): Promise<void> };
  skipped: Array<{ path: string; reason: string }>;
}

export interface FileTransferServiceOptions {
  pathPolicy: PathPolicy;
  maxTransferBytes?: number;
  tempDirectory?: string;
  /** Override archive creation in tests or deployments with a platform tool. */
  createArchive?: (files: ArchiveFile[], outputPath: string) => Promise<void>;
}

export interface ArchiveFile {
  path: string;
  entryName: string;
}

/** Secure filesystem operations used by an authorized local-control adapter. */
export class FileTransferService {
  readonly #policy: PathPolicy;
  readonly #maxBytes: number;
  readonly #tempDirectory: string;
  readonly #createArchive: (files: ArchiveFile[], outputPath: string) => Promise<void>;

  constructor(options: FileTransferServiceOptions) {
    this.#policy = options.pathPolicy;
    this.#maxBytes = options.maxTransferBytes ?? DEFAULT_MAX_TRANSFER_BYTES;
    this.#tempDirectory = options.tempDirectory ?? os.tmpdir();
    this.#createArchive = options.createArchive ?? createTarGz;
  }

  async saveInboundAttachments(attachments: InboundAttachment[], targetDirectory: string): Promise<UploadResult[]> {
    const target = await this.#policy.resolveDirectory(targetDirectory, process.cwd());
    const results: UploadResult[] = [];
    for (const attachment of attachments) {
      if (!attachment.localPath) throw new PathPolicyError("attachment has no downloaded local file");
      const source = await realpath(attachment.localPath);
      const info = await stat(source);
      if (!info.isFile()) throw new PathPolicyError("attachment is not a regular file");
      if (info.size > this.#maxBytes) throw new PathPolicyError(`attachment exceeds ${this.#maxBytes} bytes`);
      const name = sanitizeBasename(attachment.fileName ?? path.basename(source));
      const destination = await this.#availableDestination(target, name);
      // copyFile is deliberately used instead of rename: a failed upload or a
      // later cleanup must never remove the adapter's temporary source.
      await copyFile(source, destination);
      results.push({ sourceName: attachment.fileName ?? name, path: destination, sizeBytes: info.size });
    }
    return results;
  }

  async prepareDownload(expression: string, cwd: string): Promise<DownloadPlan> {
    const base = await this.#policy.resolveDirectory(".", cwd);
    const rawMatches: string[] = [];
    if (hasGlobMagic(expression)) {
      for await (const match of glob(expression, { cwd: base })) rawMatches.push(path.resolve(base, String(match)));
    } else {
      rawMatches.push(path.isAbsolute(expression) ? expression : path.resolve(base, expression));
    }
    const unique = [...new Set(rawMatches)];
    if (!unique.length) throw new PathPolicyError(`no matches for download: ${expression}`);

    const selected: Array<{ path: string; info: Awaited<ReturnType<typeof stat>> }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let matchedDirectory = false;
    for (const match of unique) {
      let canonical: string;
      try { canonical = await this.#policy.resolveExisting(match, base); }
      catch (error) { throw error; }
      const info = await stat(canonical);
      if (info.isFile()) {
        if (info.size > this.#maxBytes) skipped.push({ path: canonical, reason: `exceeds ${this.#maxBytes} bytes` });
        else selected.push({ path: canonical, info });
      } else if (info.isDirectory()) {
        matchedDirectory = true;
        const files = await this.#walk(canonical, skipped);
        selected.push(...files);
      } else skipped.push({ path: canonical, reason: "not a regular file or directory" });
    }
    if (!selected.length) return { skipped };
    if (selected.length === 1 && unique.length === 1 && !matchedDirectory) return { directFile: selected[0].path, skipped };

    const tempDir = await mkdtemp(path.join(this.#tempDirectory, "agent-bridge-download-"));
    const archivePath = path.join(tempDir, `download-${Date.now()}.tar.gz`);
    const entries = makeArchiveEntries(selected.map((item) => item.path));
    try {
      await this.#createArchive(entries, archivePath);
      const archiveSize = (await stat(archivePath)).size;
      if (archiveSize > this.#maxBytes) {
        skipped.push({ path: archivePath, reason: `archive exceeds ${this.#maxBytes} bytes` });
        await rm(tempDir, { recursive: true, force: true });
        return { skipped };
      }
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
    return {
      skipped,
      archive: {
        path: archivePath,
        displayName: path.basename(archivePath),
        cleanup: () => rm(tempDir, { recursive: true, force: true }),
      },
    };
  }

  async #availableDestination(directory: string, name: string): Promise<string> {
    let candidate = path.join(directory, name);
    const extension = path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let index = 1; ; index += 1) {
      try { await lstat(candidate); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // The parent was canonicalized before this point. Re-checking the
          // candidate's parent avoids accidentally writing through a swapped symlink.
          await this.#policy.assertAllowed(directory);
          return candidate;
        }
        throw error;
      }
      candidate = path.join(directory, `${stem} (${index})${extension}`);
    }
  }

  async #walk(directory: string, skipped: Array<{ path: string; reason: string }>): Promise<Array<{ path: string; info: Awaited<ReturnType<typeof stat>> }>> {
    const output: Array<{ path: string; info: Awaited<ReturnType<typeof stat>> }> = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const canonical = await this.#policy.resolveExisting(candidate, directory);
      const info = await stat(canonical);
      if (info.isDirectory()) output.push(...await this.#walk(canonical, skipped));
      else if (info.isFile()) {
        if (info.size > this.#maxBytes) skipped.push({ path: canonical, reason: `exceeds ${this.#maxBytes} bytes` });
        else output.push({ path: canonical, info });
      }
    }
    return output;
  }
}

function hasGlobMagic(value: string): boolean { return /[*?\[\]]/.test(value); }

function makeArchiveEntries(files: string[]): ArchiveFile[] {
  const roots = files.map((file) => path.parse(file).root);
  const common = commonDirectory(files);
  const used = new Set<string>();
  return files.map((file) => {
    let entryName = path.relative(common, file).split(path.sep).join("/");
    if (!entryName || path.isAbsolute(entryName) || roots.some((root) => entryName.startsWith(root))) entryName = path.basename(file);
    const original = entryName;
    let index = 1;
    while (used.has(entryName)) entryName = `${path.parse(original).name} (${index++})${path.extname(original)}`;
    assertSafeArchiveEntry(entryName);
    used.add(entryName);
    return { path: file, entryName };
  });
}

function commonDirectory(files: string[]): string {
  if (!files.length) return path.parse(process.cwd()).root;
  const split = files.map((file) => path.dirname(file).split(path.sep));
  const common: string[] = [];
  for (let i = 0; i < Math.min(...split.map((parts) => parts.length)); i += 1) {
    if (split.every((parts) => parts[i] === split[0][i])) common.push(split[0][i]);
    else break;
  }
  const value = common.join(path.sep);
  return value || path.parse(files[0]).root;
}

async function createTarGz(files: ArchiveFile[], outputPath: string): Promise<void> {
  const output = createWriteStream(outputPath);
  const gzip = createGzip();
  const writing = pipeline(gzip, output);
  const write = (chunk: Buffer) => new Promise<void>((resolve, reject) => {
    if (gzip.write(chunk)) resolve();
    else gzip.once("drain", resolve).once("error", reject);
  });
  try {
    for (const file of files) {
      const info = await stat(file.path);
      const header = Buffer.alloc(512, 0);
      writeTarString(header, 0, file.entryName, 100);
      writeTarString(header, 100, "0000644", 8); writeTarString(header, 108, "0000000", 8);
      writeTarString(header, 116, "0000000", 8); writeTarString(header, 124, info.size.toString(8).padStart(11, "0") + " ", 12);
      writeTarString(header, 136, Math.floor(info.mtimeMs / 1000).toString(8).padStart(11, "0") + " ", 12);
      header[156] = 48; writeTarString(header, 257, "ustar\0", 6); writeTarString(header, 263, "00", 2);
      for (let i = 148; i < 156; i += 1) header[i] = 32;
      writeTarString(header, 148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + " \0", 8);
      await write(header);
      for await (const chunk of (await import("node:fs")).createReadStream(file.path)) await write(chunk as Buffer);
      const padding = (512 - (info.size % 512)) % 512;
      if (padding) await write(Buffer.alloc(padding));
    }
    await write(Buffer.alloc(1024));
    gzip.end();
    await writing;
  } catch (error) {
    gzip.destroy(); output.destroy();
    throw error;
  }
}

function writeTarString(buffer: Buffer, offset: number, value: string, length: number): void {
  Buffer.from(value).copy(buffer, offset, 0, length);
}
