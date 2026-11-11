// The page of serve-export.mjs: the app itself with one addition, for choosing the tolerances of the picture
// comparison from real stickers. Once the Telegram packs are read, it reads every sticker file of every pack and
// sends it to the server that served this page, which keeps the files on its own disk (save-packs.ts). The files go
// nowhere else. This page is never part of a build that is deployed.

import { realServices } from '../src/app/services';
import { Workflow } from '../src/app/workflow';
import type { MigrationApp } from '../src/ui/migration-app';
import '../src/ui/migration-app';
import { connectRouter } from '../src/ui/router';
import { savePacksOnceRead, withTelegramSource } from './save-packs';

const { services, source } = withTelegramSource(realServices);
const workflow = new Workflow(services);

const status = document.createElement('div');
status.style.cssText =
  'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:1000;padding:8px 14px;max-width:90vw;' +
  'border-radius:8px;background:#1b1b1f;color:#fff;font:14px system-ui,sans-serif';

void savePacksOnceRead(workflow, source, {
  saved: async () => (await (await fetch('/export/saved')).json()) as string[],
  async send(path, body) {
    const response = await fetch(`/export/${path}`, { method: 'POST', body: body as BodyInit });
    if (!response.ok) throw new Error(`the server answered ${response.status} for ${path}`);
  },
  show(text) {
    if (!status.isConnected) document.body.append(status);
    status.textContent = text;
  },
});

const app = document.querySelector('migration-app') as MigrationApp;
app.workflow = workflow;
connectRouter(workflow);
workflow.start();
