export default function DuckMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <rect width="40" height="40" rx="10" fill="#226bff" />
      <path
        d="M8 19h13v-7a5 5 0 0 1 10 0v2h6l-6 6v2a10 10 0 0 1-10 10H8V19Z"
        fill="#ffffff"
      />
      <path d="M12 25h12l3-3" stroke="#226bff" strokeWidth="2" />
      <path d="M11 23h4v4h-4zM19 23h4v4h-4zM25 19h4v4h-4z" fill="#226bff" />
    </svg>
  );
}
