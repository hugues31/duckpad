import { useState } from "react";
import { api, send, withQuery } from "./api";
import ComparisonView from "./ComparisonView";
import type { Branch, GitTag } from "./gitTypes";
import { useT } from "./i18n";
import { jobSlug } from "./jobs";
import { Job, Review } from "./jobTypes";
import JobVersionFields from "./JobVersionFields";
import { ModalForm } from "./modals";
import { displayNodeName, type NodeNames } from "./nodeNames";
import { PageLoading } from "./pages/PageStates";
import { SearchField } from "./Search";
import Select from "./Select";
import { useWorkspace } from "./shell";
import type { Project } from "./types";
import { useApiResource } from "./useApiResource";

export function JobForm({
  project,
  job,
  onClose,
  onSaved,
}: {
  project: Project;
  job: Job | null;
  onClose: () => void;
  onSaved: (job: Job) => Promise<void>;
}) {
  const t = useT();
  const workspace = useWorkspace();
  const [targetKind, setKind] = useState<"tag" | "branch" | null>(null);
  const [chosenRef, setRef] = useState<string | null>(null);
  const [name, setName] = useState(job?.name || "");
  const [slug, setSlug] = useState<string | null>(null);
  const [scope, setScope] = useState(job?.scope || "");
  const [scopeQuery, setScopeQuery] = useState("");
  const tags = useApiResource<GitTag[]>(`/worktrees/${project.main}/git/tags`);
  const branches = useApiResource<Branch[]>(
    `/worktrees/${project.main}/git/branches`,
  );
  const kind = targetKind ?? (tags.data?.length ? "tag" : "branch");
  // Without tags, the Job targets the main branch until another is chosen.
  const ref =
    chosenRef ??
    (tags.data && kind === "branch"
      ? workspace.worktrees.find((item) => item.id === project.main)?.branch ||
        ""
      : "");
  const nodes = useApiResource<NodeNames>(
    job
      ? `/jobs/${job.slug}/nodes`
      : ref
        ? withQuery(`/projects/${project.id}/job-nodes`, { kind, ref })
        : null,
  );
  const scopeOptions = [
    { key: "", label: t("jobWholeProject"), detail: "" },
    ...Object.entries(nodes.data || {}).map(([key, parts]) => ({
      key,
      label: displayNodeName(parts, t("node"), t),
      detail: "",
    })),
  ].filter((item) =>
    item.label.toLocaleLowerCase().includes(scopeQuery.toLocaleLowerCase()),
  );
  const scopeValid = !scope || !!nodes.data?.[scope];
  return (
    <ModalForm
      title={t(job ? "editJob" : "newJob")}
      onClose={onClose}
      submitLabel={t(job ? "save" : "create")}
      disabled={
        nodes.pending ||
        !scopeValid ||
        (!job && (!ref || tags.pending || branches.pending))
      }
      onSubmit={async (form) => {
        const data = new FormData(form);
        const fields = {
          name: data.get("name"),
          description: data.get("description"),
          environment: data.get("environment"),
          scope: scope || null,
        };

        const saved = await api<Job>(
          job ? `/jobs/${job.slug}` : `/projects/${project.id}/jobs`,
          send(
            job
              ? { ...fields, revision: job.revision }
              : {
                  ...fields,
                  slug: data.get("slug"),
                  target: { kind, ref },
                },
            job ? "PATCH" : "POST",
          ),
        );
        await onSaved(saved);
      }}
    >
      <label className="field">
        <span>{t("name")}</span>
        <input
          name="name"
          required
          maxLength={120}
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {!job && (
        <label className="field">
          <span>{t("jobSlug")}</span>
          <input
            name="slug"
            aria-label={t("jobSlug")}
            aria-describedby="job-slug-help"
            required
            maxLength={80}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={slug ?? jobSlug(name)}
            onChange={(event) => setSlug(event.target.value)}
          />
          <small className="muted" id="job-slug-help">
            {t("jobSlugHint")}
          </small>
        </label>
      )}
      <label className="field">
        <span>{t("jobDescription")}</span>
        <textarea
          name="description"
          maxLength={2000}
          defaultValue={job?.description}
        />
      </label>
      <label className="field">
        <span>{t("environment")}</span>
        <Select
          aria-label={t("environment")}
          name="environment"
          defaultValue={job?.environment || "dev"}
        >
          {workspace.catalog.environment_details.map((env) => (
            <option key={env.id} value={env.id}>
              {env.label}
            </option>
          ))}
        </Select>
      </label>
      {!job && (
        <JobVersionFields
          kind={kind}
          reference={ref}
          versions={(kind === "tag" ? tags.data : branches.data) || []}
          onKind={(value) => {
            setKind(value);
            setRef(null);
            setScope("");
          }}
          onReference={(value) => {
            // Keep the chosen target when tags finish loading afterwards.
            setKind(kind);
            setRef(value);
            setScope("");
          }}
        />
      )}
      <div className="field job-scope">
        <span>{t("jobScope")}</span>
        <p title={scope}>
          {scope
            ? displayNodeName(nodes.data?.[scope], t("node"), t)
            : t("jobWholeProject")}
        </p>
        <SearchField
          label={t("jobScope")}
          query={scopeQuery}
          onQuery={setScopeQuery}
          options={scopeOptions}
          inline
          pending={nodes.pending}
          onSelect={(index) => {
            setScope(scopeOptions[index].key);
            setScopeQuery("");
          }}
        />
        <small className="muted">{t("jobScopeSelectHint")}</small>
      </div>
      {(tags.error || branches.error || nodes.error) && (
        <p className="notice error" role="alert">
          {tags.error || branches.error || nodes.error}
        </p>
      )}
    </ModalForm>
  );
}

