import { isDryRun } from "@/lib/router";
import { DryRunBanner } from "./DryRunBanner";
import { Nav } from "./Nav";
import { SystemWarningBar } from "./SystemWarningBar";

export function DashboardHeader() {
  return (
    <>
      <SystemWarningBar />
      {isDryRun() && <DryRunBanner />}
      <Nav />
    </>
  );
}
