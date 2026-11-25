/** Owner-supplied key art for discovery; the live Garden renderer is independent. */
export function EchoGardenArtwork({ className = "w-full aspect-[1672/941]" }: { className?: string }) {
  return (
    <div className={"relative overflow-hidden rounded-2xl select-none pointer-events-none " + className} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/games/echo-garden/key-art.webp" alt="" width={1672} height={941}
        className="h-full w-full object-cover object-[52%_50%]" loading="lazy" decoding="async" />
    </div>
  );
}
