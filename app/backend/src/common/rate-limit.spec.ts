import type { Request } from 'express';
import { clientKey, RateLimitStore } from './rate-limit.js';

const req = (ip?: string) => ({ ip, socket: {} }) as unknown as Request;

describe('clientKey', () => {
  it('keeps IPv4 as is and groups IPv6 by /64', () => {
    expect(clientKey(req('203.0.113.5'))).toBe('203.0.113.5');
    expect(clientKey(req('::ffff:203.0.113.5'))).toBe('::ffff:203.0.113.5');
    expect(clientKey(req('2001:db8:1:2:aaaa::1'))).toBe('2001:db8:1:2::/64');
    expect(clientKey(req('2001:db8:1:2:bbbb:cccc:dddd:eeee'))).toBe(
      '2001:db8:1:2::/64',
    );
    expect(clientKey(req('2001:db8::1'))).toBe('2001:db8:0:0::/64');
    expect(clientKey(req('2001:DB8:1:2::1'))).toBe('2001:db8:1:2::/64');
    expect(clientKey(req('::FFFF:203.0.113.5'))).toBe('::ffff:203.0.113.5');
    expect(clientKey(req('1:2:3:4:5:6:7:8:9'))).toBe('1:2:3:4:5:6:7:8:9');
    expect(clientKey(req(undefined))).toBe('unknown');
  });
});

describe('RateLimitStore', () => {
  it('counts within a window and resets after it', () => {
    const store = new RateLimitStore();
    expect(store.hit('k', 1000, 0).count).toBe(1);
    expect(store.hit('k', 1000, 500).count).toBe(2);
    expect(store.hit('k', 1000, 1000).count).toBe(1);
  });

  it('bounds memory by evicting the oldest keys', () => {
    const store = new RateLimitStore();
    for (let i = 0; i < 60_000; i++) store.hit(`ip${i}`, 60_000, 1);
    expect(store.size).toBeLessThanOrEqual(50_000);
    // 最近のキーは残っている
    expect(store.hit('ip59999', 60_000, 2).count).toBe(2);
  });
});
