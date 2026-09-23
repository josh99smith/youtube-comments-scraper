import { setTimeout as sleep } from 'node:timers/promises';

import { Actor, log } from 'apify';

import { type ApiResult, YouTubeClient } from './client.js';
import { runPool } from './pool.js';
import {
    type ApiComment,
    assertList,
    type ChannelResource,
    type CommentItem,
    type CommentThread,
    type ErrorType,
    type FailureItem,
    isAfter,
    isKeyWideError,
    type ListResponse,
    mapComment,
    parsePublishedAfter,
    parseTarget,
    type PlaylistItem,
    resolveAuthorMode,
    resolveSort,
    ResponseShapeError,
    uploadsPlaylistId,
    type VideoInfo,
    type VideoResource,
} from './youtube.js';

const CHARGE_EVENT = 'comment';
const OLDER_IN_A_ROW_CUTOFF = 5;
const MISSING_KEY_MESSAGE =
    'No YouTube API key available. Add your free YouTube Data API v3 key to the "apiKey" input ' +
    '(https://developers.google.com/youtube/v3/getting-started) or set the YOUTUBE_API_KEY environment variable.';

interface Input {
    startUrls?: (string | { url: string })[];
    maxComments?: number;
    sortBy?: string;
    includeReplies?: boolean;
    publishedAfter?: string;
    searchTerms?: string;
    maxVideosPerChannel?: number;
    authorData?: string;
    apiKey?: string;
    maxConcurrency?: number;
}

await Actor.init();

let aborting = false;
Actor.on('aborting', async () => {
    aborting = true;
    await sleep(1000);
    await Actor.exit();
});

const input = (await Actor.getInput<Input>()) ?? {};
const sortBy = resolveSort(input.sortBy);
if (!sortBy) await Actor.fail(`Input "sortBy" must be "relevance" or "time" (got "${input.sortBy}").`);
const authorMode = resolveAuthorMode(input.authorData);
if (!authorMode)
    await Actor.fail(`Input "authorData" must be "include", "hash" or "omit" (got "${input.authorData}").`);
const publishedAfter = parsePublishedAfter(input.publishedAfter);
if (publishedAfter === null) {
    await Actor.fail(
        `Input "publishedAfter" must be a date like 2026-01-31 or a relative period like "30 days" (got "${input.publishedAfter}").`,
    );
}
const maxComments = Math.max(Math.floor(input.maxComments ?? 100), 0); // 0 = no limit
const includeReplies = input.includeReplies ?? false;
const searchTerms = (input.searchTerms ?? '').trim() || undefined;
const maxVideosPerChannel = Math.min(Math.max(Math.floor(input.maxVideosPerChannel ?? 10), 1), 500);
const maxConcurrency = Math.min(Math.max(Math.floor(input.maxConcurrency ?? 4), 1), 10);
const apiKey = (input.apiKey ?? process.env.YOUTUBE_API_KEY ?? '').trim();
const ownKey = Boolean(input.apiKey?.trim());
// Hashed author IDs stay consistent across all runs of the same Apify user, but differ between users.
const salt = process.env.APIFY_USER_ID ?? 'local';

const rawInputs = (input.startUrls ?? [])
    .map((u) => (typeof u === 'string' ? u : (u?.url ?? '')))
    .filter((s) => s.trim());
if (rawInputs.length === 0) {
    await Actor.fail(
        'Input "startUrls" is empty. Add at least one YouTube video or channel URL, e.g. https://www.youtube.com/watch?v=jNQXAC9IVRw',
    );
}

const failures: FailureItem[] = [];
const fail = (
    inputStr: string,
    videoId: string | null,
    errorType: ErrorType,
    error: string,
    statusCode?: number,
): FailureItem => {
    const item: FailureItem = {
        success: false,
        input: inputStr,
        videoId,
        errorType,
        error: error.slice(0, 500),
        statusCode,
        scrapedAt: new Date().toISOString(),
    };
    log.warning(`${inputStr}: ${errorType} - ${item.error}`);
    failures.push(item);
    return item;
};

const targets = [];
for (const raw of rawInputs) {
    const t = parseTarget(raw);
    if (t) targets.push(t);
    else
        fail(
            raw,
            null,
            'invalid-url',
            'Not a YouTube video URL, Shorts URL, video ID, channel URL, @handle or channel ID',
        );
}

const chargingManager = Actor.getChargingManager();
const { isPayPerEvent } = chargingManager.getPricingInfo();
const client = new YouTubeClient({ apiKey });
let keyStop: { errorType: ErrorType; error: string } | null = null; // quota / key problem: no further request can succeed
let budgetStop = false;
let charged = 0;
let pushedComments = 0;
const shouldStop = () => aborting || budgetStop || keyStop !== null;

