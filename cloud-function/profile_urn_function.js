'use strict';

/**
 * Cloud Function that mirrors extract_profile_urn.py behaviour.
 *
 * - Accepts an HTTP request with optional `url`, `cookie`, and `csrfToken` query params/body.
 * - Falls back to LINKEDIN_COOKIE and LINKEDIN_CSRF_TOKEN env vars when parameters are missing.
 * - Fetches the LinkedIn profile HTML and extracts profile URN and display photo URL.
 * - Responds with JSON: { id, username, url, imageUrl }.
 */

const DEFAULT_PROFILE_URL = 'https://www.linkedin.com/in/ramzib/';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ALLOWED_ORIGINS = process.env.CORS_ALLOW_ORIGINS
  ? process.env.CORS_ALLOW_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : ['*'];

function applyCors(req, res) {
  const requestOrigin = req.headers.origin;
  let responseOrigin = '*';

  if (!ALLOWED_ORIGINS.includes('*')) {
    if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
      responseOrigin = requestOrigin;
    } else if (ALLOWED_ORIGINS.length) {
      responseOrigin = ALLOWED_ORIGINS[0];
    }
  }

  res.set('Access-Control-Allow-Origin', responseOrigin);
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
  res.set('Vary', 'Origin');
  if (responseOrigin !== '*') {
    res.set('Access-Control-Allow-Credentials', 'true');
  }
}

