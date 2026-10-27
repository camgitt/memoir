// Delete the caller's Supabase Auth identity after refusing active Pro
// billing and wiping every object under `${uid}/` in Storage.
//
// Prefix DELETE is not a folder delete — we list recursively (paged) and
// remove in batches of 1000, then re-list before deleteUser.
// Uses the service role only for this JWT subject — never a body-supplied id.
// Deploy with verify_jwt = true.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import {
  STORAGE_BUCKET,
  STORAGE_LIST_LIMIT,
  deleteCallerAccount,
} from "./logic.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

  const { data: subs, error: subErr } = await admin
    .from("subscriptions")
    .select("status")
    .eq("user_id", user.id);

  const result = await deleteCallerAccount({
    userId: user.id,
    subscriptions: subs,
    subscriptionError: subErr,
    listFolder: async (folder, opts) => {
      const { data, error } = await admin.storage.from(STORAGE_BUCKET).list(folder, {
        limit: opts?.limit ?? STORAGE_LIST_LIMIT,
        offset: opts?.offset ?? 0,
      });
      return { data, error };
    },
    removeObjects: async (paths) => {
      const { data, error } = await admin.storage.from(STORAGE_BUCKET).remove(paths);
      if (error) return { removed: [], error };
      return { removed: Array.isArray(data) ? data : [] };
    },
    deleteUser: async (id) => admin.auth.admin.deleteUser(id),
  });

  if (result.status >= 500) {
    console.error("account-delete failed:", result.body);
  }
  return json(result.status, result.body);
});
