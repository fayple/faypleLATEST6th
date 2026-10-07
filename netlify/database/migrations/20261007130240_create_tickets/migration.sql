CREATE TABLE "ticket_messages" (
	"id" serial PRIMARY KEY,
	"ticket_id" integer NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"author_avatar" text,
	"is_staff" boolean DEFAULT false NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" serial PRIMARY KEY,
	"owner_id" text NOT NULL,
	"owner_name" text NOT NULL,
	"owner_avatar" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" ("ticket_id","id");--> statement-breakpoint
CREATE INDEX "tickets_owner_idx" ON "tickets" ("owner_id");--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE;