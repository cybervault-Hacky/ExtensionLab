import "server-only";
import { Readable } from "node:stream";
import { StorageError, type PutOptions, type StorageObjectStat, type StorageProvider } from "./types";
import { assertValidStorageKey } from "./validation";

/**
 * S3-compatible object storage provider (Phase 13 §27/§28/§30).
 *
 * Production artifact architecture: metadata lives in the database, binary
 * objects in private object storage. Buckets MUST be private (no public
 * access, no public listing); every read goes through authenticated
 * application routes — the provider never generates public or CDN URLs and
 * credentials never leave the server process (and are never passed to
 * browser containers).
 *
 * The AWS SDK (`@aws-sdk/client-s3`) is an OPTIONAL deployment dependency —
 * selected via STORAGE_PROVIDER=s3 — resolved lazily exactly like the Redis
 * coordination client, so builds without it keep working. The provider is
 * constructed against a minimal gateway interface; tests inject a fake
 * gateway and exercise the same code path.
 */

export interface S3StorageConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  /** Key prefix (multi-tenant bucket isolation, e.g. "extensionlab/prod/"). */
  prefix?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** Minimal gateway the provider depends on (SDK adapter or test double). */
export interface S3Gateway {
  putObject(input: { bucket: string; key: string; body: Uint8Array; contentType?: string }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<Uint8Array>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  headObject(input: { bucket: string; key: string }): Promise<{ contentLength: number; lastModified: number } | null>;
  listObjects(input: { bucket: string; prefix: string }): Promise<string[]>;
  headBucket(input: { bucket: string }): Promise<boolean>;
}

export class S3StorageProvider implements StorageProvider {
  readonly name = "s3";
  private readonly gateway: S3Gateway;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(gateway: S3Gateway, config: S3StorageConfig) {
    this.gateway = gateway;
    this.bucket = config.bucket;
    this.prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
  }

