import { pgTable, serial, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

export const tickets = pgTable(
  "tickets",
  {
    id: serial().primaryKey(),
    ownerId: text("owner_id").notNull(),
    ownerName: text("owner_name").notNull(),
    ownerAvatar: text("owner_avatar"),
    reason: text().notNull(),
    status: text().notNull().default("open"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    closedAt: timestamp("closed_at"),
  },
  (t) => [index("tickets_owner_idx").on(t.ownerId)]
);

export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: serial().primaryKey(),
    ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    authorId: text("author_id").notNull(),
    authorName: text("author_name").notNull(),
    authorAvatar: text("author_avatar"),
    isStaff: boolean("is_staff").notNull().default(false),
    body: text().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ticket_messages_ticket_idx").on(t.ticketId, t.id)]
);
