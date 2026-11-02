CREATE TABLE "contents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"title" text NOT NULL,
	"hook" text NOT NULL,
	"subhook" text,
	"outro" text NOT NULL,
	"caption" text NOT NULL,
	"hashtags" text[] DEFAULT '{}' NOT NULL,
	"offer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cover_asset_id" uuid,
	"seconds" real,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"posted_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"posted_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contents_workspace_id_created_at_index" ON "contents" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "contents_status_index" ON "contents" USING btree ("status");