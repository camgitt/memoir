// Scheduled cleanup for expired share bundles.
//
// Calls memoir_purge_expired_shares(), which deletes shared_links whose
// expires_at is in the past and the matching storage objects. A daily run
// keeps expired shares from lingering past the 30-day-after-expiry deadline.
//
// MANUAL STEP: deploy this function (verify_jwt = false) and schedule it
// daily in the Supabase dashboard, or enable pg_cron from the migration.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json(405, { error: "method_not_allowed" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data, error } = await supabase.rpc("memoir_purge_expired_shares");
  if (error) {
    console.error("purge failed:", error.message);
    return json(500, { error: "purge_failed" });
  }
  return json(200, data ?? { deleted_links: 0, deleted_objects: 0 });
});
