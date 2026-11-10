// Alle logica van de parkeerhulp. Opslag, internet en meldingen worden van buitenaf
// aangeleverd (ctx), zodat dit los te testen is.
import { hhmm } from "./time.ts";
import { type Action, type FetchFn, normPlate, ParkError, type Snapshot, TwoPark } from "./twopark.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface SessionRow {
  action_id: string;
  plate: string;
  name: string | null;
  started_at: string | null;
  end_at: string | null;
  mode: "fixed" | "auto";
  block_min: number;
  max_until: string | null;
  reminded_for: string | null;
  reminded1_for: string | null;
  nudged_at: string | null;
  state: "active" | "ended";
  stopped_by_app: boolean;
  ended_at: string | null;
  cost: number | null;
  source: string;
  last_error: string | null;
}
export interface DeviceRow {
  id: string;
  token_hash: string;
  label: string | null;
  push: Json | null;
}
export interface Store {
  cfgGet(key: string): Promise<Json | null>;
  cfgSet(key: string, value: Json): Promise<void>;
  secretGet(name: string): Promise<string | null>;
  secretSet(name: string, value: string): Promise<void>;
  sessionsActive(): Promise<SessionRow[]>;
  sessionUpsert(row: Partial<SessionRow> & { action_id: string }): Promise<void>;
  deviceAdd(tokenHash: string, label: string | null): Promise<void>;
  deviceByHash(tokenHash: string): Promise<DeviceRow | null>;
  devices(): Promise<DeviceRow[]>;
  deviceSetPush(id: string, push: Json | null): Promise<void>;
  deviceRemove(id: string): Promise<void>;
  log(kind: string, detail: Json): Promise<void>;
  logCount(kind: string, sinceIso: string): Promise<number>;
}
export interface PushMsg {
  title: string;
  body: string;
  tag: string;
}
export interface Ctx {
  store: Store;
  fetch: FetchFn;
  now: () => Date;
  /** Stuurt één melding; geeft "gone" terug als het abonnement niet meer bestaat. */
  push: (sub: Json, msg: PushMsg) => Promise<"ok" | "gone" | "error">;
  vapidPublicKey: () => Promise<string>;
}

export const DEFAULTS = { lead_min: 5, low_balance: 2, nudge_min: 60, auto_block: 30, auto_max_hours: 4 };
type Settings = typeof DEFAULTS;

const MIN = 60_000;
const FINAL_MIN = 1.5; // de klok tikt per minuut: dit valt 0,5 tot 1,5 min voor het einde
const euro = (n: number) => "€ " + n.toFixed(2).replace(".", ",");

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function settings(ctx: Ctx): Promise<Settings> {
  return { ...DEFAULTS, ...((await ctx.store.cfgGet("settings")) ?? {}) };
}

async function openPark(ctx: Ctx): Promise<TwoPark> {
  const email = await ctx.store.cfgGet("owner_email");
  const password = await ctx.store.secretGet("twopark_password");
  if (!email || !password) throw new UserError("Nog niet gekoppeld aan 2Park", 401);
  const s = (await ctx.store.cfgGet("tp_session")) ?? { cookies: {}, product_id: null, location: null };
  return new TwoPark(ctx.fetch, { email, password }, s);
}
async function closePark(ctx: Ctx, tp: TwoPark): Promise<void> {
  if (tp.dirty) await ctx.store.cfgSet("tp_session", tp.s);
}

const isLive = (a: Action, now: Date) =>
  a.end.getTime() > now.getTime() && !/STOP|END|CANCEL|EXPIRE|FINISH|CLOSED/i.test(a.state);

async function notify(ctx: Ctx, msg: PushMsg): Promise<void> {
  const devs = (await ctx.store.devices()).filter((d) => d.push);
  let sent = 0;
  for (const d of devs) {
    const r = await ctx.push(d.push, msg);
    if (r === "ok") sent++;
    if (r === "gone") await ctx.store.deviceSetPush(d.id, null);
  }
  await ctx.store.log("notify", { ...msg, devices: devs.length, sent });
}

