export function CrosshairIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      style={{ display: "block" }}
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="13" stroke="#FFFFFF" strokeWidth="0.8" fill="none" />
      <g stroke="#666666" strokeWidth="0.6">
        <line x1="16" y1="6" x2="16" y2="10" />
        <line x1="16" y1="22" x2="16" y2="26" />
        <line x1="6" y1="16" x2="10" y2="16" />
        <line x1="22" y1="16" x2="26" y2="16" />
      </g>
      <circle cx="16" cy="16" r="4" stroke="#FF3300" strokeWidth="0.8" fill="none" />
      <circle cx="16" cy="16" r="1.8" fill="#FF3300" />
    </svg>
  );
}
