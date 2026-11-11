// Starts the real server (crates/server) for the integration tests: on a free port of this machine, serving a folder
// of built files, with its sticker pack index in a temporary file.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const crate = path.resolve(import.meta.dirname, '../../crates/server');

/** Compiles the server. When it is up to date this takes well under a second. */
export function buildServer() {
  execFileSync('cargo', ['build'], { cwd: crate, stdio: ['ignore', 'ignore', 'inherit'] });
}

/** A port of this machine that is free now. */
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts the server on `staticDir` and waits until it answers. `base` is its address, ending in a slash; `stop` ends
 * it and removes its index file.
 */
export async function startServer(staticDir) {
  const port = await freePort();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'server-'));
  const server = spawn(path.join(crate, 'target/debug/signal-migration-server'), [], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: String(port),
      STATIC_DIR: staticDir,
      INDEX_FILE: path.join(folder, 'index.bin'),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = new Promise((resolve) => server.once('exit', resolve));
  const base = `http://127.0.0.1:${port}/`;
  const answers = async () => {
    try {
      await fetch(`${base}v1/config`);
      return true;
    } catch {
      return false;
    }
  };
  for (const start = Date.now(); !(await answers()); await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (server.exitCode !== null) throw new Error(`the server exited with code ${server.exitCode} before it answered`);
    if (Date.now() - start > 10_000) throw new Error('the server did not answer within 10 seconds');
  }
  return {
    base,
    async stop() {
      server.kill();
      await exited;
      fs.rmSync(folder, { recursive: true, force: true });
    },
  };
}
