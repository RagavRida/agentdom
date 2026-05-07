'use client';

/**
 * AgentDOM Logo — "Agent Seeing & Executing"
 *
 * Visual metaphor:
 *   • Outer ring  — the agent's awareness / perception field
 *   • Scanning eye — pupil that moves left → right (reading/observing)
 *   • Execution pulse — a bolt/ring that fires outward after each scan
 *   • Corner nodes — data inputs being read
 */
export default function AgentLogo({
  size = 28,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  const id = 'adl'; // unique prefix for filter IDs

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="AgentDOM"
    >
      <defs>
        {/* Glow filter for the eye */}
        <filter id={`${id}-glow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Radial gradient for the iris */}
        <radialGradient id={`${id}-iris`} cx="50%" cy="50%" r="50%">
          <stop offset="0%"  stopColor="#f97316" />
          <stop offset="60%" stopColor="#ea580c" />
          <stop offset="100%" stopColor="#c2410c" stopOpacity="0.6" />
        </radialGradient>

        {/* Gradient for the outer ring */}
        <linearGradient id={`${id}-ring`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"  stopColor="#f97316" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#fb923c" stopOpacity="0.3" />
        </linearGradient>
      </defs>

      {/* ── Outer awareness ring (slow rotation) ── */}
      <circle
        cx="16" cy="16" r="14.5"
        stroke="url(#adl-ring)"
        strokeWidth="0.75"
        strokeDasharray="4 2.5"
        fill="none"
        opacity="0.6"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 16 16"
          to="360 16 16"
          dur="8s"
          repeatCount="indefinite"
        />
      </circle>

      {/* ── Inner ring (counter-rotation, faster) ── */}
      <circle
        cx="16" cy="16" r="11"
        stroke="#f97316"
        strokeWidth="0.5"
        strokeDasharray="2 4"
        fill="none"
        opacity="0.3"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="360 16 16"
          to="0 16 16"
          dur="5s"
          repeatCount="indefinite"
        />
      </circle>

      {/* ── Eye sclera (white of the eye) ── */}
      <ellipse
        cx="16" cy="16" rx="8" ry="5.5"
        fill="#0f172a"
        stroke="#f97316"
        strokeWidth="1"
        filter={`url(#${id}-glow)`}
      />

      {/* ── Iris / pupil (moves left → right → left, scanning) ── */}
      <circle cx="16" cy="16" r="3.2" fill={`url(#${id}-iris)`} filter={`url(#${id}-glow)`}>
        {/* Scan: move pupil left→right→left */}
        <animate
          attributeName="cx"
          values="13;19;13"
          dur="2.4s"
          keyTimes="0;0.5;1"
          keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
          calcMode="spline"
          repeatCount="indefinite"
        />
      </circle>

      {/* ── Inner pupil highlight ── */}
      <circle r="1.1" fill="white" opacity="0.85">
        <animate
          attributeName="cx"
          values="12.5;18.5;12.5"
          dur="2.4s"
          keyTimes="0;0.5;1"
          keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
          calcMode="spline"
          repeatCount="indefinite"
        />
        <animate
          attributeName="cy"
          values="15;15;15"
          dur="2.4s"
          repeatCount="indefinite"
        />
      </circle>

      {/* ── Execution pulse ring (fires every scan cycle) ── */}
      <circle cx="16" cy="16" r="6" fill="none" stroke="#f97316" strokeWidth="1.5" opacity="0">
        <animate
          attributeName="r"
          values="6;15;15"
          dur="2.4s"
          keyTimes="0;0.4;1"
          begin="1.2s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          values="0.8;0;0"
          dur="2.4s"
          keyTimes="0;0.4;1"
          begin="1.2s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="stroke-width"
          values="1.5;0.3;0"
          dur="2.4s"
          keyTimes="0;0.4;1"
          begin="1.2s"
          repeatCount="indefinite"
        />
      </circle>

      {/* ── Corner nodes (data inputs being read) ── */}
      {[
        { cx: 4,  cy: 4  },
        { cx: 28, cy: 4  },
        { cx: 4,  cy: 28 },
        { cx: 28, cy: 28 },
      ].map(({ cx, cy }, i) => (
        <circle key={i} cx={cx} cy={cy} r="1.2" fill="#f97316" opacity="0.5">
          <animate
            attributeName="opacity"
            values="0.5;1;0.5"
            dur="2.4s"
            begin={`${i * 0.6}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values="1.2;1.8;1.2"
            dur="2.4s"
            begin={`${i * 0.6}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </svg>
  );
}
