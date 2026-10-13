/** Stop accepting work, drain all producers, then release storage. A timeout
 * must terminate the process, not close PG underneath still-running work. */
export async function drainBeforeClose(options: {
  stop: Array<() => Promise<unknown> | unknown>;
  close: () => Promise<unknown>;
  timedOut: () => void;
  budgetMs: number;
}): Promise<void> {
  const timer = setTimeout(options.timedOut, options.budgetMs);
  try {
    const results = await Promise.allSettled(options.stop.map(stop => {
      try { return Promise.resolve(stop()); } catch (error) { return Promise.reject(error); }
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    await options.close();
  } finally { clearTimeout(timer); }
}