/** Legt de stand bij 2Park naast onze eigen administratie. */
async function sync(ctx: Ctx, snap: Snapshot, quiet = false): Promise<SessionRow[]> {
  const now = ctx.now();
  const local = await ctx.store.sessionsActive();
  const byId = new Map(local.map((r) => [r.action_id, r]));
  const live = snap.actions.filter((a) => isLive(a, now));
  const out: SessionRow[] = [];
  const st = await settings(ctx);

  for (const a of live) {
    const prev = byId.get(a.id);
    const endIso = a.end.toISOString();
    const row: SessionRow = {
      action_id: a.id,
      plate: a.plate,
      name: a.name ?? prev?.name ?? null,
      started_at: a.start.toISOString(),
      end_at: endIso,
      mode: prev?.mode ?? "fixed",
      block_min: prev?.block_min ?? st.auto_block,
      max_until: prev?.max_until ?? null,
      reminded_for: prev?.reminded_for ?? null,
      reminded1_for: prev?.reminded1_for ?? null,
      nudged_at: prev?.nudged_at ?? null,
      state: "active",
      stopped_by_app: false,
      ended_at: null,
      cost: a.cost ?? prev?.cost ?? null,
      source: prev?.source ?? "extern",
      last_error: prev?.last_error ?? null,
    };
    if (!prev || prev.end_at !== endIso || prev.cost !== row.cost || prev.name !== row.name) {
      await ctx.store.sessionUpsert(row);
    }
    out.push(row);
    const mins = (a.end.getTime() - a.start.getTime()) / MIN;
    if (a.cost && a.cost > 0 && mins >= 5) {
      await ctx.store.cfgSet("rate_per_hour", Math.round((a.cost / mins) * 60 * 100) / 100);
    }
  }
  const liveIds = new Set(live.map((a) => a.id));
  for (const r of local) {
    if (liveIds.has(r.action_id)) continue;
    await ctx.store.sessionUpsert({ action_id: r.action_id, state: "ended", ended_at: now.toISOString() });
    const expired = r.end_at && now.getTime() >= new Date(r.end_at).getTime() - 90_000;
    if (!quiet && !r.stopped_by_app && expired) {
      await notify(ctx, {
        title: `${r.name || r.plate} is afgemeld`,
        body: `Parkeertijd afgelopen om ${hhmm(new Date(r.end_at!))}. Staat de auto er nog? Meld dan opnieuw aan.`,
        tag: `end-${r.action_id}`,
      });
    }
  }
  return out;
}

async function buildState(ctx: Ctx, snap: Snapshot, rows: SessionRow[], device: DeviceRow | null): Promise<Json> {
  const now = ctx.now();
  return {
    now: now.toISOString(),
    owner_email: await ctx.store.cfgGet("owner_email"),
    balance: snap.balance,
    currency: snap.currency,
    rate_per_hour: await ctx.store.cfgGet("rate_per_hour"),
    favorites: snap.favorites,
    sessions: rows
      .map((r) => ({
        id: r.action_id,
        plate: r.plate,
        name: r.name,
        start: r.started_at,
        end: r.end_at,
        cost: r.cost,
        mode: r.mode,
        block_min: r.block_min,
        max_until: r.max_until,
        planned: r.started_at ? new Date(r.started_at).getTime() > now.getTime() + 30_000 : false,
        last_error: r.last_error,
      }))
      .sort((a, b) => String(a.end).localeCompare(String(b.end))),
    settings: await settings(ctx),
    push: { public_key: await ctx.vapidPublicKey(), subscribed: !!device?.push },
  };
}

function wantedEnd(now: Date, body: Json): Date {
  if (body.end) {
    const d = new Date(body.end);
    if (isNaN(d.getTime())) throw new UserError("Ongeldige eindtijd");
    return d;
  }
  const m = Number(body.minutes);
  if (!Number.isFinite(m) || m < 1 || m > 24 * 60) throw new UserError("Kies een duur tussen 1 minuut en 24 uur");
  return new Date(now.getTime() + m * MIN);
}

