// Checks the repository's own files for identifiers of real people. Submodules (third_party/) are other projects'
// code and are not checked.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file !== '' && !file.startsWith('third_party/'))
  .filter((file) => statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile());

/** The fixed GUID of the WebSocket handshake (RFC 6455), which is not anyone's identifier. */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PATTERNS: [string, RegExp][] = [
  ['UUID, such as a Signal account ID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ['phone number in international format', /\+[1-9]\d{9,14}\b/g],
  ['email address', /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi],
];

describe('the repository', () => {
  // Detects: a Signal account ID, a phone number or an email address copied from a live session into a fixture, a
  // log, a comment or a test.
  it('contains no account IDs, phone numbers or email addresses', () => {
    const found: string[] = [];
    for (const file of files) {
      const content = readFileSync(path.join(root, file));
      if (content.includes(0)) continue;
      const text = content.toString('utf8');
      for (const [kind, pattern] of PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          if (match[0].toUpperCase() !== WEBSOCKET_GUID) found.push(`${file}: ${kind}: ${match[0]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
