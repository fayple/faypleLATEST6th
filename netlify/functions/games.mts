// Download Games: Roblox game search + admin-published game files.
//
// Routes:
//   GET    /api/games/search?q=…            → smart search (typo tolerant, link / ID aware)
//   GET    /api/games/suggest?q=…           → live suggestions (query ideas + a few games)
//   GET    /api/games/catalog               → games that have a published file (newest first)
//   GET    /api/games/:universeId           → game details + file info (if any)
//   POST   /api/games/:universeId/upload-url (admin) {filename,size} → Supabase signed upload slot
//   POST   /api/games/:universeId/publish    (admin) {path,origName}  → publish / replace the file
//   DELETE /api/games/:universeId/file       (admin)                  → remove the file
//
// Roblox's public APIs don't allow browser (CORS) calls, so search is proxied
// through here. File metadata lives in the "game-files" Blobs store; the file
// itself goes to the same Supabase bucket the Files tab uses (prefix "games/").
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { createClient } from "@supabase/supabase-js";
import { getSession, isAdminId } from "../../lib/shared.js";
import { norm, relevance } from "../../lib/game-search.js";

const STORE = "game-files";
const BUCKET = "fayple-files";
const MAX_FILE_BYTES = 45 * 1024 * 1024; // same cap as the Files tab
const ALLOWED_EXT = ["rbxl", "rbxlx", "rbxm", "rbxmx", "zip", "rar", "7z"];
const MAX_RESULTS = 30;

const json = (data: unknown, status = 200, cache = "no-store") =>
  Response.json(data, { status, headers: { "Cache-Control": cache } });

/* ───────────────────────────── Roblox helpers ───────────────────────────── */

type Game = {
  universeId: string;
  rootPlaceId: string | null;
  name: string;
  creator: string;
  creatorVerified: boolean;
  playing: number;
  up?: number;
  down?: number;
};

const RBX_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; FaypleStudios/1.0)", Accept: "application/json" };

async function rbx(url: string, timeoutMs = 6000): Promise<any | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: RBX_HEADERS, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function omniSearch(q: string): Promise<Game[]> {
  const data = await rbx(
    `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(q)}&pageToken=&sessionId=${crypto.randomUUID()}&pageType=all`,
  );
  const out: Game[] = [];
  if (data && Array.isArray(data.searchResults)) {
    for (const group of data.searchResults) {
      for (const c of group.contents || []) {
        if ((c.contentType && c.contentType !== "Game") || !c.universeId || !c.name) continue;
        out.push({
          universeId: String(c.universeId),
          rootPlaceId: c.rootPlaceId ? String(c.rootPlaceId) : null,
          name: String(c.name),
          creator: String(c.creatorName || ""),
          creatorVerified: !!c.creatorHasVerifiedBadge,
          playing: Number(c.playerCount) || 0,
          up: Number(c.totalUpVotes) || 0,
          down: Number(c.totalDownVotes) || 0,
        });
      }
    }
  }
  if (out.length) return out;

  // Fallback: the older keyword endpoint.
  const old = await rbx(`https://games.roblox.com/v1/games/list?model.keyword=${encodeURIComponent(q)}&model.maxRows=30`);
  for (const g of old?.games || []) {
    if (!g.universeId || !g.name) continue;
    out.push({
      universeId: String(g.universeId),
      rootPlaceId: g.placeId ? String(g.placeId) : null,
      name: String(g.name),
      creator: String(g.creatorName || ""),
      creatorVerified: !!g.creatorHasVerifiedBadge,
      playing: Number(g.playerCount) || 0,
      up: Number(g.totalUpVotes) || 0,
      down: Number(g.totalDownVotes) || 0,
    });
  }
  return out;
}

async function autocomplete(q: string): Promise<string[]> {
  const data = await rbx(`https://apis.roblox.com/games-autocomplete/v1/get-suggestion/${encodeURIComponent(q)}`, 3500);
  const list: string[] = [];
  for (const e of data?.entries || []) if (e?.searchQuery) list.push(String(e.searchQuery));
  return list;
}

async function gameDetails(ids: string[]): Promise<Record<string, any>> {
  if (!ids.length) return {};
  const data = await rbx(`https://games.roblox.com/v1/games?universeIds=${ids.join(",")}`);
  const map: Record<string, any> = {};
  for (const g of data?.data || []) map[String(g.id)] = g;
  return map;
}

