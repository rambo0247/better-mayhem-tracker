import { useId, type SVGProps } from "react";

/**
 * The app's mark: a slanted gold plate with an italic M cut into it, and a
 * spark (the Mayhem augment flash) sitting in the corner clipped off the plate.
 */
export default function BrandMark(props: SVGProps<SVGSVGElement>) {
  const id = useId();
  const plate = `${id}-plate`;
  const sheen = `${id}-sheen`;
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden {...props}>
      <defs>
        <linearGradient id={plate} x1="6" y1="2" x2="34" y2="38" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f6e3b0" />
          <stop offset="0.45" stopColor="#d4b273" />
          <stop offset="1" stopColor="#8f6c2f" />
        </linearGradient>
        <linearGradient id={sheen} x1="20" y1="2" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* plate: a parallelogram with its top-right corner clipped */}
      <path d="M9 4h20l5 5-7.4 29H1z" fill={`url(#${plate})`} />
      <path d="M9 4h20l5 5-2.3 9H5.6z" fill={`url(#${sheen})`} />
      {/* the M, leaning with the plate */}
      <path
        d="M7.6 31.5 11.9 11l6.3 11.2L26.6 11l-4.3 20.5"
        stroke="#0a1024"
        strokeWidth="4"
        strokeLinejoin="miter"
        strokeLinecap="butt"
        strokeMiterlimit="12"
      />
      {/* spark in the clipped corner */}
      <path
        d="M35.5 0.5 36.6 3.4l2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9-2.9-1.1 2.9-1.1z"
        fill="#f2dca6"
      />
    </svg>
  );
}
