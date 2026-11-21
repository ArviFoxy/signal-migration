// Encrypting and uploading message attachments to Signal's CDN (CDN 3 via TUS, or CDN 2 via GCS resumable upload),
// matching Signal-Server (AttachmentControllerV4), Signal-Desktop (AttachmentCrypto.node.ts, tusProtocol.node.ts,
// WebAPI.preload.ts), and Signal-Android (AttachmentCipherOutputStream.kt, PaddingInputStream.java, CdnApi.kt).
//
// Files are streamed through AttachmentEncryptor in WebAssembly and uploaded in 2 MiB chunks so large attachments
// (up to Signal's 100 MiB ciphertext limit) never need to be buffered in memory at once.

import { AttachmentEncryptor } from '../wasm/signal_migration_wasm';
import { type ChatChannel, chatHeader, type HttpResponse, type HttpsRequest, type SignalAccount } from './transport';
import { loadSignalWasm } from './wasm';

/** Signal's default maximum encrypted attachment upload size (`global.attachments.maxBytes`). */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Signal's maximum number of attachments on a single message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 32;
/** Signal's maximum UTF-8 byte length for a `text/x-signal-plain` long-message attachment. */
export const MAX_LONG_TEXT_BYTES = 64 * 1024;
/** Encrypted bytes per HTTP upload request: 2 MiB (an exact multiple of GCS's 256 KiB alignment). */
export const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;

const TUS_VERSION = '1.0.0';
const MAX_RATE_LIMIT_RETRIES = 8;
const MAX_RETRY_WAIT_S = 60;
const encoder = new TextEncoder();

/** Signal's padded plaintext length: `max(541, floor(1.05^ceil(log_1.05(size))))`. */
export function paddedAttachmentSize(plaintextSize: number): number {
  if (plaintextSize <= 541) return 541;
  const padded = Math.floor(1.05 ** Math.ceil(Math.log(plaintextSize) / Math.log(1.05)));
  return Math.max(541, plaintextSize, padded);
}

/** Exact encrypted byte length uploaded to Signal's CDN: 16-byte IV + AES-256-CBC(padded, PKCS#7) + 32-byte HMAC. */
export function encryptedAttachmentSize(plaintextSize: number): number {
  const padded = paddedAttachmentSize(plaintextSize);
  return 16 + (Math.floor(padded / 16) + 1) * 16 + 32;
}

/** Whether a plaintext file of `plaintextSize` bytes fits within Signal's default upload limit after padding & crypto. */
export const attachmentFits = (plaintextSize: number): boolean =>
  plaintextSize >= 0 && encryptedAttachmentSize(plaintextSize) <= MAX_ATTACHMENT_UPLOAD_BYTES;

/** Metadata carried onto the Signal `AttachmentPointer` once the file is uploaded. */
export type AttachmentMetadata = {
  contentType: string;
  fileName?: string;
  width?: number;
  height?: number;
  flags?: number;
  caption?: string;
  audioDurationSeconds?: number;
};

/** Everything `noteToSelfMessage` needs to build an `AttachmentPointer` for an uploaded file. */
export type UploadedAttachment = AttachmentMetadata & {
  cdnNumber: number;
  cdnKey: string;
  /** 64-byte key: 32-byte AES-256 key || 32-byte HMAC-SHA256 key. */
  key: Uint8Array;
  /** SHA-256 over IV || ciphertext || HMAC. */
  digest: Uint8Array;
  /** Unpadded plaintext byte length. */
  size: number;
  /** Current time when uploaded, in milliseconds since 1970. */
  uploadTimestamp: number;
};

/** Supplies a file's exact plaintext size and streams its bytes in order. */
export type AttachmentSource = {
  size: number;
  readChunks: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>;
};

/** Wraps an in-memory byte array as an `AttachmentSource`. */
export function bytesSource(bytes: Uint8Array): AttachmentSource {
  return {
    size: bytes.length,
    async readChunks(onChunk) {
      if (bytes.length > 0) await onChunk(bytes);
    },
  };
}

export class AttachmentTooLargeError extends Error {
  constructor(bytes: number) {
    super(`attachment (${Math.ceil(bytes / (1024 * 1024))} MB) exceeds Signal's size limit`);
  }
}

