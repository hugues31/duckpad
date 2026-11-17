import type { TranslationKey } from "./i18n";
import type { Json, Run } from "./types";

export type StepCondition = "success" | "failure" | "always";
export type NotifyOn = "failure" | "success" | "always";

export interface ScenarioSchedule {
  cron: string;
  timezone: string;
  /** The next occurrence, in UTC; null when the schedule never occurs again. */
  next?: string | null;
}

export interface Scenario {
  slug: string;
  project: string;
  name: string;
  description: string;
  enabled: boolean;
  steps: {
    job: string;
    run_if: StepCondition;
    /** Null when the Job no longer exists. */
    name: string | null;
    environment: string | null;
  }[];
  parameters: { name: string; type: string }[];
  schedules: ScenarioSchedule[];
  webhook: boolean;
  notifications: { destination: string; on: NotifyOn }[];
  revision: string;
  last_run: ScenarioRun | null;
  active_run: string | null;
}

export type ScenarioRunStatus =
  | "running"
  | "canceling"
  | "success"
  | "failed"
  | "canceled"
  | "interrupted"
  | "rejected"
  | "missed";

export interface ScenarioRun {
  id: string;
  scenario: string;
  status: ScenarioRunStatus;
  started: string;
  finished: string | null;
  trigger: {
    source: "manual" | "schedule" | "webhook";
    delivery?: string;
    cron?: string;
    timezone?: string;
    occurrence?: string;
    missed?: number;
  };
  requester: Run["requester"];
  parameters: Record<string, Json>;
  steps: {
    job: string;
    name: string;
    run_if: StepCondition;
    status: string;
    run?: string;
    worktree?: string;
    environment?: string;
    started?: string;
    finished?: string;
    duration?: number;
    error?: string;
  }[];
  notifications: {
    destination: string;
    name: string;
    status: "sent" | "failed";
    error?: string;
    at: string;
  }[];
  error?: string;
  detail?: { code?: string; run?: string };
}

export interface Destination {
  id: string;
  name: string;
  kind: "email" | "webhook";
}

export const activeScenario = (run: ScenarioRun | null | undefined) =>
  !!run && (run.status === "running" || run.status === "canceling");

export const conditionKeys: Record<StepCondition, TranslationKey> = {
  success: "stepIfSucceeded",
  failure: "stepIfFailed",
  always: "stepAlways",
};

export const notifyKeys: Record<NotifyOn, TranslationKey> = {
  failure: "notifyOnFailure",
  success: "notifyOnSuccess",
  always: "notifyAlways",
};

export const triggerKeys: Record<
  ScenarioRun["trigger"]["source"],
  TranslationKey
> = {
  manual: "scenarioManual",
  schedule: "scenarioSchedule",
  webhook: "scenarioWebhook",
};

/** A webhook delivery to this server, as the scenario details show it. */
export function scenarioWebhook(slug: string, server: string) {
  return `# DUCKPAD_TOKEN holds an API token of an account with Operator access.
# Webhook-Id identifies the event: a repeated delivery returns its first run.
printf 'header = "Authorization: Bearer %s"\\n' "$DUCKPAD_TOKEN" | \\
  curl --fail-with-body --silent --show-error --config - \\
  -H 'Content-Type: application/json' \\
  -H "Webhook-Id: $(uuidgen)" \\
  -d '{"parameters":{}}' \\
  "${server}/api/v1/scenarios/${encodeURIComponent(slug)}/webhook"`;
}

/** Seconds as a short duration, such as 4 s or 2 min 5 s. */
export function shortDuration(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds * 10) / 10)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The scenario run's duration in seconds, while it runs as well. */
export function runSeconds(run: Pick<ScenarioRun, "started" | "finished">) {
  const end = run.finished ? Date.parse(run.finished) : Date.now();
  return (end - Date.parse(run.started)) / 1000;
}

/** An instant as wall-clock time in a schedule's time zone. */
export function zonedTime(instant: string, timeZone: string) {
  const date = new Date(instant);
  try {
    return date.toLocaleString(undefined, {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return date.toLocaleString();
  }
}
