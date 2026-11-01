CREATE TABLE "team_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "locked" boolean;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "approval_required" boolean;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "admins_add_members" boolean;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "provider_state" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "community_jid" text;--> statement-breakpoint
ALTER TABLE "team_contacts" ADD CONSTRAINT "team_contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_contacts_workspace_id_phone_index" ON "team_contacts" USING btree ("workspace_id","phone");