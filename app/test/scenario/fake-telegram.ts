// A simulated Telegram account's files: every migration kind reads files by Telegram file ID, and reads can be made
// to fail. Each kind keeps its own data (sticker packs, ...) in its folder and stores its files here.

export class FakeTelegram {
  #files = new Map<number, Uint8Array>();
  #nextFileId = 1;
  #failures: { fileIds: Set<number>; remaining: number }[] = [];
  /** Successful reads per file ID. */
  reads = new Map<number, number>();

  /** Stores a file and returns its file ID. */
  addFile(bytes: Uint8Array): number {
    const fileId = this.#nextFileId++;
    this.#files.set(fileId, bytes);
    return fileId;
  }

  async readFile(fileId: number): Promise<Uint8Array> {
    const failure = this.#failures.find((candidate) => candidate.remaining > 0 && candidate.fileIds.has(fileId));
    if (failure) {
      failure.remaining--;
      throw new Error('simulated Telegram download failure');
    }
    const file = this.#files.get(fileId);
    if (!file) throw new Error(`no file ${fileId}`);
    this.reads.set(fileId, (this.reads.get(fileId) ?? 0) + 1);
    return file.slice();
  }

  /** The next read of any of these files fails. */
  failNextRead(fileIds: number[]): void {
    this.#failures.push({ fileIds: new Set(fileIds), remaining: 1 });
  }
}
