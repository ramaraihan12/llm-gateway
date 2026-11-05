CREATE TABLE "demo_quota" (
	"bucket" text PRIMARY KEY NOT NULL,
	"hits" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "demo_quota_expires_at_idx" ON "demo_quota" USING btree ("expires_at");