// Support tickets: private chats between one member and the support team.
// A ticket is visible only to the member who opened it and to admins
// (Discord IDs listed in ADMIN_DISCORD_IDS in lib/shared.ts — the same people who get the
// Admin Panel). Sessions come from the existing Discord login (Blobs store
// "sessions_v2", see discord-callback.js); ticket data lives in Netlify Database.
//
// Routes:
//   GET    /api/tickets                    → list tickets (own, or all for admins)
//   POST   /api/tickets          {reason}  → open a ticket (reason must be 1–5 words)
//   GET    /api/tickets/:id?after=<msgId>  → ticket + messages newer than <msgId>
//   POST   /api/tickets/:id/messages {body}→ send a message
//   POST   /api/tickets/:id/images?caption=… → send an image (raw body, ≤5MB)
//   GET    /api/tickets/:id/images/:msgId  → image bytes (same access rules)
//   POST   /api/tickets/:id/close          → close the ticket
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tickets, ticketMessages } from "../../db/schema.js";
import { getSession, isAdminId, readImageUpload, syncProfile, toPublic } from "../../lib/shared.js";

const MEDIA_STORE = "ticket-media";
const MAX_MESSAGE_LENGTH = 2000;
const MAX_REASON_LENGTH = 80;

type Viewer = { id: string; name: string; avatar: string | null; isAdmin: boolean };

// Names/avatars come from the member's site profile (Edit Profile), which
// falls back to their Discord account.
async function getViewer(req: Request): Promise<Viewer | null> {
  const session = await getSession(req);
  if (!session) return null;
  const profile = toPublic(await syncProfile(session));
  return { id: session.id, name: profile.name, avatar: profile.avatar, isAdmin: isAdminId(session.id) };
}

const withAdminFlag = <T extends { authorId: string }>(m: T) => ({ ...m, authorIsAdmin: isAdminId(m.authorId) });

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function loadTicket(id: number, viewer: Viewer) {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id));
  if (!ticket) return null;
  if (!viewer.isAdmin && ticket.ownerId !== viewer.id) return null;
  return ticket;
}

export default async (req: Request) => {
  const viewer = await getViewer(req);
  if (!viewer) return json({ error: "Please sign in again" }, 401);

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/tickets\/?/, "").split("/").filter(Boolean);

  // /api/tickets
  if (parts.length === 0) {
    if (req.method === "GET") {
      const rows = viewer.isAdmin
        ? await db.select().from(tickets).orderBy(asc(tickets.status), desc(tickets.updatedAt)).limit(200)
        : await db.select().from(tickets).where(eq(tickets.ownerId, viewer.id)).orderBy(desc(tickets.updatedAt)).limit(50);
      return json({ tickets: rows.map((t) => ({ ...t, ownerIsAdmin: isAdminId(t.ownerId) })), isAdmin: viewer.isAdmin });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const reason = String(body.reason || "").trim().replace(/\s+/g, " ");
      const words = reason ? reason.split(" ").length : 0;
      if (words < 1 || words > 5 || reason.length > MAX_REASON_LENGTH) {
        return json({ error: "Describe your reason in 1–5 words" }, 400);
      }

      // One open ticket per member keeps the queue clean and prevents spam.
      const [existing] = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.ownerId, viewer.id), eq(tickets.status, "open")))
        .limit(1);
      if (existing) {
        return json({ error: "You already have an open ticket", ticket: existing }, 409);
      }

      const [ticket] = await db
        .insert(tickets)
        .values({ ownerId: viewer.id, ownerName: viewer.name, ownerAvatar: viewer.avatar, reason })
        .returning();
      return json({ ticket }, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  }

  const id = Number(parts[0]);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Not found" }, 404);
  const ticket = await loadTicket(id, viewer);
  if (!ticket) return json({ error: "Ticket not found" }, 404);

  // /api/tickets/:id
  if (parts.length === 1 && req.method === "GET") {
    const after = Number(url.searchParams.get("after") || 0) || 0;
    const messages = await db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, id), gt(ticketMessages.id, after)))
      .orderBy(asc(ticketMessages.id))
      .limit(500);
    return json({ ticket, messages: messages.map(withAdminFlag), viewerId: viewer.id, isAdmin: viewer.isAdmin });
  }

  // /api/tickets/:id/messages
  if (parts[1] === "messages" && req.method === "POST") {
    if (ticket.status !== "open") return json({ error: "This ticket is closed" }, 409);
    const body = await req.json().catch(() => ({}));
    const text = String(body.body || "").trim();
    if (!text) return json({ error: "Message cannot be empty" }, 400);
    if (text.length > MAX_MESSAGE_LENGTH) return json({ error: "Message is too long" }, 400);

    const [message] = await db
      .insert(ticketMessages)
      .values({
        ticketId: id,
        authorId: viewer.id,
        authorName: viewer.name,
        authorAvatar: viewer.avatar,
        isStaff: viewer.isAdmin && viewer.id !== ticket.ownerId,
        body: text,
      })
      .returning();
    await db.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, id));
    return json({ message: withAdminFlag(message) }, 201);
  }

  // /api/tickets/:id/images
  if (parts[1] === "images" && parts.length === 2 && req.method === "POST") {
    if (ticket.status !== "open") return json({ error: "This ticket is closed" }, 409);
    const caption = String(url.searchParams.get("caption") || "").trim();
    if (caption.length > MAX_MESSAGE_LENGTH) return json({ error: "Message is too long" }, 400);
    const upload = await readImageUpload(req);
    if ("error" in upload) return json({ error: upload.error }, upload.status);

    const imageKey = `${id}/${crypto.randomUUID()}`;
    await getStore(MEDIA_STORE).set(imageKey, upload.bytes);
    const [message] = await db
      .insert(ticketMessages)
      .values({
        ticketId: id,
        authorId: viewer.id,
        authorName: viewer.name,
        authorAvatar: viewer.avatar,
        isStaff: viewer.isAdmin && viewer.id !== ticket.ownerId,
        body: caption,
        imageKey,
        imageType: upload.type,
      })
      .returning();
    await db.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, id));
    return json({ message: withAdminFlag(message) }, 201);
  }

  // /api/tickets/:id/images/:msgId
  if (parts[1] === "images" && parts.length === 3 && req.method === "GET") {
    const msgId = Number(parts[2]);
    if (!Number.isInteger(msgId) || msgId <= 0) return json({ error: "Not found" }, 404);
    const [message] = await db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.id, msgId), eq(ticketMessages.ticketId, id)));
    if (!message?.imageKey) return json({ error: "Not found" }, 404);
    const data = await getStore(MEDIA_STORE).get(message.imageKey, { type: "arrayBuffer" });
    if (!data) return json({ error: "Image no longer available" }, 404);
    return new Response(data, {
      headers: {
        "Content-Type": message.imageType || "application/octet-stream",
        "Cache-Control": "private, max-age=86400",
      },
    });
  }

  // /api/tickets/:id/close
  if (parts[1] === "close" && req.method === "POST") {
    const [updated] = await db
      .update(tickets)
      .set({ status: "closed", closedAt: new Date(), updatedAt: new Date() })
      .where(eq(tickets.id, id))
      .returning();
    return json({ ticket: updated });
  }

  return json({ error: "Not found" }, 404);
};

export const config: Config = {
  path: ["/api/tickets", "/api/tickets/*"],
};
