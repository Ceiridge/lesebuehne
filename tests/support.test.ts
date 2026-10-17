import { describe, expect, test } from 'bun:test';

describe('01-6: no-network preload', () => {
  test('fetch to a non-loopback host throws', () => {
    expect(() => fetch('https://example.com')).toThrow(/no-network/);
    expect(() => fetch(new URL('http://93.184.215.14/'))).toThrow(/no-network/);
    expect(() => fetch(new Request('https://example.com/x'))).toThrow(/no-network/);
  });

  test('WebSocket to a non-loopback host throws', () => {
    expect(() => new WebSocket('wss://example.com/socket')).toThrow(/no-network/);
  });

  test('requests to 127.0.0.1 work', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response('local ok');
      },
      websocket: {
        open(ws) {
          ws.send('hello');
        },
        message() {},
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await res.text()).toBe('local ok');
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
      const first = await new Promise<string>((resolve, reject) => {
        ws.onmessage = (e) => resolve(String(e.data));
        ws.onerror = () => reject(new Error('local WebSocket failed'));
      });
      ws.close();
      expect(first).toBe('hello');
    } finally {
      server.stop(true);
    }
  });
});
