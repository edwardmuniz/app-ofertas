ALTER TABLE "contents" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "reviewed_by" text;