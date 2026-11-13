// Supabase Edge Function "park": de achterkant van de parkeerhulp.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { type Ctx, type DeviceRow, handle, type SessionRow, type Store } from "./core.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// deno-lint-ignore no-explicit-any
type Json = any;
// deno-lint-ignore no-explicit-any
function must<T>(r: { data: T; error: any }): T {
  if (r.error) throw new Error(`db: ${r.error.message}`);
  return r.data;
}

const store: Store = {
  async cfgGet(key) {
    const d = must(await db.from("park_config").select("value").eq("key", key).maybeSingle());
    return d ? (d as Json).value : null;
  },
  async cfgSet(key, value) {
    must(await db.from("park_config").upsert({ key, value, updated_at: new Date().toISOString() }));
  },
  async secretGet(name) {
    return must(await db.rpc("park_secret_get", { p_name: name })) as string | null;
  },
  async secretSet(name, value) {
    must(await db.rpc("park_secret_set", { p_name: name, p_value: value }));
  },
  async sessionsActive() {
    return must(await db.from("park_sessions").select("*").eq("state", "active")) as SessionRow[];
  },
  async sessionPlate(actionId) {
    const d = must(await db.from("park_sessions").select("plate").eq("action_id", actionId).maybeSingle());
    return d ? (d as Json).plate : null;
  },
  async sessionUpsert(row) {
    if (row.plate) must(await db.from("park_sessions").upsert(row));
    else must(await db.from("park_sessions").update(row).eq("action_id", row.action_id));
  },
  async deviceAdd(token_hash, label) {
    must(await db.from("park_devices").insert({ token_hash, label }));
  },
  async deviceByHash(token_hash) {
    const d = must(await db.from("park_devices").select("*").eq("token_hash", token_hash).maybeSingle());
    if (d) await db.from("park_devices").update({ last_seen: new Date().toISOString() }).eq("id", (d as Json).id);
    return d as DeviceRow | null;
  },
  async devices() {
    return must(await db.from("park_devices").select("*")) as DeviceRow[];
  },
  async deviceSetPush(id, push) {
    must(await db.from("park_devices").update({ push }).eq("id", id));
  },
  async deviceRemove(id) {
    must(await db.from("park_devices").delete().eq("id", id));
  },
  async log(kind, detail) {
    await db.from("park_log").insert({ kind, detail });
  },
  async logCount(kind, sinceIso) {
    const r = await db.from("park_log").select("id", { count: "exact", head: true }).eq("kind", kind).gte("at", sinceIso);
    return r.count ?? 0;
  },
};

async function vapid(): Promise<{ publicKey: string; privateKey: string }> {
  let keys = await store.cfgGet("vapid");
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    await store.cfgSet("vapid", keys);
  }
  return keys;
}

const ctx: Ctx = {
  store,
  fetch: (url, init) => fetch(url, init),
  now: () => new Date(),
  vapidPublicKey: async () => (await vapid()).publicKey,
  async push(sub, msg) {
    try {
      const keys = await vapid();
      const owner = (await store.cfgGet("owner_email")) ?? "parkeren@example.com";
      await webpush.sendNotification(sub, JSON.stringify(msg), {
        vapidDetails: { subject: `mailto:${owner}`, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 600,
        urgency: "high",
      });
      return "ok";
    } catch (e) {
      const code = (e as Json)?.statusCode;
      await store.log("push_error", { code, error: String((e as Error)?.message ?? e), body: (e as Json)?.body });
      return code === 404 || code === 410 ? "gone" : "error";
    }
  },
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Alleen POST" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  let body: Json = {};
  try {
    body = JSON.parse(await req.text());
  } catch {
    body = {};
  }
  const out = await handle(ctx, body);
  return new Response(JSON.stringify(out.json), {
    status: out.status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});
