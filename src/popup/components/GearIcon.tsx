/**
 * The settings gear.
 *
 * Drawn rather than typed. The archive uses the ⚙ character, which Windows
 * renders through a colour emoji font — and the interface has no emoji in it.
 * The rim is a single evenodd path so the centre stays a real hole and does not
 * have to be painted over with a background colour that changes on hover.
 */
export function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
        <rect
          key={angle}
          x="6.8"
          y="0.9"
          width="2.4"
          height="2.9"
          rx="0.5"
          transform={`rotate(${angle} 8 8)`}
        />
      ))}
      {/* fill-rule, not fillRule: Preact sets unrecognised props as attributes
          under the exact name given, and SVG attribute names are case
          sensitive — so the camelCase spelling silently loses the hole. */}
      <path
        fill-rule="evenodd"
        d="M3 8A5 5 0 1 1 13 8 5 5 0 1 1 3 8ZM6 8A2 2 0 1 1 10 8 2 2 0 1 1 6 8Z"
      />
    </svg>
  );
}
