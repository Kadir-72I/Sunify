import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Yalnızca POST desteklenir.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: 'Hesap silme servisi yapılandırılmamış.' }, 503);

  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!token) return json({ error: 'Aktif kullanıcı oturumu gerekli.' }, 401);
  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'İstek gövdesi geçersiz.' }, 400);
  }
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || password.length > 256) return json({ error: 'Hesap şifresi gerekli.' }, 400);

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(token);
  const caller = callerData.user;
  if (callerError || !caller?.id || !caller.email) return json({ error: 'Kullanıcı oturumu geçersiz.' }, 401);

  const reauthClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: reauthData, error: reauthError } = await reauthClient.auth.signInWithPassword({ email: caller.email, password });
  if (reauthError || reauthData.user?.id !== caller.id) return json({ error: 'Şifre doğrulanamadı.' }, 401);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: playlistError } = await adminClient.from('user_playlists').delete().eq('user_id', caller.id);
  if (playlistError) return json({ error: `Kullanıcı çalma listeleri silinemedi: ${playlistError.message}` }, 502);
  const { error: analyticsError } = await adminClient.from('user_analytics').delete().eq('user_id', caller.id);
  if (analyticsError) return json({ error: `Kullanıcı dinleme verileri silinemedi: ${analyticsError.message}` }, 502);
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(caller.id);
  if (deleteError) return json({ error: `Hesap silinemedi: ${deleteError.message}` }, 502);
  return json({ success: true, deletedEmail: caller.email });
});