type AttachmentUploadForm = {
  cdn: number;
  key: string;
  headers: Record<string, string>;
  signedUploadLocation: string;
};

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function abortableWait(ms: number, cancel: AbortSignal): Promise<void> {
  if (cancel.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cancel.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    cancel.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(headerValue: string | undefined, attempt: number): number {
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, MAX_RETRY_WAIT_S) * 1000 + 200;
  return Math.min(2 ** attempt, MAX_RETRY_WAIT_S) * 1000;
}

/** Validates that a CDN URL uses HTTPS on the expected Signal CDN host and returns its host and request path. */
function parseCdnUrl(raw: string, cdn: number): { host: string; path: string } {
  const expectedHost = `cdn${cdn}.signal.org`;
  const url = new URL(raw, `https://${expectedHost}`);
  if (url.protocol !== 'https:' || url.hostname !== expectedHost) {
    throw new Error(`unexpected attachment upload location: ${url.origin}`);
  }
  return { host: expectedHost, path: `${url.pathname}${url.search}` };
}

function formHeadersWithout(headers: Record<string, string>, omit: Set<string>): string[] {
  const list: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!omit.has(name.toLowerCase())) list.push(`${name}: ${value}`);
  }
  return list;
}

async function requestUploadForm(
  account: Pick<SignalAccount, 'withChat'>,
  uploadLength: number,
  cancel: AbortSignal,
): Promise<AttachmentUploadForm> {
  for (let attempt = 0; ; attempt++) {
    cancel.throwIfAborted();
    const response = await account.withChat((chat: ChatChannel) =>
      chat.request('GET', `/v4/attachments/form/upload?uploadLength=${uploadLength}`),
    );
    if (response.status === 200) {
      return JSON.parse(new TextDecoder().decode(response.body)) as AttachmentUploadForm;
    }
    if (response.status === 413) throw new AttachmentTooLargeError(uploadLength);
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const waitMs = parseRetryAfterMs(chatHeader(response.headers, 'Retry-After'), attempt);
      await abortableWait(waitMs, cancel);
      continue;
    }
    throw new Error(`requesting an attachment upload form answered ${response.status} ${response.message}`);
  }
}

async function cdnRequestWithRetry(
  https: HttpsRequest,
  host: string,
  method: string,
  path: string,
  headers: string[],
  body: Uint8Array,
  cancel: AbortSignal,
): Promise<HttpResponse> {
  for (let attempt = 0; ; attempt++) {
    cancel.throwIfAborted();
    const response = await https(host, method, path, headers, body);
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      await abortableWait(parseRetryAfterMs(response.header('Retry-After'), attempt), cancel);
      continue;
    }
    if (response.status >= 500 && response.status < 600 && attempt < 3) {
      await abortableWait(1000 * 2 ** attempt, cancel);
      continue;
    }
    return response;
  }
}

/** Sends encrypted bytes in bounded chunks to CDN 3 (TUS) or CDN 2 (GCS resumable upload). */
class ChunkedUploader {
  readonly #host: string;
  readonly #initialPath: string;
  #resumePath: string | null = null;
  #offset = 0;

  constructor(
    private readonly https: HttpsRequest,
    private readonly form: AttachmentUploadForm,
    private readonly totalBytes: number,
    private readonly cancel: AbortSignal,
  ) {
    if (form.cdn !== 2 && form.cdn !== 3) {
      throw new Error(`unsupported Signal attachment CDN ${form.cdn}`);
    }
    const parsed = parseCdnUrl(form.signedUploadLocation, form.cdn);
    this.#host = parsed.host;
    this.#initialPath = parsed.path;
  }

