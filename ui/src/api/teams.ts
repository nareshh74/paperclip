import type { CreateTeam, ProjectPmHandoff, ProjectPmHandoffInput, Team, UpdateTeam } from "@paperclipai/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/teams`;
const projectBase = (companyId: string, projectId: string) =>
  `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`;

export const teamsApi = {
  list: (companyId: string) => api.get<Team[]>(base(companyId)),
  create: (companyId: string, payload: CreateTeam) => api.post<Team>(base(companyId), payload),
  update: (companyId: string, teamId: string, payload: UpdateTeam) =>
    api.patch<Team>(`${base(companyId)}/${encodeURIComponent(teamId)}`, payload),
  remove: (companyId: string, teamId: string) =>
    api.delete<void>(`${base(companyId)}/${encodeURIComponent(teamId)}`),
  linkProject: (companyId: string, teamId: string, projectId: string) =>
    api.post<Team>(`${base(companyId)}/${encodeURIComponent(teamId)}/projects`, { projectId }),
  unlinkProject: (companyId: string, teamId: string, projectId: string) =>
    api.delete<void>(
      `${base(companyId)}/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}`,
    ),
  handOffProjectManager: (companyId: string, projectId: string, payload: ProjectPmHandoffInput) =>
    api.post<ProjectPmHandoff>(`${projectBase(companyId, projectId)}/pm-handoff`, payload),
  listProjectManagerHandoffs: (companyId: string, projectId: string) =>
    api.get<ProjectPmHandoff[]>(`${projectBase(companyId, projectId)}/pm-handoffs`),
};
