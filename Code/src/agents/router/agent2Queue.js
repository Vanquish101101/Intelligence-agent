import crypto from 'crypto';
import { getRedis } from '../../db/redis.js';

// Redis queue key — must match Agent 2's queue/index.js HEAVY_JOBS_QUEUE_KEY
const QUEUE_KEY = 'queue:deep-parsing:jobs';

/**
 * Route complex content items to Agent 2 (Deep parsing agent) via Redis queue.
 * Fire-and-forget: Redis errors are non-fatal, Agent 2 may not be running.
 *
 * @param {Array<{url: string, type: 'video'|'text'|'audio'|'document', query?: string}>} items
 * @returns {string[]} list of job_ids queued
 */
export async function routeToAgent2(items) {
  if (!items || items.length === 0) return [];

  const redis = getRedis();
  const queued = [];

  for (const item of items) {
    const job = {
      job_id:       crypto.randomUUID(),
      content_ref:  item.url,
      content_type: item.type,
      source:       'agent1',
      source_query: item.query || '',
      created_at:   new Date().toISOString()
    };

    try {
      await redis.rpush(QUEUE_KEY, JSON.stringify(job));
      queued.push(job.job_id);
    } catch (err) {
      process.stderr.write(`[Router→Agent2] queue push failed: ${err.message}\n`);
    }
  }

  if (queued.length > 0) {
    process.stdout.write(`[Router→Agent2] queued ${queued.length} job(s): ${queued.join(', ')}\n`);
  }

  return queued;
}

/**
 * Determine if a URL requires deep parsing by Agent 2.
 * Returns { needs: true, type } or { needs: false }.
 */
export function classifyContent(url) {
  if (!url) return { needs: false };
  const lower = url.toLowerCase();

  if (lower.includes('youtube.com/watch') || lower.includes('youtu.be/')) {
    return { needs: true, type: 'video' };
  }
  if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.avi')) {
    return { needs: true, type: 'video' };
  }
  if (lower.endsWith('.mp3') || lower.endsWith('.wav') || lower.endsWith('.ogg')) {
    return { needs: true, type: 'audio' };
  }
  if (lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.doc')) {
    return { needs: true, type: 'document' };
  }

  return { needs: false };
}

/**
 * Build the routing payload from Scout results.
 * YouTube videos → type 'video', complex web pages with no content → type 'text'.
 */
export function buildAgent2Jobs(scoutResult, queryTopics = []) {
  const jobs = [];
  const query = queryTopics.join(', ');

  // YouTube videos found by Scout — route for transcript extraction
  const youtubeItems = scoutResult.data['apify-youtube'] || [];
  for (const video of youtubeItems) {
    if (video.url) {
      jobs.push({ url: video.url, type: 'video', query });
    }
  }

  // Firecrawl pages with very short content — may need deeper scraping
  const webItems = scoutResult.data.firecrawl || [];
  for (const page of webItems) {
    if (page.url && page.content && page.content.length < 100) {
      jobs.push({ url: page.url, type: 'text', query });
    }
  }

  return jobs;
}
