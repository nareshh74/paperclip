import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { teamsApi } from "../api/teams";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Field } from "./agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

const UNSELECTED = "";
const CLEAR_PM = "__clear__";

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/** Shows the project's current PM (lead agent), hands off to another agent, and lists past handoffs. */
export function ProjectPmHandoff({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const companyId = project.companyId;
  const [toAgentId, setToAgentId] = useState(UNSELECTED);
  const [reason, setReason] = useState("");

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const historyKey = ["projects", "pm-handoffs", companyId, project.id] as const;
  const historyQuery = useQuery({
    queryKey: historyKey,
    queryFn: () => teamsApi.listProjectManagerHandoffs(companyId, project.id),
  });

  const handOff = useMutation({
    mutationFn: () =>
      teamsApi.handOffProjectManager(companyId, project.id, {
        toAgentId: toAgentId === CLEAR_PM ? null : toAgentId,
        reason: reason.trim() || null,
      }),
    onSuccess: async () => {
      setReason("");
      setToAgentId(UNSELECTED);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: historyKey }),
        // Project detail is keyed by id or URL key, so refresh every project query.
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });

  const agents = agentsQuery.data ?? [];
  const agentName = (id: string | null) =>
    id ? (agents.find((agent) => agent.id === id)?.name ?? (agentsQuery.isPending ? "Loading..." : "Unknown agent")) : "No PM";
  const candidates = agents.filter((agent) => agent.id !== project.leadAgentId && agent.status !== "terminated");
  const canSubmit = toAgentId !== UNSELECTED;

  return (
    <div className="space-y-4" data-testid="project-pm-handoff">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Project manager</div>
      <p className="text-sm">
        Current PM: <span className="font-medium" data-testid="project-pm-current">{agentName(project.leadAgentId)}</span>
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Hand off to" hint="The board or the CEO agent can hand off a project.">
          <select
            className={inputClass}
            value={toAgentId}
            onChange={(e) => setToAgentId(e.target.value)}
            data-testid="project-pm-handoff-agent"
          >
            <option value={UNSELECTED}>Select an agent</option>
            {project.leadAgentId && <option value={CLEAR_PM}>No PM (clear)</option>}
            {candidates.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason">
          <input
            className={inputClass}
            value={reason}
            placeholder="Optional"
            onChange={(e) => setReason(e.target.value)}
            data-testid="project-pm-handoff-reason"
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!canSubmit || handOff.isPending}
          onClick={() => handOff.mutate()}
          data-testid="project-pm-handoff-submit"
        >
          {handOff.isPending ? "Handing off..." : "Hand off"}
        </Button>
        {handOff.isError && (
          <span className="text-xs text-destructive">{errorText(handOff.error, "Failed to hand off")}</span>
        )}
      </div>
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Handoff history</div>
      {historyQuery.isError && (
        <span className="text-xs text-destructive">{errorText(historyQuery.error, "Failed to load handoffs")}</span>
      )}
      {historyQuery.data && historyQuery.data.length === 0 && (
        <p className="text-sm text-muted-foreground">No handoffs yet.</p>
      )}
      <ul className="space-y-2" data-testid="project-pm-handoff-history">
        {(historyQuery.data ?? []).map((handoff) => (
          <li key={handoff.id} className="rounded-md border border-border px-3 py-2 text-sm">
            <div>
              {agentName(handoff.fromAgentId)} to {agentName(handoff.toAgentId)}
            </div>
            <div className="text-xs text-muted-foreground">
              {new Date(handoff.createdAt).toLocaleString()} by {handoff.actorType}
              {handoff.reason ? `: ${handoff.reason}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
