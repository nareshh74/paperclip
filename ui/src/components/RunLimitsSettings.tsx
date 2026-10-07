import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, Company, Project, RunLimits, Team } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { companiesApi } from "../api/companies";
import { projectsApi } from "../api/projects";
import { teamsApi } from "../api/teams";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Field } from "./agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

type Draft = { model: string; maxAicPerRun: string; timeoutSec: string };

function toDraft(limits: RunLimits | null | undefined): Draft {
  return {
    model: limits?.model ?? "",
    maxAicPerRun: limits?.maxAicPerRun?.toString() ?? "",
    timeoutSec: limits?.timeoutSec?.toString() ?? "",
  };
}

function toPositiveInt(value: string): number | null {
  const n = Number(value);
  return value.trim() && Number.isInteger(n) && n > 0 ? n : null;
}

/** Empty fields are dropped so the level inherits from the one above it. */
function draftToRunLimits(draft: Draft): RunLimits {
  const limits: RunLimits = {};
  if (draft.model.trim()) limits.model = draft.model.trim();
  const cap = toPositiveInt(draft.maxAicPerRun);
  if (cap) limits.maxAicPerRun = cap;
  const timeout = toPositiveInt(draft.timeoutSec);
  if (timeout) limits.timeoutSec = timeout;
  return limits;
}

function sameDraft(a: Draft, b: Draft) {
  return a.model === b.model && a.maxAicPerRun === b.maxAicPerRun && a.timeoutSec === b.timeoutSec;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/** Model, AIC cap, and time limit fields shared by company and team rows. */
function RunLimitFields(props: { value: Draft; onChange: (next: Draft) => void; testIdPrefix: string }) {
  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    props.onChange({ ...props.value, [key]: e.target.value });
  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="Model" hint="Empty inherits from the level above.">
        <input
          className={inputClass}
          value={props.value.model}
          placeholder="Inherit"
          onChange={set("model")}
          data-testid={`${props.testIdPrefix}-model`}
        />
      </Field>
      <Field
        label="Max AIC per run"
        hint="A run whose recorded AIC goes over this is stopped mid-run and leaves resume notes on the task."
      >
        <input
          className={inputClass}
          type="number"
          min={1}
          value={props.value.maxAicPerRun}
          placeholder="Inherit"
          onChange={set("maxAicPerRun")}
          data-testid={`${props.testIdPrefix}-cap`}
        />
      </Field>
      <Field label="Time limit per run (sec)" hint="A run that runs longer is stopped and leaves resume notes on the task.">
        <input
          className={inputClass}
          type="number"
          min={1}
          value={props.value.timeoutSec}
          placeholder="Inherit"
          onChange={set("timeoutSec")}
          data-testid={`${props.testIdPrefix}-timeout`}
        />
      </Field>
    </div>
  );
}

