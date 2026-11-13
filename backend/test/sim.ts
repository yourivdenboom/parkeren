// Test tegen een nagebootste 2Park: geen echt account, geen echte kosten.
import { type Ctx, type DeviceRow, handle, type PushMsg, type SessionRow, type Store } from "../park/core.ts";
import { fmtLocal, parseLocal } from "../park/time.ts";

// deno-lint-ignore no-explicit-any
type Json = any;
let failures = 0;
function ok(cond: unknown, label: string) {
  console.log(`${cond ? "  ok  " : "  FOUT"} ${label}`);
  if (!cond) failures++;
}

// ---- nep-2Park ----
const fake = {
  password: "geheim",
  cookie: "",
  balance: 10.0,
  rate: 2.04, // euro per uur
  members: [{ id: 1, plate: "H817TK", name: "Miki" }, { id: 2, plate: "AB123C", name: "Mam" }] as Json[],
  actions: [] as { id: number; plate: string; start: Date; end: Date; state: string }[],
  nextId: 100,
  calls: [] as string[],
  down: false,
  extendFails: "",
  stopCascades: true,
};
const OK = (data: Json = {}, minor = "SUCCESS") => ({ status: { code: { major: "OK", minor } }, data });
const NOK = (minor: string, message = "") => ({ status: { code: { major: "NOK", minor }, message }, data: {} });
let clock = new Date("2026-11-10T14:00:00Z");

function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  if (fake.down) return Promise.reject(new Error("connection refused"));
  const ep = url.split("/").pop()!;
  fake.calls.push(ep);
  const form = new URLSearchParams(String(init.body));
  const cookie = (init.headers as Record<string, string>)["Cookie"] ?? "";
  const headers = new Headers({ "content-type": "application/json" });
  const reply = (j: Json) => Promise.resolve(new Response(JSON.stringify(j), { status: 200, headers }));
  if (ep === "check_credentials.json") {
    if (form.get("password") !== fake.password) return reply(NOK("NOT_AUTHENTICATED", "Onjuiste gegevens"));
    fake.cookie = "S" + Math.random().toString(36).slice(2);
    headers.append("set-cookie", `JSESSIONID=${fake.cookie}; Path=/; HttpOnly`);
    return reply(OK({}, "AUTHENTICATED"));
  }
  if (!fake.cookie || !cookie.includes(fake.cookie)) return reply(NOK("NOT_AUTHENTICATED", "Niet ingelogd"));
  for (const a of fake.actions) {
    if (a.state === "STOPPED") continue;
    a.state = a.end <= clock ? "ENDED" : a.start > clock ? "PLANNED" : "ACTIVE";
  }
  const live = fake.actions.filter((a) => a.state === "ACTIVE" || a.state === "PLANNED");
  const cost = (a: { start: Date; end: Date }) => ((a.end.getTime() - a.start.getTime()) / 3.6e6) * fake.rate;
  switch (ep) {
    case "get_categories.json":
      return reply(OK({
        categories: [{
          cty_products: [{
            pdt_id: "RSDBZRG_77$1",
            pdt_is_blocked: "false",
            pdt_parameter_groups: [{ pgp_label: "START", pgp_parameters: [{ prr_label: "LOCATION", prr_default_value: "RSD77" }] }],
          }],
        }],
      }));
    case "get_balance.json":
      return reply(OK({
        balance: {
          ble_parameters: [
            { prr_label: "AMOUNT", prr_value: (fake.balance - live.reduce((s, a) => s + cost(a), 0)).toFixed(2) },
            { prr_label: "CURRENCY_CODE", prr_value: "EUR" },
          ],
        },
      }));
    case "get_category_product_details.json": {
      const plates = new Set([...fake.members.map((m) => m.plate), ...live.map((a) => a.plate)]);
      return reply(OK({
        pdt_members: [...plates].map((plate) => {
          const m = fake.members.find((x) => x.plate === plate);
          return {
            mbr_id: m?.id ?? 999,
            mbr_type: "LPN",
            mbr_identifier: plate,
            mbr_parameters: m ? [{ prr_label: "NICKNAME", prr_value: m.name }] : [],
            mbr_actions: live.filter((a) => a.plate === plate).map((a) => ({
              atn_id: a.id,
              atn_state: a.state,
              atn_parameters: [
                { prr_label: "MBR_IDENT", prr_value: a.plate },
                { prr_label: "TIMESTART", prr_value: fmtLocal(a.start) },
                { prr_label: "TIMEEND", prr_value: fmtLocal(a.end) },
                { prr_label: "AMOUNT", prr_value: cost(a).toFixed(2) },
              ],
            })),
          };
        }),
      }));
    }
    case "start_action.json": {
      const p = Object.fromEntries(
        JSON.parse(form.get("data")!).action.atn_parameters.map((x: Json) => [x.prr_label, x.prr_value]),
      );
      const a = { id: fake.nextId++, plate: p.MBR_IDENT, start: parseLocal(p.TIMESTART)!, end: parseLocal(p.TIMEEND)!, state: "ACTIVE" };
      fake.actions.push(a);
      return reply(OK({ atn_id: a.id }));
    }
    case "extend_action.json": {
      if (fake.extendFails) return reply(NOK("ERROR", fake.extendFails));
      const a = fake.actions.find((x) => String(x.id) === form.get("action_id"))!;
      if (fake.actions.some((x) => x.plate === a.plate && x.state !== "STOPPED" && x.start > a.end && x.start.getTime() - a.end.getTime() < 5000)) {
        return reply(NOK("ERROR", "Deze actie is al verlengd"));
      }
      fake.actions.push({ id: fake.nextId++, plate: a.plate, start: new Date(a.end.getTime() + 1000), end: parseLocal(form.get("VALID_UNTIL")!)!, state: "PLANNED" });
      return reply(OK());
    }
    case "stop_action.json": {
      const a = fake.actions.find((x) => String(x.id) === form.get("action_id"))!;
      a.state = "STOPPED";
      if (fake.stopCascades) for (const x of fake.actions) if (x.plate === a.plate && x.start > a.start) x.state = "STOPPED";
      return reply(OK());
    }
    case "handle_favorite.json": {
      const f = JSON.parse(form.get("data")!).favorite;
      if (f.action === "add") fake.members.push({ id: fake.nextId++, plate: f.mbr_ident, name: f.fav_parameters[0].prr_value });
      else fake.members = fake.members.filter((m) => m.plate !== f.mbr_ident);
      return reply(OK());
    }
  }
  return Promise.resolve(new Response("nope", { status: 404 }));
}

