import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-admin-pin',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const ADMIN_EMAIL = 'abdulkadirguness72@gmail.com';
const pinAttempts = new Map<string, { count: number; resetAt: number }>();
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const publishableKeys = (() => {
  try {
    return JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
  } catch {
    return {};
  }
})();
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Object.values(publishableKeys).find((key) => typeof key === 'string' && key.startsWith('sb_publishable_')) || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function pinMatches(candidate: string) {
  const expected = Deno.env.get('SUNIFY_ADMIN_PIN') || '';
  if (!expected || !candidate) return false;
  const encoder = new TextEncoder();
  const [expectedHash, candidateHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
  ]);
  const a = new Uint8Array(expectedHash);
  const b = new Uint8Array(candidateHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function allowedPinAttempt(key: string) {
  const now = Date.now();
  const attempt = pinAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    pinAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return true;
  }
  if (attempt.count >= 8) return false;
  attempt.count += 1;
  return true;
}

async function verifyAdmin(request: Request, pin: string) {
  const address = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!allowedPinAttempt(address)) return { error: 'Çok fazla başarısız admin denemesi; 15 dakika sonra tekrar deneyin.', status: 429 };
  if (!(await pinMatches(pin))) return { error: 'Admin doğrulaması başarısız.', status: 401 };
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!token) return { error: 'Supabase oturumu gerekli.', status: 401 };
  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data.user || data.user.email?.toLowerCase() !== ADMIN_EMAIL) {
    return { error: 'Bu hesap admin alanına erişemez.', status: 403 };
  }
  if (!data.user.email_confirmed_at) return { error: 'Admin e-posta adresi Supabase üzerinden doğrulanmalı.', status: 403 };
  pinAttempts.delete(address);
  return { user: data.user };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const requestUrl = new URL(request.url);
  if (request.method === 'GET' && requestUrl.searchParams.get('action') === 'download-release') {
    const repository = Deno.env.get('SUNIFY_GITHUB_REPOSITORY') || '';
    const githubToken = Deno.env.get('SUNIFY_GITHUB_TOKEN') || '';
    const assetId = requestUrl.searchParams.get('assetId') || '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !githubToken || !/^\d+$/.test(assetId)) {
      return json({ error: 'Özel sürüm indirmesi yapılandırılmamış.' }, 503);
    }
    const upstream = await fetch(`https://api.github.com/repos/${repository}/releases/assets/${assetId}`, {
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Sunify-Desktop',
      },
      redirect: 'manual',
    });
    if (upstream.status === 302 || upstream.status === 301) {
      const location = upstream.headers.get('location');
      if (!location || !location.startsWith('https://')) return json({ error: 'GitHub güvenli indirme bağlantısı üretmedi.' }, 502);
      return new Response(null, { status: 302, headers: { ...corsHeaders, Location: location, 'Cache-Control': 'no-store' } });
    }
    if (!upstream.ok || !upstream.body) return json({ error: `GitHub varlığı indirilemedi (${upstream.status}).` }, 502);
    const downloadHeaders = new Headers({
      ...corsHeaders,
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Disposition': upstream.headers.get('content-disposition') || 'attachment',
      'Cache-Control': 'no-store',
    });
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) downloadHeaders.set('Content-Length', contentLength);
    return new Response(upstream.body, { status: upstream.status, headers: downloadHeaders });
  }
  if (request.method !== 'POST') return json({ error: 'Yalnızca POST desteklenir.' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'İstek gövdesi geçersiz.' }, 400);
  }
  const action = String(body.action || '');
  const pin = request.headers.get('x-admin-pin') || '';

  if (action === 'latest-release') {
    const repository = Deno.env.get('SUNIFY_GITHUB_REPOSITORY') || '';
    const githubToken = Deno.env.get('SUNIFY_GITHUB_TOKEN') || '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !githubToken) {
      return json({ error: 'Güncelleme kaynağı Supabase SUNIFY_GITHUB_REPOSITORY ve SUNIFY_GITHUB_TOKEN secrets değerleriyle yapılandırılmamış.' }, 503);
    }
    const upstream = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Sunify-Desktop',
      },
    });
    if (!upstream.ok) return json({ error: `GitHub sürümü okunamadı (${upstream.status}).` }, 502);
    const release = await upstream.json();
    const installer = (release.assets || []).find((asset: Record<string, unknown>) => typeof asset.name === 'string' && /\.exe$/i.test(asset.name));
    return json({ ...release, assetId: installer?.id || null });
  }

  if (action === 'admin-login') {
    if (!Deno.env.get('SUNIFY_ADMIN_PIN')) {
      return json({ error: 'Supabase Edge Function secret SUNIFY_ADMIN_PIN ayarlanmamış.' }, 503);
    }
    const address = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!allowedPinAttempt(address)) return json({ error: 'Çok fazla deneme; 15 dakika sonra tekrar deneyin.' }, 429);
    if (!(await pinMatches(pin))) return json({ error: 'Admin doğrulaması başarısız.' }, 401);
    if (!anonKey) return json({ error: 'Supabase publishable/anon key Edge Function ortamında eksik.' }, 503);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (email !== ADMIN_EMAIL) return json({ error: 'Bu e-posta admin erişimine yetkili değil.' }, 403);
    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error || !data.user || !data.session) return json({ error: 'Supabase e-posta veya şifresi hatalı.' }, 401);
    if (!data.user.email_confirmed_at) return json({ error: 'Admin e-posta adresini Supabase üzerinden doğrulayın.' }, 403);
    pinAttempts.delete(address);
    return json({ accessToken: data.session.access_token, expiresAt: data.session.expires_at });
  }

  const authorization = await verifyAdmin(request, pin);
  if ('error' in authorization) return json({ error: authorization.error }, authorization.status);

  if (action === 'list-users') {
    const users: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 10; page += 1) {
      const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 200 });
      if (error) return json({ error: error.message }, 502);
      users.push(...data.users.map((user) => ({
        id: user.id,
        email: user.email,
        createdAt: user.created_at,
        lastSignInAt: user.last_sign_in_at,
        emailConfirmed: Boolean(user.email_confirmed_at),
      })));
      if (data.users.length < 200) break;
    }
    return json({ users });
  }

  if (action === 'get-user-data' || action === 'delete-user-data' || action === 'delete-user') {
    const userId = String(body.userId || '');
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ error: 'Kullanıcı kimliği geçersiz.' }, 400);
    if (userId === authorization.user.id) return json({ error: 'Admin hesabı bu işlemle değiştirilemez.' }, 400);

    if (action === 'get-user-data') {
      const [playlists, analytics] = await Promise.all([
        adminClient.from('user_playlists').select('*').eq('user_id', userId),
        adminClient.from('user_analytics').select('*').eq('user_id', userId).maybeSingle(),
      ]);
      if (playlists.error || analytics.error) return json({ error: playlists.error?.message || analytics.error?.message }, 502);
      return json({ playlists: playlists.data || [], analytics: analytics.data || null });
    }

    const { error: playlistError } = await adminClient.from('user_playlists').delete().eq('user_id', userId);
    if (playlistError) return json({ error: playlistError.message }, 502);
    if (action === 'delete-user') {
      const { error: analyticsError } = await adminClient.from('user_analytics').delete().eq('user_id', userId);
      if (analyticsError) return json({ error: analyticsError.message }, 502);
      const { error } = await adminClient.auth.admin.deleteUser(userId);
      if (error) return json({ error: error.message }, 502);
      return json({ success: true, deletedUser: true });
    }

    const { error: analyticsError } = await adminClient
      .from('user_analytics')
      .upsert({ user_id: userId, liked_tracks: [], listening_stats: {}, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (analyticsError) return json({ error: analyticsError.message }, 502);
    return json({ success: true, deletedUser: false });
  }

  if (action === 'publish-release') {
    const version = String(body.version || '').trim().replace(/^v/i, '');
    const notes = String(body.notes || '').slice(0, 5000);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return json({ error: 'Sürüm biçimi 1.2.3 olmalı.' }, 400);
    const repository = Deno.env.get('SUNIFY_GITHUB_REPOSITORY') || '';
    const token = Deno.env.get('SUNIFY_GITHUB_TOKEN') || '';
    const ref = Deno.env.get('SUNIFY_GITHUB_REF') || 'main';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) return json({ error: 'GitHub deposu veya yayın yetkisi Supabase Edge Function sırlarında ayarlanmamış.' }, 503);
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/release.yml/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref, inputs: { version, notes } }),
    });
    if (!response.ok) return json({ error: `GitHub yayın akışı başlatılamadı (${response.status}).` }, 502);
    return json({ success: true, version, message: 'Windows derlemesi başladı. Tamamlanınca GitHub Releases bölümünde yayımlanacak.' });
  }

  return json({ error: 'Admin işlemi tanınmıyor.' }, 400);
});
