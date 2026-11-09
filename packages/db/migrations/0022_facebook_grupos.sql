CREATE TABLE "browser_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"facebook_account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"post_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"lease_until" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facebook_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"fb_user_id" text NOT NULL,
	"name" text,
	"last_seen_at" timestamp with time zone,
	"paused_until" timestamp with time zone,
	"pause_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "facebook_account_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "external_url" text;--> statement-breakpoint
ALTER TABLE "browser_jobs" ADD CONSTRAINT "browser_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_jobs" ADD CONSTRAINT "browser_jobs_facebook_account_id_facebook_accounts_id_fk" FOREIGN KEY ("facebook_account_id") REFERENCES "public"."facebook_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_jobs" ADD CONSTRAINT "browser_jobs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facebook_accounts" ADD CONSTRAINT "facebook_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_jobs_facebook_account_id_status_index" ON "browser_jobs" USING btree ("facebook_account_id","status");--> statement-breakpoint
CREATE INDEX "browser_jobs_post_id_index" ON "browser_jobs" USING btree ("post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facebook_accounts_workspace_id_fb_user_id_index" ON "facebook_accounts" USING btree ("workspace_id","fb_user_id");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_facebook_account_id_facebook_accounts_id_fk" FOREIGN KEY ("facebook_account_id") REFERENCES "public"."facebook_accounts"("id") ON DELETE set null ON UPDATE no action;