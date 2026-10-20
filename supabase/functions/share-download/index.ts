// Download grant for `memoir restore --from <token>`.
//
// Share bundles are not readable through Storage rules. A rule that let
// recipients read them would also let anyone list them (listing is a read),
// and every bundle name contains its secret token. Instead the caller sends
// the exact token here; this function uses up one use atomically and returns
// a short-lived signed URL for that single object.
//
// Deployed with verify_jwt = false: recipients don't need a Memoir account.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const BUCKET = "memoir-backups";
const SIGNED_URL_SECONDS = 120;
// share.js mints tokens with crypto.randomUUID().
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  let token = "";
  try {
    const body = await req.json();
    token = String(body?.token ?? "").trim();
  } catch {
    return json(400, { error: "bad_request" });
  }
  // Same answer for malformed and unknown tokens, so the response says
  // nothing about which tokens exist.
  if (!TOKEN_RE.test(token)) return json(404, { error: "not_available" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Increments use_count only while the link is unexpired and under max_uses.
  const { data: rows, error } = await supabase.rpc("memoir_consume_shared_link", { link_token: token });
  if (error) {
    console.error("consume failed:", error.message);
    return json(500, { error: "lookup_failed" });
  }
  const link = Array.isArray(rows) ? rows[0] : null;
  if (!link) return json(404, { error: "not_available" });

  // Row-level rules only force created_by to be the sharer; backup_id is
  // whatever their client wrote. Sign nothing outside the sharer's own
  // share path, or a crafted row could hand out someone else's backup.
  const expectedPath = `${link.created_by}/shares/${token}.gz`;
  if (link.backup_id !== expectedPath) {
    console.error("share path mismatch for link", link.id);
    return json(404, { error: "not_available" });
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(expectedPath, SIGNED_URL_SECONDS);
  if (signError || !signed?.signedUrl) {
    console.error("sign failed:", signError?.message);
    return json(502, { error: "sign_failed" });
  }

  return json(200, {
    url: signed.signedUrl,
    use_count: link.use_count,
    max_uses: link.max_uses,
    expires_at: link.expires_at,
  });
});
