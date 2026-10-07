CREATE TABLE "matching_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"trial_id" uuid,
	"task_kind" text NOT NULL,
	"project_id" uuid,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title_tokens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" double precision NOT NULL,
	"aic_spent" integer DEFAULT 0 NOT NULL,
	"wall_seconds" integer,
	"source" text NOT NULL,
	"closed_by_actor_type" text,
	"closed_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching_trial_arms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trial_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"child_issue_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"winner_agent_id" uuid,
	"decision_reason" text,
	"decided_by_actor_type" text,
	"decided_by_actor_id" text,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "matching_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "matching_outcomes" ADD CONSTRAINT "matching_outcomes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_outcomes" ADD CONSTRAINT "matching_outcomes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_outcomes" ADD CONSTRAINT "matching_outcomes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_outcomes" ADD CONSTRAINT "matching_outcomes_trial_id_matching_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."matching_trials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_outcomes" ADD CONSTRAINT "matching_outcomes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_trial_arms" ADD CONSTRAINT "matching_trial_arms_trial_id_matching_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."matching_trials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_trial_arms" ADD CONSTRAINT "matching_trial_arms_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_trial_arms" ADD CONSTRAINT "matching_trial_arms_child_issue_id_issues_id_fk" FOREIGN KEY ("child_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_trials" ADD CONSTRAINT "matching_trials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_trials" ADD CONSTRAINT "matching_trials_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_trials" ADD CONSTRAINT "matching_trials_winner_agent_id_agents_id_fk" FOREIGN KEY ("winner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matching_outcomes_company_agent_idx" ON "matching_outcomes" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "matching_outcomes_company_kind_idx" ON "matching_outcomes" USING btree ("company_id","task_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "matching_trial_arms_trial_agent_uq" ON "matching_trial_arms" USING btree ("trial_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matching_trial_arms_child_issue_uq" ON "matching_trial_arms" USING btree ("child_issue_id");--> statement-breakpoint
CREATE INDEX "matching_trials_company_issue_idx" ON "matching_trials" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matching_trials_open_issue_uq" ON "matching_trials" USING btree ("issue_id") WHERE "matching_trials"."status" = 'open';--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_events_company_team_occurred_idx" ON "cost_events" USING btree ("company_id","team_id","occurred_at");--> statement-breakpoint
-- One task at a time: before the unique index, keep only the most recently started
-- in_progress task per agent and move the others back to todo. Demoted tasks lose
-- their checkout and execution ownership, and each demotion is logged.
WITH "demoted" AS (
  UPDATE "issues" SET
    "status" = 'todo',
    "checkout_run_id" = NULL,
    "execution_run_id" = NULL,
    "execution_agent_name_key" = NULL,
    "execution_locked_at" = NULL,
    "updated_at" = now()
  WHERE "id" IN (
    SELECT "id" FROM (
      SELECT "id", row_number() OVER (
        PARTITION BY "assignee_agent_id"
        ORDER BY "started_at" DESC NULLS LAST, "updated_at" DESC, "id"
      ) AS "rn"
      FROM "issues"
      WHERE "status" = 'in_progress' AND "assignee_agent_id" IS NOT NULL
        AND "hidden_at" IS NULL AND "conversation_agent_id" IS NULL
    ) "ranked"
    WHERE "rn" > 1
  )
  RETURNING "id", "company_id", "assignee_agent_id"
)
INSERT INTO "activity_log" ("company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "agent_id", "details")
SELECT "company_id", 'system', 'migration_0296', 'issue.in_progress_demoted_by_migration', 'issue', "id"::text, "assignee_agent_id",
  jsonb_build_object('fromStatus', 'in_progress', 'toStatus', 'todo', 'reason', 'one_task_in_progress')
FROM "demoted";--> statement-breakpoint
CREATE UNIQUE INDEX "issues_agent_single_in_progress_uq" ON "issues" USING btree ("assignee_agent_id") WHERE "issues"."status" = 'in_progress'
          and "issues"."assignee_agent_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."conversation_agent_id" is null;