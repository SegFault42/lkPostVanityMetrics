'use strict';

const { URLSearchParams } = require('url');
const admin = require('firebase-admin');

const PROFILE_URN_FUNCTION_URL = process.env.PROFILE_URN_FUNCTION_URL ||
  'https://us-central1-linkedincreatorleaderboard.cloudfunctions.net/profileUrnFetcher';

const GRAPHQL_URL = 'https://www.linkedin.com/voyager/api/graphql';
const QUERY_ID = 'voyagerFeedDashProfileUpdates.80d5abb3cd25edff72c093a5db696079';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const DEFAULT_COUNT = 100;
const DEFAULT_TIMEOUT_SECONDS = 30;

const BROWSER_HEADER_PRESET = {
  'accept': 'application/vnd.linkedin.normalized+json+2.1',
  'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'priority': 'u=1, i',
  'sec-ch-prefers-color-scheme': 'dark',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': USER_AGENT,
  'x-li-lang': 'en_US',
  'x-li-page-instance': 'urn:li:page:d_flagship3_profile_view_base_recent_activity_content_view;pOmfvj00SMuwft9dt3dl1g==',
  'x-li-track': '{"clientVersion":"1.13.39368","mpVersion":"1.13.39368","osName":"web","timezoneOffset":3,"timezone":"Europe/Moscow","deviceFormFactor":"DESKTOP","mpName":"voyager-web","displayDensity":2,"displayWidth":3840,"displayHeight":2486}',
  'x-li-deco-include-micro-schema': 'true',
  'x-restli-protocol-version': '2.0.0',
  'referer': 'https://www.linkedin.com/feed/',
};

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

function normalizeUrn(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const prefixes = [
    'urn:li:fsd_socialActivityCounts:',
    'urn:li:fs_socialActivityCounts:',
  ];
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      const candidate = value.split(':', 4).pop();
      if (candidate && candidate.startsWith('urn:li:')) {
        return candidate;
      }
      return value;
    }
  }
  if (value.startsWith('urn:li:fsd_update:(')) {
    const innerStart = value.indexOf('(');
    if (innerStart !== -1) {
      const inner = value.slice(innerStart + 1, value.indexOf(',', innerStart + 1));
      if (inner && inner.startsWith('urn:li:')) {
        return inner;
      }
    }
  }
  return value;
}

function extractSnowflakeTimestamp(urn) {
  if (typeof urn !== 'string') return null;
  const parts = urn.split(':');
  const candidate = parts[parts.length - 1];
  if (!/^(\d+)$/.test(candidate)) {
    return null;
  }
  try {
    const snowflake = BigInt(candidate);
    const shifted = snowflake >> 22n;
    const asNumber = Number(shifted);
    return Number.isFinite(asNumber) ? asNumber : null;
  } catch (err) {
    return null;
  }
}

function dedupeItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    let key = null;
    for (const candidate of ['$id', 'entityUrn', 'urn']) {
      const value = item[candidate];
      if (typeof value === 'string') {
        key = `${candidate}:${value}`;
        break;
      }
    }
    if (!key) {
      key = `index:${result.length}`;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function buildProfileUpdatesUrl(profileUrn, start, count, paginationToken, includeWebMetadata) {
  const params = new URLSearchParams({ queryId: QUERY_ID });
  if (includeWebMetadata) {
    params.set('includeWebMetadata', 'true');
  }
  const escapedProfile = profileUrn.replace(/:/g, '%3A');
  const parts = [
    `count:${count}`,
    `start:${start}`,
    `profileUrn:${escapedProfile}`,
  ];
  if (paginationToken) {
    parts.push(`paginationToken:${paginationToken}`);
  }
  const variables = `(${parts.join(',')})`;
  const encodedVariables = encodeURIComponent(variables)
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2C/g, ',')
    .replace(/%3A/g, ':')
    .replace(/%25/g, '%');
  return `${GRAPHQL_URL}?${params.toString()}&variables=${encodedVariables}`;
}

