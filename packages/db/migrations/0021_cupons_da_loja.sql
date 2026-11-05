CREATE TABLE "store_coupons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"title" text NOT NULL,
	"code" text,
	"details" text,
	"url" text NOT NULL,
	"affiliate_url" text,
	"image_url" text,
	"valid_until" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "store_coupons" ADD CONSTRAINT "store_coupons_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_coupons_workspace_id_created_at_index" ON "store_coupons" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_coupon_id_store_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."store_coupons"("id") ON DELETE set null ON UPDATE no action;