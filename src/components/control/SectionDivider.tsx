export function SectionDivider({ label }: { label?: string }) {
  return (
    <div className="divider">
      <span className="line" />
      {label && <span className="label">{label}</span>}
      <span className="line" />
    </div>
  );
}
