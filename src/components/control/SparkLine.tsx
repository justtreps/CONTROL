type Props = {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
};

export function SparkLine({
  data,
  width = 100,
  height = 24,
  color = "#FF3300",
  strokeWidth = 1,
}: Props) {
  if (data.length === 0) return null;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  const points = data
    .map((val, i) => {
      const x = (i / Math.max(1, data.length - 1)) * width;
      const y =
        height - strokeWidth / 2 - ((val - min) / range) * (height - strokeWidth);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
      />
    </svg>
  );
}
