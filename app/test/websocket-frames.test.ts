// Frame encoding and decoding checked against the example frames in RFC 6455 section 5.7.

import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame } from '../src/signal/websocket-client';

const hello = new TextEncoder().encode('Hello');

describe('WebSocket frames (RFC 6455 section 5.7 examples)', () => {
  // Detects: a wrong mask application or header layout, which Signal's server would reject as a protocol error.
  it('encodes the masked "Hello" text frame byte for byte', () => {
    const frame = encodeFrame(0x1, hello, new Uint8Array([0x37, 0xfa, 0x21, 0x3d]));
    expect([...frame]).toEqual([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  });

  // Detects: misreading the short length form of an unmasked server frame.
  it('decodes the unmasked "Hello" text frame', () => {
    const decoded = decodeFrame(new Uint8Array([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    expect(decoded).toMatchObject({ fin: true, opcode: 0x1, frameLength: 7 });
    expect([...decoded!.payload]).toEqual([...hello]);
  });

  // Detects: misreading the 16-bit extended length (payloads of 126 to 65535 bytes).
  it('decodes the 256-byte binary frame header', () => {
    const frame = new Uint8Array(4 + 256);
    frame.set([0x82, 0x7e, 0x01, 0x00]);
    frame.fill(0xab, 4);
    const decoded = decodeFrame(frame);
    expect(decoded).toMatchObject({ opcode: 0x2, frameLength: 260 });
    expect(decoded!.payload.length).toBe(256);
  });

  // Detects: misreading the 64-bit extended length (payloads of 64 KiB and more).
  it('decodes the 64 KiB binary frame header', () => {
    const frame = new Uint8Array(10 + 65536);
    frame.set([0x82, 0x7f, 0, 0, 0, 0, 0, 1, 0, 0]);
    const decoded = decodeFrame(frame);
    expect(decoded).toMatchObject({ opcode: 0x2, frameLength: 65546 });
    expect(decoded!.payload.length).toBe(65536);
  });

  // Detects: treating a partly received frame as complete, which would corrupt every later message.
  it('returns null until the whole frame has arrived', () => {
    expect(decodeFrame(new Uint8Array([0x81, 0x05, 0x48, 0x65]))).toBeNull();
    expect(decodeFrame(new Uint8Array([0x82, 0x7e, 0x01]))).toBeNull();
  });
});
