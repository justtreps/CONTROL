import { DashboardHeader } from "@/components/DashboardHeader";
import { LibraryShowcase } from "./LibraryShowcase";

export const dynamic = "force-dynamic";

export default function LibraryPage() {
  return (
    <>
      <DashboardHeader />
      <LibraryShowcase />
    </>
  );
}
