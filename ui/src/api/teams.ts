import type { CreateTeam, Team, UpdateTeam } from "@paperclipai/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/teams`;

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
};
