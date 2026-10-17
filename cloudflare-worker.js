// Free Cloudflare Worker that sends push notifications for your chat app.
// Secrets/variables (set in the Cloudflare dashboard, NOT in this file):
//   SERVICE_ACCOUNT  (secret)  - the whole Firebase service-account JSON
//   ALLOWED_ORIGIN   (text)    - e.g. https://yourname.github.io   (no slash, no repo name)

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = s => b64u(enc.encode(s));
const fromB64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };

let cachedAccess = { token: null, exp: 0 };
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccess.token && cachedAccess.exp > now + 60) return cachedAccess.token;
  const header = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64uStr(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(header + '.' + claim));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claim + '.' + b64u(sig) })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Could not get Google access token');
  cachedAccess = { token: j.access_token, exp: now + 3500 };
  return j.access_token;
}

let jwksCache = { keys: null, exp: 0 };
async function verifyIdToken(token, projectId) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const header = JSON.parse(dec.decode(fromB64u(parts[0])));
  const payload = JSON.parse(dec.decode(fromB64u(parts[1])));
  const now = Math.floor(Date.now() / 1000);
  if (!jwksCache.keys || jwksCache.exp < now) {
    const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    jwksCache = { keys: (await r.json()).keys, exp: now + 3600 };
  }
  const jwk = jwksCache.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64u(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok || payload.aud !== projectId || payload.iss !== 'https://securetoken.google.com/' + projectId || payload.exp < now || !payload.sub)
    throw new Error('invalid token');
  return payload.sub;
}

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin'
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return reply({ ok: true, info: 'push worker running' });

    try {
      const sa = JSON.parse(env.SERVICE_ACCOUNT);
      const project = sa.project_id;
      const idToken = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
      const callerUid = await verifyIdToken(idToken, project);

      const body = await req.json();
      const { fid, type } = body;
      if (!/^[A-Za-z0-9_]+$/.test(fid || '') || !['msg', 'call'].includes(type)) return reply({ error: 'bad request' }, 400);

      const access = await getAccessToken(sa);
      const FS = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
      const auth = { Authorization: 'Bearer ' + access };

      // who is in this friendship?
      const fr = await fetch(`${FS}/friendships/${fid}`, { headers: auth });
      if (!fr.ok) return reply({ error: 'no such chat' }, 404);
      const f = (await fr.json()).fields;
      const users = f.users.arrayValue.values.map(v => v.stringValue);
      if (f.status.stringValue !== 'accepted' || !users.includes(callerUid)) return reply({ error: 'not allowed' }, 403);
      const toUid = users.find(u => u !== callerUid);
      const name = (f.names && f.names.mapValue.fields[callerUid] && f.names.mapValue.fields[callerUid].stringValue) || 'Someone';

      // the other person's devices
      const tr = await fetch(`${FS}/users/${toUid}/tokens?pageSize=20`, { headers: auth });
      const docs = tr.ok ? ((await tr.json()).documents || []) : [];
      const tokens = docs.map(d => decodeURIComponent(d.name.split('/').pop()));

      // generic text on purpose: no private message content on a lock screen
      const data = type === 'call'
        ? { type: 'call', title: name, body: body.video ? '📹 Incoming video call' : '📞 Incoming call', tag: 'call-' + fid, fid, callId: /^[A-Za-z0-9]+$/.test(body.callId || '') ? body.callId : '' }
        : { type: 'msg', title: name, body: body.hasImg && !body.hasText ? '📷 New photo' : 'New message', tag: 'msg-' + fid, fid };

      let sent = 0;
      await Promise.all(tokens.map(async token => {
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token, data, webpush: { headers: { Urgency: 'high', TTL: type === 'call' ? '45' : '86400' } } } })
        });
        if (r.ok) sent++;
        else if (r.status === 404) await fetch(`${FS}/users/${toUid}/tokens/${encodeURIComponent(token)}`, { method: 'DELETE', headers: auth });
      }));
      return reply({ ok: true, sent });
    } catch (e) {
      return reply({ error: String(e.message || e) }, 401);
    }
  }
};
