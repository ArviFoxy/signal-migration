#!/usr/bin/env node
// Fetches Sigstore's production trusted_root.json verified via The Update Framework (TUF) and writes it to
// app/src/attestation/trusted-root.json. Run from the repository root after `cd app && npm ci`.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const pkg = path.join(repo, 'app/node_modules/@freedomofpress/sigstore-browser/dist/index.js');
const { TrustedRootProvider } = await import(pathToFileURL(pkg).href);

const provider = new TrustedRootProvider({ disableCache: true });
const root = await provider.getTrustedRoot();
const target = path.join(repo, 'app/src/attestation/trusted-root.json');
fs.writeFileSync(target, JSON.stringify(root, null, 2) + '\n');
console.log(`Updated ${path.relative(repo, target)}`);
