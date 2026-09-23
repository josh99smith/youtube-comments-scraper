![youtube-comments-scraper banner](https://raw.githubusercontent.com/josh99smith/apify-actor-assets/main/banners/youtube-comments-scraper.png?v=bd1)

Get **YouTube comments and replies** from any video, Short or whole channel through the **official YouTube Data API v3**: comment text, likes, reply counts, post and edit dates, whether the creator wrote it, and a direct link to every comment, in one downloadable dataset.

Built for **marketers, brand and community managers, researchers and AI builders** who need audience reactions at scale: sentiment analysis, product feedback mining, creator research and LLM training sets. You pay a flat price per comment, and videos that cannot be read (comments off, private, deleted) cost nothing.

## Features

- Scrape YouTube comments from video, Shorts and live URLs or bare video IDs
- Scrape comments from a whole YouTube channel's most recent videos (`@handle` or channel URL)
- Include replies in conversation order, linked to their parent comment
- Sort by top comments or newest first
- Only comments after a date, e.g. "last 7 days" for monitoring
- Only comments containing a keyword (YouTube's own comment search)
- Flag comments written by the video's creator
- Pseudonymise or drop author data for privacy-friendly research
- Export YouTube comments to CSV, Excel, JSON or Google Sheets

## What can you do with Best Damn YouTube Comments Scraper?

- **Sentiment and brand monitoring**: schedule a daily run over your channel with "Only comments after: 1 day" and feed new comments into a sentiment model or a Slack channel.
- **Product feedback mining**: pull every comment on review and unboxing videos of your product (or a competitor's) and cluster the complaints.
- **Creator and influencer research**: compare engagement (likes per comment, creator reply rate) across channels before a sponsorship.
- **Content ideas**: collect the questions viewers ask under the top videos in your niche.
- **AI datasets**: build clean comment corpora for classification or fine-tuning, with optional pseudonymised authors.

## How it works

The Actor calls Google's official YouTube Data API v3 (`commentThreads`, `comments`, `videos`, `channels` and `playlistItems`), the same data YouTube shows publicly under a video. Nothing is scraped from HTML, no browser runs and no login is used. Each API page returns up to 100 comments, so runs are fast (typically under a second per 100 comments). YouTube only exposes comments for public videos whose owner has not turned comments off; made-for-kids videos never have comments.

## How to use it

1. Paste one or more video, Shorts or channel URLs into **YouTube URLs**, one per line.
2. Set **Max comments per video** (0 = all) and choose **Top comments** or **Newest first**.
3. Optionally switch on **Include replies**, set **Only comments after** or **Only comments containing**, and pick how much **Author data** to keep.
4. Click **Start**. Comments appear in the **Output** tab as they arrive; download them as JSON, CSV or Excel, or connect an integration.

```json
{
    "startUrls": ["https://www.youtube.com/watch?v=jNQXAC9IVRw", "https://www.youtube.com/@YouTube"],
    "maxComments": 500,
    "sortBy": "time",
    "includeReplies": true,
    "publishedAfter": "30 days",
    "authorData": "include",
    "maxVideosPerChannel": 5
}
```

## Use it from the API, Python, JavaScript or an AI agent

Get the 100 top comments of a video in one HTTP call:

```bash
curl -X POST "https://api.apify.com/v2/acts/josh99smith~youtube-comments-scraper/run-sync-get-dataset-items?token=<YOUR_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"startUrls": ["https://www.youtube.com/watch?v=jNQXAC9IVRw"], "maxComments": 100}'
```

Python, with the `apify-client` package:

```python
from apify_client import ApifyClient

client = ApifyClient("<YOUR_API_TOKEN>")
run = client.actor("josh99smith/youtube-comments-scraper").call(
    run_input={"startUrls": ["https://www.youtube.com/@YouTube"], "maxVideosPerChannel": 3, "includeReplies": True}
)
for item in client.dataset(run["defaultDatasetId"]).iterate_items():
    if item["success"]:
        print(item["videoTitle"], item["likeCount"], item["text"][:80])
```

JavaScript or TypeScript, with the `apify-client` package:

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: '<YOUR_API_TOKEN>' });
const run = await client.actor('josh99smith/youtube-comments-scraper').call({
    startUrls: ['https://youtu.be/jNQXAC9IVRw'],
    sortBy: 'time',
    publishedAfter: '7 days',
});
const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(items.filter((i) => i.success).length, 'new comments');
```

### Use it from Claude, Cursor, ChatGPT or any MCP client

The Actor is exposed as a tool by the [Apify MCP server](https://mcp.apify.com), so an AI agent can call it by name. Add this to your MCP client configuration (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf and others):

```json
{
    "mcpServers": {
        "apify": {
            "url": "https://mcp.apify.com?tools=josh99smith/youtube-comments-scraper",
            "headers": { "Authorization": "Bearer <YOUR_API_TOKEN>" }
        }
    }
}
```

Then ask, for example: _"Get the newest 200 comments on https://youtu.be/jNQXAC9IVRw with josh99smith/youtube-comments-scraper and summarise what viewers are asking."_ The agent fills in the input, runs the Actor and reads the dataset back; you pay the same per-comment price as in the Console.

## Output

One record per comment or reply. Real example (trimmed):

```json
{
    "success": true,
    "commentId": "UgzuC3zzpRZkjc5Qzsd4AaABAg",
    "commentUrl": "https://www.youtube.com/watch?v=jNQXAC9IVRw&lc=UgzuC3zzpRZkjc5Qzsd4AaABAg",
    "videoId": "jNQXAC9IVRw",
    "videoTitle": "Me at the zoo",
    "videoChannelTitle": "jawed",
    "text": "We're so honored that the first ever YouTube video was filmed here!",
    "likeCount": 4830783,
    "replyCount": 1000,
    "isReply": false,
    "parentCommentId": null,
    "isByVideoOwner": false,
    "publishedAt": "2020-02-17T18:58:15Z",
    "isEdited": false,
    "authorName": "@SanDiegoZoo",
    "authorChannelId": "UCC5NfQ6Mf0dq_eEwv4P_hWA",
    "authorChannelUrl": "https://www.youtube.com/@SanDiegoZoo",
    "scrapedAt": "2026-09-23T14:04:13.713Z"
}
```

Videos that cannot be read produce a free record instead, for example `{"success": false, "input": "https://www.youtube.com/watch?v=XqZsoesa55w", "errorType": "comments-disabled", "error": "The owner has turned comments off for this video"}`.

## Output fields

| Field                                                                           | Description                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commentId` / `commentUrl`                                                      | YouTube's comment ID and a link that opens the video with the comment highlighted.                                                                                                      |
| `videoId` / `videoUrl` / `videoTitle`                                           | The video the comment belongs to.                                                                                                                                                       |
| `videoChannelId` / `videoChannelTitle`                                          | The channel that owns the video.                                                                                                                                                        |
| `text`                                                                          | The comment as the author wrote it, in plain text.                                                                                                                                      |
| `likeCount`                                                                     | Likes on the comment.                                                                                                                                                                   |
| `replyCount`                                                                    | Total replies under a top-level comment (`null` for replies).                                                                                                                           |
| `isReply` / `parentCommentId`                                                   | Whether the record is a reply, and to which comment.                                                                                                                                    |
| `isByVideoOwner`                                                                | `true` when the video's creator wrote the comment (works in every author-data mode).                                                                                                    |
| `publishedAt` / `updatedAt` / `isEdited`                                        | When the comment was posted and last edited.                                                                                                                                            |
| `authorName` / `authorChannelId` / `authorChannelUrl` / `authorProfileImageUrl` | Public commenter identity with **Author data: Include**. With **Pseudonymise**, `authorChannelId` is a stable 16-character hash and the rest are `null`; with **Omit**, all are `null`. |
| `success`                                                                       | `true` for a delivered (billed) comment, `false` for a free failure record.                                                                                                             |
| `errorType`                                                                     | For failures: `invalid-url`, `not-found`, `comments-disabled`, `rate-limited`, `missing-api-key`, `http-error`, `timeout`, `network` or `other`.                                        |

A `SUMMARY` record in the key-value store lists comments per video, failures and the API quota units used.

## Pricing: how much does it cost to scrape YouTube comments?

You pay a **flat price per delivered comment or reply** (see the price next to the Start button): 1,000 comments cost $0.40. Videos with comments turned off, private or deleted videos, invalid URLs and quota errors cost nothing, and there is no charge for Actor start-up. The Actor stops automatically when it reaches the maximum cost you set for a run, so "all comments" on a viral video never produces a surprise bill.

**How it compares (September 2026).** The most popular YouTube comment actors on Apify Store charge $0.50 to $2.00 per 1,000 comments. This one charges $0.40, reads comments through the official API instead of the YouTube website, and adds channel input, date and keyword filters and privacy options.

## API key and quota

By default the Actor uses a built-in YouTube API key shared by all its users. The YouTube Data API is free but each key has a daily quota of 10,000 units, and every page of up to 100 comments costs one unit. For large or scheduled workloads, create your own free key in the [Google Cloud Console](https://developers.google.com/youtube/v3/getting-started) (enable "YouTube Data API v3", then create an API key) and paste it into **YouTube API key**: that gives you roughly a million comments a day to yourself. The key is stored encrypted and never written to the log or dataset. When a quota is exhausted, the run stops cleanly and the remaining videos are listed as free `rate-limited` records; the quota resets at midnight Pacific Time.

## Tips

- **Monitoring**: combine **Newest first** with **Only comments after** (for example "1 day") on a daily schedule; the Actor stops paging as soon as it reaches older comments, so each run is cheap and fast.
- **Whole conversation**: switch on **Include replies**; replies follow their parent comment in posting order.
- **Top vs newest**: "Top comments" is what viewers see first and is best for sentiment; "Newest first" is best for monitoring.
- **Keyword filter**: **Only comments containing** uses YouTube's own search and applies to top-level comments.
- **Big channels**: raise **Videos per channel** gradually; each video is read in parallel, up to **Max concurrency**.

## FAQ

### Is it legal to scrape YouTube comments?

The Actor does not scrape YouTube's website: it uses Google's official, documented YouTube Data API under its terms of service and returns only comments that are publicly visible. Comments are personal data under GDPR and similar laws, so you are responsible for having a legitimate purpose. The **Pseudonymise** and **Omit** author options help you collect only what you need. This Actor is not affiliated with, endorsed by or sponsored by YouTube or Google.

### Why do I get fewer comments than the video shows?

YouTube's comment count includes replies and comments held for review or later removed as spam; the API returns what is currently public. Use **Include replies** to get replies too.

### Why does a video return "comments-disabled"?

The owner turned comments off, or the video is marked as made for kids. There is nothing to collect, and the record is free.

### Can it get comments from private or members-only videos?

No. Only public videos are available through the API, and the Actor never logs in.

### Will the output fields change between runs?

No. Output fields are stable: existing fields are never renamed or removed without a major version bump announced in the changelog, and new fields are only ever added. You can build integrations on the schema without checking it after every run.

## Integrate Best Damn YouTube Comments Scraper and automate your workflow

Best Damn YouTube Comments Scraper plugs into the tools you already use through [Apify integrations](https://docs.apify.com/platform/integrations), so results can flow on without anyone downloading a file. Ready-made connectors include:

- [Make](https://docs.apify.com/platform/integrations/make)
- [Zapier](https://docs.apify.com/platform/integrations/zapier)
- [n8n](https://docs.apify.com/platform/integrations/n8n)
- [Slack](https://docs.apify.com/platform/integrations/slack)
- [Airbyte](https://docs.apify.com/platform/integrations/airbyte)
- [GitHub](https://docs.apify.com/platform/integrations/github)
- [Google Drive](https://docs.apify.com/platform/integrations/drive)
- and [many more](https://docs.apify.com/platform/integrations).

You can also attach [webhooks](https://docs.apify.com/platform/integrations/webhooks) to trigger your own endpoint whenever a run succeeds, fails or times out. For example, post every new comment on your channel to Slack, or send the day's comments to a sentiment model and a Google Sheet.

## Related Actors by the same developer

- [Best Damn App Reviews Scraper](https://apify.com/josh99smith/app-reviews-scraper): App Store and Google Play reviews as JSON.
- [Best Damn Google Autocomplete Scraper](https://apify.com/josh99smith/google-autocomplete-scraper): keyword suggestions from Google search.
- [Best Damn RSS to JSON Converter](https://apify.com/josh99smith/rss-feed-to-json): RSS and Atom feeds as JSON.
- [Best Damn Tech Stack Detector](https://apify.com/josh99smith/tech-stack-detector): find out what a website is built with.
- [Best Damn Website Screenshot API](https://apify.com/josh99smith/website-screenshot-api): full-page screenshots and PDFs of any URL.
- [Best Damn PageSpeed Insights Audit](https://apify.com/josh99smith/pagespeed-insights-audit): Core Web Vitals and Lighthouse scores in bulk.
- [Best Damn Remote Jobs Aggregator](https://apify.com/josh99smith/remote-jobs-aggregator): remote job listings from five public boards.
- [Best Damn PDF Text Extractor](https://apify.com/josh99smith/pdf-text-extractor): text and metadata from PDF files.
- [Best Damn Sitemap URL Extractor](https://apify.com/josh99smith/sitemap-url-extractor): all URLs from XML sitemaps.

## Support and feedback

Found a video that fails unexpectedly, or a field you are missing? Open a ticket in the **Issues** tab of this Actor.
