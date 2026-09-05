// Shared, server-side storage for announcements, updates, and file metadata
// using Netlify Blobs. Anyone can GET (read) — visitors should see what's
// published. Only POST (publish) and DELETE (remove) require a valid admin
// session, obtained via Discord sign-in (see discord-callback.js).
//
// For type=files, this only stores metadata (name, description, size, and
// the path/URL in Supabase Storage) — the actual file bytes live in Supabase,
// never in Netlify Blobs, since Netlify Functions cap bodies at ~6MB.
const { getStore } = require('@netlify/blobs');
const { createClient } = require('@supabase/supabase-js');

const ALLOWED_TYPES = ['ann', 'updates', 'files'];
const BUCKET = 'fayple-files';

async function isAuthorized(event) {
  const auth = event.headers['authorization'] || event.headers['Authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  // Must match SESSIONS_STORE in discord-callback.js.
  const sessions = getStore('sessions_v2');
  let session;
  try {
    session = await sessions.get(token, { type: 'json' });
  } catch (e) {
    return false;
  }
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    await sessions.delete(token);
    return false;
  }
  // Regular (non-admin) visitors get a session too now, so they can browse —
  // but only admins can publish or delete.
  return !!session.isAdmin;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const type = params.type;

  if (!ALLOWED_TYPES.includes(type)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid type — must be "ann", "updates" or "files"' }) };
  }

  const store = getStore('fayple-data');

  if (event.httpMethod === 'GET') {
    const list = (await store.get(type, { type: 'json' })) || [];
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list })
    };
  }

  const authorized = await isAuthorized(event);
  if (!authorized) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized — please sign in again' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad request' }) };
  }

  const list = (await store.get(type, { type: 'json' })) || [];

  if (event.httpMethod === 'POST') {
    if (!body.item) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing item' }) };
    }
    list.push(body.item);
    await store.setJSON(type, list);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list })
    };
  }

  if (event.httpMethod === 'DELETE') {
    const idx = body.index;
    if (typeof idx !== 'number' || idx < 0 || idx >= list.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid index' }) };
    }

    // For files, also remove the actual object from Supabase Storage —
    // otherwise deleting the listing would leave an orphaned file behind.
    if (type === 'files') {
      const item = list[idx];
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (item && item.path && supabaseUrl && serviceKey) {
        try {
          const supabase = createClient(supabaseUrl, serviceKey);
          await supabase.storage.from(BUCKET).remove([item.path]);
        } catch (e) {
          // Don't block removing the listing even if the storage delete fails.
        }
      }
    }

    list.splice(idx, 1);
    await store.setJSON(type, list);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list })
    };
  }

  return { statusCode: 405, body: 'Method not allowed' };
};
