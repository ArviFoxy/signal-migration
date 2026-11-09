// A time limit for work that waits on something outside the page's control (a browser event, a worker's answer),
// which may never come.

/** `work`'s result, or the error `expire` returns once `ms` have passed; `expire` also stops what is still running. */
export function withTimeLimit<T>(work: Promise<T>, ms: number, expire: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(expire()), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
