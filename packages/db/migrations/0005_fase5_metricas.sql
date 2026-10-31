CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "click_stats_hourly" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"channel_id" uuid,
	"offer_id" uuid,
	"post_id" uuid,
	"tracked_link_id" uuid,
	"invite_link_id" uuid,
	"human" integer DEFAULT 0 NOT NULL,
	"bot" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_stats_hourly" ADD CONSTRAINT "click_stats_hourly_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_workspace_id_status_index" ON "alerts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_workspace_id_kind_subject_index" ON "alerts" USING btree ("workspace_id","kind","subject") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "click_stats_hourly_workspace_id_hour_index" ON "click_stats_hourly" USING btree ("workspace_id","hour");--> statement-breakpoint
CREATE INDEX "click_stats_hourly_hour_index" ON "click_stats_hourly" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "click_stats_hourly_post_id_index" ON "click_stats_hourly" USING btree ("post_id");