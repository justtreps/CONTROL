import { Nav } from "./Nav";
import { SystemWarningBar } from "./SystemWarningBar";

// Dry-run mode is surfaced via a chip in the dashboard hero (see
// DashboardClient.tsx → ToggleChip "DRY RUN") rather than a banner
// at the top of every page. Source of truth is SystemToggle.dryRunMode
// (DB), not the legacy DRY_RUN env var.
export function DashboardHeader() {
  return (
    <>
      <SystemWarningBar />
      <Nav />
    </>
  );
}
