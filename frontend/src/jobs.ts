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

export function jobInvocation(slug: string) {
  return `# DUCKPAD_SERVER and DUCKPAD_TOKEN come from your environment.
printf 'header = "Authorization: Bearer %s"\\n' "$DUCKPAD_TOKEN" | \\
  curl --fail-with-body --silent --show-error --config - \\
  -H 'Content-Type: application/json' \\
  -d '{"trigger":{"source":"api"}}' \\
  "$DUCKPAD_SERVER/api/v1/jobs/${encodeURIComponent(slug)}/runs"`;
}

export function jobCron(slug: string) {
  return `# Daily at 02:00; configure DUCKPAD_SERVER in the scheduler environment.
0 2 * * * /opt/duckpad/bin/duckpad run ${slug} --token-file /etc/duckpad/job.token --source cron --timeout 2h`;
}
