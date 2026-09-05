// Handles the redirect Discord sends back after the user approves the login.
// Exchanges the temporary code for an access token (server-side only —
// the client secret never touches the browser), fetches the Discord profile,
// and creates a session for ANY Discord user who logs in. Whether they get
// admin powers (publish/delete) depends on whether their Discord ID is in
// ADMIN_DISCORD_IDS — regular visitors can still sign in and browse, they
// just won't see admin controls.
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const SESSIONS_STORE = 'sessions_v2';
const SESSION_TTL_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

exports.handler = async (event) => {
  const code = event.queryStringParameters && event.queryStringParameters.code;
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['host'];
  const redirectUri = `${proto}://${host}/.netlify/functions/discord-callback`;

  if (!code) {
    return { statusCode: 302, headers: { Location: '/?discord_error=missing_code' } };
  }

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { statusCode: 302, headers: { Location: '/?discord_error=not_configured' } };
  }

  let tokenData;
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });
    if (!tokenRes.ok) {
      return { statusCode: 302, headers: { Location: '/?discord_error=token_exchange_failed' } };
    }
    tokenData = await tokenRes.json();
  } catch (e) {
    return { statusCode: 302, headers: { Location: '/?discord_error=token_exchange_failed' } };
  }

  let user;
  try {
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok) {
      return { statusCode: 302, headers: { Location: '/?discord_error=profile_failed' } };
    }
    user = await userRes.json();
  } catch (e) {
    return { statusCode: 302, headers: { Location: '/?discord_error=profile_failed' } };
  }

  const allowlist = (process.env.ADMIN_DISCORD_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const isAdmin = allowlist.includes(user.id);

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;

  const token = crypto.randomBytes(24).toString('hex');
  const sessions = getStore(SESSIONS_STORE);
  await sessions.setJSON(token, {
    expiresAt: Date.now() + SESSION_TTL_MS,
    isAdmin,
    discord: {
      id: user.id,
      username: user.global_name || user.username,
      avatar: avatarUrl
    }
  });

  // Notify a Discord channel whenever an ADMIN logs in (not regular visitors,
  // to avoid spamming the channel). Set DISCORD_WEBHOOK_URL in Netlify env
  // vars to enable this — safe to leave unset, login still works either way.
  if (isAdmin && process.env.DISCORD_WEBHOOK_URL) {
    const ip = event.headers['x-nf-client-connection-ip'] || 'unknown';
    try {
      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: '🔑 Admin login — Fayple Studios',
            color: 0xF5F5F0,
            thumbnail: { url: avatarUrl },
            fields: [
              { name: 'User', value: `${user.global_name || user.username} (\`${user.id}\`)`, inline: false },
              { name: 'IP', value: ip, inline: true },
              { name: 'Time', value: new Date().toISOString(), inline: true }
            ]
          }]
        })
      });
    } catch (e) {
      // Never let a webhook failure block the actual login.
    }
  }

  return { statusCode: 302, headers: { Location: `/?session=${token}` } };
};
