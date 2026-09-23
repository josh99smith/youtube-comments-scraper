/**
 * Pure, network-free logic for the YouTube Data API v3 comment endpoints:
 * input parsing, response mapping, author-field handling and error categorisation.
 * Everything in this file is unit-tested against fixtures in test/fixtures.
 */
import { createHash } from 'node:crypto';

export const API_BASE = 'https://www.googleapis.com/youtube/v3';

export type ErrorType =
    | 'missing-api-key'
    | 'invalid-url'
    | 'not-found'
    | 'comments-disabled'
    | 'rate-limited'
    | 'http-error'
    | 'timeout'
    | 'network'
    | 'other';

export type SortBy = 'relevance' | 'time';
export type AuthorMode = 'include' | 'hash' | 'omit';

/** A parsed entry from the startUrls input. */
export type Target =
    | { kind: 'video'; videoId: string; input: string }
    | { kind: 'channel'; channelId: string; input: string }
    | { kind: 'handle'; handle: string; input: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/**
 * Accepts watch / Shorts / live / embed / youtu.be URLs, bare 11-char video IDs, channel URLs (/@handle, /channel/UC...)
 * and bare @handles or UC... channel IDs. Returns null for anything else.
 */
export function parseTarget(raw: string): Target | null {
    const input = (raw ?? '').trim();
    if (!input) return null;
    if (VIDEO_ID.test(input)) return { kind: 'video', videoId: input, input };
    if (CHANNEL_ID.test(input)) return { kind: 'channel', channelId: input, input };
    if (HANDLE.test(input)) return { kind: 'handle', handle: input, input };

    let url: URL;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be' || host === 'www.youtu.be') {
        return parts[0] && VIDEO_ID.test(parts[0]) ? { kind: 'video', videoId: parts[0], input } : null;
    }
    if (!YT_HOSTS.has(host)) return null;

    const v = url.searchParams.get('v');
    if (parts[0] === 'watch' && v && VIDEO_ID.test(v)) return { kind: 'video', videoId: v, input };
    if (['shorts', 'live', 'embed', 'v'].includes(parts[0] ?? '') && parts[1] && VIDEO_ID.test(parts[1])) {
        return { kind: 'video', videoId: parts[1], input };
    }
    if (parts[0] === 'channel' && parts[1] && CHANNEL_ID.test(parts[1])) {
        return { kind: 'channel', channelId: parts[1], input };
    }
    if (parts[0]?.startsWith('@') && HANDLE.test(decodeURIComponent(parts[0]))) {
        return { kind: 'handle', handle: decodeURIComponent(parts[0]), input };
    }
    return null;
}

/** Channel IDs map to their uploads playlist by swapping the UC prefix for UU. */
export function uploadsPlaylistId(channelId: string): string {
    return `UU${channelId.slice(2)}`;
}

export function resolveSort(value: unknown): SortBy | null {
    if (value === undefined || value === null || value === '') return 'relevance';
    if (value === 'relevance' || value === 'top') return 'relevance';
    if (value === 'time' || value === 'newest') return 'time';
    return null;
}

export function resolveAuthorMode(value: unknown): AuthorMode | null {
    if (value === undefined || value === null || value === '') return 'include';
    return value === 'include' || value === 'hash' || value === 'omit' ? value : null;
}

/** Parses an ISO date or a relative "N days/weeks/months" string into a Date. Returns undefined when empty, null when invalid. */
export function parsePublishedAfter(value: unknown, now = new Date()): Date | null | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') return null;
    const rel = /^\s*(\d+)\s*(day|week|month|year)s?\s*(ago)?\s*$/i.exec(value);
    if (rel) {
        const n = Number(rel[1]);
        const d = new Date(now);
        const unit = rel[2].toLowerCase();
        if (unit === 'day') d.setUTCDate(d.getUTCDate() - n);
        else if (unit === 'week') d.setUTCDate(d.getUTCDate() - 7 * n);
        else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - n);
        else d.setUTCFullYear(d.getUTCFullYear() - n);
        return d;
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

