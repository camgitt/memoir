// Delete the caller's Supabase Auth identity.
//
// The CLI removes user-owned backups/shares/subscriptions first, then POSTs
// here with the user's JWT. This function uses the service role only to call
// auth.admin.deleteUser on the JWT subject — never a body-supplied id, and
// never from the CLI. Deploy with verify_jwt = true.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function alreadyGone(error: { message?: string; status?: number } | null): boolean {
  if (!error) return false;
  if (error.status === 404) return true;
  const msg = String(error.message || "").toLowerCase();
  return msg.includes("not found") || msg.includes("user not found");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!/^bearer\s+\S+/i.test(authHeader)) return json(401, { error: "unauthorized" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  const user = userData?.user;
  if (userErr || !user?.id) return json(401, { error: "unauthorized" });

  const admin = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr && !alreadyGone(delErr)) {
    console.error("auth delete failed:", delErr.message);
    return json(502, { error: "delete_failed" });
  }

  return json(200, { deleted: true, id: user.id, already_gone: alreadyGone(delErr) });
});
