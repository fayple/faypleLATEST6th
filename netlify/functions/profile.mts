// Member profiles (shown on posts, in tickets and in the profile card).
// Members who never edited their profile simply show their Discord name and
// avatar. Avatars uploaded here live in the "profile-avatars" Blobs store.
//
// Routes:
//   GET    /api/profile/me              → own profile (syncs Discord data)
//   PUT    /api/profile/me {nickname?, bio?, resetAvatar?, resetNickname?}
//   POST   /api/profile/me/avatar       → raw image body (PNG/JPG/GIF/WEBP, ≤5MB)
//   GET    /api/profile/:id             → public profile
//   GET    /api/profile/:id/avatar      → uploaded avatar image
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { profiles } from "../../db/schema.js";
import { getSession, getProfileRow, readImageUpload, syncProfile, toPublic } from "../../lib/shared.js";

const AVATAR_STORE = "profile-avatars";
const NICKNAME_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_NICKNAME_LENGTH = 32;
const MAX_BIO_LENGTH = 190;

const json = (data: unknown, status = 200) => Response.json(data, { status });

const nextNicknameAt = (row: { nicknameChangedAt: Date | null }) =>
  row.nicknameChangedAt ? row.nicknameChangedAt.getTime() + NICKNAME_COOLDOWN_MS : 0;

const meResponse = (row: Parameters<typeof toPublic>[0]) =>
  json({ profile: toPublic(row), nicknameOverride: row.displayName || "", nextNicknameChangeAt: nextNicknameAt(row) });

export default async (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/profile\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);

  if (parts[0] === "me") {
    const session = await getSession(req);
    if (!session) return json({ error: "Please sign in again" }, 401);
    const row = await syncProfile(session);

    if (parts.length === 1 && req.method === "GET") return meResponse(row);

    if (parts.length === 1 && req.method === "PUT") {
      const body = await req.json().catch(() => ({}));
      const changes: Partial<typeof profiles.$inferInsert> = {};

      if (body.nickname !== undefined || body.resetNickname) {
        const nickname = body.resetNickname ? "" : String(body.nickname || "").trim().replace(/\s+/g, " ");
        if (nickname.length > MAX_NICKNAME_LENGTH) return json({ error: `Nickname can be at most ${MAX_NICKNAME_LENGTH} characters` }, 400);
        const next = nickname && nickname !== row.discordName ? nickname : null;
        if (next !== (row.displayName || null)) {
          const wait = nextNicknameAt(row) - Date.now();
          if (wait > 0) return json({ error: "You can only change your nickname once every 24 hours", retryAfterMs: wait }, 429);
          changes.displayName = next;
          changes.nicknameChangedAt = new Date();
        }
      }

      if (body.bio !== undefined) {
        const bio = String(body.bio || "").trim().replace(/\n{3,}/g, "\n\n");
        if (bio.length > MAX_BIO_LENGTH) return json({ error: `Description can be at most ${MAX_BIO_LENGTH} characters` }, 400);
        changes.bio = bio || null;
      }

      if (body.resetAvatar && row.avatarKey) {
        await getStore(AVATAR_STORE).delete(row.discordId);
        changes.avatarKey = null;
      }

      if (!Object.keys(changes).length) return meResponse(row);
      const [updated] = await db
        .update(profiles)
        .set({ ...changes, updatedAt: new Date() })
        .where(eq(profiles.discordId, row.discordId))
        .returning();
      return meResponse(updated);
    }

    if (parts[1] === "avatar" && req.method === "POST") {
      const upload = await readImageUpload(req);
      if ("error" in upload) return json({ error: upload.error }, upload.status);
      await getStore(AVATAR_STORE).set(row.discordId, upload.bytes, { metadata: { type: upload.type } });
      const [updated] = await db
        .update(profiles)
        .set({ avatarKey: Date.now().toString(36), updatedAt: new Date() })
        .where(eq(profiles.discordId, row.discordId))
        .returning();
      return meResponse(updated);
    }

    return json({ error: "Not found" }, 404);
  }

  const id = parts[0];
  if (!id || !/^\d{5,25}$/.test(id) || req.method !== "GET") return json({ error: "Not found" }, 404);

  if (parts[1] === "avatar") {
    const blob = await getStore(AVATAR_STORE).getWithMetadata(id, { type: "arrayBuffer" });
    if (!blob) return new Response("Not found", { status: 404 });
    return new Response(blob.data, {
      headers: {
        "Content-Type": String(blob.metadata?.type || "application/octet-stream"),
        // Avatar URLs carry a ?v= version that changes on every upload.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (parts.length === 1) {
    const row = await getProfileRow(id);
    if (!row) return json({ error: "Profile not found" }, 404);
    return json({ profile: toPublic(row) });
  }

  return json({ error: "Not found" }, 404);
};

export const config: Config = {
  path: ["/api/profile/*"],
};
