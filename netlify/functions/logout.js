const { getStore, connectLambda } = require('@netlify/blobs');
const SESSIONS_STORE = 'sessions_v2';

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const auth = event.headers['authorization'] || event.headers['Authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const sessions = getStore(SESSIONS_STORE);
    await sessions.delete(token).catch(() => {});
  }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
};
