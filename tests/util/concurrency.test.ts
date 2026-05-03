import { describe, it, expect } from 'vitest';

import { mapWithConcurrency } from '../../src/util/concurrency';

describe('mapWithConcurrency', () => {
    it('returns [] for an empty input list', async () => {
        const fn = async (n: number) => n * 2;
        await expect(mapWithConcurrency([], 5, fn)).resolves.toEqual([]);
    });

    it('preserves input order in the result regardless of completion order', async () => {
        const items = [30, 10, 20];
        const result = await mapWithConcurrency(items, 3, async (ms) => {
            await new Promise((r) => setTimeout(r, ms));
            return ms;
        });
        expect(result.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 10, 20]);
    });

    it('caps simultaneous in-flight calls to the limit', async () => {
        let inFlight = 0;
        let peak = 0;
        const items = Array.from({ length: 10 }, (_, i) => i);

        await mapWithConcurrency(items, 3, async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
        });

        expect(peak).toBeLessThanOrEqual(3);
        expect(peak).toBeGreaterThan(1); // confirms it actually parallelizes
    });

    it('isolates rejections per item — others still resolve', async () => {
        const result = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
            if (n === 2) throw new Error(`fail-${n}`);
            return n * 10;
        });

        expect(result[0]).toEqual({ status: 'fulfilled', value: 10 });
        expect(result[1]?.status).toBe('rejected');
        expect((result[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
        expect(result[2]).toEqual({ status: 'fulfilled', value: 30 });
    });

    it('uses items.length workers when limit > items.length', async () => {
        let peak = 0;
        let inFlight = 0;

        await mapWithConcurrency([1, 2], 100, async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
        });

        expect(peak).toBe(2);
    });
});
