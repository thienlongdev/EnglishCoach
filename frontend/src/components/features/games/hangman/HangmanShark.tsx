import type { RefObject } from 'react';
const ATLAS = '/assets/hangman/shark-atlas.png';
import { SHARK_SCALE, SHARK_HINGE, JAW_SOURCE_HINGE, mouthBridge } from './hangmanRig';
function Part({ crop, x, y, scale, clip }: { crop: readonly [number,number,number,number]; x: number; y: number; scale: number; clip?: string }) {
  return <svg x={x} y={y} width={crop[2]*scale} height={crop[3]*scale} viewBox={crop.join(' ')} overflow="hidden" aria-hidden="true"><image href={ATLAS} width="1254" height="1254" clipPath={clip}/></svg>;
}
export function SharkRig({ jawRef, pupilsRef, mouthRef, open = 4 }: { jawRef?: RefObject<SVGGElement|null>; pupilsRef?: RefObject<SVGGElement|null>; mouthRef?: RefObject<SVGPathElement|null>; open?: number }) {
  return <g className="hm-shark-body">
    <defs>
      {/* Body crop shares a row with the jaw: exclude neighbouring teeth below the belly. */}
      <clipPath id="hm-shark-body-cut"><polygon points="20,109 625,109 625,429 540,445 460,520 20,520"/></clipPath>
      <linearGradient id="hm-mouth-inner" x2="0" y2="1"><stop stopColor="#48223e"/><stop offset="1" stopColor="#9b4568"/></linearGradient>
    </defs>
    {/* Root sockets overlap the body at every bounded swim angle. Atlas padding
        is excluded from the attachment calculation, not treated as painted skin. */}
    <g transform="translate(89 8)"><g className="hm-joint-tail"><Part crop={[973,125,267,465]} x={-5.88} y={-60.9} scale={.21}/></g></g>
    <g className="hm-dorsal-fin" transform="translate(-3 -36) rotate(28)"><Part crop={[48,798,344,313]} x={-1.12} y={-41.6} scale={.16}/></g>
    <path ref={mouthRef} className="hm-mouth-bridge" d={mouthBridge(open)} fill="url(#hm-mouth-inner)" stroke="#24283c" strokeWidth="1"/>
    <g transform={`translate(${SHARK_HINGE.join(' ')})`}><g ref={jawRef} className="hm-joint-jaw" transform={`rotate(${-open})`}>
      <Part crop={[577,437,363,210]} x={(577-JAW_SOURCE_HINGE[0])*SHARK_SCALE} y={(437-JAW_SOURCE_HINGE[1])*SHARK_SCALE} scale={SHARK_SCALE}/>
    </g></g>
    <Part crop={[20,109,605,411]} x={-120} y={-88} scale={SHARK_SCALE} clip="url(#hm-shark-body-cut)"/>
    <g ref={pupilsRef} className="hm-shark-pupils" fill="#18253a"><ellipse cx={-64} cy={-62} rx="1.8" ry="3"/><ellipse cx={-33} cy={-47} rx="2" ry="3"/></g>
    <g transform="translate(50 24)"><g className="hm-joint-fin"><Part crop={[393,906,308,216]} x={-3.04} y={-10.07} scale={.19}/></g></g>
  </g>;
}
