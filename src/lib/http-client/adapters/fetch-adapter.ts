import { extractFetchHeaders } from '../utils';
import type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
} from '../types';

export class FetchAdapter implements HTTPAdapter {
  public getType(): AdapterType {
    return 'fetch';
  }

  public async send(request: AdapterRequest): Promise<AdapterResponse> {
    const { requestURL, method, headers, body, signal } = request;

    // Fire 0% upload progress
    request.onUploadProgress?.({ loaded: 0, total: 0, progress: 0 });

    let response: Response;

    try {
      response = await fetch(requestURL, {
        method,
        headers,
        body: body as BodyInit | null,
        signal: signal ?? null,
        redirect: 'manual',
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error; // preserve cancellation / timeout classification
      }

      return {
        status: 0,
        headers: {},
        body: null,
      };
    }

    if (response.type === 'opaqueredirect') {
      return {
        status: 0,
        isOpaqueRedirect: true,
        headers: {},
        body: null,
      };
    }

    // Fire 100% upload + download progress (fetch has no real per-chunk progress)
    request.onUploadProgress?.({ loaded: 1, total: 1, progress: 1 });

    const rawBody = await readResponseBody(method, response);

    request.onDownloadProgress?.({
      loaded: rawBody?.length ?? 0,
      total: rawBody?.length ?? 0,
      progress: 1,
    });

    return {
      status: response.status,
      headers: extractFetchHeaders(response.headers),
      body: rawBody,
    };
  }
}

async function readResponseBody(
  method: string,
  response: Response,
): Promise<Uint8Array | null> {
  if (method === 'HEAD' || response.status === 204 || response.status === 304) {
    return null;
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
