export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    let cursor = 0;

    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            const item = items[i] as T;
            try {
                const value = await fn(item, i);
                results[i] = { status: 'fulfilled', value };
            } catch (reason) {
                results[i] = { status: 'rejected', reason };
            }
        }
    });

    await Promise.all(workers);
    return results;
}
