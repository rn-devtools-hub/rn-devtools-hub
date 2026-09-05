/** The bound port and current token are authoritative, including fallback ports. */
export const dashboardLink = ({ projectName, port, token }) => {
  const url = new URL(`http://localhost:${port}/`);
  url.searchParams.set("token", token);
  return { projectName, url: url.href };
};

export const dashboardAnnouncement = (dashboard) =>
  `Before the first hub action in each testing or debugging task, tell the user ` +
  `which project is being tested and show a clickable Markdown link to its dashboard. ` +
  `Current dashboard: ${JSON.stringify(dashboard)}. ` +
  `Use the exact URL, including its port and token. Continue the task immediately; ` +
  `do not wait for the user to open the link. Announce once per task, and again ` +
  `if the project or dashboard URL changes. Keep this local dashboard link in ` +
  `the conversation, not in committed files or public reports.`;