// ---- opslag in het geheugen ----
const cfg = new Map<string, Json>([["cron_secret", "klok"]]);
const secrets = new Map<string, string>();
const sessions = new Map<string, SessionRow>();
const devices: DeviceRow[] = [];
const logs: { kind: string; detail: Json; at: string }[] = [];
const pushes: PushMsg[] = [];
const store: Store = {
  cfgGet: (k) => Promise.resolve(cfg.has(k) ? structuredClone(cfg.get(k)) : null),
  cfgSet: (k, v) => (cfg.set(k, structuredClone(v)), Promise.resolve()),
  secretGet: (n) => Promise.resolve(secrets.get(n) ?? null),
  secretSet: (n, v) => (secrets.set(n, v), Promise.resolve()),
  sessionsActive: () =>
    Promise.resolve([...sessions.values()].filter((s) => s.state === "active").map((s) => {
      // net als de echte database: tijden komen terug als "...+00:00" in plaats van "...000Z"
      const o: Json = { ...s };
      for (const k of ["started_at", "end_at", "max_until", "reminded_for", "reminded1_for", "nudged_at"]) {
        if (o[k]) o[k] = new Date(o[k]).toISOString().replace(".000Z", "+00:00");
      }
      return o;
    })),
  sessionPlate: (id) => Promise.resolve(sessions.get(id)?.plate ?? null),
  sessionUpsert: (row) => {
    const prev = sessions.get(row.action_id);
    if (!prev && !row.plate) return Promise.resolve();
    sessions.set(row.action_id, { ...(prev ?? {}), ...row } as SessionRow);
    return Promise.resolve();
  },
  deviceAdd: (h, l) => (devices.push({ id: "d" + devices.length, token_hash: h, label: l, push: null }), Promise.resolve()),
  deviceByHash: (h) => Promise.resolve(devices.find((d) => d.token_hash === h) ?? null),
  devices: () => Promise.resolve(devices),
  deviceSetPush: (id, p) => (devices.find((d) => d.id === id)!.push = p, Promise.resolve()),
  deviceRemove: (id) => (devices.splice(devices.findIndex((d) => d.id === id), 1), Promise.resolve()),
  log: (kind, detail) => (logs.push({ kind, detail, at: clock.toISOString() }), Promise.resolve()),
  logCount: (kind, since) => Promise.resolve(logs.filter((l) => l.kind === kind && l.at >= since).length),
};
const ctx: Ctx = {
  store,
  fetch: fakeFetch,
  now: () => new Date(clock),
  push: (_s, m) => (pushes.push(m), Promise.resolve("ok")),
  vapidPublicKey: () => Promise.resolve("PUB"),
};
const call = (body: Json) => handle(ctx, body);
const advance = async (min: number) => {
  for (let i = 0; i < min; i++) {
    clock = new Date(clock.getTime() + 60_000);
    const r = await call({ action: "tick", secret: "klok" });
    if (r.status !== 200) throw new Error("tick: " + JSON.stringify(r));
  }
};
const titles = () => pushes.map((p) => p.title);

