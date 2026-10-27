// Scheduled cleanup for expired or exhausted share bundles.
//
// Pages filtered shared_links rows (expired or used), keeps only rows whose
// backup_id equals created_by/shares/<token>.gz, removes those objects through
// the Storage API in batches of 1000, then deletes the matching rows.
// Never DELETE FROM storage.objects.
//
// OWNER: set MEMOIR_PURGE_SECRET (and the same value in Vault), deploy with
// verify_jwt = false, and schedule a daily pg_cron + pg_net POST that sends
// header x-memoir-purge-secret from vault.decrypted_secrets. See the PR body.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import {
  SHARE_BUCKET,
  PURGE_PAGE_SIZE,
  dueShareOrFilter,
  purgeExpiredShares,
  secretsEqual,
} from "./logic.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const secret = Deno.env.get("MEMOIR_PURGE_SECRET") ?? "";
  const provided = req.headers.get("x-memoir-purge-secret") ?? "";
  if (!secret || !secretsEqual(secret, provided)) return json(401, { error: "unauthorized" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  try {
    const result = await purgeExpiredShares({
      listSharePage: async ({ afterId, limit, now }) => {
        let q = supabase
          .from("shared_links")
          .select("id, token, backup_id, created_by, expires_at, use_count, max_uses")
          .or(dueShareOrFilter(now))
          .order("id", { ascending: true })
          .limit(limit ?? PURGE_PAGE_SIZE);
        if (afterId) q = q.gt("id", afterId);
        const { data, error } = await q;
        if (error) return { rows: [], error };
        return { rows: data || [] };
      },
      removeObjects: async (paths) => {
        const { error } = await supabase.storage.from(SHARE_BUCKET).remove(paths);
        if (error) return { removed: [], error };
        // A successful Storage API call confirms the objects are gone (or were
        // already absent). Rows are deleted only for this confirmed set.
        return { removed: paths };
      },
      deleteShareRows: async (ids) => {
        const { error } = await supabase.from("shared_links").delete().in("id", ids);
        return { error };
      },
    });
    if (result.error) return json(500, { error: "purge_failed", detail: result.error });
    return json(200, result);
  } catch (err) {
    console.error("purge failed:", (err as Error)?.message || err);
    return json(500, { error: "purge_failed" });
  }
});
