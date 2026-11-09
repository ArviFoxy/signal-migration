// Downloading a Telegram file through TDLib, with a limit on how long it may make no progress. TDLib answers a
// synchronous downloadFile only once the file is complete, so a download that stalls, or a TDLib that stopped,
// would otherwise be waited for forever.

import type * as Td from 'tdlib-types';

/** A download that received no new bytes within the limit; it was cancelled. */
export class DownloadStalledError extends Error {
  constructor(
    readonly received: number,
    readonly total: number,
    limitMs: number,
  ) {
    const kb = (bytes: number) => Math.round(bytes / 1024);
    super(
      `downloading from Telegram made no progress for ${limitMs / 1000} seconds (${kb(received)} of ${kb(total)} KB received)`,
    );
  }
}

/** How long a download may receive nothing before it counts as stalled. */
export const STALL_LIMIT_MS = 60_000;
/** How often TDLib is asked how far the download got. */
const PROGRESS_POLL_MS = 5_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Downloads a file completely; fails with DownloadStalledError when no bytes arrive for `limitMs`. */
export async function downloadWithStallLimit(
  invoke: Td.Invoke,
  fileId: number,
  limitMs = STALL_LIMIT_MS,
  pollMs = PROGRESS_POLL_MS,
): Promise<void> {
  let finished = false;
  const download = invoke({
    _: 'downloadFile',
    file_id: fileId,
    priority: 1,
    offset: 0,
    limit: 0,
    synchronous: true,
  }).finally(() => (finished = true));
  let received = 0;
  let total = 0;
  let progressAt = Date.now();
  while (!finished) {
    await Promise.race([download.then(undefined, () => undefined), wait(pollMs)]);
    if (finished) break;
    // TDLib may not answer at all (when it stopped), so the question about progress has a limit too.
    const file = await Promise.race([
      invoke({ _: 'getFile', file_id: fileId }).catch(() => null),
      wait(pollMs).then(() => null),
    ]);
    if (file) {
      total = file.expected_size || file.size || total;
      if (file.local.downloaded_size > received) {
        received = file.local.downloaded_size;
        progressAt = Date.now();
      }
    }
    if (Date.now() - progressAt >= limitMs) {
      void invoke({ _: 'cancelDownloadFile', file_id: fileId, only_if_pending: false }).catch(() => undefined);
      throw new DownloadStalledError(received, total, limitMs);
    }
  }
  await download;
}
