ALTER TABLE "channels" ADD COLUMN "posting_policy" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "policy_source" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "policy_notes" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "policy_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "policy_checked_at" timestamp with time zone;