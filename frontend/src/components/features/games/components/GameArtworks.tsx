import React from "react";

/**
 * Owner-approved Games Library Hero Artwork:
 * Majestic cosmic blue whale (Echo Whale mascot) with realistic blue whale anatomy,
 * glowing bioluminescent cyan & azure light currents, stardust trail. The Games Hub places, masks and blends it as the sky
 * of its scene (the className carries all of that); the picture itself is unchanged.
 */
export function HeroArenaMascotArtwork({ className = "w-full h-full" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/games/hero-whale-key-art.webp"
      alt=""
      aria-hidden="true"
      width={1376}
      height={768}
      className={`select-none pointer-events-none ${className}`}
      loading="eager"
      decoding="async"
      draggable={false}
    />
  );
}

/**
 * Owner-approved key art for Card Blast:
 * Kinetic space defense, neon card projectiles, and planetary atmosphere.
 */
export function CardBlastArtwork({ className = "w-full aspect-[16/9]" }: { className?: string }) {
  return (
    <div className={"relative overflow-hidden select-none pointer-events-none " + className} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/games/card-blast/key-art.webp"
        alt=""
        width={1024}
        height={576}
        className="h-full w-full object-cover object-center"
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

/**
 * Owner-approved key art for Word Chain:
 * Floating sky islands, Echo Whale, and glowing E-C-H-O letter chain.
 */
export function WordChainArtwork({ className = "w-full aspect-[16/9]" }: { className?: string }) {
  return (
    <div className={"relative overflow-hidden select-none pointer-events-none " + className} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/games/word-chain/key-art.webp"
        alt=""
        width={1024}
        height={576}
        className="h-full w-full object-cover object-center"
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

/**
 * Original vector artwork for Word Chain Hero & Lobby:
 * Holographic Acoustic Resonance Beacon & Connected Letter Lattice.
 * Replaces any generic website whale/avatar/logo in Word Chain.
 */
export function WordChainHeroArtwork({ className = "w-16 h-16" }: { className?: string }) {
  return (
    <div className={`relative select-none pointer-events-none flex items-center justify-center ${className}`}>
      <svg
        viewBox="0 0 80 80"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full object-contain"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="wch-glow" x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse">
            <stop stopColor="#2DD4BF" />
            <stop offset="0.6" stopColor="#0284C7" />
            <stop offset="1" stopColor="#6366F1" />
          </linearGradient>
        </defs>

        {/* Acoustic Sonar Rings */}
        <circle cx="40" cy="40" r="36" stroke="#2DD4BF" strokeOpacity="0.25" strokeWidth="1.5" strokeDasharray="3 5" />
        <circle cx="40" cy="40" r="28" stroke="#38BDF8" strokeOpacity="0.4" strokeWidth="1.5" />

        {/* Central Hexagonal Core */}
        <polygon
          points="40,16 60,28 60,52 40,64 20,52 20,28"
          fill="url(#wch-glow)"
          stroke="#99F6E4"
          strokeWidth="2"
        />

        {/* Connected Node Linkers */}
        <line x1="40" y1="16" x2="40" y2="64" stroke="#FFFFFF" strokeWidth="1.5" strokeOpacity="0.7" />
        <line x1="20" y1="40" x2="60" y2="40" stroke="#FFFFFF" strokeWidth="1.5" strokeOpacity="0.7" />

        {/* Center Rune */}
        <circle cx="40" cy="40" r="7" fill="#042F2E" stroke="#FFFFFF" strokeWidth="1.5" />
        <text x="40" y="44" fill="#5EEAD4" fontSize="11" fontWeight="900" textAnchor="middle">∞</text>
      </svg>
    </div>
  );
}

/** Four original miniature game worlds; illustrations never use player avatars. */
export function WordChainModeArtwork({ mode }: { mode: 'solo' | 'echo' | 'quick' | 'private' }) {
  const colors = {solo:['#123b3a','#40d5ae'],echo:['#242052','#9b9eff'],quick:['#472839','#ffc974'],private:['#12334c','#70d7f7']}[mode];
  return <div className="relative -mx-2 mb-5 h-36 overflow-hidden rounded-2xl bg-slate-950 motion-safe:group-hover:scale-[1.025] transition-transform duration-500 motion-reduce:transition-none">
    <svg viewBox="0 0 420 170" fill="none" className="h-full w-full" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="420" height="170" fill={colors[0]}/><circle cx="315" cy="29" r="98" fill={colors[1]} fillOpacity=".07"/>
      <path d="M0 146 Q86 91 169 141 T420 125 V170 H0Z" fill="#020c21" fillOpacity=".6"/>
      <ellipse cx="209" cy="145" rx="137" ry="15" stroke={colors[1]} strokeOpacity=".3"/>
      {mode==='solo' && <g><path d="M112 119 L176 75 L277 107 L222 145Z" fill="#28564b" stroke="#5ff6bb" strokeOpacity=".3"/><path d="M159 114 L189 88 L228 105 L207 128Z" fill="#14312d"/><path d="M178 105 V61 H220 V118" fill="#21786c" stroke="#b5ffdf" strokeWidth="2"/><path d="M168 63 L200 40 L231 63Z" fill="#80e5c0"/><rect x="187" y="76" width="25" height="27" rx="5" fill="#072e2d"/><text x="200" y="97" textAnchor="middle" fill="#aeffe0" fontWeight="900" fontSize="22">A</text><path d="M249 94 Q272 55 298 73" stroke="#79e1bc" strokeWidth="2" strokeDasharray="4 5"/><rect x="277" y="47" width="29" height="35" rx="6" transform="rotate(15 277 47)" fill="#3b9c83"/><text x="288" y="70" fill="#d5ffed" fontSize="18">B</text></g>}
      {mode==='echo' && <g><ellipse cx="232" cy="126" rx="94" ry="24" stroke="#b7baff" strokeOpacity=".4"/><path d="M148 100 C167 43 256 40 284 80 C310 121 251 143 208 120 L180 102 C160 119 135 115 113 85 C142 78 155 91 161 95Z" fill="#6e9ce5" stroke="#d9e7ff" strokeWidth="2"/><path d="M192 110 Q237 127 290 98 Q268 142 214 121Z" fill="#d4ecff"/><path d="M205 92 Q182 104 200 138 Q226 126 230 113Z" fill="#4165b8"/><ellipse cx="268" cy="84" rx="6" ry="9" fill="#11234d"/><circle cx="270" cy="80" r="2" fill="white"/><path d="M269 105 Q279 112 286 101" stroke="#253960" strokeWidth="2"/><circle cx="314" cy="52" r="17" stroke="#c2bfff"/><text x="314" y="59" textAnchor="middle" fill="#e3e1ff" fontSize="22" fontWeight="800">E</text><path d="M300 64 L284 77" stroke="#c2bfff" strokeDasharray="3 3"/></g>}
      {mode==='quick' && <g><path d="M210 35 L186 90 H210 L197 137 L240 75 H216 L235 35Z" fill="#ffe6ad"/><g transform="translate(112 63) rotate(-14)"><rect width="60" height="75" rx="12" fill="#ae565c" stroke="#ffc4ad" strokeWidth="2"/><text x="30" y="51" textAnchor="middle" fill="#fff1dc" fontSize="43" fontWeight="900">A</text></g><g transform="translate(272 49) rotate(14)"><rect width="60" height="75" rx="12" fill="#7161a9" stroke="#c6bdff" strokeWidth="2"/><text x="30" y="51" textAnchor="middle" fill="#f5efff" fontSize="43" fontWeight="900">Z</text></g><path d="M56 86 H92 M65 101 H88 M338 78 H381 M341 94 H368" stroke="#ffcd9c" strokeWidth="3" strokeLinecap="round"/></g>}
      {mode==='private' && <g><path d="M162 94 Q211 39 261 94" stroke="#87e7ff" strokeWidth="4" strokeDasharray="5 7"/><g transform="translate(111 65)"><rect width="58" height="66" rx="13" fill="#1f749b" stroke="#b2f0ff" strokeWidth="2"/><rect x="17" y="29" width="24" height="23" rx="5" fill="#b2f0ff"/><path d="M22 29 V23 a7 7 0 0 1 14 0 V29" stroke="#b2f0ff" strokeWidth="3"/></g><g transform="translate(256 65)"><rect width="58" height="66" rx="13" fill="#345b98" stroke="#b2d6ff" strokeWidth="2"/><text x="29" y="44" textAnchor="middle" fill="#e2f5ff" fontWeight="900" fontSize="31">B</text></g><circle cx="211" cy="58" r="17" fill="#122f4c" stroke="#96e8ff"/><path d="M203 58 H219 M211 50 V66" stroke="#96e8ff" strokeWidth="2"/></g>}
      <g fill={colors[1]} opacity=".6"><circle cx="60" cy="42" r="2"/><circle cx="354" cy="131" r="3"/><circle cx="331" cy="32" r="2"/></g>
    </svg>
  </div>;
}

/**
 * Owner-approved key art for Hangman (Image B):
 * Polished ocean-adventure illustration with orange-clothed boy, shark character,
 * ocean waves and floating alphabet tiles.
 */
export function HangmanArtwork({ className = "w-full aspect-[16/9]" }: { className?: string }) {
  return (
    <div className={"relative overflow-hidden select-none pointer-events-none " + className} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/games/hangman/key-art.webp"
        alt=""
        width={1024}
        height={576}
        className="h-full w-full object-cover object-center"
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