async function gameVotes(id: string): Promise<{ up: number; down: number } | null> {
  const data = await rbx(`https://games.roblox.com/v1/games/votes?universeIds=${id}`);
  const v = data?.data?.[0];
  return v ? { up: Number(v.upVotes) || 0, down: Number(v.downVotes) || 0 } : null;
}

async function gameIcons(ids: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  if (!ids.length) return map;
  const data = await rbx(
    `https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids.join(",")}&returnPolicy=PlaceHolder&size=256x256&format=Png&isCircular=false`,
  );
  for (const d of data?.data || []) if (d?.imageUrl) map[String(d.targetId)] = String(d.imageUrl);
  return map;
}

async function gameBanner(id: string): Promise<string | null> {
  const data = await rbx(
    `https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${id}&countPerUniverse=1&defaults=true&size=768x432&format=Png&isCircular=false`,
  );
  return data?.data?.[0]?.thumbnails?.[0]?.imageUrl || null;
}

/** Roblox link or bare ID → universe id (place ids are converted). */
function parseDirectId(q: string): string | null {
  const m = q.match(/roblox\.com\/(?:[a-z-]+\/)?games\/(\d+)/i);
  if (m) return m[1];
  return /^\d{5,19}$/.test(q.trim()) ? q.trim() : null;
}

async function resolveUniverse(id: string): Promise<string> {
  const r = await rbx(`https://apis.roblox.com/universes/v1/places/${id}/universe`, 4000);
  return r?.universeId ? String(r.universeId) : id;
}

/* ─────────────────────────── file catalog (Blobs) ─────────────────────────── */

type CatalogEntry = { universeId: string; rootPlaceId: string | null; name: string; creator: string; ts: number };
type GameFile = { path: string; publicUrl: string; origName: string; size: number; ts: number; byName: string };
type GameRecord = { universeId: string; rootPlaceId: string | null; name: string; creator: string; file: GameFile };

const store = () => getStore(STORE);

async function readIndex(): Promise<CatalogEntry[]> {
  try {
    const idx = (await store().get("index", { type: "json" })) as { items?: CatalogEntry[] } | null;
    return Array.isArray(idx?.items) ? idx!.items : [];
  } catch {
    return [];
  }
}

const writeIndex = (items: CatalogEntry[]) => store().setJSON("index", { items });

const publicFile = (f: GameFile) => ({ publicUrl: f.publicUrl, origName: f.origName, size: f.size, ts: f.ts });

/* ───────────────────────────────── search ───────────────────────────────── */

type Result = Game & { icon?: string; hasFile: boolean; updatedAt: number | null; score: number };

function mergeGames(lists: Game[][]): Game[] {
  const seen = new Set<string>();
  const out: Game[] = [];
  for (const list of lists) {
    for (const g of list) {
      if (seen.has(g.universeId)) continue;
      seen.add(g.universeId);
      out.push(g);
    }
  }
  return out;
}

