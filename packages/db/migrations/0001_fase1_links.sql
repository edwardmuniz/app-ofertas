CREATE TABLE "channel_segments" (
	"channel_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	CONSTRAINT "channel_segments_channel_id_segment_id_pk" PRIMARY KEY("channel_id","segment_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text DEFAULT 'wa_group' NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"invite_url" text,
	"member_count" integer DEFAULT 0 NOT NULL,
	"member_limit" integer DEFAULT 1024 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clicks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"tracked_link_id" uuid,
	"invite_link_id" uuid,
	"channel_id" uuid,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"referrer" text,
	"params" jsonb,
	"is_bot" boolean DEFAULT false NOT NULL,
	"outcome" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"segment_id" uuid NOT NULL,
	"strategy" text DEFAULT 'fill_first' NOT NULL,
	"reserve" integer DEFAULT 10 NOT NULL,
	"fallback_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_links_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"destination_url" text NOT NULL,
	"fallback_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"title" text,
	"source" text,
	"campaign" text,
	"channel_id" uuid,
	"offer_id" uuid,
	"post_id" uuid,
	"creative_id" uuid,
	"sub_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_links_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "channel_segments" ADD CONSTRAINT "channel_segments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_segments" ADD CONSTRAINT "channel_segments_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_tracked_link_id_tracked_links_id_fk" FOREIGN KEY ("tracked_link_id") REFERENCES "public"."tracked_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_invite_link_id_invite_links_id_fk" FOREIGN KEY ("invite_link_id") REFERENCES "public"."invite_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_segments_segment_id_index" ON "channel_segments" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "channels_workspace_id_index" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "clicks_workspace_id_ts_index" ON "clicks" USING btree ("workspace_id","ts");--> statement-breakpoint
CREATE INDEX "clicks_tracked_link_id_ts_index" ON "clicks" USING btree ("tracked_link_id","ts");--> statement-breakpoint
CREATE INDEX "clicks_invite_link_id_ts_index" ON "clicks" USING btree ("invite_link_id","ts");--> statement-breakpoint
CREATE INDEX "events_workspace_id_created_at_index" ON "events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "invite_links_workspace_id_index" ON "invite_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "segments_workspace_id_name_index" ON "segments" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "tracked_links_workspace_id_created_at_index" ON "tracked_links" USING btree ("workspace_id","created_at");