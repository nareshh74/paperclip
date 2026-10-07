/** Feature keys of the task matching score. Each feature is in 0..1. */
export type MatchFeatureKey = "similarity" | "quality" | "efficiency" | "availability" | "teamProject";

export type MatchWeights = Record<MatchFeatureKey, number>;

/** Company-owned matching strategy, stored in `companies.matching_config`. All keys optional. */
export interface MatchingConfig {
  weights?: Partial<MatchWeights>;
  /** Candidates within this distance of the top score form the tie group. */
  tieEpsilon?: number;
}

export interface MatchFeature {
  value: number;
  weight: number;
  /** value * weight */
  contribution: number;
  explanation: string;
}

export interface MatchCandidate {
  agentId: string;
  agentName: string;
  score: number;
  features: Record<MatchFeatureKey, MatchFeature>;
  explanation: string;
  tiedWithTop: boolean;
}

export interface MatchCandidatesResult {
  issueId: string;
  taskKind: string;
  tieEpsilon: number;
  weights: MatchWeights;
  candidates: MatchCandidate[];
  /** Agent ids within `tieEpsilon` of the top score (top included). */
  tieGroup: string[];
}

export interface MatchingTrialArm {
  agentId: string;
  childIssueId: string;
}

export interface MatchingTrial {
  id: string;
  companyId: string;
  issueId: string;
  status: "open" | "decided";
  winnerAgentId: string | null;
  decisionReason: string | null;
  decidedByActorType: string | null;
  decidedByActorId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  arms: MatchingTrialArm[];
}
