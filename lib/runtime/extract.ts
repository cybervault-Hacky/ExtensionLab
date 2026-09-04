import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import {
  MAX_FILE_COUNT,
  MAX_SINGLE_FILE_SIZE,
  MAX_TOTAL_UNCOMPRESSED_SIZE,
} from "@/lib/extension/limits";
import { ExtensionLabError } from "@/lib/extension/errors";

/**
 * Extract an uploaded extension ZIP into a private temporary directory.
 *
 * The output is only ever consumed by a freshly-created sandbox container. No
 * path may escape the extraction root, and zip-bomb style packages are
 * rejected before expansion.
 */
export async function extractZipToDirectory(
  bytes: Uint8Array,
  destination: string,
): Promise<string> {
  let zip: JSZip;
  try {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new ExtensionLabError(
      "zip-corrupt",
      "We couldn't read this ZIP. The file may be corrupted or incorrectly packaged.",
    );
  }

  const entries = Object.values(zip.files);
  if (entries.length === 0) {
    throw new ExtensionLabError("zip-empty", "This ZIP is empty.");
  }
  if (entries.length > MAX_FILE_COUNT) {
    throw new ExtensionLabError(
      "too-many-files",
      `This ZIP contains too many files (more than ${MAX_FILE_COUNT}).`,
    );
  }

  let total = 0;
  for (const entry of entries) {
    const size = safeUncompressedSize(entry);
    total += size;
    if (size > MAX_SINGLE_FILE_SIZE) {
      throw new ExtensionLabError(
        "file-too-large-in-zip",
        "A file inside this ZIP is too large to inspect safely.",
      );
    }
    if (total > MAX_TOTAL_UNCOMPRESSED_SIZE) {
      throw new ExtensionLabError(
        "total-too-large",
        "This ZIP expands to too much data to inspect safely.",
      );
    }
  }

  for (const entry of entries) {
    const normalized = normalizeEntryPath(entry.name);
    if (!normalized) continue;
    const target = safeJoin(destination, normalized);
    if (entry.dir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    const content = await entry.async("uint8array");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  return destination;
}

function safeUncompressedSize(entry: JSZip.JSZipObject): number {
  const candidate: unknown = entry;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "_data" in candidate
  ) {
    const data = (candidate as { _data?: { uncompressedSize?: number } })._data;
    if (data && typeof data.uncompressedSize === "number") {
      return data.uncompressedSize;
    }
  }
  return 0;
}

function normalizeEntryPath(value: string): string {
  return value
    .split("/")
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .join("/");
}

function safeJoin(root: string, relative: string): string {
  const segments = relative.split("/");
  if (segments.includes("..")) {
    throw new ExtensionLabError(
      "manifest-invalid",
      "The ZIP contains an unsafe path.",
    );
  }
  return join(root, ...segments);
}
