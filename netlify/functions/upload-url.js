// Lets an admin get permission to upload a file directly to Supabase Storage.
// The actual file bytes never touch this function (or Netlify at all) — the
// browser uploads straight to Supabase using the signed URL this returns.
// That's what lets this handle files way bigger than Netlify Functions'
// ~6MB request/response cap.
const { getStore, connectLambda } = require('@netlify/blobs');
const { createClient } = require('@supabase/supabase-js');

const SESSIONS_STORE = 'sessions_v2';
const BUCKET = 'fayple-files';

async function isAdminSession(event) {
  const auth = event.headers['authorization'] || event.headers['Authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  const sessions = getStore(SESSIONS_STORE);
  let session;
  try {
    session = await sessions.get(token, { type: 'json' });
  } catch (e) {
    return false;
  }
  if (!session || session.expiresAt < Date.now()) return false;
  return !!session.isAdmin;
}

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const authorized = await isAdminSession(event);
  if (!authorized) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad request' }) };
  }

  const filename = (body.filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename}`;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Supabase is not configured on the server yet' }) };
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message || 'Could not create upload slot' }) };
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: data.path, token: data.token, publicUrl: pub.publicUrl })
  };
};