/** Records a failed API call; returns true if it was a key-wide error that stops the run. */
function handleError(res: Extract<ApiResult<unknown>, { ok: false }>, inputStr: string, videoId: string | null): void {
    if (isKeyWideError(res.reason)) {
        if (!keyStop) {
            keyStop = { errorType: res.errorType, error: res.error };
            log.error(`${res.error}. Stopping: no further requests can succeed with this key.`);
        }
    }
    fail(inputStr, videoId, res.errorType, res.error, res.statusCode);
}

if (!apiKey) {
    log.error(MISSING_KEY_MESSAGE);
    for (const t of targets)
        fail(t.input, t.kind === 'video' ? t.videoId : null, 'missing-api-key', MISSING_KEY_MESSAGE);
    targets.length = 0;
}

// ---------- 1. Resolve channels and handles to video IDs ----------
const videoInputs = new Map<string, string>(); // videoId -> the input line it came from
for (const t of targets) {
    if (shouldStop()) break;
    if (t.kind === 'video') {
        if (!videoInputs.has(t.videoId)) videoInputs.set(t.videoId, t.input);
        continue;
    }
    let channelId = t.kind === 'channel' ? t.channelId : null;
    if (t.kind === 'handle') {
        const res = await client.list<ListResponse<ChannelResource>>('channels', { part: 'id', forHandle: t.handle });
        if (!res.ok) {
            handleError(res, t.input, null);
            continue;
        }
        channelId = res.body.items?.[0]?.id ?? null;
        if (!channelId) {
            fail(t.input, null, 'not-found', `No YouTube channel found for ${t.handle}`);
            continue;
        }
    }
    let pageToken: string | undefined;
    let found = 0;
    while (found < maxVideosPerChannel && !shouldStop()) {
        const res = await client.list<ListResponse<PlaylistItem>>('playlistItems', {
            part: 'contentDetails',
            playlistId: uploadsPlaylistId(channelId!),
            maxResults: Math.min(50, maxVideosPerChannel - found),
            pageToken,
        });
        if (!res.ok) {
            handleError(res, t.input, null);
            break;
        }
        for (const it of res.body.items ?? []) {
            const id = it.contentDetails?.videoId;
            if (id && found < maxVideosPerChannel) {
                found += 1;
                if (!videoInputs.has(id)) videoInputs.set(id, t.input);
            }
        }
        pageToken = res.body.nextPageToken;
        if (!pageToken) break;
    }
    log.info(`${t.input}: ${found} most recent video(s) queued`);
}

// ---------- 2. Video metadata (also tells us which IDs exist) ----------
const videos = new Map<string, VideoInfo>();
const ids = [...videoInputs.keys()];
for (let i = 0; i < ids.length && !shouldStop(); i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await client.list<ListResponse<VideoResource>>('videos', {
        part: 'snippet,statistics',
        id: chunk.join(','),
        maxResults: 50,
    });
    if (!res.ok) {
        for (const id of chunk) handleError(res, videoInputs.get(id)!, id);
        continue;
    }
    for (const v of res.body.items ?? []) {
        if (!v.id) continue;
        const cc = v.statistics?.commentCount;
        videos.set(v.id, {
            videoId: v.id,
            title: v.snippet?.title ?? null,
            channelId: v.snippet?.channelId ?? null,
            channelTitle: v.snippet?.channelTitle ?? null,
            commentCount: cc === undefined ? null : Number(cc),
        });
    }
    for (const id of chunk) {
        if (!videos.has(id))
            fail(videoInputs.get(id)!, id, 'not-found', 'Video not found: it is private, deleted or the ID is wrong');
    }
}

// ---------- 3. Comments ----------
const perVideo: Record<string, number> = {};

/** Pushes and charges a batch of comments. Returns false when the run's budget is exhausted. */
async function deliver(items: CommentItem[]): Promise<boolean> {
    if (!items.length) return true;
    const { eventChargeLimitReached } = await Actor.pushData(items, CHARGE_EVENT);
    pushedComments += items.length;
    charged += items.length;
    if (eventChargeLimitReached) {
        budgetStop = true;
        log.warning(
            'Maximum charge limit for this run reached; stopping early. Raise the run cost limit to get more comments.',
        );
        return false;
    }
    return true;
}

async function fetchReplies(parentId: string, video: VideoInfo, room: number): Promise<CommentItem[] | null> {
    const out: CommentItem[] = [];
    let pageToken: string | undefined;
    do {
        const res = await client.list<ListResponse<ApiComment>>('comments', {
            part: 'snippet',
            parentId,
            maxResults: 100,
            textFormat: 'plainText',
            pageToken,
        });
        if (!res.ok) {
            handleError(res, videoInputs.get(video.videoId)!, video.videoId);
            return null;
        }
        const body = assertList<ApiComment>(res.body, 'comment replies');
        for (const c of body.items!) {
            const item = mapComment(c, video, { authorMode: authorMode!, salt, replyCount: null });
            if (item && isAfter(item.publishedAt, publishedAfter ?? undefined)) out.push(item);
        }
        pageToken = body.nextPageToken;
    } while (pageToken && (room === 0 || out.length < room) && !shouldStop());
    return out;
}

