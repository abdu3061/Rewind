import mascot from "./assets/rewind-mascot.png";

export function Mascot({
  state = "idle",
  className = "",
}: {
  state?: "idle" | "working" | "recording" | "thinking" | "success";
  className?: string;
}) {
  return (
    <img
      src={mascot}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`mascot mascot-${state} ${className}`}
    />
  );
}
