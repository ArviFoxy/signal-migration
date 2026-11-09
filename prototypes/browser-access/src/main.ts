import { probeProvisioningSocket, REFLECTORS } from './provisioning';
import { fetchManifest } from './sticker';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Shows a line in the page and, for headless runs, posts it to the local server's log. */
function report(outputId: string, line: string): void {
  element<HTMLPreElement>(outputId).textContent += line + '\n';
  void fetch('/log', { method: 'POST', body: line }).catch(() => undefined);
}

async function runStickerTest(): Promise<void> {
  const packId = element<HTMLInputElement>('pack-id').value.trim();
  const packKey = element<HTMLInputElement>('pack-key').value.trim();
  try {
    const manifest = await fetchManifest(packId, packKey);
    report('out-sticker', `sticker: OK, ${manifest.encryptedBytes} encrypted bytes, title "${manifest.title}", author "${manifest.author}", ${manifest.stickerCount} stickers`);
  } catch (error) {
    report('out-sticker', `sticker: FAILED ${error}`);
  }
}

async function runProvisioningTest(): Promise<void> {
  for (const reflector of REFLECTORS) {
    const result = await probeProvisioningSocket(reflector);
    const outcome = result.error === undefined ? 'OK' : `FAILED ${result.error}`;
    report('out-provisioning', `provisioning ${reflector}: ${outcome}, opened=${result.opened}, first request ${result.firstRequest ?? '-'}, address length ${result.addressLength ?? '-'}`);
  }
}

element('run-sticker').addEventListener('click', () => void runStickerTest());
element('run-provisioning').addEventListener('click', () => void runProvisioningTest());

// "?run=all" runs every test on load, for headless browsers.
if (new URLSearchParams(location.search).get('run') === 'all') {
  void (async () => {
    await runStickerTest();
    await runProvisioningTest();
    report('out-provisioning', 'DONE');
  })();
}