async function scrapeVideo(video: VideoInfo): Promise<void> {
    const inputStr = videoInputs.get(video.videoId)!;
    let pageToken: string | undefined;
    let count = 0;
    let olderInARow = 0;
    const started = Date.now();
    const room = () => (maxComments === 0 ? Infinity : maxComments - count);
    try {
        do {
            const res = await client.list<ListResponse<CommentThread>>('commentThreads', {
                part: includeReplies ? 'snippet,replies' : 'snippet',
                videoId: video.videoId,
                maxResults: 100,
                order: sortBy!,
                textFormat: 'plainText',
                searchTerms,
                pageToken,
            });
            if (!res.ok) {
                handleError(res, inputStr, video.videoId);
                return;
            }
            const body = assertList<CommentThread>(res.body, 'comment threads');
            const batch: CommentItem[] = [];
            let reachedCutoff = false;
            for (const th of body.items!) {
                if (room() - batch.length <= 0) break;
                const top = th.snippet?.topLevelComment;
                if (!top) continue;
                const totalReplies = th.snippet?.totalReplyCount ?? 0;
                const item = mapComment(top, video, { authorMode: authorMode!, salt, replyCount: totalReplies });
                if (!item) continue;
                if (!isAfter(item.publishedAt, publishedAfter ?? undefined)) {
                    // Newest-first order: once several older threads arrive in a row, the rest are older too.
                    // (A single old thread is usually the pinned comment, which YouTube always lists first.)
                    olderInARow += 1;
                    if (sortBy === 'time' && olderInARow >= OLDER_IN_A_ROW_CUTOFF) {
                        reachedCutoff = true;
                        break;
                    }
                    continue;
                }
                olderInARow = 0;
                batch.push(item);
                if (includeReplies && totalReplies > 0) {
                    const inline = th.replies?.comments ?? [];
                    let replies: CommentItem[] | null;
                    if (inline.length >= totalReplies) {
                        replies = inline
                            .map((c) => mapComment(c, video, { authorMode: authorMode!, salt, replyCount: null }))
                            .filter(
                                (c): c is CommentItem =>
                                    c !== null && isAfter(c.publishedAt, publishedAfter ?? undefined),
                            );
                    } else {
                        const left = room() - batch.length;
                        replies = await fetchReplies(top.id!, video, Number.isFinite(left) ? left : 0);
                        if (replies === null) break;
                    }
                    // The API returns replies newest first; restore conversation order.
                    replies.sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''));
                    batch.push(...replies.slice(0, Math.max(room() - batch.length, 0)));
                }
            }
            count += batch.length;
            if (!(await deliver(batch))) return;
            pageToken = reachedCutoff ? undefined : body.nextPageToken;
        } while (pageToken && room() > 0 && !shouldStop());
    } catch (err) {
        if (err instanceof ResponseShapeError) {
            fail(inputStr, video.videoId, 'other', err.message);
            return;
        }
        throw err;
    } finally {
        perVideo[video.videoId] = count;
    }
    log.info(
        `${video.videoId} "${(video.title ?? '').slice(0, 60)}": ${count} comment(s)` +
            `${video.commentCount !== null ? ` of ${video.commentCount} on YouTube` : ''} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
}

if (videos.size && !shouldStop()) {
    log.info(
        `Scraping comments from ${videos.size} video(s): sort ${sortBy}, max ${maxComments || 'all'} per video, replies ${includeReplies ? 'on' : 'off'}, ` +
            `author data ${authorMode}, key from ${ownKey ? 'input' : 'environment'}.`,
    );
}
const queue = [...videos.values()];
const { skipped } = await runPool(queue, maxConcurrency, scrapeVideo, shouldStop);

// Videos we never reached because the key's quota ran out get an explicit free record, so users know what to rerun.
if (keyStop) {
    const done = new Set(Object.keys(perVideo));
    const stopped: { errorType: ErrorType; error: string } = keyStop;
    for (const v of queue) {
        if (!done.has(v.videoId)) fail(videoInputs.get(v.videoId)!, v.videoId, stopped.errorType, stopped.error);
    }
}
if (failures.length) await Actor.pushData(failures); // free of charge

const summary = {
    inputs: rawInputs.length,
    videos: videos.size,
    comments: pushedComments,
    commentsPerVideo: perVideo,
    failed: failures.length,
    skippedVideos: keyStop ? 0 : skipped,
    quotaUnitsUsed: client.unitsUsed,
    chargedEvents: isPayPerEvent ? charged : undefined,
    stoppedEarlyDueToBudget: budgetStop,
    stoppedBecauseOfKey: keyStop ? (keyStop as { error: string }).error : null,
};
await Actor.setValue('SUMMARY', summary);
log.info(`Done. ${JSON.stringify({ ...summary, commentsPerVideo: undefined })}`);

await Actor.exit();