// ---------- API response typing (only the fields we read) ----------

export interface ApiError {
    error?: { code?: number; message?: string; errors?: { reason?: string; message?: string }[] };
}

export interface CommentSnippet {
    videoId?: string;
    channelId?: string;
    textOriginal?: string;
    textDisplay?: string;
    authorDisplayName?: string;
    authorProfileImageUrl?: string;
    authorChannelUrl?: string;
    authorChannelId?: { value?: string };
    likeCount?: number;
    publishedAt?: string;
    updatedAt?: string;
    parentId?: string;
}

export interface ApiComment {
    id?: string;
    snippet?: CommentSnippet;
}

export interface CommentThread {
    id?: string;
    snippet?: {
        videoId?: string;
        channelId?: string;
        topLevelComment?: ApiComment;
        totalReplyCount?: number;
        canReply?: boolean;
    };
    replies?: { comments?: ApiComment[] };
}

export interface ListResponse<T> {
    items?: T[];
    nextPageToken?: string;
    pageInfo?: { totalResults?: number };
}

export interface VideoResource {
    id?: string;
    snippet?: { title?: string; channelId?: string; channelTitle?: string; publishedAt?: string };
    statistics?: { commentCount?: string };
}

export interface ChannelResource {
    id?: string;
    snippet?: { title?: string };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

export interface PlaylistItem {
    contentDetails?: { videoId?: string };
}

/** Thrown when a 2xx response does not have the shape we expect; the page is not billed. */
export class ResponseShapeError extends Error {}

export function assertList<T>(body: unknown, what: string): ListResponse<T> {
    if (!body || typeof body !== 'object' || !Array.isArray((body as ListResponse<T>).items)) {
        throw new ResponseShapeError(`YouTube returned an unexpected response for ${what} (no items array)`);
    }
    return body as ListResponse<T>;
}

// ---------- Output ----------

export interface VideoInfo {
    videoId: string;
    title: string | null;
    channelId: string | null;
    channelTitle: string | null;
    commentCount: number | null;
}

export interface CommentItem {
    success: true;
    commentId: string;
    commentUrl: string;
    videoId: string;
    videoUrl: string;
    videoTitle: string | null;
    videoChannelId: string | null;
    videoChannelTitle: string | null;
    text: string;
    likeCount: number;
    replyCount: number | null;
    isReply: boolean;
    parentCommentId: string | null;
    isByVideoOwner: boolean;
    publishedAt: string | null;
    updatedAt: string | null;
    isEdited: boolean;
    authorName: string | null;
    authorChannelId: string | null;
    authorChannelUrl: string | null;
    authorProfileImageUrl: string | null;
    scrapedAt: string;
}

export interface FailureItem {
    success: false;
    input: string;
    videoId: string | null;
    errorType: ErrorType;
    error: string;
    statusCode?: number;
    scrapedAt: string;
}

export function videoUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Stable, non-reversible pseudonym for an author channel ID (per salt), so the same commenter can be grouped without being identified. */
export function hashAuthor(id: string, salt: string): string {
    return createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 16);
}

