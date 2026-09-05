import { describe, expect, it } from "vitest";
// @ts-expect-error untyped server module
import { dashboardLink, dashboardAnnouncement } from "../server/dashboard-link.mjs";

describe("project dashboard announcement", () => {
  it("uses the bound port and preserves tokens with URL-reserved characters", () => {
    const dashboard = dashboardLink({ projectName: "Project X", port: 8976, token: "a&b+#?/" });
    const url = new URL(dashboard.url);
    expect(dashboard.projectName).toBe("Project X");
    expect(url.origin).toBe("http://localhost:8976");
    expect([...url.searchParams]).toEqual([["token", "a&b+#?/"]]);
    expect(url.hash).toBe("");
  });

  it("refreshes the announcement when the hub port or token changes", () => {
    const first = dashboardLink({ projectName: "Project X", port: 8973, token: "old" });
    const next = dashboardLink({ projectName: "Project Y", port: 8974, token: "new" });
    expect(next.url).not.toBe(first.url);
    const instruction = dashboardAnnouncement(next);
    expect(instruction).toContain(JSON.stringify(next));
    expect(instruction).not.toContain(first.url);
    expect(instruction).toContain("Continue the task immediately");
  });
});