  async #ensureCdn2Session(): Promise<string> {
    if (this.#resumePath) return this.#resumePath;
    const headers = [
      ...formHeadersWithout(this.form.headers, new Set(['host', 'content-type', 'content-length'])),
      'Content-Type: application/octet-stream',
    ];
    const response = await cdnRequestWithRetry(
      this.https,
      this.#host,
      'POST',
      this.#initialPath,
      headers,
      new Uint8Array(0),
      this.cancel,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`starting attachment upload answered ${response.status}`);
    }
    const location = response.header('Location');
    if (!location) throw new Error('attachment upload start response had no Location header');
    this.#resumePath = parseCdnUrl(location, 2).path;
    return this.#resumePath;
  }

  async sendChunk(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    const start = this.#offset;
    const end = start + chunk.length;
    const isFinal = end === this.totalBytes;

    if (this.form.cdn === 3) {
      if (start === 0) {
        const omit = new Set(['host', 'content-type', 'content-length', 'tus-resumable', 'upload-length']);
        const headers = formHeadersWithout(this.form.headers, omit);
        const hasMetadata = Object.keys(this.form.headers).some((k) => k.toLowerCase() === 'upload-metadata');
        if (!hasMetadata) headers.push(`Upload-Metadata: filename ${toBase64(encoder.encode(this.form.key))}`);
        headers.push(
          `Tus-Resumable: ${TUS_VERSION}`,
          `Upload-Length: ${this.totalBytes}`,
          'Content-Type: application/offset+octet-stream',
        );
        const response = await cdnRequestWithRetry(
          this.https,
          this.#host,
          'POST',
          this.#initialPath,
          headers,
          chunk,
          this.cancel,
        );
        if (response.status === 413) throw new AttachmentTooLargeError(this.totalBytes);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`uploading attachment answered ${response.status}`);
        }
        const location = response.header('Location');
        this.#resumePath = location
          ? parseCdnUrl(location, 3).path
          : `${this.#initialPath.replace(/\/$/, '')}/${encodeURIComponent(this.form.key)}`;
        const reportedOffset = response.header('Upload-Offset');
        if (reportedOffset !== undefined && Number(reportedOffset) !== end) {
          throw new Error(`attachment upload offset mismatch: expected ${end}, got ${reportedOffset}`);
        }
      } else {
        const omit = new Set([
          'host',
          'upload-metadata',
          'content-type',
          'content-length',
          'tus-resumable',
          'upload-offset',
          'upload-length',
        ]);
        const headers = [
          ...formHeadersWithout(this.form.headers, omit),
          `Tus-Resumable: ${TUS_VERSION}`,
          `Upload-Offset: ${start}`,
          `Upload-Length: ${this.totalBytes}`,
          'Content-Type: application/offset+octet-stream',
        ];
        const response = await cdnRequestWithRetry(
          this.https,
          this.#host,
          'PATCH',
          this.#resumePath!,
          headers,
          chunk,
          this.cancel,
        );
        if (response.status === 413) throw new AttachmentTooLargeError(this.totalBytes);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`uploading attachment chunk answered ${response.status}`);
        }
        const reportedOffset = response.header('Upload-Offset');
        if (reportedOffset !== undefined && Number(reportedOffset) !== end) {
          throw new Error(`attachment upload offset mismatch: expected ${end}, got ${reportedOffset}`);
        }
      }
    } else {
      const resumePath = await this.#ensureCdn2Session();
      const headers = [
        `Content-Range: bytes ${start}-${end - 1}/${this.totalBytes}`,
        'Content-Type: application/octet-stream',
      ];
      const response = await cdnRequestWithRetry(
        this.https,
        this.#host,
        'PUT',
        resumePath,
        headers,
        chunk,
        this.cancel,
      );
      if (isFinal) {
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`finishing attachment upload answered ${response.status}`);
        }
      } else if (response.status !== 308) {
        throw new Error(`uploading attachment chunk answered ${response.status}`);
      }
    }

    this.#offset = end;
  }

  get uploaded(): number {
    return this.#offset;
  }
}

/**
 * Encrypts `source` in Signal's attachment format and uploads it to Signal's CDN in chunks.
 * Returns the pointer fields needed to attach the uploaded file to a Signal message.
 */
export async function uploadAttachment(
  account: Pick<SignalAccount, 'withChat' | 'https'>,
  source: AttachmentSource,
  metadata: AttachmentMetadata,
  cancel: AbortSignal,
  chunkBytes = UPLOAD_CHUNK_BYTES,
): Promise<UploadedAttachment> {
  const ciphertextSize = encryptedAttachmentSize(source.size);
  if (ciphertextSize > MAX_ATTACHMENT_UPLOAD_BYTES) throw new AttachmentTooLargeError(ciphertextSize);

  await loadSignalWasm();
  const form = await requestUploadForm(account, ciphertextSize, cancel);
  const uploader = new ChunkedUploader(account.https, form, ciphertextSize, cancel);
  const encryptor = new AttachmentEncryptor(source.size);

  // Coalesce encrypted output into fixed-size chunks (except the final remainder) for CDN upload.
  const staging = new Uint8Array(Math.min(chunkBytes, ciphertextSize));
  let staged = 0;

  const enqueue = async (encrypted: Uint8Array) => {
    let offset = 0;
    while (offset < encrypted.length) {
      const take = Math.min(staging.length - staged, encrypted.length - offset);
      staging.set(encrypted.subarray(offset, offset + take), staged);
      staged += take;
      offset += take;
      if (staged === staging.length) {
        await uploader.sendChunk(staging.slice());
        staged = 0;
      }
    }
  };

  try {
    await source.readChunks(async (plainChunk) => {
      cancel.throwIfAborted();
      const encrypted = encryptor.push(plainChunk);
      if (encrypted.length > 0) await enqueue(encrypted);
    });
    const end = encryptor.finish();
    try {
      await enqueue(end.tail);
      if (staged > 0) {
        await uploader.sendChunk(staging.slice(0, staged));
        staged = 0;
      }
      if (uploader.uploaded !== end.ciphertextSize) {
        throw new Error(`uploaded ${uploader.uploaded} of ${end.ciphertextSize} encrypted attachment bytes`);
      }
      return {
        ...metadata,
        cdnNumber: form.cdn,
        cdnKey: form.key,
        key: end.key,
        digest: end.digest,
        size: source.size,
        uploadTimestamp: Date.now(),
      };
    } finally {
      end.free();
    }
  } finally {
    encryptor.free();
  }
}
