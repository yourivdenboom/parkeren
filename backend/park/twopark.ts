// Dunne client voor de (onofficiële) webkoppeling van mijn.2park.nl.
import { fmtLocal, parseLocal } from "./time.ts";

const BASE = "https://mijn.2park.nl";
const API = "/gsmpark-app-www/json";
const LOCALE = "nl_NL";

export class ParkError extends Error {
  kind: "auth" | "provider" | "network";
  constructor(kind: "auth" | "provider" | "network", message: string) {
    super(message);
    this.kind = kind;
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
// deno-lint-ignore no-explicit-any
type Json = any;

export interface Action {
  id: string;
  plate: string;
  name: string | null;
  start: Date;
  end: Date;
  state: string;
  cost: number | null;
}
export interface Favorite {
  plate: string;
  name: string | null;
}
export interface Snapshot {
  balance: number | null;
  currency: string | null;
  favorites: Favorite[];
  actions: Action[];
}

export const normPlate = (p: string) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const plist = (arr: Json): Record<string, string> => {
  const out: Record<string, string> = {};
  if (Array.isArray(arr)) {
    for (const p of arr) if (p && typeof p.prr_label === "string") out[p.prr_label] = p.prr_value;
  }
  return out;
};

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function findCost(action: Json, params: Record<string, string>): number | null {
  const want = /AMOUNT|COST|PRICE|TOTAL/i;
  for (const [k, v] of Object.entries(params)) {
    if (want.test(k) && !/CURRENCY/i.test(k)) {
      const n = toNum(v);
      if (n !== null) return n;
    }
  }
  for (const [k, v] of Object.entries(action ?? {})) {
    if (want.test(k) && typeof v !== "object") {
      const n = toNum(v);
      if (n !== null) return n;
    }
  }
  return null;
}

export interface Creds {
  email: string;
  password: string;
}
export interface SessionState {
  cookies: Record<string, string>;
  product_id: string | null;
  location: string | null;
}

export class TwoPark {
  dirty = false; // sessie-gegevens gewijzigd -> opslaan
  constructor(private fetchFn: FetchFn, private creds: Creds, public s: SessionState) {}

  private async post(endpoint: string, form: Record<string, string>): Promise<Json> {
    const cookie = Object.entries(this.s.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    let res: Response;
    try {
      res = await this.fetchFn(`${BASE}${API}/${endpoint}`, {
        method: "POST",
        headers: {
          "Accept": "application/json, */*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Origin": BASE,
          "Referer": `${BASE}/`,
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
          ...(cookie ? { "Cookie": cookie } : {}),
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new ParkError("network", `2Park is niet bereikbaar (${(e as Error).message})`);
    }
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookies) {
      const m = c.match(/^([^=;\s]+)=([^;]*)/);
      if (m) {
        this.s.cookies[m[1]] = m[2];
        this.dirty = true;
      }
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new ParkError("auth", "Niet ingelogd bij 2Park");
    if (!res.ok) throw new ParkError("provider", `2Park gaf fout ${res.status}`);
    try {
      return JSON.parse(text);
    } catch {
      // een HTML-pagina i.p.v. JSON betekent meestal: sessie verlopen
      throw new ParkError("auth", "2Park gaf geen geldig antwoord (sessie verlopen?)");
    }
  }

  private static check(data: Json, what: string): void {
    const st = data?.status ?? {};
    if (st?.code?.major === "OK") return;
    const minor = String(st?.code?.minor ?? "");
    const msg = String(st?.message ?? "").trim();
    const authish = /AUTH|LOGIN|SESSION|CREDENTIAL|PERMISSION/i.test(minor + " " + msg);
    throw new ParkError(authish ? "auth" : "provider", msg || minor || `${what} mislukt`);
  }

  async login(): Promise<void> {
    this.s.cookies = {};
    const data = await this.post("check_credentials.json", {
      email: this.creds.email,
      password: this.creds.password,
      locale: LOCALE,
    });
    if (data?.status?.code?.major !== "OK") {
      throw new ParkError("auth", "Inloggen bij 2Park mislukt: controleer e-mail en wachtwoord");
    }
    this.dirty = true;
    if (!this.s.product_id || !this.s.location) await this.detectProduct();
  }

  private async detectProduct(): Promise<void> {
    const data = await this.post("get_categories.json", { locale: LOCALE });
    TwoPark.check(data, "Producten ophalen");
    const all: Json[] = [];
    for (const c of data?.data?.categories ?? []) for (const p of c?.cty_products ?? []) all.push(p);
    all.sort((a, b) =>
      Number(String(a?.pdt_is_blocked).toLowerCase() !== "false") -
      Number(String(b?.pdt_is_blocked).toLowerCase() !== "false")
    );
    const best = all[0];
    if (!best?.pdt_id) throw new ParkError("provider", "Geen bezoekersregeling gevonden op dit 2Park-account");
    this.s.product_id = String(best.pdt_id);
    let loc: string | null = null;
    for (const g of best.pdt_parameter_groups ?? []) {
      if (g?.pgp_label !== "START") continue;
      for (const p of g.pgp_parameters ?? []) {
        if (p?.prr_label === "LOCATION") loc = p.prr_value || p.prr_default_value || loc;
      }
    }
    if (!loc) {
      const m = this.s.product_id.match(/^([A-Z]{3})\w+_(\d+)\$/);
      if (m) loc = `${m[1]}${m[2]}`;
    }
    this.s.location = loc;
    this.dirty = true;
  }

  /** Leesactie met automatisch opnieuw inloggen. */
  private async read(endpoint: string, what: string): Promise<Json> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!this.s.product_id || Object.keys(this.s.cookies).length === 0) await this.login();
        const data = await this.post(endpoint, { product_id: this.s.product_id ?? "", locale: LOCALE });
        TwoPark.check(data, what);
        return data;
      } catch (e) {
        if (attempt === 0 && e instanceof ParkError && e.kind !== "network") {
          await this.login();
          continue;
        }
        throw e;
      }
    }
    throw new ParkError("provider", `${what} mislukt`);
  }

  rawDetails: Json = null;

  async snapshot(): Promise<Snapshot> {
    const details = await this.read("get_category_product_details.json", "Parkeeracties ophalen");
    this.rawDetails = details;
    let balance: number | null = null;
    let currency: string | null = null;
    try {
      const b = await this.read("get_balance.json", "Saldo ophalen");
      const bp = plist(b?.data?.balance?.ble_parameters);
      balance = toNum(bp.AMOUNT);
      currency = bp.CURRENCY_CODE ?? bp.CURRENCY_DESC ?? null;
    } catch (e) {
      if (e instanceof ParkError && e.kind === "network") throw e;
    }
    const favorites: Favorite[] = [];
    const actions: Action[] = [];
    for (const m of details?.data?.pdt_members ?? []) {
      if (!m || (m.mbr_type && m.mbr_type !== "LPN")) continue;
      const plate = normPlate(m.mbr_identifier);
      const name = plist(m.mbr_parameters).NICKNAME || null;
      if (plate) favorites.push({ plate, name });
      for (const a of m.mbr_actions ?? []) {
        const p = plist(a?.atn_parameters);
        const start = parseLocal(p.TIMESTART);
        const end = parseLocal(p.TIMEEND);
        const id = a?.atn_id != null ? String(a.atn_id) : "";
        if (!id || !start || !end) continue;
        actions.push({
          id,
          plate: normPlate(p.MBR_IDENT || plate),
          name,
          start,
          end,
          state: String(a.atn_state ?? ""),
          cost: findCost(a, p),
        });
      }
    }
    return { balance, currency, favorites, actions };
  }

  /** Schrijfactie: precies één poging, zodat er nooit dubbel wordt gestart. */
  private async write(endpoint: string, form: Record<string, string>, what: string): Promise<Json> {
    const data = await this.post(endpoint, { ...form, product_id: this.s.product_id ?? "", locale: LOCALE });
    TwoPark.check(data, what);
    return data;
  }

  async start(plate: string, start: Date, end: Date): Promise<string | null> {
    if (!this.s.location) throw new ParkError("provider", "Geen parkeerzone bekend voor dit account");
    const payload = {
      action: {
        atn_parameters: [
          { prr_label: "MBR_IDENT", prr_value: normPlate(plate) },
          { prr_label: "TIMESTART", prr_value: fmtLocal(start) },
          { prr_label: "TIMEEND", prr_value: fmtLocal(end) },
          { prr_label: "LOCATION", prr_value: this.s.location },
        ],
      },
    };
    const data = await this.write("start_action.json", { data: JSON.stringify(payload) }, "Aanmelden");
    const id = data?.data?.atn_id ?? data?.data?.action?.atn_id;
    return id != null ? String(id) : null;
  }

  async extend(actionId: string, until: Date): Promise<void> {
    await this.write("extend_action.json", { action_id: actionId, VALID_UNTIL: fmtLocal(until) }, "Verlengen");
  }

  async stop(actionId: string): Promise<void> {
    await this.write("stop_action.json", { action_id: actionId }, "Afmelden");
  }

  async favorite(action: "add" | "remove", plate: string, name: string): Promise<void> {
    const payload = {
      favorite: {
        fav_parameters: [{ prr_label: "NICKNAME", prr_value: name }],
        action,
        mbr_ident: normPlate(plate),
      },
    };
    await this.write("handle_favorite.json", { data: JSON.stringify(payload) }, "Favoriet opslaan");
  }
}
