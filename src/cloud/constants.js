export const SUPABASE_URL = process.env.MEMOIR_SUPABASE_URL || 'https://oqrkxytbahfwjhcbyzrx.supabase.co';
export const SUPABASE_ANON_KEY = process.env.MEMOIR_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xcmt4eXRiYWhmd2poY2J5enJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyMTQ4MzMsImV4cCI6MjA4ODc5MDgzM30.jOKOi73OJgIgi1zj0VOIQkGp0xqS3ee4gfCjpdqCnvM';
export const STORAGE_BUCKET = 'memoir-backups';
// Cloud backup retention (cleanupOldBackups prunes beyond these, oldest first).
// Through 3.11 these were FREE=100 / PRO=50 — Pro pruned twice as aggressively
// as free on a destructive path, while the upsell copy promised Pro more.
// Free is a safety net; Pro is "full version history" (memoir.sh pricing).
export const MAX_BACKUPS_FREE = 10;
export const MAX_BACKUPS_PRO = 100;
