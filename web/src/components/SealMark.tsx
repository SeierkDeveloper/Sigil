// A static seal drawing for the hero. The motion version is part of the design pass.

export function SealMark() {
  const ticks = Array.from({ length: 72 }, (_, i) => i * 5);
  const points = Array.from({ length: 7 }, (_, i) => {
    const a = (i / 7) * Math.PI * 2 - Math.PI / 2;
    return [100 + 46 * Math.cos(a), 100 + 46 * Math.sin(a)] as const;
  });
  const star = points.map((_, i) => points[(i * 3) % 7]);
  return (
    <svg viewBox="0 0 200 200" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="100" cy="100" r="94" strokeWidth="0.75" />
      <circle cx="100" cy="100" r="88" strokeWidth="0.5" opacity="0.6" />
      {ticks.map((deg) => (
        <line key={deg} x1="100" y1="12" x2="100" y2={deg % 30 === 0 ? 20 : 16} strokeWidth="0.6" transform={`rotate(${deg} 100 100)`} />
      ))}
      <circle cx="100" cy="100" r="62" strokeWidth="0.75" />
      <polygon points={star.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")} strokeWidth="0.9" strokeLinejoin="round" />
      {points.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="2.2" strokeWidth="0.75" />
      ))}
      <circle cx="100" cy="100" r="7" strokeWidth="0.75" />
    </svg>
  );
}