const friendly = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- acties vanuit de app ----------

async function login(ctx: Ctx, body: Json): Promise<Json> {
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!email || !password) throw new UserError("Vul e-mail en wachtwoord in");
  const since = new Date(ctx.now().getTime() - 15 * MIN).toISOString();
  if ((await ctx.store.logCount("login_fail", since)) >= 8) {
    throw new UserError("Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.", 429);
  }
  const owner = await ctx.store.cfgGet("owner_email");
  if (owner && owner !== email) {
    await ctx.store.log("login_fail", { reason: "other_account" });
    throw new UserError("Deze app is gekoppeld aan een ander 2Park-account", 403);
  }
  const tp = new TwoPark(ctx.fetch, { email, password }, { cookies: {}, product_id: null, location: null });
  try {
    await tp.login();
  } catch (e) {
    await ctx.store.log("login_fail", { reason: friendly(e) });
    if (e instanceof ParkError && e.kind === "auth") throw new UserError(e.message, 401);
    throw e;
  }
  await ctx.store.cfgSet("owner_email", email);
  await ctx.store.secretSet("twopark_password", password);
  await ctx.store.cfgSet("tp_session", tp.s);
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  await ctx.store.deviceAdd(await sha256(token), String(body.label ?? "").slice(0, 80) || null);
  await ctx.store.log("login_ok", { product_id: tp.s.product_id, location: tp.s.location });
  return { token };
}

async function stateAction(ctx: Ctx, device: DeviceRow): Promise<Json> {
  const tp = await openPark(ctx);
  try {
    const snap = await tp.snapshot();
    const rows = await sync(ctx, snap);
    await ctx.store.cfgSet("last_poll", ctx.now().toISOString());
    return await buildState(ctx, snap, rows, device);
  } finally {
    await closePark(ctx, tp);
  }
}

async function startAction(ctx: Ctx, device: DeviceRow, body: Json): Promise<Json> {
  const plate = normPlate(body.plate);
  if (plate.length < 4 || plate.length > 9) throw new UserError("Vul een geldig kenteken in");
  const name = String(body.name ?? "").trim().slice(0, 40) || null;
  const st = await settings(ctx);
  const now = ctx.now();
  const auto = body.mode === "auto";
  const block = Math.min(240, Math.max(10, Number(body.block_min) || st.auto_block));
  const end = auto ? new Date(now.getTime() + block * MIN) : wantedEnd(now, body);
  if (end.getTime() < now.getTime() + MIN) throw new UserError("De eindtijd moet in de toekomst liggen");
  const maxUntil = auto
    ? new Date(now.getTime() + Math.min(24, Math.max(0.5, Number(body.max_hours) || st.auto_max_hours)) * 60 * MIN)
    : null;

  const tp = await openPark(ctx);
  try {
    const before = await tp.snapshot();
    if (before.actions.some((a) => a.plate === plate && isLive(a, now))) {
      throw new UserError(`${plate} staat al aangemeld`);
    }
    await tp.start(plate, now, end);
    let snap = await tp.snapshot();
    let found = snap.actions.find((a) => a.plate === plate && isLive(a, ctx.now()));
    if (!found) {
      await new Promise((r) => setTimeout(r, 1500));
      snap = await tp.snapshot();
      found = snap.actions.find((a) => a.plate === plate && isLive(a, ctx.now()));
    }
    if (!found) {
      await ctx.store.log("start_unconfirmed", { plate });
      throw new UserError("2Park bevestigt de aanmelding niet. Controleer het in 2Park zelf.", 502);
    }
    const known = before.favorites.find((f) => f.plate === plate);
    await ctx.store.sessionUpsert({
      action_id: found.id,
      plate,
      name: found.name ?? known?.name ?? name,
      started_at: found.start.toISOString(),
      end_at: found.end.toISOString(),
      mode: auto ? "auto" : "fixed",
      block_min: block,
      max_until: maxUntil ? maxUntil.toISOString() : null,
      reminded_for: null,
      reminded1_for: null,
      nudged_at: null,
      state: "active",
      stopped_by_app: false,
      cost: found.cost,
      source: "app",
      last_error: null,
    });
    if (body.save_favorite && name && !known) {
      try {
        await tp.favorite("add", plate, name);
        snap = await tp.snapshot();
      } catch (e) {
        await ctx.store.log("favorite_fail", { plate, error: friendly(e) });
      }
    }
    await ctx.store.log("start", { plate, id: found.id, end: found.end.toISOString(), auto });
    return await buildState(ctx, snap, await sync(ctx, snap, true), device);
  } finally {
    await closePark(ctx, tp);
  }
}

