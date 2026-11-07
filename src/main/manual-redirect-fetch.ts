import { net } from 'electron';
import { Readable } from 'node:stream';

/**
 * fetch() on top of net.request that reports redirects instead of following them.
 *
 * Electron's net.fetch rejects `redirect: 'manual'` ("Redirect was cancelled"), so the update
 * downloader could not vet GitHub's hop to its asset host. Here a redirect resolves to a 3xx
 * Response carrying the Location header; the caller validates it before requesting the next hop.
 * Requests never send cookies or stored credentials.
 */
export function manualRedirectFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const { signal } = init;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const request = net.request({
      url,
      method: init.method ?? 'GET',
      redirect: 'manual',
      credentials: 'omit',
      useSessionCookies: false,
    });
    for (const [name, value] of new Headers(init.headers)) request.setHeader(name, value);
    const onAbort = () => {
      request.abort();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('redirect', (statusCode, _method, redirectUrl) => {
      signal?.removeEventListener('abort', onAbort);
      request.abort();
      resolve(new Response(null, { status: statusCode, headers: { location: redirectUrl } }));
    });
    request.on('response', (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      }
      // The abort listener stays attached so cancelling a download also stops the body stream.
      const body = Readable.toWeb(response as unknown as Readable) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status: response.statusCode, headers }));
    });
    request.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    request.end();
  });
}
