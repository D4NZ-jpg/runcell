import { describe, expect, it, vi } from 'vitest';
import { snapshotRunContext } from './run-context.js';
import { InvalidOptionError } from './errors.js';

describe('snapshotRunContext', () => {
  it('copies and freezes finite scalar attributes without freezing caller data', () => {
    const input = {
      requestId: 'req-1',
      operation: 'summarize',
      retry: 2,
      sampled: false,
      parent: null,
    };
    const snapshot = snapshotRunContext(input);
    expect(snapshot).toEqual(input);
    expect(snapshot).not.toBe(input);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    input.requestId = 'changed';
    expect(snapshot?.['requestId']).toBe('req-1');
  });

  it('distinguishes omitted context from an empty map', () => {
    expect(snapshotRunContext(undefined)).toBeUndefined();
    expect(snapshotRunContext({})).toEqual({});
  });

  it.each([
    null,
    'req-1',
    1,
    true,
    [],
    new Date(),
    new Map(),
    { nested: {} },
    { list: [] },
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: BigInt(1) },
    { value: Symbol('id') },
    { value: () => 'id' },
  ])('rejects unsupported context case %#', value => {
    expect(() => snapshotRunContext(value)).toThrow(InvalidOptionError);
  });

  it('does not invoke getters or toJSON hooks', () => {
    const getter = vi.fn(() => 'req-1');
    expect(() =>
      snapshotRunContext({
        get requestId() {
          return getter();
        },
      }),
    ).toThrow(InvalidOptionError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => snapshotRunContext({ toJSON: getter })).toThrow(
      InvalidOptionError,
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it('accepts null-prototype maps and treats __proto__ as an ordinary attribute', () => {
    const context: unknown = JSON.parse(
      '{"__proto__":"correlation-id","requestId":"req-1"}',
    );
    const snapshot = snapshotRunContext(context);
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(Object.hasOwn(snapshot ?? {}, '__proto__')).toBe(true);
    expect(snapshot?.['__proto__']).toBe('correlation-id');
    expect(
      snapshotRunContext(
        Object.assign(Object.create(null) as Record<string, string>, {
          requestId: 'req-1',
        }),
      ),
    ).toEqual({ requestId: 'req-1' });
  });

  it('converts reflection failures into an option error', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => snapshotRunContext(proxy)).toThrow(InvalidOptionError);
  });
});