async function extendAction(ctx: Ctx, device: DeviceRow, body: Json): Promise<Json> {
  const id = String(body.action_id ?? "");
  const tp = await openPark(ctx);
  try {
    const before = await tp.snapshot();
    const a = before.actions.find((x) => x.id === id && isLive(x, ctx.now()));
    if (!a) throw new UserError("Deze parkeeractie loopt niet meer. Meld opnieuw aan.", 404);
    let until: Date;
    if (body.end) {
      until = wantedEnd(ctx.now(), body);
    } else {
      const m = Number(body.minutes);
      if (!Number.isFinite(m) || m === 0 || Math.abs(m) > 24 * 60) throw new UserError("Ongeldige duur");
      until = new Date(a.end.getTime() + m * MIN);
    }
    if (until.getTime() < ctx.now().getTime() + MIN) throw new UserError("De eindtijd moet in de toekomst liggen");
    await tp.extend(id, until);
    await ctx.store.sessionUpsert({ action_id: id, reminded_for: null, reminded1_for: null, last_error: null });
    const snap = await tp.snapshot();
    await ctx.store.log("extend", { id, until: until.toISOString() });
    return await buildState(ctx, snap, await sync(ctx, snap, true), device);
  } finally {
    await closePark(ctx, tp);
  }
}

async function stopAction(ctx: Ctx, device: DeviceRow, body: Json): Promise<Json> {
  const id = String(body.action_id ?? "");
  const tp = await openPark(ctx);
  try {
    const before = await tp.snapshot();
    if (before.actions.some((x) => x.id === id && isLive(x, ctx.now()))) {
      await ctx.store.sessionUpsert({ action_id: id, stopped_by_app: true });
      await tp.stop(id);
    }
    const snap = await tp.snapshot();
    if (snap.actions.some((x) => x.id === id && isLive(x, ctx.now()))) {
      await ctx.store.sessionUpsert({ action_id: id, stopped_by_app: false });
      throw new UserError("2Park bevestigt het afmelden niet. Probeer opnieuw.", 502);
    }
    await ctx.store.log("stop", { id });
    return await buildState(ctx, snap, await sync(ctx, snap, true), device);
  } finally {
    await closePark(ctx, tp);
  }
}

async function sessionUpdate(ctx: Ctx, device: DeviceRow, body: Json): Promise<Json> {
  const id = String(body.action_id ?? "");
  const st = await settings(ctx);
  const auto = body.mode === "auto";
  const hours = Math.min(24, Math.max(0.5, Number(body.max_hours) || st.auto_max_hours));
  await ctx.store.sessionUpsert({
    action_id: id,
    mode: auto ? "auto" : "fixed",
    block_min: Math.min(240, Math.max(10, Number(body.block_min) || st.auto_block)),
    max_until: auto ? new Date(ctx.now().getTime() + hours * 60 * MIN).toISOString() : null,
    reminded_for: null,
    reminded1_for: null,
    nudged_at: ctx.now().toISOString(),
  });
  return await stateAction(ctx, device);
}

