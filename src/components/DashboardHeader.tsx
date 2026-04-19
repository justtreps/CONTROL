import { isDryRun } from "@/lib/router";
import { DryRunBanner } from "./DryRunBanner";
import { Nav } from "./Nav";

export function DashboardHeader() {
  return (
    <>
      {isDryRun() && <DryRunBanner />}
      <Nav />
    </>
  );
}
