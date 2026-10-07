const { getStore, connectLambda } = require('@netlify/blobs');
const SESSIONS_STORE = 'sessions_v2';
// The only Discord account with admin powers (Admin Panel, publishing,
// support-team access to every ticket). Checked on every request, so changing
// it here immediately revokes admin from anyone else, even mid-session.
const ADMIN_DISCORD_IDS = ['1122944588232011796'];

exports.handler = async (event) => {
  connectLambda(event);
  const auth = event.headers['authorization'] || event.headers['Authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  const token = auth.slice(7);
  const sessions = getStore(SESSIONS_STORE);
  const session = await sessions.get(token, { type: 'json' }).catch(() => null);
  if (!session || session.expiresAt < Date.now()) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Session expired' }) };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discord: session.discord || null, isAdmin: ADMIN_DISCORD_IDS.includes(String(session.discord?.id)) })
  };
};
