import { describe, expect, it } from 'vitest';
import { cacheKey, ResponseCache } from '../src/cache.js';
import { chatRequest } from './helpers.js';

describe('ResponseCache', () => {
  it('expires entries after the ttl', () => {
    let now = 0;
    const cache = new ResponseCache<string>(1000, 10, () => now);
    cache.set('a', 'value');

    now = 999;
    expect(cache.get('a')).toBe('value');
    now = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new ResponseCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });
});

describe('cacheKey', () => {
  it('ignores key order and streaming flags', () => {
    const a = chatRequest({ temperature: 0, max_tokens: 10 });
    const b = { max_tokens: 10, ...chatRequest(), temperature: 0, stream: false };

    expect(cacheKey('key-1', a)).toBe(cacheKey('key-1', b));
  });

  it('differs per API key and per parameter', () => {
    const req = chatRequest();

    expect(cacheKey('key-1', req)).not.toBe(cacheKey('key-2', req));
    expect(cacheKey('key-1', req)).not.toBe(cacheKey('key-1', { ...req, temperature: 0.7 }));
  });
});
