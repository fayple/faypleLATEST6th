// Helpers shared by the profile and ticket functions: Discord session lookup,
// admin check, profile resolution and image validation.
import { getStore } from "@netlify/blobs";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { profiles } from "../db/schema.js";

export const SESSIONS_STORE = "sessions_v2";
// The only Discord account with admin powers (Admin Panel, publishing,
// support-team access to every ticket). Checked on every request, so changing
// it here immediately revokes admin from anyone else, even mid-session.
export const ADMIN_DISCORD_IDS = ["1122944588232011796"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const isAdminId = (id: string) => ADMIN_DISCORD_IDS.includes(String(id));

export type Session = { id: string; discordName: string; discordAvatar: string | null };

export async function getSession(req: Request): Promise<Session | null> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const session: any = await getStore(SESSIONS_STORE).get(auth.slice(7), { type: "json" }).catch(() => null);
  if (!session || session.expiresAt < Date.now() || !session.discord?.id) return null;
  return {
    id: String(session.discord.id),
    discordName: session.discord.username || "User",
    discordAvatar: session.discord.avatar || null,
  };
}

export type ProfileRow = typeof profiles.$inferSelect;

export type PublicProfile = {
  id: string;
  name: string;
  discordName: string;
  avatar: string | null;
  discordAvatar: string | null;
  bio: string;
  isAdmin: boolean;
  customized: boolean;
};

// Anything the member hasn't customised falls back to their Discord account.
export function toPublic(row: ProfileRow): PublicProfile {
  return {
    id: row.discordId,
    name: row.displayName || row.discordName,
    discordName: row.discordName,
    avatar: row.avatarKey
      ? `/api/profile/${encodeURIComponent(row.discordId)}/avatar?v=${encodeURIComponent(row.avatarKey)}`
      : row.discordAvatar,
    discordAvatar: row.discordAvatar,
    bio: row.bio || "",
    isAdmin: isAdminId(row.discordId),
    customized: !!(row.displayName || row.bio || row.avatarKey),
  };
}

// Keeps the stored Discord name/avatar in sync with the latest login and
// returns the member's profile row (creating it on first visit).
export async function syncProfile(session: Session): Promise<ProfileRow> {
  const [row] = await db
    .insert(profiles)
    .values({ discordId: session.id, discordName: session.discordName, discordAvatar: session.discordAvatar })
    .onConflictDoUpdate({
      target: profiles.discordId,
      set: { discordName: session.discordName, discordAvatar: session.discordAvatar },
    })
    .returning();
  return row;
}

export async function getProfileRow(id: string) {
  const [row] = await db.select().from(profiles).where(eq(profiles.discordId, id));
  return row || null;
}

export async function getProfileRows(ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(profiles).where(inArray(profiles.discordId, ids));
}

// Detects the real image type from the file's first bytes, so a renamed
// HTML/SVG file can never be served back as an "image".
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

// Reads a raw image upload body, enforcing the size cap and allowed formats.
export async function readImageUpload(req: Request): Promise<{ bytes: Uint8Array; type: string } | { error: string; status: number }> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_IMAGE_BYTES) return { error: "Image is too large (max 5MB)", status: 413 };
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return { error: "No image received", status: 400 };
  if (bytes.length > MAX_IMAGE_BYTES) return { error: "Image is too large (max 5MB)", status: 413 };
  const type = sniffImageType(bytes);
  if (!type) return { error: "Only PNG, JPG, GIF or WEBP images are allowed", status: 415 };
  return { bytes, type };
}
