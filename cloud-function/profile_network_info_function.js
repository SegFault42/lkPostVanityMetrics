'use strict';

const admin = require('firebase-admin');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const NETWORKINFO_BASE_URL = 'https://www.linkedin.com/voyager/api/identity/profiles';

if (!admin.apps.length) {
  admin.initializeApp();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function parseCookieHeader(cookieHeader) {
  const map = {};
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const [name, value] = trimmed.split('=', 2);
    map[name.trim()] = value.trim().replace(/^"|"$/g, '');
  }
  return map;
}

async function fetchNetworkInfo(publicId, cookieHeader, csrfToken, timeoutSeconds) {
  const controller = new AbortController();
  const timeout = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? setTimeout(() => controller.abort(), timeoutSeconds * 1000)
    : null;
  try {
    const url = `${NETWORKINFO_BASE_URL}/${encodeURIComponent(publicId)}/networkinfo`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'csrf-token': csrfToken,
        'user-agent': USER_AGENT,
        'cookie': cookieHeader,
      },
      signal: timeout ? controller.signal : undefined,
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`status ${response.status}: ${details.slice(0, 200)}`);
    }
    const payload = await response.json();
    return payload?.data || {};
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function applyCors(req, res) {
  const origins = process.env.CORS_ALLOW_ORIGINS
    ? process.env.CORS_ALLOW_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : ['*'];
  const requestOrigin = req.headers.origin;
  let responseOrigin = '*';

  if (!origins.includes('*')) {
    if (requestOrigin && origins.includes(requestOrigin)) {
      responseOrigin = requestOrigin;
    } else if (origins.length) {
      responseOrigin = origins[0];
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

exports.profileNetworkInfoFetcher = async (req, res) => {
  try {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    const cookieHeader = requireEnv('LINKEDIN_COOKIE');
    const csrfToken = requireEnv('LINKEDIN_CSRF_TOKEN');
    const timeoutSeconds = Number(process.env.NETWORKINFO_TIMEOUT_SECONDS ?? 30);

    const publicId = req.method === 'POST' && req.body && req.body.publicId
      ? req.body.publicId
      : req.query.publicId;

    if (!publicId) {
      res.status(400).json({ error: 'Missing `publicId` parameter.' });
      return;
    }

    const data = await fetchNetworkInfo(publicId, cookieHeader, csrfToken, timeoutSeconds);
    res.json({ publicId, data });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error' });
  }
};
