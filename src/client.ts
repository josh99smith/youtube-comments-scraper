import { setTimeout as sleep } from 'node:timers/promises';

import { API_BASE, categorizeFetchError, categorizeHttpError, type ErrorType } from './youtube.js';

export type ApiResult<T> =
    { ok: true; body: T } | { ok: false; errorType: ErrorType; error: string; statusCode?: number; reason?: string };

export interface ClientOptions {
    apiKey: string;
    timeoutMs?: number;
    /** Extra attempts for transient failures (5xx, per-minute rate limits, network). */
    maxRetries?: number;
    retryDelayMs?: number;
    fetchImpl?: typeof fetch;
}

/** Thin YouTube Data API v3 client. The key travels in the X-Goog-Api-Key header so it never appears in URLs or logs. */
export class YouTubeClient {
    /** Quota units spent by this run (every list call we make costs 1 unit). */
    unitsUsed = 0;

    constructor(private readonly options: ClientOptions) {}

    async list<T>(resource: string, params: Record<string, string | number | undefined>): Promise<ApiResult<T>> {
        const url = new URL(`${API_BASE}/${resource}`);
        for (const [k, v] of Object.entries(params))
            if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
        const fetchImpl = this.options.fetchImpl ?? fetch;
        const maxRetries = this.options.maxRetries ?? 2;
        const retryDelayMs = this.options.retryDelayMs ?? 1500;

        let last: ApiResult<T> | undefined;
        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            if (attempt > 1) await sleep(retryDelayMs * 2 ** (attempt - 2));
            try {
                this.unitsUsed += 1;
                const res = await fetchImpl(url, {
                    signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
                    headers: { accept: 'application/json', 'x-goog-api-key': this.options.apiKey },
                });
                const text = await res.text();
                let body: unknown;
                try {
                    body = JSON.parse(text);
                } catch {
                    body = undefined;
                }
                if (res.ok) {
                    if (body === undefined) {
                        return {
                            ok: false,
                            errorType: 'other',
                            error: 'YouTube returned a non-JSON response',
                            statusCode: res.status,
                        };
                    }
                    return { ok: true, body: body as T };
                }
                const c = categorizeHttpError(res.status, body, text);
                last = { ok: false, ...c, statusCode: res.status };
                // Per-minute limits and server errors are worth retrying; daily quota, bad keys and 4xx are not.
                const transient = res.status >= 500 || c.reason === 'rateLimitExceeded';
                if (!transient) return last;
            } catch (err) {
                const c = categorizeFetchError(err);
                last = { ok: false, ...c };
            }
        }
        return last!;
    }
}