function getUpdatesSection(payload) {
  if (!payload || typeof payload !== 'object' || payload === null) return {};
  const queue = [];
  const visited = new Set();
  if (payload.data && typeof payload.data === 'object' && payload.data !== null) {
    queue.push(payload.data);
  }

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') {
      continue;
    }
    if (visited.has(node)) {
      continue;
    }
    visited.add(node);

    if (Array.isArray(node.items)) {
      return node;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }
  return {};
}

function extractPaginationToken(payload) {
  function scan(root) {
    const queue = [root];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);

      if (Array.isArray(current)) {
        for (const item of current) {
          if (item && typeof item === 'object') {
            queue.push(item);
          }
        }
        continue;
      }

      if (typeof current === 'object') {
        if (typeof current.paginationToken === 'string') {
          return current.paginationToken;
        }
        for (const value of Object.values(current)) {
          if (value && typeof value === 'object') {
            queue.push(value);
          }
        }
      }
    }
    return null;
  }

  const section = getUpdatesSection(payload);
  const token = scan(section);
  if (token) {
    return token;
  }
  return scan(payload);
}

async function fetchJsonWithTimeout(url, headers, timeoutSeconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`LinkedIn request failed (${response.status}): ${details.slice(0, 300)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function collectIncluded({
  profileUrn,
  cookie,
  csrfToken,
  count,
  includeWebMetadata,
  timeoutSeconds,
}) {
  const collected = [];
  let paginationToken = null;
  const seenTokens = new Set();
  let cursor = 0;
  const headers = { ...BROWSER_HEADER_PRESET };
  headers['csrf-token'] = csrfToken;
  headers.cookie = cookie;

  while (true) {
    const url = buildProfileUpdatesUrl(profileUrn, cursor, count, paginationToken, includeWebMetadata);
    const payload = await fetchJsonWithTimeout(url, headers, timeoutSeconds);
    const included = Array.isArray(payload.included) ? payload.included : [];
    collected.push(...included);

    const nextToken = extractPaginationToken(payload);
    const section = getUpdatesSection(payload);
    const items = Array.isArray(section.items) ? section.items : [];
    if (items.length < count && !nextToken) {
      break;
    }
    if (!nextToken || seenTokens.has(nextToken)) {
      break;
    }
    seenTokens.add(nextToken);
    paginationToken = nextToken;
    cursor += count;
  }

  return dedupeItems(collected);
}

function containsProfile(obj, profileId) {
  if (!profileId) return false;
  if (typeof obj === 'string') {
    return obj.includes(profileId);
  }
  if (Array.isArray(obj)) {
    return obj.some((entry) => containsProfile(entry, profileId));
  }
  if (obj && typeof obj === 'object') {
    return Object.values(obj).some((value) => containsProfile(value, profileId));
  }
  return false;
}

function derivePosts(included, profileId) {
  const shareUrlsByUrn = new Map();
  for (const item of included) {
    if (!item || typeof item !== 'object') continue;
    if (item.$type !== 'com.linkedin.voyager.dash.feed.Update') continue;
    const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : null;
    let backend = metadata && typeof metadata.backendUrn === 'string' ? metadata.backendUrn : null;
    backend = normalizeUrn(backend);
    if (!backend) continue;
    const social = item.socialContent && typeof item.socialContent === 'object' ? item.socialContent : null;
    const shareUrl = social && typeof social.shareUrl === 'string' ? social.shareUrl : null;
    shareUrlsByUrn.set(backend, shareUrl);
  }

  const authoredUrns = new Set();
  if (profileId) {
    for (const [urn, shareUrl] of shareUrlsByUrn.entries()) {
      if (typeof shareUrl === 'string' && shareUrl.includes(profileId)) {
        authoredUrns.add(normalizeUrn(urn) || urn);
      }
    }
  }

  const ownedUrns = new Set();
  if (profileId) {
    for (const item of included) {
      if (!item || typeof item !== 'object') continue;
      if (item.$type !== 'com.linkedin.voyager.dash.feed.Update') continue;
      const actor = item.actor;
      if (!containsProfile(actor, profileId)) continue;
      const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : null;
      const backend = metadata && typeof metadata.backendUrn === 'string' ? metadata.backendUrn : null;
      const urnCandidates = [
        normalizeUrn(backend),
        normalizeUrn(item.entityUrn),
        normalizeUrn(item.preDashEntityUrn),
      ];
      for (const candidate of urnCandidates) {
        if (candidate) {
          ownedUrns.add(candidate);
        }
      }
    }
  }

  const counts = [];
  const seen = new Set();
  for (const item of included) {
    if (!item || typeof item !== 'object') continue;
    if (item.$type !== 'com.linkedin.voyager.dash.feed.SocialActivityCounts') continue;
    const urn = normalizeUrn(item.urn) || normalizeUrn(item.entityUrn);
    if (!urn || seen.has(urn)) continue;
    counts.push({
      urn,
      numLikes: Number(item.numLikes || 0),
      numComments: Number(item.numComments || 0),
      numShares: Number(item.numShares || 0),
      publishedAt: extractSnowflakeTimestamp(urn),
    });
    seen.add(urn);
  }

  if (authoredUrns.size || ownedUrns.size) {
    const desired = new Set([...authoredUrns, ...ownedUrns]);
    const filtered = counts.filter((entry) => desired.has(entry.urn));
    if (filtered.length) {
      return filtered;
    }
  }
  return counts;
}

async function fetchProfileMetadata(targetUrl) {
  const response = await fetch(PROFILE_URN_FUNCTION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: targetUrl }),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`profileUrnFetcher call failed (${response.status}): ${details.slice(0, 200)}`);
  }
  return response.json();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function inferVanity(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (!segments.length) return null;
    if (['in', 'pub', 'profile'].includes(segments[0]) && segments.length >= 2) {
      return segments[1];
    }
    return segments[segments.length - 1];
  } catch (err) {
    return null;
  }
}

exports.profilePostsFetcher = async (req, res) => {
  try {
    const isHealthCheck = req.method === 'GET' && Object.keys(req.query || {}).length === 0 && !req.body;
    if (isHealthCheck) {
      res.json({ status: 'ok' });
      return;
    }

    const requestUrl = req.method === 'POST' && req.body && req.body.url
      ? req.body.url
      : req.query.url;
    if (!requestUrl) {
      res.status(400).json({ error: 'Missing `url` parameter.' });
      return;
    }

    const count = Number(req.query.count || req.body?.count || DEFAULT_COUNT);
    if (!Number.isInteger(count) || count <= 0 || count > 100) {
      res.status(400).json({ error: '`count` must be an integer between 1 and 100.' });
      return;
    }

    const includeWebMetadata = !(req.query.noWebMetadata === 'true' || req.body?.noWebMetadata === true);
    const cookie = requireEnv('LINKEDIN_COOKIE');
    const csrfToken = requireEnv('LINKEDIN_CSRF_TOKEN');

    const profileMetadata = await fetchProfileMetadata(requestUrl);
    let profileUrn = profileMetadata && profileMetadata.id;
    const profileUsername = profileMetadata && profileMetadata.username;
    const profileUrl = profileMetadata && profileMetadata.url || requestUrl;
    const profileImageUrl = profileMetadata && profileMetadata.imageUrl;

    if (!profileUrn) {
      res.status(502).json({ error: 'Profile URN fetcher did not return an id.' });
      return;
    }

    if (!profileUrn.startsWith('urn:')) {
      profileUrn = `urn:li:fsd_profile:${profileUrn}`;
    }
    const profileId = profileUrn.split(':').pop();

    const included = await collectIncluded({
      profileUrn,
      cookie,
      csrfToken,
      count,
      includeWebMetadata,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    });

    const posts = derivePosts(included, profileId);
    const vanity = profileUsername || inferVanity(profileUrl) || profileId;
    const docRef = db.collection('creators').doc(vanity);
    await docRef.set({
      id: profileUrn,
      profileId,
      username: vanity,
      url: profileUrl,
      imageUrl: profileImageUrl || null,
      posts,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.json({
      id: profileUrn,
      username: vanity,
      url: profileUrl,
      imageUrl: profileImageUrl || null,
      posts,
      storedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error' });
  }
};
