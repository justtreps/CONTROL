export function DryRunBanner() {
  return (
    <div className="bg-yellow-100 border-b border-yellow-300 text-yellow-900 text-sm px-6 py-2 text-center">
      <strong>Mode test actif</strong> —{" "}
      <code className="bg-yellow-200/60 px-1 rounded">DRY_RUN=true</code>.{" "}
      <code>/api/order</code> simule les placements, aucune commande
      BulkMedya n&apos;est engagée.
    </div>
  );
}
