type Level = "info" | "warn" | "error" | "ok";

export function LogLine({
  time,
  level = "info",
  message,
}: {
  time: string;
  level?: Level;
  message: string;
}) {
  return (
    <div className={`log-line log-line--${level}`}>
      <span className="log-time">{time}</span>
      <span className="log-level">[{level.toUpperCase()}]</span>
      <span className="log-message">{message}</span>
    </div>
  );
}
