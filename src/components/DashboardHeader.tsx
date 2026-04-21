import { Nav } from "./Nav";
import { SystemWarningBar } from "./SystemWarningBar";

// Per user request: the DryRunBanner was dropped from the dashboard
// header. The DRY_RUN env still gates /api/order at runtime; we just
// don't surface it visually at the top of every page anymore.
export function DashboardHeader() {
  return (
    <>
      <SystemWarningBar />
      <Nav />
    </>
  );
}
