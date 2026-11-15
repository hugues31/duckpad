/**
 * The Duckpad mark: a duck carrying a pipeline drawn like the canvas, with a
 * square source, a round step, a square export and a curved link. The
 * stylesheet paints the tile. The website's mark and the two favicons
 * (`assets/favicon.svg` here, `website/public/favicon.svg`) repeat this path.
 */
export default function DuckMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      className="duck-mark"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
    >
      <path
        fill="#fff"
        fillRule="evenodd"
        d="M7.92 16.83C9 18.5 10.7 19.5 13 19.5h6a2 2 0 0 0 2-2V12a5 5 0 0 1 10 0v2h4.55a.6 .6 0 0 1 .42 1.03L31 20v2a10 10 0 0 1-10 10h-7a7 7 0 0 1-7-7v-7.9a.5 .5 0 0 1 .92-.27ZM25.65 12a1.35 1.35 0 1 0 2.7 0 1.35 1.35 0 1 0-2.7 0ZM10.7 24a.8 .8 0 0 0-.8 .8v3a.8 .8 0 0 0 .8 .8h3a.8 .8 0 0 0 .8-.8v-.75h2.07A2.45 2.45 0 0 0 21.34 26.09Q22.08 25.44 22.67 24.33 23.52 22.73 24.5 22.65v.75a.8 .8 0 0 0 .8 .8h3a.8 .8 0 0 0 .8-.8v-3a.8 .8 0 0 0-.8-.8h-3a.8 .8 0 0 0-.8 .8v.75Q22.62 21.21 21.34 23.63 21.03 24.21 20.68 24.62A2.45 2.45 0 0 0 16.57 25.55H14.5v-.75a.8 .8 0 0 0-.8-.8Z"
      />
    </svg>
  );
}
