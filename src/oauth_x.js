// OAuth helper for X (Twitter) using Authorization Code + PKCE
export function randomString(len = 48) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export async function sha256Base64Url(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildAuthorizeUrl({ client_id, redirect_uri, scope, state, code_challenge }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri,
    scope,
    state,
    code_challenge,
    code_challenge_method: 'S256'
  });
  return `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
}

export async function handleStart(request, env) {
  // generate state and PKCE verifier/challenge, store verifier keyed by state
  const state = randomString(24);
  const code_verifier = randomString(128);
  const code_challenge = await sha256Base64Url(code_verifier);

  // store in KV with short TTL (e.g., 10 minutes). Cloudflare KV doesn't support TTL per put,
  // but you can store timestamp and check expiry on callback. For simplicity we store timestamp.
  const meta = { code_verifier, created_at: Date.now() };
  await env.OAUTH_KV.put(`pkce_${state}`, JSON.stringify(meta));

  const client_id = env.X_CLIENT_ID;
  const redirect_uri = env.X_REDIRECT_URI;
  const scope = env.X_OAUTH_SCOPE || 'tweet.read users.read offline.access'; // adjust as needed
  const url = buildAuthorizeUrl({ client_id, redirect_uri, scope, state, code_challenge });

  return Response.redirect(url, 302);
}

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return new Response('code/state missing', { status: 400 });
  }

  const kvRaw = await env.OAUTH_KV.get(`pkce_${state}`);
  if (!kvRaw) return new Response('invalid or expired state', { status: 400 });
  const { code_verifier, created_at } = JSON.parse(kvRaw);
  if (Date.now() - created_at > 1000 * 60 * 15) {
    await env.OAUTH_KV.delete(`pkce_${state}`);
    return new Response('state expired', { status: 400 });
  }

  // token exchange (existing logic)
  const tokenUrl = 'https://api.twitter.com/2/oauth2/token';
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.X_REDIRECT_URI,
    client_id: env.X_CLIENT_ID,
    code_verifier
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_SECRET) {
    const basic = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
    headers['Authorization'] = `Basic ${basic}`;
  }

  const tokenRes = await fetch(tokenUrl, { method: 'POST', headers, body });
  const tokenJson = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !tokenJson) {
    return new Response('token exchange failed: ' + JSON.stringify(tokenJson), { status: 500 });
  }

  const access_token = tokenJson.access_token;
  const refresh_token = tokenJson.refresh_token || null;

  const meRes = await fetch('https://api.twitter.com/2/users/me', {
    headers: { Authorization: `Bearer ${access_token}` }
  });
  const meJson = await meRes.json().catch(()=>null);
  let userId = null;
  if (meRes.ok && meJson && meJson.data && meJson.data.id) {
    userId = meJson.data.id;
  } else {
    userId = `unknown_${state}`;
  }

  const record = {
    access_token,
    refresh_token,
    scope: tokenJson.scope || null,
    token_type: tokenJson.token_type || null,
    expires_in: tokenJson.expires_in || null,
    obtained_at: Date.now()
  };

  // store token under user key
  await env.OAUTH_KV.put(`x_user_${userId}`, JSON.stringify(record));
  await env.OAUTH_KV.delete(`pkce_${state}`);

  // create session id and store session -> maps session to userId
  const sessionId = randomString(40);
  const sessionRec = {
    userId,
    created_at: Date.now(),
    // store minimal token meta for quick /auth/x/me (do not store full secrets if sensitive)
    token_meta: { obtained_at: record.obtained_at, expires_in: record.expires_in, scope: record.scope }
  };
  await env.OAUTH_KV.put(`session_${sessionId}`, JSON.stringify(sessionRec));

  // set HttpOnly cookie (30 days)
  const cookie = `cal_session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;

  const redirectTo = env.X_POST_AUTH_REDIRECT || '/';
  return new Response(null, { status: 302, headers: { Location: redirectTo, 'Set-Cookie': cookie } });
}

