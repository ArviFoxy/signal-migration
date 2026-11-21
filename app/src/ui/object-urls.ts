// Manages blob object URLs owned by a view so they are revoked when the view unmounts instead of leaking until tab
// close (WeakMap entries are garbage-collected without invoking URL.revokeObjectURL).

export class ObjectUrlPool<K> {
  #urls = new Map<K, string[]>();

  /** Returns the cached URLs for `key`, creating and recording them once via `create` if not yet present. */
  get(key: K, create: () => string[]): string[] {
    let urls = this.#urls.get(key);
    if (!urls) {
      urls = create();
      if (urls.length > 0) this.#urls.set(key, urls);
    }
    return urls;
  }

  /** Returns one cached URL for `key`, creating and recording it once via `create` if not yet present. */
  getOne(key: K, create: () => string): string {
    return this.get(key, () => [create()])[0];
  }

  /** Revokes every object URL recorded in this pool and clears the cache. */
  revokeAll(): void {
    for (const urls of this.#urls.values()) {
      for (const url of urls) URL.revokeObjectURL(url);
    }
    this.#urls.clear();
  }
}