function TeamRow({
  companyId,
  team,
  agents,
  projects,
}: {
  companyId: string;
  team: Team;
  agents: Agent[];
  projects: Project[];
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => toDraft(team.runLimits));
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.teams.list(companyId) });
  const save = useMutation({
    mutationFn: () =>
      teamsApi.update(companyId, team.id, { runLimits: draftToRunLimits(draft) }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: () => teamsApi.remove(companyId, team.id), onSuccess: invalidate });
  const setManager = useMutation({
    mutationFn: (managerAgentId: string | null) => teamsApi.update(companyId, team.id, { managerAgentId }),
    onSuccess: invalidate,
  });
  const linkProject = useMutation({
    mutationFn: (projectId: string) => teamsApi.linkProject(companyId, team.id, projectId),
    onSuccess: invalidate,
  });
  const unlinkProject = useMutation({
    mutationFn: (projectId: string) => teamsApi.unlinkProject(companyId, team.id, projectId),
    onSuccess: invalidate,
  });
  const linkedIds = team.projectIds ?? [];
  const linkable = projects.filter((project) => !linkedIds.includes(project.id));
  const mutationError = save.error ?? remove.error ?? setManager.error ?? linkProject.error ?? unlinkProject.error;
  const dirty = !sameDraft(draft, toDraft(team.runLimits));

  return (
    <div className="space-y-2 border border-border rounded-md px-3 py-3" data-testid="run-limits-team-row">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{team.name}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete team "${team.name}"? Its agents fall back to company limits.`)) remove.mutate();
          }}
        >
          Delete
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Manager" hint="Members report to the manager. The manager reports to the CEO.">
          <select
            className={inputClass}
            value={team.managerAgentId ?? ""}
            disabled={setManager.isPending}
            onChange={(e) => setManager.mutate(e.target.value || null)}
            data-testid="run-limits-team-manager"
          >
            <option value="">No manager</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Projects" hint="Projects this team works on. Does not limit task assignment.">
          <select
            className={inputClass}
            value=""
            disabled={linkProject.isPending || linkable.length === 0}
            onChange={(e) => e.target.value && linkProject.mutate(e.target.value)}
            data-testid="run-limits-team-add-project"
          >
            <option value="">Add project…</option>
            {linkable.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {linkedIds.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="run-limits-team-projects">
          {linkedIds.map((projectId) => (
            <span key={projectId} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs">
              {projects.find((project) => project.id === projectId)?.name ?? projectId}
              <Button
                size="sm"
                variant="ghost"
                disabled={unlinkProject.isPending}
                onClick={() => unlinkProject.mutate(projectId)}
                aria-label="Remove project"
              >
                Remove
              </Button>
            </span>
          ))}
        </div>
      )}
      <RunLimitFields value={draft} onChange={setDraft} testIdPrefix="run-limits-team" />
      <div className="flex items-center gap-2">
        {dirty && (
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving..." : "Save team"}
          </Button>
        )}
        {mutationError && (
          <span className="text-xs text-destructive">{errorText(mutationError, "Failed to update team")}</span>
        )}
      </div>
    </div>
  );
}

/** Company- and team-level run limits (model, AIC cap, time limit), team managers, and team projects. */
export function RunLimitsSettings({ company }: { company: Company }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => toDraft(company.runLimits));
  const [newTeamName, setNewTeamName] = useState("");

  useEffect(() => setDraft(toDraft(company.runLimits)), [company]);

  const teamsQuery = useQuery({
    queryKey: queryKeys.teams.list(company.id),
    queryFn: () => teamsApi.list(company.id),
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(company.id),
    queryFn: () => agentsApi.list(company.id),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(company.id),
    queryFn: () => projectsApi.list(company.id),
  });

  const saveCompany = useMutation({
    mutationFn: () =>
      companiesApi.update(company.id, { runLimits: draftToRunLimits(draft) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.companies.all }),
  });

  const createTeam = useMutation({
    mutationFn: () => teamsApi.create(company.id, { name: newTeamName.trim() }),
    onSuccess: () => {
      setNewTeamName("");
      return queryClient.invalidateQueries({ queryKey: queryKeys.teams.list(company.id) });
    },
  });

  const companyDirty = !sameDraft(draft, toDraft(company.runLimits));

  return (
    <div className="max-w-2xl space-y-4" data-testid="company-settings-run-limits">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Run limits</div>
      <p className="text-sm text-muted-foreground">
        Limits are ceilings: company, then team, then agent, then task. A lower level can only lower a limit.
        Model uses the most specific level that sets it.
      </p>
      <RunLimitFields value={draft} onChange={setDraft} testIdPrefix="run-limits-company" />
      {(companyDirty || saveCompany.isError) && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={saveCompany.isPending} onClick={() => saveCompany.mutate()}>
            {saveCompany.isPending ? "Saving..." : "Save run limits"}
          </Button>
          {saveCompany.isError && (
            <span className="text-xs text-destructive">{errorText(saveCompany.error, "Failed to save")}</span>
          )}
        </div>
      )}

      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Teams</div>
      {teamsQuery.isError && (
        <span className="text-xs text-destructive">{errorText(teamsQuery.error, "Failed to load teams")}</span>
      )}
      <div className="space-y-2">
        {teamsQuery.data?.map((team) => (
          <TeamRow
            key={team.id}
            companyId={company.id}
            team={team}
            agents={agentsQuery.data ?? []}
            projects={projectsQuery.data ?? []}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          className={inputClass}
          value={newTeamName}
          placeholder="New team name"
          onChange={(e) => setNewTeamName(e.target.value)}
          data-testid="run-limits-new-team-name"
        />
        <Button size="sm" disabled={!newTeamName.trim() || createTeam.isPending} onClick={() => createTeam.mutate()}>
          Add team
        </Button>
      </div>
      {createTeam.isError && (
        <span className="text-xs text-destructive">{errorText(createTeam.error, "Failed to create team")}</span>
      )}
    </div>
  );
}