// 新規: セッション復元 -> token metadata を返す
export async function handleMe(request, env) {
  const cookie = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|; )cal_session=([^;]+)/);
  if (!match) return new Response(JSON.stringify({ ok: false, authenticated: false }), { headers: { 'Content-Type': 'application/json' }});

  const sessionId = match[1];
  const raw = await env.OAUTH_KV.get(`session_${sessionId}`);
  if (!raw) {
    // clear cookie on client if invalid
    const clearCookie = `cal_session=deleted; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
    return new Response(JSON.stringify({ ok: false, authenticated: false }), { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie }});
  }
  const sess = JSON.parse(raw);
  const userKey = `x_user_${sess.userId}`;
  const tokenRaw = await env.OAUTH_KV.get(userKey);
  const tokenRec = tokenRaw ? JSON.parse(tokenRaw) : null;
  const info = {
    ok: true,
    authenticated: true,
    userId: sess.userId,
    session: { created_at: sess.created_at },
    token: tokenRec ? { scope: tokenRec.scope, obtained_at: tokenRec.obtained_at, expires_in: tokenRec.expires_in } : null
  };
  return new Response(JSON.stringify(info), { headers: { 'Content-Type': 'application/json' }});
}

// 修正: handleLogout はクッキーがある場合はセッションを削除しクッキーをクリア
export async function handleLogout(request, env) {
  // try body first (backward-compat)
  const body = await request.json().catch(()=>null);
  if (body && body.userId) {
    await env.OAUTH_KV.delete(`x_user_${body.userId}`);
    // also delete any session entries referencing this user (best-effort: list)
    const list = await env.OAUTH_KV.list({ prefix: 'session_', limit: 1000 }).catch(()=>({ keys: [] }));
    for (const k of (list.keys || [])) {
      const val = await env.OAUTH_KV.get(k.name).catch(()=>null);
      if (!val) continue;
      const s = JSON.parse(val);
      if (s.userId === body.userId) await env.OAUTH_KV.delete(k.name);
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' }});
  }

  // cookie-based logout
  const cookie = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|; )cal_session=([^;]+)/);
  if (!match) return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' }});
  const sessionId = match[1];
  const rawSess = await env.OAUTH_KV.get(`session_${sessionId}`);
  if (rawSess) {
    const sess = JSON.parse(rawSess);
    // optionally delete user token too (commented out: preserve tokens unless explicit)
    // await env.OAUTH_KV.delete(`x_user_${sess.userId}`);
    await env.OAUTH_KV.delete(`session_${sessionId}`);
  }
  const clearCookie = `cal_session=deleted; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie }});
}

export async function fetchTweetForUrl(targetUrl, env, userId = null) {
  // choose stored token: if userId provided, use that; otherwise use any stored token (not ideal)
  let tokenRec = null;
  if (userId) {
    const raw = await env.OAUTH_KV.get(`x_user_${userId}`);
    if (raw) tokenRec = JSON.parse(raw);
  } else {
    // try to pick first key (KV list API used sparingly)
    const list = await env.OAUTH_KV.list({ prefix: 'x_user_', limit: 10 });
    if (list.keys && list.keys.length > 0) {
      const raw = await env.OAUTH_KV.get(list.keys[0].name);
      if (raw) tokenRec = JSON.parse(raw);
    }
  }
  if (!tokenRec || !tokenRec.access_token) throw new Error('no access token available');

  // Use X API to get tweet content. Try to extract tweet id from URL and use GET /2/tweets/:id with expansions
  const m = targetUrl.match(/status\/(\d+)/) || targetUrl.match(/\/(\d+)(?:\?|$)/);
  const tweetId = m ? m[1] : null;
  if (!tweetId) {
    // fallback: fetch oembed endpoint without auth
    const oe = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(targetUrl)}`);
    if (oe.ok) return await oe.json();
    throw new Error('could not determine tweet id');
  }

  const apiUrl = `https://api.twitter.com/2/tweets/${tweetId}?expansions=attachments.media_keys,author_id&media.fields=url,preview_image_url&tweet.fields=created_at,text`;
  const resp = await fetch(apiUrl, { headers: { Authorization: `Bearer ${tokenRec.access_token}` }});
  if (!resp.ok) {
    // consider refresh token flow if 401
    if (resp.status === 401 && tokenRec.refresh_token) {
      // attempt refresh
      const refreshed = await tryRefreshToken(env, tokenRec, userId);
      if (refreshed && refreshed.access_token) {
        const resp2 = await fetch(apiUrl, { headers: { Authorization: `Bearer ${refreshed.access_token}` }});
        if (resp2.ok) return await resp2.json();
      }
    }
    throw new Error('tweet fetch failed: ' + resp.status);
  }
  return await resp.json();
}

async function tryRefreshToken(env, tokenRec, userId) {
  if (!tokenRec.refresh_token) return null;
  const tokenUrl = 'https://api.twitter.com/2/oauth2/token';
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokenRec.refresh_token,
    client_id: env.X_CLIENT_ID
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_SECRET) {
    const basic = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
    headers['Authorization'] = `Basic ${basic}`;
  }
  const res = await fetch(tokenUrl, { method: 'POST', headers, body });
  const j = await res.json().catch(()=>null);
  if (!res.ok || !j || !j.access_token) return null;
  // update stored record
  const updated = {
    ...tokenRec,
    access_token: j.access_token,
    refresh_token: j.refresh_token || tokenRec.refresh_token,
    expires_in: j.expires_in || tokenRec.expires_in,
    obtained_at: Date.now()
  };
  await env.OAUTH_KV.put(`x_user_${userId}`, JSON.stringify(updated));
  return updated;
}
