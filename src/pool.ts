/**
 * Runs `worker` over `items` with at most `concurrency` in flight. Stops handing out new items as soon as
 * `shouldStop()` returns true (used for budget exhaustion and graceful abort); in-flight items finish.
 */
export async function runPool<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
    shouldStop: () => boolean = () => false,
): Promise<{ started: number; skipped: number }> {
    let next = 0;
    let started = 0;
    const size = Math.max(1, Math.min(concurrency, items.length || 1));

    async function lane(): Promise<void> {
        while (next < items.length && !shouldStop()) {
            const index = next++;
            started += 1;
            await worker(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: size }, async () => lane()));
    return { started, skipped: items.length - started };
}
