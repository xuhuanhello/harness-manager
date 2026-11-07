import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Behaviour = (request: FakeRequest) => void;
class FakeRequest extends EventEmitter {
  headers: Record<string, string> = {};
  aborted = false;
  constructor(
    readonly options: Record<string, unknown>,
    private behaviour: Behaviour,
  ) {
    super();
  }
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  abort() {
    this.aborted = true;
  }
  end() {
    queueMicrotask(() => this.behaviour(this));
  }
}

const net = vi.hoisted(() => ({ behaviour: (_request: unknown) => {}, requests: [] as unknown[] }));
vi.mock('electron', () => ({
  net: {
    request: (options: Record<string, unknown>) => {
      const request = new FakeRequest(options, net.behaviour as Behaviour);
      net.requests.push(request);
      return request;
    },
  },
}));

const { manualRedirectFetch } = await import('../src/main/manual-redirect-fetch');
const lastRequest = () => net.requests.at(-1) as FakeRequest;

describe('manualRedirectFetch', () => {
  beforeEach(() => {
    net.requests.length = 0;
  });

  it('reports a redirect as a 3xx response with its location instead of following it', async () => {
    net.behaviour = (request) => (request as FakeRequest).emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/a');
    const response = await manualRedirectFetch('https://github.com/x/y/releases/download/v1/a.zip', {
      headers: { 'User-Agent': 'Harness-Manager/1.0.0' },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://release-assets.githubusercontent.com/a');
    expect(lastRequest().aborted).toBe(true);
    expect(lastRequest().options).toMatchObject({ redirect: 'manual', credentials: 'omit', useSessionCookies: false });
    expect(lastRequest().headers['user-agent']).toBe('Harness-Manager/1.0.0');
  });

  it('streams the final response body with its status and headers', async () => {
    net.behaviour = (request) => {
      const body = Readable.from([Buffer.from('hello '), Buffer.from('world')]) as Readable & {
        statusCode?: number;
        headers?: Record<string, string | string[]>;
      };
      body.statusCode = 200;
      body.headers = { 'content-length': '11', 'set-cookie': ['a=1', 'b=2'] };
      (request as FakeRequest).emit('response', body);
    };
    const response = await manualRedirectFetch(new URL('https://api.github.com/repos/x/y/releases'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('11');
    expect(await response.text()).toBe('hello world');
  });

  it('rejects on network errors and on an aborted signal', async () => {
    net.behaviour = (request) => (request as FakeRequest).emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    await expect(manualRedirectFetch('https://api.github.com/')).rejects.toThrow('ERR_INTERNET_DISCONNECTED');

    net.behaviour = () => {};
    const controller = new AbortController();
    const pending = manualRedirectFetch('https://api.github.com/', { signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(lastRequest().aborted).toBe(true);

    await expect(manualRedirectFetch('https://api.github.com/', { signal: AbortSignal.abort(new Error('early')) })).rejects.toThrow(
      'early',
    );
  });
});