export function mapComment(
    comment: ApiComment,
    video: VideoInfo,
    opts: { authorMode: AuthorMode; salt: string; replyCount: number | null; now?: Date },
): CommentItem | null {
    const s = comment.snippet;
    if (!comment.id || !s) return null;
    const text = s.textOriginal ?? s.textDisplay;
    if (typeof text !== 'string') return null;
    const authorId = s.authorChannelId?.value ?? null;
    const isReply = Boolean(s.parentId);
    const base = {
        success: true as const,
        commentId: comment.id,
        commentUrl: `${videoUrl(video.videoId)}&lc=${comment.id}`,
        videoId: video.videoId,
        videoUrl: videoUrl(video.videoId),
        videoTitle: video.title,
        videoChannelId: video.channelId,
        videoChannelTitle: video.channelTitle,
        text,
        likeCount: s.likeCount ?? 0,
        replyCount: isReply ? null : opts.replyCount,
        isReply,
        parentCommentId: s.parentId ?? null,
        isByVideoOwner: Boolean(authorId && video.channelId && authorId === video.channelId),
        publishedAt: s.publishedAt ?? null,
        updatedAt: s.updatedAt ?? null,
        isEdited: Boolean(s.publishedAt && s.updatedAt && s.publishedAt !== s.updatedAt),
    };
    const scrapedAt = (opts.now ?? new Date()).toISOString();
    if (opts.authorMode === 'omit') {
        return {
            ...base,
            authorName: null,
            authorChannelId: null,
            authorChannelUrl: null,
            authorProfileImageUrl: null,
            scrapedAt,
        };
    }
    if (opts.authorMode === 'hash') {
        return {
            ...base,
            authorName: null,
            authorChannelId: authorId ? hashAuthor(authorId, opts.salt) : null,
            authorChannelUrl: null,
            authorProfileImageUrl: null,
            scrapedAt,
        };
    }
    return {
        ...base,
        authorName: s.authorDisplayName ?? null,
        authorChannelId: authorId,
        authorChannelUrl: s.authorChannelUrl?.replace(/^http:/, 'https:') ?? null,
        authorProfileImageUrl: s.authorProfileImageUrl ?? null,
        scrapedAt,
    };
}

/** True when the comment passes the optional date filter. */
export function isAfter(publishedAt: string | null, after: Date | undefined): boolean {
    if (!after) return true;
    if (!publishedAt) return true;
    return new Date(publishedAt).getTime() >= after.getTime();
}

// ---------- Errors ----------

export function errorReason(body: unknown): string | undefined {
    return (body as ApiError | undefined)?.error?.errors?.[0]?.reason;
}

export function categorizeHttpError(
    status: number,
    body: unknown,
    rawText: string,
): { errorType: ErrorType; error: string; reason?: string } {
    const reason = errorReason(body);
    const message = (body as ApiError | undefined)?.error?.message ?? rawText.slice(0, 200) ?? `HTTP ${status}`;
    if (reason === 'commentsDisabled') {
        return { errorType: 'comments-disabled', error: 'The owner has turned comments off for this video', reason };
    }
    if (reason === 'videoNotFound' || reason === 'channelNotFound' || reason === 'playlistNotFound' || status === 404) {
        return { errorType: 'not-found', error: message, reason };
    }
    if (
        reason === 'quotaExceeded' ||
        reason === 'rateLimitExceeded' ||
        reason === 'dailyLimitExceeded' ||
        status === 429
    ) {
        return {
            errorType: 'rate-limited',
            error: 'The YouTube API quota for this key is used up. Try again after midnight Pacific Time or add your own free API key.',
            reason,
        };
    }
    if (reason === 'keyInvalid' || (reason === 'badRequest' && /api key/i.test(message))) {
        return { errorType: 'other', error: 'The YouTube API key is not valid', reason: 'keyInvalid' };
    }
    if (
        reason === 'accessNotConfigured' ||
        (reason === 'forbidden' && /has not been used|is disabled/i.test(message))
    ) {
        return {
            errorType: 'other',
            error: "The YouTube Data API v3 is not enabled for this API key's Google Cloud project",
            reason: 'accessNotConfigured',
        };
    }
    return { errorType: 'http-error', error: `${message} (HTTP ${status})`, reason };
}

export function categorizeFetchError(err: unknown): { errorType: ErrorType; error: string } {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
        return { errorType: 'timeout', error: 'Request timed out' };
    return { errorType: 'network', error: e?.cause?.code ?? e?.message ?? 'Network error' };
}

/** Errors that affect every request made with the same key: the run should stop instead of failing video by video. */
export function isKeyWideError(reason: string | undefined): boolean {
    return (
        reason === 'quotaExceeded' ||
        reason === 'dailyLimitExceeded' ||
        reason === 'keyInvalid' ||
        reason === 'accessNotConfigured'
    );
}