console.log("\n1. Tijdomrekening");
ok(fmtLocal(new Date("2026-11-10T14:06:00Z")) === "10-11-2026 15:06:00", "wintertijd: 14:06 UTC = 15:06");
ok(fmtLocal(new Date("2026-07-01T12:00:00Z")) === "01-07-2026 14:00:00", "zomertijd: 12:00 UTC = 14:00");
ok(parseLocal("10-11-2026 15:06:00")?.toISOString() === "2026-11-10T14:06:00.000Z", "terug naar UTC (winter)");
ok(parseLocal("01-07-2026 14:00:00")?.toISOString() === "2026-07-01T12:00:00.000Z", "terug naar UTC (zomer)");
ok(parseLocal("25-10-2026 12:00:00")?.toISOString() === "2026-10-25T11:00:00.000Z", "dag van de klokwissel");

console.log("\n2. Inloggen en toegang");
let r = await call({ action: "state", token: "x" });
ok(r.status === 401, "zonder inlog geen toegang");
r = await call({ action: "tick", secret: "fout" });
ok(r.status === 401, "klok alleen met geheim");
r = await call({ action: "login", email: "Youri@Example.nl", password: "fout" });
ok(r.status === 401 && !cfg.has("owner_email"), "fout wachtwoord geweigerd, niets opgeslagen");
r = await call({ action: "login", email: "Youri@Example.nl", password: "geheim", label: "iPhone" });
const token = r.json.token;
ok(r.status === 200 && token?.length === 64, "juiste gegevens geven een apparaat-sleutel");
ok(secrets.get("twopark_password") === "geheim" && !JSON.stringify([...cfg]).includes("geheim"), "wachtwoord alleen in de kluis");
r = await call({ action: "login", email: "iemand@anders.nl", password: "geheim" });
ok(r.status === 403, "ander account kan de app niet overnemen");
devices[0].push = { endpoint: "x" };

console.log("\n3. Overzicht");
r = await call({ action: "state", token });
ok(r.status === 200 && r.json.balance === 10 && r.json.favorites.length === 2, "saldo en favorieten");
ok(r.json.favorites[0].name === "Miki" && r.json.sessions.length === 0, "Miki staat klaar, niets actief");

console.log("\n4. Aanmelden 30 min, herinnering, verlengen, afmelden");
r = await call({ action: "start", token, plate: "h-817-tk", minutes: 30 });
ok(r.status === 200 && r.json.sessions.length === 1, "gestart");
const s1 = r.json.sessions[0];
ok(s1.name === "Miki" && s1.end === "2026-11-10T14:30:00.000Z", "naam en eindtijd kloppen");
ok(Math.abs(s1.cost - 1.02) < 0.001 && Math.abs(r.json.balance - 8.98) < 0.001, "kosten en saldo doorgekomen");
ok(fake.calls.filter((c) => c === "start_action.json").length === 1, "precies één keer gestart");
r = await call({ action: "start", token, plate: "H817TK", minutes: 30 });
ok(r.status === 400, "dubbel aanmelden geblokkeerd");
await advance(24);
ok(pushes.length === 0, "24 min: nog geen melding");
await advance(1);
ok(titles().join() === "Nog 5 min: Miki", "25 min: herinnering 5 min van tevoren");
await advance(2);
ok(pushes.length === 1, "geen dubbele herinnering");
{ const keep = clock; const n0 = pushes.length; /* aparte controle hieronder */ void keep; void n0; }
r = await call({ action: "extend", token, action_id: s1.id, minutes: 10 });
ok(r.json.sessions[0].end === "2026-11-10T14:40:00.000Z", "+10 min verlengd");
await advance(8);
ok(titles().length === 2 && titles()[1] === "Nog 5 min: Miki", "nieuwe herinnering voor de nieuwe eindtijd");
r = await call({ action: "stop", token, action_id: s1.id });
ok(r.status === 200 && r.json.sessions.length === 0, "afgemeld");
await advance(10);
ok(pushes.length === 2, "na afmelden via de app geen 'afgelopen'-melding");

