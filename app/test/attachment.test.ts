// Signal message attachment encryption and chunked CDN upload (signal/attachment.ts) against the simulated Signal
// service, verifying both CDN 3 (TUS) and CDN 2 (GCS) protocols and decrypting uploaded bytes back to the original.

import { describe, expect, it } from 'vitest';
import {
  AttachmentTooLargeError,
  bytesSource,
  encryptedAttachmentSize,
  paddedAttachmentSize,
  uploadAttachment,
} from '../src/signal/attachment';
import { decryptAttachment } from '../src/wasm/signal_migration_wasm';
import { VirtualClock } from './scenario/clock';
import { FakeSignal } from './scenario/fake-signal';
import './wasm';

function accountOn(signal: FakeSignal, aci: string, deviceId: number) {
  const chat = signal.chat(aci, deviceId);
  return {
    withChat: <T>(action: (channel: typeof chat) => Promise<T>) => action(chat),
    https: signal.https,
  };
}

describe('Signal attachment upload', () => {
  // Detects: encryption padding, block boundary, or multi-chunk TUS (CDN 3) upload bugs by encrypting a file across
  // multiple chunks, uploading via POST + PATCH, and decrypting the exact bytes stored on the simulated CDN.
  it('streams and encrypts an attachment across multiple TUS chunks on CDN 3 and decrypts cleanly', async () => {
    const signal = new FakeSignal(new VirtualClock());
    signal.attachmentCdn = 3;
    const aci = signal.createAccount();
    const deviceId = signal.linkDevice(aci);

    // 7,500 bytes -> padded to 7,619 -> encrypted 7,680 bytes; chunk size 2,048 forces POST + 3 PATCH requests.
    const original = Uint8Array.from({ length: 7500 }, (_, i) => (i * 53 + 11) & 0xff);
    const uploaded = await uploadAttachment(
      accountOn(signal, aci, deviceId),
      {
        size: original.length,
        async readChunks(onChunk) {
          for (let offset = 0; offset < original.length; offset += 1000) {
            await onChunk(original.subarray(offset, Math.min(original.length, offset + 1000)));
          }
        },
      },
      { contentType: 'image/jpeg', width: 1200, height: 800 },
      new AbortController().signal,
      2048,
    );

    expect(uploaded.cdnNumber).toBe(3);
    expect(uploaded.size).toBe(original.length);
    expect(uploaded.key).toHaveLength(64);
    expect(uploaded.digest).toHaveLength(32);

    const stored = signal.attachmentFile(uploaded.cdnKey);
    expect(stored).not.toBeNull();
    expect(stored!.length).toBe(encryptedAttachmentSize(original.length));
    const decrypted = decryptAttachment(stored!, uploaded.key, uploaded.digest, uploaded.size);
    expect(decrypted).toEqual(original);
  });

  // Detects: CDN 2 (GCS resumable upload) session creation, Location header parsing, or Content-Range chunking bugs.
  it('uploads an attachment across multiple GCS resumable chunks on CDN 2 and decrypts cleanly', async () => {
    const signal = new FakeSignal(new VirtualClock());
    signal.attachmentCdn = 2;
    const aci = signal.createAccount();
    const deviceId = signal.linkDevice(aci);

    const original = Uint8Array.from({ length: 5000 }, (_, i) => (i * 17 + 3) & 0xff);
    const uploaded = await uploadAttachment(
      accountOn(signal, aci, deviceId),
      bytesSource(original),
      { contentType: 'application/pdf', fileName: 'report.pdf' },
      new AbortController().signal,
      2048,
    );

    expect(uploaded.cdnNumber).toBe(2);
    expect(uploaded.fileName).toBe('report.pdf');
    const stored = signal.attachmentFile(uploaded.cdnKey);
    expect(stored).not.toBeNull();
    expect(decryptAttachment(stored!, uploaded.key, uploaded.digest, uploaded.size)).toEqual(original);
  });

  // Detects: empty files (0 bytes) failing encryption or upload, or oversized files not reporting AttachmentTooLargeError.
  it('handles 0-byte files and rejects files exceeding Signal’s upload limit', async () => {
    const signal = new FakeSignal(new VirtualClock());
    const aci = signal.createAccount();
    const deviceId = signal.linkDevice(aci);
    const account = accountOn(signal, aci, deviceId);

    const empty = await uploadAttachment(
      account,
      bytesSource(new Uint8Array(0)),
      { contentType: 'application/octet-stream', fileName: 'empty.txt' },
      new AbortController().signal,
    );
    expect(paddedAttachmentSize(0)).toBe(541);
    expect(decryptAttachment(signal.attachmentFile(empty.cdnKey)!, empty.key, empty.digest, 0)).toEqual(
      new Uint8Array(0),
    );

    signal.maxAttachmentBytes = 1000;
    await expect(
      uploadAttachment(
        account,
        bytesSource(new Uint8Array(2000)),
        { contentType: 'application/octet-stream' },
        new AbortController().signal,
      ),
    ).rejects.toThrow(AttachmentTooLargeError);
  });
});