async function favoriteAction(ctx: Ctx, device: DeviceRow, body: Json): Promise<Json> {
  const plate = normPlate(body.plate);
  const name = String(body.name ?? "").trim().slice(0, 40);
  const op = body.op === "remove" ? "remove" : "add";
  if (plate.length < 4) throw new UserError("Vul een geldig kenteken in");
  if (op === "add" && !name) throw new UserError("Geef de favoriet een naam");
  const tp = await openPark(ctx);
  try {
    const snap0 = await tp.snapshot();
    const cur = snap0.favorites.find((f) => f.plate === plate);
    if (op === "add" && cur) throw new UserError("Dit kenteken staat al bij je favorieten");
    await tp.favorite(op, plate, op === "remove" ? (cur?.name ?? plate) : name);
    const snap = await tp.snapshot();
    return await buildState(ctx, snap, await sync(ctx, snap, true), device);
  } finally {
    await closePark(ctx, tp);
  }
}

async function saveSettings(ctx: Ctx, body: Json): Promise<Json> {
  const cur = await settings(ctx);
  const num = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const next: Settings = {
    lead_min: num(body.lead_min, 1, 30, cur.lead_min),
    low_balance: num(body.low_balance, 0, 100, cur.low_balance),
    nudge_min: num(body.nudge_min, 15, 480, cur.nudge_min),
    auto_block: num(body.auto_block, 10, 240, cur.auto_block),
    auto_max_hours: num(body.auto_max_hours, 0.5, 24, cur.auto_max_hours),
  };
  await ctx.store.cfgSet("settings", next);
  return { settings: next };
}

// ---------- de klok: elke minuut ----------

