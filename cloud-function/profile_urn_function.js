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

const PRIMARY_COMPONENT_PATTERN = /componentkey[\s:='\"]+com\.linkedin\.sdui\.profile\.card\.ref(?<urn>[A-Za-z0-9_-]+?)(?:Topcard|TopCard)?/i;
const FALLBACK_COMPONENT_PATTERN = /com\.linkedin\.sdui\.profile\.card\.ref(?<urn>[A-Za-z0-9_-]+?)(?:Topcard|TopCard)?/i;
const IDENTITY_DASH_PATTERN = /identityDashProfilesByMemberIdentity[\s\S]*?urn:li:(?:fsd?_)?profile:(?<urn>[A-Za-z0-9_-]+)/i;
const URN_PATTERN_SOURCE = 'urn:li:(?:fsd?_)?profile:(?<urn>[A-Za-z0-9_-]+)';
const URN_PATTERN_FLAGS = 'gi';
const ROOT_URL_PATTERN = /"rootUrl"\s*:\s*"(?<root>https:\/\/media\.licdn\.com\/dms\/image[^"\\]+)"/i;
const ARTIFACT_SEGMENT_PATTERN_SOURCE = '"fileIdentifyingUrlPathSegment"\\s*:\\s*"(?<segment>[^"\\\\]+)"';
const ARTIFACT_SEGMENT_PATTERN_FLAGS = 'gi';

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

function extractProfileImageUrl(html) {
  const { plain, normalized } = normalizeHtml(html);

  const attempt = (text) => {
    const candidates = [];
    for (const body of extractVectorImageBodies(text)) {
      if (!body.includes('profile-displayphoto')) continue;
      const rootMatch = body.match(ROOT_URL_PATTERN);
      if (!rootMatch || !rootMatch.groups?.root) continue;
      const root = sanitizeRoot(rootMatch.groups.root);
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
      candidates.push({ score: artifactSegmentScore(cleanSegment), url: root + cleanSegment });
    }
    candidates.sort((a, b) => {
      if (b.score[0] !== a.score[0]) return b.score[0] - a.score[0];
      if (b.score[1] !== a.score[1]) return b.score[1] - a.score[1];
      return b.url.localeCompare(a.url);
    });
    return candidates.length ? candidates[0].url : null;
  };

  return attempt(normalized) || attempt(plain);
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

    const imageUrl = extractProfileImageUrl(html);
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