async function decorate(q: string, games: Game[], index: CatalogEntry[]): Promise<Result[]> {
  const files = new Map(index.map((e) => [e.universeId, e]));
  const scored = games.map((g, i) => {
    const rel = relevance(q, g.name);
    const pop = Math.min(15, Math.log10(g.playing + 1) * 3);
    const rank = Math.max(0, 12 - i * 0.6);
    const file = files.get(g.universeId);
    return { g, file, score: rel + pop + rank + (file ? 12 : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MAX_RESULTS);
  const icons = await gameIcons(top.map((t) => t.g.universeId));
  return top.map(({ g, file, score }) => ({
    ...g,
    icon: icons[g.universeId],
    hasFile: !!file,
    updatedAt: file ? file.ts : null,
    score: Math.round(score),
  }));
}

function catalogAsGames(index: CatalogEntry[], q: string, min: number): Game[] {
  return index
    .map((e) => ({ e, r: relevance(q, e.name) }))
    .filter((x) => x.r >= min)
    .sort((a, b) => b.r - a.r)
    .map(({ e }) => ({
      universeId: e.universeId,
      rootPlaceId: e.rootPlaceId,
      name: e.name,
      creator: e.creator,
      creatorVerified: false,
      playing: 0,
    }));
}

async function smartSearch(q: string) {
  const index = await readIndex();

  const direct = parseDirectId(q);
  if (direct) {
    const universeId = await resolveUniverse(direct);
    const d = (await gameDetails([universeId]))[universeId];
    if (d) {
      const g: Game = {
        universeId,
        rootPlaceId: d.rootPlaceId ? String(d.rootPlaceId) : null,
        name: String(d.name),
        creator: String(d.creator?.name || ""),
        creatorVerified: !!d.creator?.hasVerifiedBadge,
        playing: Number(d.playing) || 0,
      };
      return { results: await decorate(q, [g], index), suggestions: [] as string[], didYouMean: null as string | null };
    }
  }

  const [primary, ac] = await Promise.all([omniSearch(q), autocomplete(q)]);
  const local = catalogAsGames(index, q, 45);
  let games = mergeGames([local.slice(0, 5), primary, local]);

  const best = Math.max(0, ...games.map((g) => relevance(q, g.name)));
  const nq = norm(q);
  let didYouMean: string | null = null;

  // Weak result set → also run the closest alternatives (Roblox suggestions and
  // look-alike catalog titles) so a typo still lands on the right game.
  if (games.length < 8 || best < 60) {
    const alts: string[] = [];
    for (const s of ac) if (norm(s) !== nq && !alts.includes(s)) alts.push(s);
    const near = catalogAsGames(index, q, 55)[0];
    if (near && norm(near.name) !== nq) alts.unshift(near.name);
    const extra = alts.slice(0, 2);
    if (extra.length) {
      const lists = await Promise.all(extra.map(omniSearch));
      games = mergeGames([games, ...lists]);
      if (best < 60) didYouMean = extra[0];
    }
  }

  const results = await decorate(q, games, index);
  const suggestions = ac.filter((s) => norm(s) !== nq).slice(0, 5);
  return { results, suggestions, didYouMean };
}

async function suggest(q: string) {
  const index = await readIndex();
  const [games, ac] = await Promise.all([omniSearch(q), autocomplete(q)]);
  const local = catalogAsGames(index, q, 50);
  const merged = await decorate(q, mergeGames([local.slice(0, 3), games]), index);
  const nq = norm(q);
  const queries = [...new Set([...ac, ...local.map((g) => g.name)])].filter((s) => norm(s) !== nq).slice(0, 5);
  return {
    queries,
    games: merged.slice(0, 5).map((g) => ({
      universeId: g.universeId,
      name: g.name,
      creator: g.creator,
      icon: g.icon,
      hasFile: g.hasFile,
    })),
  };
}

/* ───────────────────────────── admin: file publishing ───────────────────────────── */

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key) : null;
}

async function requireAdmin(req: Request) {
  const session = await getSession(req);
  if (!session || !isAdminId(session.id)) return null;
  return session;
}

const safeName = (s: string) => String(s || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
const extOf = (s: string) => (String(s).split(".").pop() || "").toLowerCase();

async function removeObject(sb: NonNullable<ReturnType<typeof supabase>>, path: string) {
  try {
    await sb.storage.from(BUCKET).remove([path]);
  } catch {
    /* best effort */
  }
}

/* ───────────────────────────────── router ───────────────────────────────── */

export default async (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/games\/?/, "").split("/").filter(Boolean);
  const [a, b] = parts;

  try {
    if (req.method === "GET" && a === "search") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
      if (!q) return json({ results: [], suggestions: [], didYouMean: null });
      return json({ query: q, ...(await smartSearch(q)) }, 200, "public, max-age=60");
    }

    if (req.method === "GET" && a === "suggest") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
      if (q.length < 2) return json({ queries: [], games: [] });
      return json(await suggest(q), 200, "public, max-age=30");
    }

    if (req.method === "GET" && a === "catalog") {
      const items = (await readIndex()).slice().sort((x, y) => y.ts - x.ts).slice(0, 60);
      const icons = await gameIcons(items.map((i) => i.universeId));
      return json({ items: items.map((i) => ({ ...i, icon: icons[i.universeId], hasFile: true, updatedAt: i.ts })) });
    }

    if (a && /^\d{1,20}$/.test(a)) {
      const id = a;

      if (req.method === "GET" && !b) {
        const [details, votes, icons, banner, rec] = await Promise.all([
          gameDetails([id]),
          gameVotes(id),
          gameIcons([id]),
          gameBanner(id),
          store().get(`game:${id}`, { type: "json" }).catch(() => null) as Promise<GameRecord | null>,
        ]);
        const d = details[id];
        if (!d && !rec) return json({ error: "Game not found" }, 404);
        const game = {
          universeId: id,
          rootPlaceId: d?.rootPlaceId ? String(d.rootPlaceId) : rec?.rootPlaceId || null,
          name: String(d?.name || rec?.name || "Unknown game"),
          description: String(d?.description || ""),
          creator: String(d?.creator?.name || rec?.creator || ""),
          creatorVerified: !!d?.creator?.hasVerifiedBadge,
          playing: Number(d?.playing) || 0,
          visits: Number(d?.visits) || 0,
          maxPlayers: Number(d?.maxPlayers) || 0,
          genre: d?.genre && d.genre !== "All" ? String(d.genre) : "",
          robloxUpdated: d?.updated || null,
          up: votes?.up ?? 0,
          down: votes?.down ?? 0,
          icon: icons[id] || null,
          banner,
        };
        return json({ game, file: rec?.file ? publicFile(rec.file) : null });
      }

      if (req.method === "POST" && b === "upload-url") {
        if (!(await requireAdmin(req))) return json({ error: "Unauthorized" }, 401);
        const body = (await req.json().catch(() => ({}))) as { filename?: string; size?: number };
        const filename = safeName(body.filename || "");
        if (!ALLOWED_EXT.includes(extOf(filename))) return json({ error: `Allowed file types: ${ALLOWED_EXT.join(", ")}` }, 400);
        if (Number(body.size) > MAX_FILE_BYTES) return json({ error: "File too large (max ~45MB)" }, 413);
        const sb = supabase();
        if (!sb) return json({ error: "Supabase is not configured on the server yet" }, 500);
        const path = `games/${id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename}`;
        const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
        if (error || !data) return json({ error: error?.message || "Could not create upload slot" }, 500);
        return json({ path: data.path, token: data.token, signedUrl: data.signedUrl });
      }

      if (req.method === "POST" && b === "publish") {
        const session = await requireAdmin(req);
        if (!session) return json({ error: "Unauthorized" }, 401);
        const body = (await req.json().catch(() => ({}))) as { path?: string; origName?: string };
        const path = String(body.path || "");
        const dir = `games/${id}`;
        if (!path.startsWith(dir + "/") || path.includes("..")) return json({ error: "Bad file path" }, 400);
        const sb = supabase();
        if (!sb) return json({ error: "Supabase is not configured on the server yet" }, 500);

        const fileName = path.slice(dir.length + 1);
        const { data: listed, error: listErr } = await sb.storage.from(BUCKET).list(dir, { limit: 100, search: fileName });
        const obj = listed?.find((o) => o.name === fileName);
        if (listErr || !obj) return json({ error: "Upload not found — please try again" }, 400);
        const size = Number((obj.metadata as any)?.size) || 0;
        if (size > MAX_FILE_BYTES) {
          await removeObject(sb, path);
          return json({ error: "File too large (max ~45MB)" }, 413);
        }

        const prev = (await store().get(`game:${id}`, { type: "json" }).catch(() => null)) as GameRecord | null;
        const d = (await gameDetails([id]))[id];
        if (!d && !prev) {
          await removeObject(sb, path);
          return json({ error: "That game doesn't exist on Roblox" }, 404);
        }

        const record: GameRecord = {
          universeId: id,
          rootPlaceId: d?.rootPlaceId ? String(d.rootPlaceId) : prev?.rootPlaceId || null,
          name: String(d?.name || prev?.name || "Unknown game"),
          creator: String(d?.creator?.name || prev?.creator || ""),
          file: {
            path,
            publicUrl: sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl,
            origName: safeName(body.origName || fileName),
            size,
            ts: Date.now(),
            byName: session.discordName,
          },
        };
        await store().setJSON(`game:${id}`, record);
        const index = (await readIndex()).filter((e) => e.universeId !== id);
        index.push({ universeId: id, rootPlaceId: record.rootPlaceId, name: record.name, creator: record.creator, ts: record.file.ts });
        await writeIndex(index);
        if (prev?.file?.path && prev.file.path !== path) await removeObject(sb, prev.file.path);
        return json({ game: { universeId: id, name: record.name }, file: publicFile(record.file) });
      }

      if (req.method === "DELETE" && b === "file") {
        if (!(await requireAdmin(req))) return json({ error: "Unauthorized" }, 401);
        const rec = (await store().get(`game:${id}`, { type: "json" }).catch(() => null)) as GameRecord | null;
        if (rec?.file?.path) {
          const sb = supabase();
          if (sb) await removeObject(sb, rec.file.path);
        }
        await store().delete(`game:${id}`);
        await writeIndex((await readIndex()).filter((e) => e.universeId !== id));
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error("games function error", e);
    return json({ error: "Something went wrong" }, 500);
  }
};

export const config: Config = {
  path: ["/api/games", "/api/games/*"],
};