export async function tick(ctx: Ctx): Promise<Json> {
  const email = await ctx.store.cfgGet("owner_email");
  if (!email) return { skipped: "niet gekoppeld" };
  const now = ctx.now();
  const st = await settings(ctx);
  const local = await ctx.store.sessionsActive();
  const lastPoll = new Date((await ctx.store.cfgGet("last_poll")) ?? 0).getTime();
  const sincePoll = now.getTime() - lastPoll;
  const urgent = local.some((r) => {
    const left = (new Date(r.end_at ?? 0).getTime() - now.getTime()) / MIN;
    return left <= Math.max(st.lead_min, 3) + 1.5;
  });
  const nudgeDue = local.some((r) =>
    r.mode === "auto" && now.getTime() - new Date(r.nudged_at ?? r.started_at ?? 0).getTime() >= st.nudge_min * MIN
  );
  const need = urgent || nudgeDue || sincePoll >= (local.length ? 4 : 10) * MIN;
  if (!need) return { skipped: "niets te doen" };

  const tp = await openPark(ctx);
  const did: string[] = [];
  try {
    let snap: Snapshot;
    try {
      snap = await tp.snapshot();
    } catch (e) {
      await ctx.store.log("tick_error", { error: friendly(e) });
      // Kan 2Park niet bereikt worden terwijl er iets afloopt? Dan in elk geval waarschuwen.
      for (const r of local) {
        const left = (new Date(r.end_at ?? 0).getTime() - now.getTime()) / MIN;
        if (left <= st.lead_min && left > -1 && r.reminded_for !== r.end_at) {
          await notify(ctx, {
            title: `Nog ${Math.max(1, Math.round(left))} min: ${r.name || r.plate}`,
            body: `Loopt af om ${hhmm(new Date(r.end_at!))}. Let op: 2Park is nu niet bereikbaar (${friendly(e)}).`,
            tag: `rem-${r.action_id}`,
          });
          await ctx.store.sessionUpsert({ action_id: r.action_id, reminded_for: r.end_at });
        }
      }
      return { error: friendly(e) };
    }
    await ctx.store.cfgSet("last_poll", now.toISOString());
    const rows = await sync(ctx, snap);

    for (const r of rows) {
      const end = new Date(r.end_at!);
      const start = new Date(r.started_at ?? now);
      if (start.getTime() > now.getTime() + 30_000) continue; // gepland, nog niet begonnen
      const left = (end.getTime() - now.getTime()) / MIN;
      const who = r.name || r.plate;
      const dur = (end.getTime() - start.getTime()) / MIN;
      const lead = Math.min(st.lead_min, Math.max(2, dur / 2));
      let extended = false;
      const cap = r.max_until ? new Date(r.max_until).getTime() : end.getTime();
      const target = Math.min(end.getTime() + r.block_min * MIN, cap);
      const canExtend = r.mode === "auto" && target > end.getTime() + 30_000;
      if (canExtend && left > 3.5) {
        // wordt straks vanzelf verlengd: alleen af en toe vragen of het bezoek er nog is
        const last = new Date(r.nudged_at ?? r.started_at ?? now).getTime();
        if (now.getTime() - last >= st.nudge_min * MIN) {
          const mins = Math.round((now.getTime() - start.getTime()) / MIN);
          const h = Math.floor(mins / 60);
          const long = h ? `${h} uur${mins % 60 ? ` ${mins % 60} min` : ""}` : `${mins} min`;
          await notify(ctx, {
            title: `${who} staat nog aangemeld`,
            body: `Al ${long}${r.cost ? ` (${euro(r.cost)})` : ""}. Wordt automatisch verlengd` +
              `${r.max_until ? ` tot uiterlijk ${hhmm(new Date(r.max_until))}` : ""}. Vertrokken? Tik om af te melden.`,
            tag: `nudge-${r.action_id}`,
          });
          await ctx.store.sessionUpsert({ action_id: r.action_id, nudged_at: now.toISOString() });
          did.push(`check ${r.plate}`);
        }
        continue;
      }

      if (canExtend) {
        try {
          await tp.extend(r.action_id, new Date(target));
          await ctx.store.sessionUpsert({
            action_id: r.action_id,
            end_at: new Date(target).toISOString(),
            reminded_for: null,
            reminded1_for: null,
            last_error: null,
          });
          did.push(`verlengd ${r.plate} tot ${hhmm(new Date(target))}`);
          await ctx.store.log("auto_extend", { id: r.action_id, until: new Date(target).toISOString() });
          extended = true;
        } catch (e) {
          const msg = friendly(e);
          await ctx.store.log("auto_extend_fail", { id: r.action_id, error: msg });
          if (r.last_error !== msg || r.reminded_for !== r.end_at) {
            await notify(ctx, {
              title: `Verlengen mislukt: ${who}`,
              body: `${msg}. De parkeertijd loopt af om ${hhmm(end)}. Tik om het zelf te regelen.`,
              tag: `rem-${r.action_id}`,
            });
            await ctx.store.sessionUpsert({ action_id: r.action_id, last_error: msg, reminded_for: r.end_at });
          }
          continue;
        }
      }
      if (extended) continue;

      const capped = r.mode === "auto";
      if (left <= FINAL_MIN && left > -1 && r.reminded1_for !== r.end_at) {
        // laatste waarschuwing, ongeveer 1 minuut van tevoren
        await notify(ctx, {
          title: `Nog 1 min: ${who}`,
          body: `Loopt af om ${hhmm(end)}. Tik nu om te verlengen, anders staat de auto zo onaangemeld.`,
          tag: `rem-${r.action_id}`,
        });
        await ctx.store.sessionUpsert({ action_id: r.action_id, reminded1_for: r.end_at, reminded_for: r.end_at });
        did.push(`laatste herinnering ${r.plate}`);
      } else if (left <= lead && left > FINAL_MIN && r.reminded_for !== r.end_at) {
        await notify(ctx, {
          title: `Nog ${Math.max(2, Math.round(left))} min: ${who}`,
          body: capped
            ? `Maximum bereikt, stopt om ${hhmm(end)}. Tik om te verlengen of af te melden.`
            : `Aangemeld tot ${hhmm(end)}. Tik om te verlengen of af te melden.`,
          tag: `rem-${r.action_id}`,
        });
        await ctx.store.sessionUpsert({ action_id: r.action_id, reminded_for: r.end_at });
        did.push(`herinnering ${r.plate}`);
      }
    }

    if (snap.balance !== null) {
      const flagged = !!(await ctx.store.cfgGet("low_notified"));
      if (snap.balance < st.low_balance && !flagged) {
        await notify(ctx, {
          title: `Saldo bijna op: ${euro(snap.balance)}`,
          body: "Waardeer op in 2Park, anders kun je bezoek straks niet aanmelden of verlengen.",
          tag: "balance",
        });
        await ctx.store.cfgSet("low_notified", true);
        did.push("saldo-waarschuwing");
      } else if (snap.balance >= st.low_balance && flagged) {
        await ctx.store.cfgSet("low_notified", false);
      }
    }
    // af en toe een voorbeeld van het ruwe antwoord bewaren, om de koppeling te kunnen bijstellen
    const lastSample = new Date((await ctx.store.cfgGet("last_sample")) ?? 0).getTime();
    if (rows.length && now.getTime() - lastSample > 24 * 60 * MIN) {
      await ctx.store.log("sample", tp.rawDetails);
      await ctx.store.cfgSet("last_sample", now.toISOString());
    }
    return { sessions: rows.length, did };
  } finally {
    await closePark(ctx, tp);
  }
}

