/** Owner-supplied hero poster; gameplay atlases remain owned by RushScene. */
export function RushArtwork() {
  return (
    <div className="relative aspect-[1672/941] overflow-hidden select-none pointer-events-none" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/games/echo-quiz-rush/key-art.webp" alt="" width={1672} height={941}
        className="h-full w-full object-cover object-[50%_50%]" loading="lazy" decoding="async" />
    </div>
  );
}