console.log("\n5. Tijd laten verlopen");
pushes.length = 0;
r = await call({ action: "start", token, plate: "AB123C", minutes: 10 });
ok(r.status === 200, "Mam 10 min");
await advance(12);
ok(titles().join("|") === "Nog 5 min: Mam|Nog 1 min: Mam|Mam is afgemeld", "5 min, 1 min en daarna 'is afgemeld'");

console.log("\n5b. Verlengen na de 5-minutenmelding: geen 1-minuutmelding voor de oude tijd, wel beide voor de nieuwe");
pushes.length = 0;
r = await call({ action: "start", token, plate: "AB123C", minutes: 20 });
await advance(16);
r = await call({ action: "extend", token, action_id: r.json.sessions[0].id, minutes: 10 });
await advance(4);
ok(titles().join("|") === "Nog 5 min: Mam", "alleen de eerste melding voor de oude eindtijd");
await advance(9);
ok(titles().join("|") === "Nog 5 min: Mam|Nog 5 min: Mam|Nog 1 min: Mam", "na verlengen opnieuw 5 min en 1 min");
r = await call({ action: "state", token });
await call({ action: "stop", token, action_id: r.json.sessions[0].id });
pushes.length = 0;
r = await call({ action: "start", token, plate: "AB123C", minutes: 2 });
await advance(1);
ok(titles().filter((x) => x.startsWith("Nog ")).join("|") === "Nog 1 min: Mam", "heel korte actie: alleen de 1-minuutmelding");
await advance(3);

console.log("\n6. Eindtijd zelf kiezen + nieuw kenteken als favoriet");
pushes.length = 0;
const endAt = new Date(clock.getTime() + 95 * 60_000).toISOString();
r = await call({ action: "start", token, plate: "XX999X", name: "Loodgieter", end: endAt, save_favorite: true });
ok(r.status === 200 && r.json.sessions[0].end === endAt, "eindtijd overgenomen");
ok(r.json.favorites.some((f: Json) => f.plate === "XX999X" && f.name === "Loodgieter"), "bewaard als favoriet");
r = await call({ action: "stop", token, action_id: r.json.sessions[0].id });
r = await call({ action: "favorite", token, op: "remove", plate: "XX999X" });
ok(!r.json.favorites.some((f: Json) => f.plate === "XX999X"), "favoriet weer verwijderd");

console.log("\n7. Automatisch verlengen met maximum");
pushes.length = 0;
r = await call({ action: "start", token, plate: "H817TK", mode: "auto", block_min: 10, max_hours: 0.5 });
const s2 = r.json.sessions[0];
ok(s2.mode === "auto" && new Date(s2.end).getTime() - clock.getTime() === 600_000, "eerste blok 10 min");
await advance(8);
ok(fake.actions.at(-1)!.end.getTime() - new Date(s2.start).getTime() === 20 * 60_000, "automatisch verlengd naar 20 min (als nieuwe actie erachter)");
ok(pushes.length === 0, "stil verlengd, geen melding");
await advance(10);
ok(fake.actions.at(-1)!.end.getTime() - new Date(s2.start).getTime() === 30 * 60_000, "verlengd tot het maximum (30 min)");
await advance(8);
ok(titles().some((t) => t.startsWith("Nog ") && t.endsWith("Miki")), "bij maximum: herinnering i.p.v. verlengen");
ok(pushes.find((p) => p.title.startsWith("Nog "))!.body.includes("Maximum bereikt"), "melding noemt het maximum");
await advance(6);
ok(fake.actions.at(-1)!.end.getTime() - new Date(s2.start).getTime() === 30 * 60_000, "niet voorbij het maximum verlengd");
ok(titles().at(-1) === "Miki is afgemeld", "daarna afgemeld-melding");