const PRIMARY_COMPONENT_PATTERN = /componentkey[\s:='\"]+com\.linkedin\.sdui\.profile\.card\.ref(?<urn>[A-Za-z0-9_-]+?)(?:Topcard|TopCard)?/i;
const FALLBACK_COMPONENT_PATTERN = /com\.linkedin\.sdui\.profile\.card\.ref(?<urn>[A-Za-z0-9_-]+?)(?:Topcard|TopCard)?/i;
const IDENTITY_DASH_PATTERN = /identityDashProfilesByMemberIdentity[\s\S]*?urn:li:(?:fsd?_)?profile:(?<urn>[A-Za-z0-9_-]+)/i;
const URN_PATTERN_SOURCE = 'urn:li:(?:fsd?_)?profile:(?<urn>[A-Za-z0-9_-]+)';
const URN_PATTERN_FLAGS = 'gi';
const ROOT_URL_PATTERN = /"rootUrl"\s*:\s*"(?<root>https:\/\/media\.licdn\.com\/dms\/image[^"\\]+)"/i;
const ARTIFACT_SEGMENT_PATTERN_SOURCE = '"fileIdentifyingUrlPathSegment"\\s*:\\s*"(?<segment>[^"\\\\]+)"';
const ARTIFACT_SEGMENT_PATTERN_FLAGS = 'gi';
const PRESENCE_IMAGE_PATTERN = /<img\b[^>]*class=["'][^"']*presence-entity__image[^"']*["'][^>]*>/gi;
const INLINE_PROFILE_IMG_PATTERN = /<img\b[^>]*src=["'][^"']*profile-displayphoto[^"']*["'][^>]*>/gi;
const META_OG_IMAGE_PATTERN = /<meta\b[^>]*property=["']og:image["'][^>]*content=["'](?<url>[^"']+)["'][^>]*>/i;
const META_OG_TITLE_PATTERN = /<meta\b[^>]*property=["']og:title["'][^>]*content=["'](?<title>[^"']+)["'][^>]*>/i;
const DEFAULT_EXCLUDED_IMAGE_ROOT = 'https://media.licdn.com/dms/image/v2/D4D03AQEJqKg9s8pQ6g';

/**
 * Decode minimal HTML entities without external dependencies.
 */
function decodeHtmlEntities(input) {
  if (!input) return '';
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function normalizeHtml(html) {
  const plain = decodeHtmlEntities(html);
  let normalized = plain
    .replace(/\\+\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&');
  return { plain, normalized };
}

function parseImgAttributes(tag) {
  const attrs = {};
  const attrPattern = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attrPattern.exec(tag)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[3] !== undefined ? match[3] : match[4] || '';
    attrs[name] = value;
  }
  return attrs;
}

function sanitizeMediaUrl(value) {
  if (!value) return null;
  let url = decodeHtmlEntities(value)
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&');
  if (url.startsWith('//')) {
    url = `https:${url}`;
  }
  return url;
}

function extractOgImageUrl(text) {
  if (!text) return null;
  const match = META_OG_IMAGE_PATTERN.exec(text);
  if (match && match.groups?.url) {
    const url = sanitizeMediaUrl(match.groups.url);
    if (url && url.startsWith('https://media.licdn.com/dms/image')) {
      return url;
    }
  }
  return null;
}

function extractOgTitle(text) {
  if (!text) return null;
  const match = META_OG_TITLE_PATTERN.exec(text);
  if (match && match.groups?.title) {
    return match.groups.title;
  }
  return null;
}

function extractPresenceImageUrl(text, expectedName) {
  if (!text) return null;
  const normalizedExpected = expectedName ? expectedName.toLowerCase() : null;
  let match;
  while ((match = PRESENCE_IMAGE_PATTERN.exec(text)) !== null) {
    const tag = match[0];
    const attrs = parseImgAttributes(tag);
    const candidate = attrs.src || attrs['data-delayed-url'] || attrs['data-delayload'] || attrs['data-delayed-src'] || attrs['data-src'] || attrs['data-lazy-src'];
    const url = sanitizeMediaUrl(candidate);
    if (!url || !url.startsWith('https://media.licdn.com/dms/image/v2')) {
      continue;
    }
    if (normalizedExpected) {
      const alt = (attrs.alt || '').toLowerCase();
      if (alt && alt.includes(normalizedExpected)) {
        return url;
      }
      continue;
    }
    return url;
  }
  return null;
}

function extractInlineProfileImageUrl(text, expectedName) {
  if (!text) return null;
  const normalizedExpected = expectedName ? expectedName.toLowerCase() : null;
  let match;
  while ((match = INLINE_PROFILE_IMG_PATTERN.exec(text)) !== null) {
    const tag = match[0];
    const attrs = parseImgAttributes(tag);
    const src = sanitizeMediaUrl(attrs.src);
    if (!src || !src.includes('profile-displayphoto')) {
      continue;
    }
    if (normalizedExpected) {
      const alt = (attrs.alt || attrs['aria-label'] || '').toLowerCase();
      if (alt && alt.includes(normalizedExpected)) {
        return src;
      }
      continue;
    }
    return src;
  }
  return null;
}

function orderedUnique(iterable) {
  const seen = new Set();
  const result = [];
  for (const value of iterable) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function inferVanityFromUrl(url) {
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

function extractProfileUrn(html, vanity) {
  const { plain, normalized } = normalizeHtml(html);

  const primary = normalized.match(PRIMARY_COMPONENT_PATTERN);
  if (primary && primary.groups?.urn) {
    return primary.groups.urn;
  }

  const fallback = normalized.match(FALLBACK_COMPONENT_PATTERN);
  if (fallback && fallback.groups?.urn) {
    return fallback.groups.urn;
  }

  const dash = normalized.match(IDENTITY_DASH_PATTERN);
  if (dash && dash.groups?.urn) {
    return dash.groups.urn;
  }

  if (vanity) {
    const publicPattern = new RegExp(`"publicIdentifier"\\s*:\\s*"${escapeRegex(vanity)}"`, 'i');
    let contextMatch = normalized.match(publicPattern);
    let source = normalized;

    if (!contextMatch) {
      const escapedPattern = new RegExp(`\\\\"publicIdentifier\\\\"\\s*:\\s*\\\\"${escapeRegex(vanity)}\\\\"`, 'i');
      contextMatch = plain.match(escapedPattern);
      source = plain;
    }

    if (contextMatch && contextMatch.index !== undefined) {
      const start = Math.max(0, contextMatch.index - 500);
      const end = Math.min(source.length, contextMatch.index + 500);
      const window = source.slice(start, end);
      const urnPattern = new RegExp(URN_PATTERN_SOURCE, URN_PATTERN_FLAGS);
      const urnMatch = [...window.matchAll(urnPattern)][0];
      if (urnMatch && urnMatch.groups?.urn) {
        return urnMatch.groups.urn;
      }
    }
  }

  const allPattern = new RegExp(URN_PATTERN_SOURCE, URN_PATTERN_FLAGS);
  const urns = orderedUnique(Array.from(normalized.matchAll(allPattern)).map((m) => m.groups?.urn).filter(Boolean));
  if (urns.length === 1) {
    return urns[0];
  }

  throw new Error('Unable to locate profile component key or URN. Did the page layout change or are you signed in?');
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function artifactSegmentScore(segment) {
  const exact200 = segment.includes('scale_200_200') ? 1 : 0;
  const sizeMatch = segment.match(/_(\d{2,4})_(\d{2,4})/);
  const width = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
  return [exact200, width];
}

function chooseArtifactSegment(segments) {
  let bestSegment = null;
  let bestScore = null;
  for (const segment of segments) {
    const score = artifactSegmentScore(segment);
    if (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      bestScore = score;
      bestSegment = segment;
    }
  }
  return bestSegment;
}

function extractVectorImageBodies(text) {
  const bodies = [];
  const needle = '"vectorImage"';
  let index = 0;
  while (index < text.length) {
    const found = text.indexOf(needle, index);
    if (found === -1) break;
    const braceStart = text.indexOf('{', found + needle.length);
    if (braceStart === -1) break;
    const { body, nextIndex } = extractObject(text, braceStart);
    if (!body) break;
    bodies.push(body);
    index = nextIndex;
  }
  return bodies;
}

function extractObject(text, startIndex) {
  let depth = 0;
  let i = startIndex;
  let inString = false;
  while (i < text.length) {
    const char = text[i];
    if (char === '"' && text[i - 1] !== '\\') {
      inString = !inString;
    }
    if (!inString) {
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return { body: text.slice(startIndex, i + 1), nextIndex: i + 1 };
        }
      }
    }
    i += 1;
  }
  return { body: null, nextIndex: text.length };
}

function sanitizeSegment(segment) {
  return segment
    .replace(/\\\//g, '/')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&');
}

function sanitizeRoot(root) {
  return root
    .replace(/\\\//g, '/')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&');
}

function extractProfileImageUrl(html, profileUrn) {
  const { plain, normalized } = normalizeHtml(html);
  const profileId = typeof profileUrn === 'string' && profileUrn.includes(':')
    ? profileUrn.split(':').pop()
    : null;
  const expectedName = extractOgTitle(plain) || extractOgTitle(normalized) || null;

  const attempt = (text) => {
    const candidates = [];
    for (const body of extractVectorImageBodies(text)) {
      if (!body.includes('profile-displayphoto')) continue;
      const rootMatch = body.match(ROOT_URL_PATTERN);
      if (!rootMatch || !rootMatch.groups?.root) continue;
      const root = sanitizeRoot(rootMatch.groups.root);
      if (root && root.startsWith(DEFAULT_EXCLUDED_IMAGE_ROOT)) {
        continue;
      }
      const segments = [];
      const artifactPattern = new RegExp(ARTIFACT_SEGMENT_PATTERN_SOURCE, ARTIFACT_SEGMENT_PATTERN_FLAGS);
      let match;
      while ((match = artifactPattern.exec(body)) !== null) {
        if (match.groups?.segment) {
          segments.push(match.groups.segment);
        }
      }
      if (!segments.length) continue;
      const segment = chooseArtifactSegment(segments);
      if (!segment) continue;
      const cleanSegment = sanitizeSegment(segment);
      if (cleanSegment && cleanSegment.startsWith('D4D03AQEJqKg9s8pQ6g')) {
        continue;
      }
      const matchesProfile = Boolean(
        (profileUrn && body.includes(profileUrn)) ||
        (profileId && body.includes(profileId))
      );
      candidates.push({
        match: matchesProfile ? 1 : 0,
        score: artifactSegmentScore(cleanSegment),
        url: root + cleanSegment,
      });
    }
    candidates.sort((a, b) => {
      if (b.match !== a.match) return b.match - a.match;
      if (b.score[0] !== a.score[0]) return b.score[0] - a.score[0];
      if (b.score[1] !== a.score[1]) return b.score[1] - a.score[1];
      return b.url.localeCompare(a.url);
    });
    return candidates.length ? candidates[0].url : null;
  };

  const ogImage = extractOgImageUrl(plain) || extractOgImageUrl(normalized);
  if (ogImage && ogImage.includes('profile-displayphoto')) {
    return ogImage;
  }

  const vectorImage = attempt(normalized) || attempt(plain);
  if (vectorImage) {
    return vectorImage;
  }

  const inlineImage = extractInlineProfileImageUrl(plain, expectedName) || extractInlineProfileImageUrl(normalized, expectedName);
  if (inlineImage) {
    return inlineImage;
  }

  return extractPresenceImageUrl(plain, expectedName) || extractPresenceImageUrl(normalized, expectedName);
}

async function fetchProfileHtml({ url, cookie, csrfToken, timeoutSeconds = 30 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        'csrf-token': csrfToken,
        'Cookie': cookie,
        'Referer': url,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Unexpected status ${response.status} when fetching profile page.`);
    }

    return await response.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('HTTP request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

exports.profileUrnFetcher = async (req, res) => {
  try {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    const isHealthCheck = req.method === 'GET' && !req.query.url && !req.query.cookie && !req.query.csrfToken;
    if (isHealthCheck) {
      res.json({ status: 'ok' });
      return;
    }

    const requestUrl = req.method === 'POST' && req.body?.url ? req.body.url : req.query.url || DEFAULT_PROFILE_URL;
    const cookie = req.method === 'POST' && req.body?.cookie ? req.body.cookie : req.query.cookie || process.env.LINKEDIN_COOKIE;
    const csrfToken = req.method === 'POST' && req.body?.csrfToken ? req.body.csrfToken : req.query.csrfToken || process.env.LINKEDIN_CSRF_TOKEN;

    if (!cookie) {
      res.status(400).json({ error: 'Missing LinkedIn cookie. Set LINKEDIN_COOKIE env or provide `cookie` parameter.' });
      return;
    }

    if (!csrfToken) {
      res.status(400).json({ error: 'Missing CSRF token. Set LINKEDIN_CSRF_TOKEN env or provide `csrfToken` parameter.' });
      return;
    }

    const vanity = inferVanityFromUrl(requestUrl);
    const html = await fetchProfileHtml({ url: requestUrl, cookie, csrfToken });

    let profileUrn;
    try {
      profileUrn = extractProfileUrn(html, vanity);
    } catch (err) {
      res.status(502).json({ error: err.message });
      return;
    }

    const profileUrnValue = profileUrn;
    const imageUrl = extractProfileImageUrl(html, profileUrnValue);
    const username = vanity || inferVanityFromUrl(requestUrl);
    if (!username) {
      res.status(400).json({ error: 'Unable to infer username from the supplied URL.' });
      return;
    }

    res.json({
      id: profileUrn,
      username,
      url: requestUrl,
      imageUrl: imageUrl || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error' });
  }
};
