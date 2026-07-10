import { describe, expect, it } from 'vitest';
import { defineExtension } from './pi.js';

describe('runcell/pi', () => {
  it('defineExtension returns the factory unchanged', () => {
    const factory = () => undefined;
    expect(defineExtension(factory)).toBe(factory);
  });
});