  private fullKey(key: string): string {
    assertValidStorageKey(key);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private stripPrefix(key: string): string {
    return this.prefix && key.startsWith(`${this.prefix}/`) ? key.slice(this.prefix.length + 1) : key;
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<StorageObjectStat> {
    const contentType = options?.contentType ?? "application/octet-stream";
    if (!isValidContentType(contentType)) {
      throw new StorageError("io", "Unsupported content type.");
    }
    const full = this.fullKey(key);
    try {
      await this.gateway.putObject({ bucket: this.bucket, key: full, body: data, contentType });
      return { size: data.byteLength, createdAt: Date.now() };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("io", "The object could not be stored.", error);
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return await this.gateway.getObject({ bucket: this.bucket, key: this.fullKey(key) });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("not_found", "The object does not exist.", error);
    }
  }

  async delete(key: string): Promise<void> {
    await this.gateway.deleteObject({ bucket: this.bucket, key: this.fullKey(key) }).catch(() => undefined);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<StorageObjectStat | null> {
    try {
      const head = await this.gateway.headObject({ bucket: this.bucket, key: this.fullKey(key) });
      return head ? { size: head.contentLength, createdAt: head.lastModified } : null;
    } catch {
      return null;
    }
  }

  async createReadStream(key: string): Promise<Readable> {
    const bytes = await this.get(key);
    return Readable.from(bytes);
  }

  async list(prefix: string): Promise<string[]> {
    // Listing prefixes are directory-like (e.g. "artifacts/"); enforce the
    // traversal rules without requiring the ≥2-segment object-key shape.
    const normalized = prefix.replace(/\/+$/, "");
    if (normalized.includes("..") || normalized.startsWith("/") || normalized.includes("\\") || normalized.includes("//")) {
      throw new StorageError("invalid_key", "Invalid storage key.");
    }
    const fullPrefix = this.prefix ? `${this.prefix}/${normalized}` : normalized;
    try {
      const keys = await this.gateway.listObjects({ bucket: this.bucket, prefix: fullPrefix });
      return keys.map((key) => this.stripPrefix(key)).filter((key) => key.length > 0);
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const reachable = await this.gateway.headBucket({ bucket: this.bucket });
      if (!reachable) return { ok: false, detail: "bucket_unreachable" };
      const marker = `${this.prefix ? `${this.prefix}/` : ""}healthcheck/${Date.now().toString(36)}.bin`;
      await this.gateway.putObject({ bucket: this.bucket, key: marker, body: new Uint8Array([1]) });
      await this.gateway.deleteObject({ bucket: this.bucket, key: marker });
      return { ok: true };
    } catch {
      return { ok: false, detail: "s3_unavailable" };
    }
  }
}

/** Content types allowed into object storage (bounded allowlist §28). */
const ALLOWED_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/zip",
  "application/json",
  "image/png",
  "image/jpeg",
  "text/plain",
  "text/csv",
]);

export function isValidContentType(contentType: string): boolean {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.has(normalized);
}

/**
 * Creates the AWS SDK gateway. The SDK is loaded lazily through a variable
 * specifier so a deployment without `@aws-sdk/client-s3` fails at startup
 * with a descriptive error instead of breaking the build.
 */
export async function createAwsS3Gateway(config: S3StorageConfig): Promise<S3Gateway> {
  type S3Client = { send: (command: unknown) => Promise<unknown> };
  type S3Module = {
    S3Client: new (options: Record<string, unknown>) => S3Client;
    PutObjectCommand: new (input: Record<string, unknown>) => unknown;
    GetObjectCommand: new (input: Record<string, unknown>) => unknown;
    DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
    HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
    ListObjectsV2Command: new (input: Record<string, unknown>) => unknown;
    HeadBucketCommand: new (input: Record<string, unknown>) => unknown;
  };
  let s3: S3Module;
  try {
    const specifier = "@aws-sdk/client-s3";
    s3 = (await import(/* @vite-ignore */ specifier)) as unknown as S3Module;
  } catch {
    throw new Error(
      "STORAGE_PROVIDER=s3 requires the '@aws-sdk/client-s3' npm package in the deployment image (npm install @aws-sdk/client-s3).",
    );
  }
  const clientOptions: Record<string, unknown> = { region: config.region ?? "us-east-1" };
  if (config.endpoint) clientOptions.endpoint = config.endpoint;
  if (config.forcePathStyle) clientOptions.forcePathStyle = true;
  if (config.accessKeyId && config.secretAccessKey) {
    clientOptions.credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  }
  const client = new s3.S3Client(clientOptions);

  const asRecord = (value: unknown): Record<string, unknown> => (value ?? {}) as Record<string, unknown>;
  return {
    async putObject(input) {
      await client.send(new s3.PutObjectCommand({ Bucket: input.bucket, Key: input.key, Body: input.body, ContentType: input.contentType }));
    },
    async getObject(input) {
      const response = asRecord(await client.send(new s3.GetObjectCommand({ Bucket: input.bucket, Key: input.key })));
      const body = response.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) throw new StorageError("not_found", "The object does not exist.");
      return body.transformToByteArray();
    },
    async deleteObject(input) {
      await client.send(new s3.DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
    },
    async headObject(input) {
      try {
        const response = asRecord(await client.send(new s3.HeadObjectCommand({ Bucket: input.bucket, Key: input.key })));
        return {
          contentLength: Number(response.ContentLength ?? 0),
          lastModified: response.LastModified ? new Date(response.LastModified as string).getTime() : Date.now(),
        };
      } catch {
        return null;
      }
    },
    async listObjects(input) {
      const response = asRecord(await client.send(new s3.ListObjectsV2Command({ Bucket: input.bucket, Prefix: input.prefix })));
      return ((response.Contents as Array<{ Key?: string }> | undefined) ?? [])
        .map((item) => item.Key ?? "")
        .filter((key) => key.length > 0);
    },
    async headBucket(input) {
      try {
        await client.send(new s3.HeadBucketCommand({ Bucket: input.bucket }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
