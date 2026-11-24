/* 把 Supabase 的 UMD 包按模块方式加载，确保在静态站点里能注册 window.supabase。 */
import './supabase.js';
export const createClient = (...args) => window.supabase.createClient(...args);
