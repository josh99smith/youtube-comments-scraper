import { describe, expect, it } from 'vitest';

import { YouTubeClient } from '../src/client.js';
import { runPool } from '../src/pool.js';
import {
    assertList,
    categorizeFetchError,
    categorizeHttpError,
    hashAuthor,
    isAfter,
    isKeyWideError,
    mapComment,
    parsePublishedAfter,
    parseTarget,
    resolveAuthorMode,
    resolveSort,
    ResponseShapeError,
    uploadsPlaylistId,
    type ApiComment,
    type VideoInfo,
} from '../src/youtube.js';

// Synthetic fixtures shaped like YouTube Data API v3 responses (no real users).
const VIDEO: VideoInfo = {
    videoId: 'AAAAAAAAAAA',
    title: 'Test video',
    channelId: 'UCowner0000000000000000A',
    channelTitle: 'Owner',
    commentCount: 12,
};
const TOP: ApiComment = {
    id: 'Ugtop1',
    snippet: {
        videoId: 'AAAAAAAAAAA',
        textOriginal: 'First!\nSecond line',
        textDisplay: 'First!<br>Second line',
        authorDisplayName: '@viewer',
        authorProfileImageUrl: 'https://yt3.ggpht.com/a.jpg',
        authorChannelUrl: 'http://www.youtube.com/@viewer',
        authorChannelId: { value: 'UCviewer000000000000000A' },
        likeCount: 7,
        publishedAt: '2026-09-01T10:00:00Z',
        updatedAt: '2026-09-02T10:00:00Z',
    },
};
const OWNER_REPLY: ApiComment = {
    id: 'Ugtop1.reply1',
    snippet: {
        textOriginal: 'Thanks!',
        authorDisplayName: '@owner',
        authorChannelId: { value: 'UCowner0000000000000000A' },
        likeCount: 1,
        publishedAt: '2026-09-03T10:00:00Z',
        updatedAt: '2026-09-03T10:00:00Z',
        parentId: 'Ugtop1',
    },
};
const NOW = new Date('2026-09-23T00:00:00Z');

describe('parseTarget', () => {
    it('parses every video URL shape and bare IDs', () => {
        for (const s of [
            'https://www.youtube.com/watch?v=jNQXAC9IVRw',
            'youtube.com/watch?v=jNQXAC9IVRw&t=10s',
            'https://m.youtube.com/watch?v=jNQXAC9IVRw',
            'https://youtu.be/jNQXAC9IVRw?si=abc',
            'https://www.youtube.com/shorts/jNQXAC9IVRw',
            'https://www.youtube.com/live/jNQXAC9IVRw',
            'https://www.youtube.com/embed/jNQXAC9IVRw',
            '  jNQXAC9IVRw ',
        ]) {
            expect(parseTarget(s)).toMatchObject({ kind: 'video', videoId: 'jNQXAC9IVRw' });
        }
    });

    it('parses channel URLs, IDs and handles', () => {
        expect(parseTarget('https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ')).toMatchObject({
            kind: 'channel',
            channelId: 'UCBR8-60-B28hp2BmDPdntcQ',
        });
        expect(parseTarget('UCBR8-60-B28hp2BmDPdntcQ')).toMatchObject({ kind: 'channel' });
        expect(parseTarget('https://www.youtube.com/@YouTube/videos')).toMatchObject({
            kind: 'handle',
            handle: '@YouTube',
        });
        expect(parseTarget('@YouTube')).toMatchObject({ kind: 'handle', handle: '@YouTube' });
    });

    it('rejects non-YouTube and malformed inputs', () => {
        for (const s of [
            '',
            'https://example.com/watch?v=jNQXAC9IVRw',
            'https://www.youtube.com/watch?v=short',
            'https://www.youtube.com/results?search_query=x',
            'not a url',
        ]) {
            expect(parseTarget(s)).toBeNull();
        }
    });
});

