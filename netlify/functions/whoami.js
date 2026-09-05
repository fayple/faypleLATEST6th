const { getStore, connectLambda } = require('@netlify/blobs');
const SESSIONS_STORE = 'sessions_v2';

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
    body: JSON.stringify({ discord: session.discord || null, isAdmin: !!session.isAdmin })
  };
};
