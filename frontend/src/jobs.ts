/** A suggested slug keeps the user's override independent from the display name. */
export function jobSlug(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80)
    .replace(/^-|-$/g, "");
}

export function jobInvocation(slug: string, server: string) {
  return `# DUCKPAD_TOKEN holds an API token allowed to run this Job.
printf 'header = "Authorization: Bearer %s"\\n' "$DUCKPAD_TOKEN" | \\
  curl --fail-with-body --silent --show-error --config - \\
  -H 'Content-Type: application/json' \\
  -d '{"trigger":{"source":"api"}}' \\
  "${server}/api/v1/jobs/${encodeURIComponent(slug)}/runs"`;
}

export function jobCron(slug: string, server: string) {
  return `# Daily at 02:00, with the API token stored in /etc/duckpad/job.token.
0 2 * * * DUCKPAD_SERVER=${server} /opt/duckpad/bin/duckpad run ${slug} --token-file /etc/duckpad/job.token --source cron --timeout 2h`;
}
