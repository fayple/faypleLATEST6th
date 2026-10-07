CREATE TABLE "profiles" (
	"discord_id" text PRIMARY KEY,
	"discord_name" text NOT NULL,
	"discord_avatar" text,
	"display_name" text,
	"bio" text,
	"avatar_key" text,
	"nickname_changed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "image_key" text;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "image_type" text;