describe('option resolvers', () => {
    it('resolves sort and author mode with defaults and aliases', () => {
        expect(resolveSort(undefined)).toBe('relevance');
        expect(resolveSort('newest')).toBe('time');
        expect(resolveSort('bogus')).toBeNull();
        expect(resolveAuthorMode(undefined)).toBe('include');
        expect(resolveAuthorMode('hash')).toBe('hash');
        expect(resolveAuthorMode('nope')).toBeNull();
    });

    it('parses absolute and relative publishedAfter values', () => {
        expect(parsePublishedAfter('')).toBeUndefined();
        expect(parsePublishedAfter('2026-01-31')?.toISOString()).toBe('2026-01-31T00:00:00.000Z');
        expect(parsePublishedAfter('7 days', NOW)?.toISOString()).toBe('2026-09-16T00:00:00.000Z');
        expect(parsePublishedAfter('2 weeks ago', NOW)?.toISOString()).toBe('2026-09-09T00:00:00.000Z');
        expect(parsePublishedAfter('3 months', NOW)?.toISOString()).toBe('2026-06-23T00:00:00.000Z');
        expect(parsePublishedAfter('yesterday-ish')).toBeNull();
    });

    it('maps a channel ID to its uploads playlist', () => {
        expect(uploadsPlaylistId('UCBR8-60-B28hp2BmDPdntcQ')).toBe('UUBR8-60-B28hp2BmDPdntcQ');
    });
});

describe('mapComment', () => {
    it('maps a top-level comment with author data', () => {
        const item = mapComment(TOP, VIDEO, { authorMode: 'include', salt: 's', replyCount: 3, now: NOW })!;
        expect(item).toMatchObject({
            success: true,
            commentId: 'Ugtop1',
            commentUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA&lc=Ugtop1',
            text: 'First!\nSecond line',
            likeCount: 7,
            replyCount: 3,
            isReply: false,
            parentCommentId: null,
            isByVideoOwner: false,
            isEdited: true,
            authorName: '@viewer',
            authorChannelUrl: 'https://www.youtube.com/@viewer',
            videoTitle: 'Test video',
            scrapedAt: NOW.toISOString(),
        });
    });

    it('marks replies and comments by the video owner', () => {
        const item = mapComment(OWNER_REPLY, VIDEO, { authorMode: 'include', salt: 's', replyCount: 99 })!;
        expect(item).toMatchObject({
            isReply: true,
            parentCommentId: 'Ugtop1',
            replyCount: null,
            isByVideoOwner: true,
            isEdited: false,
        });
    });

    it('pseudonymises or omits author fields', () => {
        const hashed = mapComment(TOP, VIDEO, { authorMode: 'hash', salt: 'user1', replyCount: 0 })!;
        expect(hashed.authorName).toBeNull();
        expect(hashed.authorChannelUrl).toBeNull();
        expect(hashed.authorProfileImageUrl).toBeNull();
        expect(hashed.authorChannelId).toBe(hashAuthor('UCviewer000000000000000A', 'user1'));
        expect(hashed.authorChannelId).toMatch(/^[0-9a-f]{16}$/);
        expect(hashAuthor('UCviewer000000000000000A', 'user2')).not.toBe(hashed.authorChannelId);
        // The owner flag still works when authors are hidden.
        expect(mapComment(OWNER_REPLY, VIDEO, { authorMode: 'omit', salt: 's', replyCount: null })).toMatchObject({
            authorChannelId: null,
            isByVideoOwner: true,
        });
    });

    it('rejects comments without an id or text (silent-failure guard)', () => {
        expect(
            mapComment({ snippet: TOP.snippet }, VIDEO, { authorMode: 'include', salt: 's', replyCount: 0 }),
        ).toBeNull();
        expect(
            mapComment({ id: 'x', snippet: { likeCount: 1 } }, VIDEO, {
                authorMode: 'include',
                salt: 's',
                replyCount: 0,
            }),
        ).toBeNull();
    });
});

describe('isAfter / assertList', () => {
    it('filters by date and keeps undated comments', () => {
        const cutoff = new Date('2026-09-02T00:00:00Z');
        expect(isAfter('2026-09-01T10:00:00Z', cutoff)).toBe(false);
        expect(isAfter('2026-09-03T10:00:00Z', cutoff)).toBe(true);
        expect(isAfter(null, cutoff)).toBe(true);
        expect(isAfter('2020-01-01T00:00:00Z', undefined)).toBe(true);
    });

    it('throws on a 2xx body without items', () => {
        expect(() => assertList({ kind: 'youtube#commentThreadListResponse' }, 'x')).toThrow(ResponseShapeError);
        expect(assertList({ items: [] }, 'x').items).toEqual([]);
    });
});

const err = (code: number, reason: string, message = 'msg') => ({
    error: { code, message, errors: [{ reason, message }] },
});

describe('categorizeHttpError', () => {
    it('recognises YouTube-specific reasons', () => {
        expect(categorizeHttpError(403, err(403, 'commentsDisabled'), '').errorType).toBe('comments-disabled');
        expect(categorizeHttpError(404, err(404, 'videoNotFound'), '').errorType).toBe('not-found');
        expect(categorizeHttpError(403, err(403, 'quotaExceeded'), '')).toMatchObject({
            errorType: 'rate-limited',
            reason: 'quotaExceeded',
        });
        expect(
            categorizeHttpError(400, err(400, 'badRequest', 'API key not valid. Please pass a valid API key.'), ''),
        ).toMatchObject({ reason: 'keyInvalid' });
        expect(categorizeHttpError(403, err(403, 'accessNotConfigured'), '')).toMatchObject({
            reason: 'accessNotConfigured',
        });
        expect(categorizeHttpError(500, undefined, 'oops').errorType).toBe('http-error');
    });

    it('treats quota and key problems as run-wide', () => {
        expect(isKeyWideError('quotaExceeded')).toBe(true);
        expect(isKeyWideError('keyInvalid')).toBe(true);
        expect(isKeyWideError('rateLimitExceeded')).toBe(false);
        expect(isKeyWideError('commentsDisabled')).toBe(false);
    });

    it('categorises fetch errors', () => {
        expect(categorizeFetchError({ name: 'TimeoutError' }).errorType).toBe('timeout');
        expect(categorizeFetchError(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))).toEqual({
            errorType: 'network',
            error: 'ECONNRESET',
        });
    });
});

describe('YouTubeClient', () => {
    const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

    it('sends the key as a header, never in the URL', async () => {
        let seen: { url: string; key: string | null } | undefined;
        const client = new YouTubeClient({
            apiKey: 'secret',
            fetchImpl: (async (url: URL, init: RequestInit) => {
                seen = { url: String(url), key: new Headers(init.headers).get('x-goog-api-key') };
                return respond(200, { items: [] });
            }) as unknown as typeof fetch,
        });
        const res = await client.list('commentThreads', { videoId: 'AAAAAAAAAAA', searchTerms: undefined });
        expect(res.ok).toBe(true);
        expect(seen!.key).toBe('secret');
        expect(seen!.url).not.toContain('secret');
        expect(seen!.url).not.toContain('searchTerms');
        expect(client.unitsUsed).toBe(1);
    });

    it('retries 5xx and per-minute limits but not quota or disabled comments', async () => {
        const script = [
            respond(503, {}),
            respond(403, err(403, 'rateLimitExceeded')),
            respond(200, { items: [{ id: 'x' }] }),
        ];
        let calls = 0;
        const client = new YouTubeClient({
            apiKey: 'k',
            retryDelayMs: 1,
            fetchImpl: (async () => script[calls++]) as unknown as typeof fetch,
        });
        expect((await client.list('commentThreads', {})).ok).toBe(true);
        expect(calls).toBe(3);

        let calls2 = 0;
        const client2 = new YouTubeClient({
            apiKey: 'k',
            retryDelayMs: 1,
            fetchImpl: (async () => (calls2++, respond(403, err(403, 'quotaExceeded')))) as unknown as typeof fetch,
        });
        expect(await client2.list('commentThreads', {})).toMatchObject({ ok: false, errorType: 'rate-limited' });
        expect(calls2).toBe(1);
    });

    it('reports non-JSON 200s as failures instead of data', async () => {
        const client = new YouTubeClient({
            apiKey: 'k',
            fetchImpl: (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch,
        });
        expect(await client.list('commentThreads', {})).toMatchObject({ ok: false, errorType: 'other' });
    });
});

describe('runPool', () => {
    it('stops handing out work when asked', async () => {
        const done: number[] = [];
        const { skipped } = await runPool(
            [1, 2, 3, 4, 5],
            1,
            async (n) => {
                done.push(n);
            },
            () => done.length >= 2,
        );
        expect(done).toEqual([1, 2]);
        expect(skipped).toBe(3);
    });
});
