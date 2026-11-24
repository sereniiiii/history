import '../vendor/supabase-mount.js';

/* ============================================================
   cloud.js —— Supabase 登录与云同步（低层 API）
   - 未登录 / 未配置时完全不影响本机使用
   - 只在主站调用；解析页仍读同一份 localStorage
   ============================================================ */

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, CLOUD_TABLE } from './supabase-config.js';
import { exportPayload } from './store.js';

let client = null;
let initPromise = null;
let authCallback = null;
let authListenerBound = false;

export function cloudConfigured() {
  return Boolean(
    SUPABASE_URL
    && /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL)
    && SUPABASE_PUBLISHABLE_KEY
    && !SUPABASE_PUBLISHABLE_KEY.includes('xxxx')
  );
}

export function setAuthCallback(cb) {
  authCallback = typeof cb === 'function' ? cb : null;
}

function loadSdk() {
  if (window.supabase?.createClient) return Promise.resolve();
  if (window.__hsSupabasePromise) return window.__hsSupabasePromise;
  window.__hsSupabasePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'assets/vendor/supabase.js';
    script.async = true;
    script.onload = () => {
      if (window.supabase?.createClient) resolve();
      else reject(new Error('Supabase 组件没有正确加载'));
    };
    script.onerror = () => reject(new Error('登录组件加载失败，请检查网络或本地文件'));
    document.head.appendChild(script);
  });
  return window.__hsSupabasePromise;
}

export async function initCloud() {
  if (!cloudConfigured()) return null;
  if (client) return client;
  if (!initPromise) {
    initPromise = (async () => {
      await loadSdk();
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
        global: { headers: { 'x-application-name': 'history-kb' } },
      });
      if (!authListenerBound) {
        authListenerBound = true;
        client.auth.onAuthStateChange((event, session) => {
          try { authCallback?.(event, session); } catch (e) { console.warn('auth callback', e); }
        });
      }
      return client;
    })();
  }
  return initPromise;
}

export async function getSession() {
  const c = await initCloud();
  if (!c) return null;
  const { data, error } = await c.auth.getSession();
  if (error) throw error;
  return data?.session || null;
}

export async function sendMagicLink(email) {
  const c = await initCloud();
  if (!c) throw new Error('尚未配置 Supabase');
  const redirectTo = new URL('./', location.href).href;
  const { error } = await c.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
  });
  if (error) throw error;
  return redirectTo;
}

export async function signOutCloud() {
  const c = await initCloud();
  if (!c) return;
  const { error } = await c.auth.signOut();
  if (error) throw error;
}

async function requireUser() {
  const c = await initCloud();
  if (!c) throw new Error('尚未配置 Supabase');
  const { data, error } = await c.auth.getUser();
  if (error) throw error;
  if (!data?.user) {
    const err = new Error('NOT_SIGNED_IN');
    err.code = 'NOT_SIGNED_IN';
    throw err;
  }
  return { c, user: data.user };
}

export async function fetchCloudState() {
  const { c, user } = await requireUser();
  const { data, error } = await c
    .from(CLOUD_TABLE)
    .select('data,updated_at')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  return data ? { ...data, user } : null;
}

export async function pushCloudState(userData) {
  if (!userData) return false;
  const { c, user } = await requireUser();
  const { error } = await c.from(CLOUD_TABLE).upsert({
    user_id: user.id,
    data: exportPayload(userData).data,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw error;
  return true;
}

export function authErrorMessage(error) {
  if (!error) return '未知错误';
  if (error.code === 'NOT_SIGNED_IN') return '请先登录邮箱';
  if (error.code === 'PGRST205' || /could not find the table/i.test(error.message || '')) {
    return '云端表还没创建：请先在 Supabase SQL Editor 执行建表 SQL';
  }
  if (error.code === 'PGRST301' || /row-level security/i.test(error.message || '')) {
    return '云端权限未配置好：请检查 RLS 策略';
  }
  if (/failed to fetch|networkerror|network request failed/i.test(error.message || '')) {
    return '网络连接失败，数据仍保存在本机';
  }
  return error.message || String(error);
}