// ---------- ingang ----------

export async function handle(ctx: Ctx, body: Json): Promise<{ status: number; json: Json }> {
  try {
    const action = String(body?.action ?? "");
    if (action === "ping") return { status: 200, json: { ok: true, linked: !!(await ctx.store.cfgGet("owner_email")) } };
    if (action === "tick") {
      const secret = await ctx.store.cfgGet("cron_secret");
      if (!secret || body.secret !== secret) throw new UserError("Geen toegang", 401);
      return { status: 200, json: await tick(ctx) };
    }
    if (action === "login") return { status: 200, json: await login(ctx, body) };

    const token = String(body?.token ?? "");
    const device = token ? await ctx.store.deviceByHash(await sha256(token)) : null;
    if (!device) throw new UserError("Log opnieuw in", 401);

    switch (action) {
      case "state":
        return { status: 200, json: await stateAction(ctx, device) };
      case "start":
        return { status: 200, json: await startAction(ctx, device, body) };
      case "extend":
        return { status: 200, json: await extendAction(ctx, device, body) };
      case "stop":
        return { status: 200, json: await stopAction(ctx, device, body) };
      case "session_update":
        return { status: 200, json: await sessionUpdate(ctx, device, body) };
      case "favorite":
        return { status: 200, json: await favoriteAction(ctx, device, body) };
      case "settings":
        return { status: 200, json: await saveSettings(ctx, body) };
      case "push_subscribe":
        await ctx.store.deviceSetPush(device.id, body.subscription ?? null);
        return { status: 200, json: { ok: true } };
      case "push_test": {
        const fresh = await ctx.store.deviceByHash(await sha256(token));
        if (!fresh?.push) throw new UserError("Meldingen staan op dit apparaat nog niet aan");
        const r = await ctx.push(fresh.push, {
          title: "Testmelding",
          body: "Meldingen werken. Zo krijg je straks een seintje voordat de parkeertijd afloopt.",
          tag: "test",
        });
        if (r !== "ok") throw new UserError("De melding kon niet verstuurd worden. Zet meldingen opnieuw aan.", 502);
        return { status: 200, json: { ok: true } };
      }
      case "logout":
        await ctx.store.deviceRemove(device.id);
        return { status: 200, json: { ok: true } };
      default:
        throw new UserError("Onbekende actie", 404);
    }
  } catch (e) {
    if (e instanceof UserError) return { status: e.status, json: { error: e.message } };
    if (e instanceof ParkError) {
      await ctx.store.log("park_error", { action: body?.action, kind: e.kind, error: e.message }).catch(() => {});
      return { status: e.kind === "network" ? 503 : 502, json: { error: e.message } };
    }
    await ctx.store.log("crash", { action: body?.action, error: friendly(e) }).catch(() => {});
    return { status: 500, json: { error: "Er ging iets mis. Probeer het opnieuw." } };
  }
}
