import { describe, it, expect } from 'vitest';

import { parseCommandArgs, stripAt } from '../../src/util/command';

describe('parseCommandArgs', () => {
    it('returns [] for undefined', () => {
        expect(parseCommandArgs(undefined)).toEqual([]);
    });

    it('returns [] for empty / whitespace-only string', () => {
        expect(parseCommandArgs('')).toEqual([]);
        expect(parseCommandArgs('   ')).toEqual([]);
    });

    it('strips the leading command token', () => {
        expect(parseCommandArgs('/add')).toEqual([]);
        expect(parseCommandArgs('/add @alice')).toEqual(['@alice']);
        expect(parseCommandArgs('/add @alice @bob')).toEqual(['@alice', '@bob']);
    });

    it('collapses arbitrary whitespace between args', () => {
        expect(parseCommandArgs('/add   @alice\t@bob   @carol')).toEqual(['@alice', '@bob', '@carol']);
    });

    it('handles bot mention in command (e.g. /add@DutyBot)', () => {
        // The first token is dropped wholesale, regardless of @suffix.
        expect(parseCommandArgs('/add@DutyBot @alice')).toEqual(['@alice']);
    });
});

describe('stripAt', () => {
    it('removes a single leading @', () => {
        expect(stripAt('@alice')).toBe('alice');
    });

    it('returns the string unchanged when there is no @', () => {
        expect(stripAt('alice')).toBe('alice');
    });

    it('only strips one leading @', () => {
        expect(stripAt('@@alice')).toBe('@alice');
    });

    it('handles empty input', () => {
        expect(stripAt('')).toBe('');
    });
});