console.log("\n7b. Zoals bij jou: per 10 min verlengen, ruim een uur lang");
pushes.length = 0;
r = await call({ action: "start", token, plate: "H817TK", mode: "auto", block_min: 10, max_hours: 4 });
const s3 = r.json.sessions[0];
const before7b = fake.actions.length;
await advance(65);
r = await call({ action: "state", token });
ok(r.json.sessions.length === 1 && r.json.sessions[0].mode === "auto", "na 65 min nog steeds één aanmelding, nog op automatisch");
ok(fake.actions.length - before7b >= 6, `in die tijd ${fake.actions.length - before7b} keer verlengd`);
ok(new Date(r.json.sessions[0].end).getTime() > clock.getTime(), "eindtijd ligt nog in de toekomst");
ok(r.json.sessions[0].start === s3.start, "begintijd blijft de oorspronkelijke");
ok(Math.abs(r.json.sessions[0].cost - ((new Date(r.json.sessions[0].end).getTime() - new Date(s3.start).getTime()) / 3.6e6) * 2.04) < 0.08, "kosten zijn het totaal van alle stukken");
ok(!titles().some((x) => x.includes("afgemeld") || x.startsWith("Nog ")), "geen valse 'afgemeld'- of afloop-meldingen tussendoor");
ok(titles().filter((x) => x === "Miki staat nog aangemeld").length === 1, "wel het seintje na een uur");
r = await call({ action: "extend", token, action_id: s3.id, plate: "H817TK", minutes: 30 });
ok(r.status === 200, "handmatig verlengen werkt ook met een oud actienummer");
fake.stopCascades = false;
r = await call({ action: "stop", token, action_id: r.json.sessions[0].id, plate: "H817TK" });
ok(r.status === 200 && r.json.sessions.length === 0, "afmelden stopt de hele keten");
ok(!fake.actions.some((a) => a.plate === "H817TK" && (a.state === "ACTIVE" || a.state === "PLANNED")), "bij 2Park loopt er niets meer voor dit kenteken");
fake.stopCascades = true;
await advance(5);
ok(!titles().some((x) => x.includes("afgemeld")), "na zelf afmelden geen melding");
r = await call({ action: "start", token, plate: "AB123C", minutes: 20 });
r = await call({ action: "extend", token, action_id: r.json.sessions[0].id, minutes: -5 });
ok(r.status === 400, "inkorten wordt netjes geweigerd");
r = await call({ action: "state", token });
await call({ action: "stop", token, action_id: r.json.sessions[0].id });

console.log("\n8. 'Staat nog aangemeld'-check en mislukte verlenging");
pushes.length = 0;
r = await call({ action: "start", token, plate: "H817TK", mode: "auto", block_min: 30, max_hours: 4 });
await advance(61);
ok(titles().filter((t) => t === "Miki staat nog aangemeld").length === 1, "na een uur één check-melding");
fake.extendFails = "Onvoldoende saldo";
pushes.length = 0;
await advance(30);
ok(titles().filter((t) => t === "Verlengen mislukt: Miki").length === 1, "mislukte verlenging één keer gemeld");
ok(pushes.find((p) => p.title.startsWith("Verlengen mislukt"))!.body.includes("Onvoldoende saldo"), "met de reden van 2Park erbij");
fake.extendFails = "";
await advance(10);

console.log("\n9. Sessie bij 2Park verlopen, buiten de app gestart, storing");
fake.cookie = "verlopen";
r = await call({ action: "state", token });
ok(r.status === 200, "logt vanzelf opnieuw in");
pushes.length = 0;
fake.actions.push({ id: 900, plate: "ZZ111Z", start: new Date(clock), end: new Date(clock.getTime() + 20 * 60_000), state: "ACTIVE" });
await advance(16);
ok(titles().includes("Nog 5 min: ZZ111Z"), "ook herinnering voor iets dat in 2Park zelf is gestart");
await advance(6);
pushes.length = 0;
r = await call({ action: "start", token, plate: "AB123C", minutes: 10 });
await advance(3);
fake.down = true;
await advance(3);
ok(titles().some((t) => t.includes("Mam")) && pushes[0].body.includes("niet bereikbaar"), "storing bij 2Park: toch een waarschuwing");
r = await call({ action: "state", token });
ok(r.status === 503, "app krijgt nette foutmelding bij storing");
fake.down = false;
await advance(8);

console.log("\n10. Saldo-waarschuwing");
pushes.length = 0;
fake.balance = 1.5;
await advance(11);
ok(titles().filter((t) => t.startsWith("Saldo bijna op")).length === 1, "één waarschuwing onder € 2");
await advance(30);
ok(titles().filter((t) => t.startsWith("Saldo bijna op")).length === 1, "niet herhaald");
fake.balance = 20;
await advance(11);
fake.balance = 1;
await advance(11);
ok(titles().filter((t) => t.startsWith("Saldo bijna op")).length === 2, "na opwaarderen en weer zakken opnieuw");

console.log("\n11. Rustig voor 2Park");
fake.calls.length = 0;
await advance(60);
ok(fake.calls.length <= 14, `zonder bezoek ${fake.calls.length} verzoeken per uur`);
r = await call({ action: "logout", token });
r = await call({ action: "state", token });
ok(r.status === 401, "uitloggen werkt");

const crashes = logs.filter((l) => l.kind === "crash");
ok(crashes.length === 0, "geen onverwachte fouten in het logboek");
if (crashes.length) console.log(crashes);
console.log(failures ? `\n${failures} test(s) mislukt` : "\nAlles geslaagd");
Deno.exit(failures ? 1 : 0);
