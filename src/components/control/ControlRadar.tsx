type Props = {
  size?: number;
  active?: boolean;
  rings?: 1 | 2 | 3;
  className?: string;
};

export function ControlRadar({
  size = 48,
  active = false,
  rings = 3,
  className = "",
}: Props) {
  return (
    <svg
      className={`control-radar ${active ? "is-active" : ""} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="13" stroke="#666666" strokeWidth="0.5" fill="none" />
      {rings >= 2 && (
        <circle cx="16" cy="16" r="9" stroke="#666666" strokeWidth="0.4" fill="none" opacity="0.5" />
      )}
      {rings >= 3 && (
        <circle cx="16" cy="16" r="5" stroke="#666666" strokeWidth="0.4" fill="none" opacity="0.5" />
      )}
      {rings >= 2 && (
        <>
          <line x1="3" y1="16" x2="29" y2="16" stroke="#666666" strokeWidth="0.3" opacity="0.3" />
          <line x1="16" y1="3" x2="16" y2="29" stroke="#666666" strokeWidth="0.3" opacity="0.3" />
        </>
      )}
      <g className="sweep">
        <path d="M16,16 L16,3.5 A12.5,12.5 0 0,1 24.04,6.42 Z" fill="#FF3300" opacity="0.35" />
        <line x1="16" y1="16" x2="16" y2="3.5" stroke="#FF3300" strokeWidth="0.9" opacity="0.95" />
      </g>
      <circle className="center" cx="16" cy="16" r="2" fill="#FF3300" />
    </svg>
  );
}
