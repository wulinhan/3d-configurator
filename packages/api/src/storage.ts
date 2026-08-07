// Where the bytes live: models, published GLBs, customer artwork.
//
// Three drivers behind one interface. `memoryStore` is for tests, `fsStore`
// runs the service on a plain server with a disk, and `s3Store` speaks to S3
// or anything S3-compatible (R2, Spaces, MinIO) for the real deployment.
// Nothing above this file knows which one it has.

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /**
   * A URL the browser can fetch directly, when the driver has one.
   *
   * Returning null is not a failure — it means "serve it yourself", and the
   * service streams the object instead. That is how the fs and memory drivers
   * work, and how S3 works too until a CDN domain is configured.
   */
  publicUrl(key: string): string | null;
}

export function memoryStore(): ObjectStore & { size(): number } {
  const objects = new Map<string, StoredObject>();
  return {
    async put(key, bytes, contentType) { objects.set(key, { bytes, contentType }); },
    async get(key) { return objects.get(key) ?? null; },
    async delete(key) { objects.delete(key); },
    publicUrl: () => null,
    size: () => objects.size,
  };
}

/** Disk. Keys are paths, so they are checked against the root — a key is
 * derived from a hash here, but a driver that trusts its input is one
 * refactor away from serving /etc/passwd. */
export function fsStore(root: string): ObjectStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    const full = resolve(join(base, key));
    if (full !== base && !full.startsWith(base + '/')) throw new Error(`key escapes the store root: ${key}`);
    return full;
  };
  return {
    async put(key, bytes, contentType) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      await writeFile(`${path}.type`, contentType, 'utf8');
    },
    async get(key) {
      const path = pathOf(key);
      try {
        const [bytes, contentType] = await Promise.all([
          readFile(path),
          readFile(`${path}.type`, 'utf8').catch(() => 'application/octet-stream'),
        ]);
        return { bytes: new Uint8Array(bytes), contentType };
      } catch {
        return null;
      }
    },
    async delete(key) {
      const path = pathOf(key);
      await rm(path, { force: true });
      await rm(`${path}.type`, { force: true });
    },
    publicUrl: () => null,
  };
}

export interface S3Config {
  bucket: string;
  region: string;
  /** Set for R2/MinIO/Spaces; omit for AWS proper. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * CDN origin in front of the bucket. Set it and published manifests and
   * models are served straight off the edge, never touching this service —
   * which is the whole reason publications are immutable.
   */
  cdnBase?: string;
}

export async function s3Store(config: S3Config): Promise<ObjectStore> {
  // Imported lazily so the fs and memory drivers cost nothing: the tests and
  // a single-server deployment never load the AWS SDK at all.
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } =
    await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    // Path-style keeps bucket names out of DNS, which is what every
    // S3-compatible service other than AWS actually wants.
    forcePathStyle: !!config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return {
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: key, Body: bytes, ContentType: contentType,
        // Everything here is content-addressed, so a key's bytes can never
        // change and the cache can hold them for a year.
        CacheControl: 'public, max-age=31536000, immutable',
      }));
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        const bytes = await out.Body!.transformToByteArray();
        return { bytes, contentType: out.ContentType ?? 'application/octet-stream' };
      } catch {
        return null;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
    publicUrl: (key) => (config.cdnBase ? `${config.cdnBase.replace(/\/$/, '')}/${key}` : null),
  };
}

/**
 * Where an asset's bytes go.
 *
 * Content-addressed and namespaced by org: the same file uploaded twice
 * writes one object, and no key can be guessed from another tenant's.
 */
export const assetKey = (orgId: string, sha256: string): string =>
  `assets/${orgId}/${sha256.slice(0, 2)}/${sha256}`;
