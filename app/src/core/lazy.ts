// Memoizes an asynchronous loader while keeping failures retryable.
//
// Unlike a bare `promise ??= load()`, a rejection clears the cached promise so a transient network failure (for
// example fetching a WebAssembly module) can succeed on "Try again" without a full page reload.

export function retryableOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = load().catch((error) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
}
