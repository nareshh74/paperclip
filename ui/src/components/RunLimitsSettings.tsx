import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Company, RunLimits, Team } from "@paperclipai/shared";
import { companiesApi } from "../api/companies";
import { teamsApi } from "../api/teams";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Field } from "./agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

type Draft = { model: string; maxOutputTokensPerRun: string; timeoutSec: string };

function toDraft(limits: RunLimits | null | undefined): Draft {
  return {
    model: limits?.model ?? "",
    maxOutputTokensPerRun: limits?.maxOutputTokensPerRun?.toString() ?? "",
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
  const cap = toPositiveInt(draft.maxOutputTokensPerRun);
  if (cap) limits.maxOutputTokensPerRun = cap;
  const timeout = toPositiveInt(draft.timeoutSec);
  if (timeout) limits.timeoutSec = timeout;
  return limits;
}

function sameDraft(a: Draft, b: Draft) {
  return a.model === b.model && a.maxOutputTokensPerRun === b.maxOutputTokensPerRun && a.timeoutSec === b.timeoutSec;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/** Model, output-token cap, and time limit fields shared by company and team rows. */
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
        label="Max output tokens per run"
        hint="A run that goes over this is stopped mid-run and leaves resume notes on the task."
      >
        <input
          className={inputClass}
          type="number"
          min={1}
          value={props.value.maxOutputTokensPerRun}
          placeholder="Inherit"
          onChange={set("maxOutputTokensPerRun")}
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

function TeamRow({ companyId, team }: { companyId: string; team: Team }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => toDraft(team.runLimits));
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.teams.list(companyId) });
  const save = useMutation({
    mutationFn: () =>
      teamsApi.update(companyId, team.id, { runLimits: draftToRunLimits(draft) }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: () => teamsApi.remove(companyId, team.id), onSuccess: invalidate });
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
      <RunLimitFields value={draft} onChange={setDraft} testIdPrefix="run-limits-team" />
      <div className="flex items-center gap-2">
        {dirty && (
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving..." : "Save team"}
          </Button>
        )}
        {(save.isError || remove.isError) && (
          <span className="text-xs text-destructive">
            {errorText(save.error ?? remove.error, "Failed to update team")}
          </span>
        )}
      </div>
    </div>
  );
}

/** Company- and team-level run limits: model, output-token cap, time limit. */
export function RunLimitsSettings({ company }: { company: Company }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => toDraft(company.runLimits));
  const [newTeamName, setNewTeamName] = useState("");

  useEffect(() => setDraft(toDraft(company.runLimits)), [company]);

  const teamsQuery = useQuery({
    queryKey: queryKeys.teams.list(company.id),
    queryFn: () => teamsApi.list(company.id),
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
        Each limit uses the most specific level that sets it: task, then agent, then team, then company.
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
        {teamsQuery.data?.map((team) => <TeamRow key={team.id} companyId={company.id} team={team} />)}
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