export function VersionModal({
  job,
  project,
  initialTag = "",
  onClose,
  onSaved,
}: {
  job: Job;
  project: Project;
  initialTag?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [tag, setTag] = useState(initialTag);
  const [kind, setKind] = useState<"tag" | "branch">(
    initialTag ? "tag" : job.target.kind,
  );
  const tags = useApiResource<GitTag[]>(`/worktrees/${project.main}/git/tags`);
  const branches = useApiResource<Branch[]>(
    `/worktrees/${project.main}/git/branches`,
  );
  const review = useApiResource<Review>(
    tag ? withQuery(`/jobs/${job.slug}/version`, { kind, ref: tag }) : null,
  );
  return (
    <ModalForm
      title={t("changeJobVersion")}
      onClose={onClose}
      wide
      submitLabel={t("confirmJobVersion")}
      disabled={!review.data || review.pending}
      onSubmit={async () => {
        const { revision, previous_commit, commit } = review.data!;
        await api(
          `/jobs/${job.slug}/version`,
          send({
            revision,
            previous_commit,
            commit,
            target: { kind, ref: tag },
          }),
        );
        await onSaved();
      }}
    >
      <JobVersionFields
        kind={kind}
        reference={tag}
        versions={(kind === "tag" ? tags.data : branches.data) || []}
        onKind={(value) => {
          setKind(value);
          setTag("");
        }}
        onReference={setTag}
      />
      <h3>{t("compareVersions")}</h3>
      <p className="muted">{t("jobCompareHint")}</p>
      {(review.error || tags.error || branches.error) && (
        <p className="notice error" role="alert">
          {review.error || tags.error || branches.error}
        </p>
      )}
      {review.pending && <PageLoading />}
      {review.data && (
        <>
          <p>
            <code>
              {review.data.previous_commit.slice(0, 8)} →{" "}
              {review.data.commit.slice(0, 8)}
            </code>
          </p>
          <ComparisonView
            report={review.data.comparison}
            storageKey={`job-comparison.${job.slug}`}
          />
        </>
      )}
    </ModalForm>
  );
}
