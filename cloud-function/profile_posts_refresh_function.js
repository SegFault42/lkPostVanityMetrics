'use strict';

const admin = require('firebase-admin');

const PROFILE_POSTS_FUNCTION_URL = process.env.PROFILE_POSTS_FUNCTION_URL ||
  'https://us-central1-linkedincreatorleaderboard.cloudfunctions.net/profilePostsFetcher';
const REFRESH_AUTH_KEY = process.env.REFRESH_AUTH_KEY;
const DEFAULT_TIMEOUT_MS = 60000;
const BATCH_DELAY_MS = Number(process.env.REFRESH_BATCH_DELAY_MS || 500);
const CONCURRENCY = Math.max(1, Number(process.env.REFRESH_CONCURRENCY || 5));

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

async function callProfilePostsFetcher(profileUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(PROFILE_POSTS_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(REFRESH_AUTH_KEY ? { 'x-refresh-key': REFRESH_AUTH_KEY } : {}),
      },
      body: JSON.stringify({ url: profileUrl }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`status ${response.status}: ${details.slice(0, 200)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function validateAuth(req) {
  if (!REFRESH_AUTH_KEY) {
    return true;
  }
  const provided = req.headers['x-refresh-key'] || req.body?.key || req.query.key;
  return provided === REFRESH_AUTH_KEY;
}

exports.refreshCreators = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (!validateAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const snapshot = await db.collection('creators').get();
    const creatorIds = snapshot.docs.map((doc) => doc.id);

    const errors = [];
    let refreshed = 0;

    const queue = creatorIds.slice();
    const workerCount = Math.min(CONCURRENCY, Math.max(queue.length, 1));
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const vanity = queue.shift();
        if (!vanity) {
          break;
        }
        const profileUrl = vanity.startsWith('http') ? vanity : `https://www.linkedin.com/in/${vanity}/`;
        try {
          await callProfilePostsFetcher(profileUrl);
          refreshed += 1;
        } catch (err) {
          errors.push({ vanity, error: err.message });
        }
        if (BATCH_DELAY_MS > 0 && queue.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }
    });

    await Promise.all(workers);

    res.json({ total: creatorIds.length, refreshed, errors, concurrency: CONCURRENCY });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error' });
  }
};
