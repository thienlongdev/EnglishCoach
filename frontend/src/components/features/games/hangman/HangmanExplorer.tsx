/** The atlas's assembled pose supplies continuous painted limbs. Keep each bent
 * arm/hand and leg/boot together: the detached source pieces contain hollow sockets.
 * All polygons use original 1254px atlas coordinates, never CSS compensation. */
const ATLAS = '/assets/hangman/explorer-atlas.png';
import { EXPLORER_SOURCE_ROOT as ROOT, EXPLORER_SCALE, EXPLORER_NECK, EXPLORER_REST, EXPLORER_GRIPS, type ExplorerPose } from './hangmanRig';
const LIMBS = {
  leftArm: { anchor: [1038, 1046], polygon: '965,978 985,970 1008,990 1036,1019 1054,1034 1050,1058 1027,1063 1002,1045 974,1007' },
  rightArm: { anchor: [1138, 1042], polygon: '1129,1024 1160,1006 1179,978 1198,974 1212,995 1176,1041 1155,1061 1128,1060' },
  leftLeg: { anchor: [1067, 1116], polygon: '1028,1090 1089,1090 1089,1146 1062,1178 1075,1204 1062,1245 970,1245 970,1203 998,1167 996,1124' },
  rightLeg: { anchor: [1123, 1116], polygon: '1089,1090 1158,1090 1184,1124 1184,1167 1237,1202 1253,1245 1111,1245 1111,1198 1124,1173 1093,1146' },
} as const;
function Atlas({ clip }: { clip: string }) {
  return <image href={ATLAS} width="1254" height="1254" clipPath={`url(#${clip})`} />;
}
function Limb({ name, angle, preview = false }: { name: keyof typeof LIMBS; angle: number; preview?: boolean }) {
  const { anchor, polygon } = LIMBS[name], id = `hm-explorer-${name}`;
  return <g transform={`translate(${anchor.join(' ')})`}>
    <g className={`hm-joint-${name}`} transform={`rotate(${angle})`}>
      <g transform={`translate(${-anchor[0]} ${-anchor[1]})`}>
        <defs><clipPath id={id}><polygon points={polygon}/></clipPath></defs><Atlas clip={id}/>
        {(name==='leftArm'||name==='rightArm')&&<Hand side={name==='leftArm'?0:1} preview={preview}/>}
      </g>
    </g>
  </g>;
}
function Hand({ side, preview }: { side: 0|1; preview: boolean }) {
  const grip=EXPLORER_GRIPS[side],id=`hm-open-hand-${side}`;
  const open=side===0?'929,898 1009,898 1008,974 986,983 965,988 938,978 929,971':'1168,925 1253,925 1253,1008 1212,1010 1196,996 1179,990 1168,977';
  return <>
    <g className="hm-hand-open" opacity={preview?0:undefined}><defs><clipPath id={id}><polygon points={open}/></clipPath></defs><Atlas clip={id}/></g>
    <g className="hm-hand-grip" opacity={preview?1:undefined} data-grip-side={side===0?'LEFT':'RIGHT'} data-anatomical-hand={grip.anatomy} transform={`translate(${grip.wrist.join(' ')}) rotate(${grip.angle}) scale(${grip.scale}) translate(${-grip.sourceWrist[0]} ${-grip.sourceWrist[1]})`}>
      <svg x={grip.crop[0]} y={grip.crop[1]} width={grip.crop[2]} height={grip.crop[3]} viewBox={grip.crop.join(' ')} overflow="hidden"><image href="/assets/hangman/grip-atlas.png" width="1254" height="1254"/></svg>
    </g>
  </>;
}
function Face({ crop, neck, name }: { crop: readonly number[]; neck: readonly number[]; name: string }) {
  return <g className={`hm-face-${name}`} transform={`translate(${ROOT.join(' ')}) scale(.52) translate(${-neck[0]} ${-neck[1]})`}>
    <svg x={crop[0]} y={crop[1]} width={crop[2]} height={crop[3]} viewBox={crop.join(' ')} overflow="hidden">
      <image href={ATLAS} width="1254" height="1254"/>
      {name==='defeated'&&<g className="hm-x-eyes" stroke="#563127" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round">
        {/* Cover only pupils INSIDE the painted eye whites. All skin, nose,
            cheek texture and the original mouth outline remain atlas pixels. */}
        <g fill="#fff8e8" stroke="none"><ellipse cx="1084" cy="188" rx="12" ry="21"/><ellipse cx="1142" cy="180" rx="12" ry="21"/></g>
        <path d="M1059 173l30 31m0-31-30 31M1127 165l30 31m0-31-30 31" strokeWidth="8"/>
        <path d="M1107 274q8 15 18 3l-2-13q-9-4-16 10Z" fill="#e18d91" strokeWidth="4"/>
      </g>}
    </svg>
  </g>;
}
export function ExplorerRig({ pose = EXPLORER_REST, preview = false }: { pose?: ExplorerPose; preview?: boolean }) {
  return <g className="hm-person hm-painted-person" transform={`translate(${EXPLORER_NECK.join(' ')}) scale(${EXPLORER_SCALE})`}>
    <g transform={`translate(${-ROOT[0]} ${-ROOT[1]})`}>
      {/* Torso is the common parent. Painted cuff/hip overlap covers the joint cuts. */}
      <g className="hm-explorer-torso">
        <Limb name="leftLeg" angle={pose.leftLeg}/><Limb name="rightLeg" angle={pose.rightLeg}/>
        <defs><clipPath id="hm-explorer-torso-cut"><polygon points="1029,1039 1054,1028 1128,1028 1149,1034 1151,1096 1134,1134 1114,1143 1087,1128 1069,1143 1038,1130 1024,1103"/></clipPath></defs>
        <Atlas clip="hm-explorer-torso-cut"/>
        <g transform={`translate(${ROOT.join(' ')})`}><g className="hm-joint-head" transform={`rotate(${pose.head})`}><g transform={`translate(${-ROOT[0]} ${-ROOT[1]})`}>
          <Face name="idle" crop={[28,0,280,338]} neck={[177,316]}/>
          {!preview&&<><Face name="happy" crop={[330,0,286,338]} neck={[486,322]}/>
          <Face name="worried" crop={[632,0,302,338]} neck={[785,322]}/>
          <Face name="panic" crop={[944,0,308,338]} neck={[1103,322]}/>
          <Face name="defeated" crop={[944,0,308,338]} neck={[1103,322]}/>
          {/* Small eyelid overlays share the head transform and only show during idle blink. */}
          <g className="hm-painted-blink" transform="translate(1088 1044) scale(.52) translate(-177 -316)" fill="#f3c38c" stroke="#603c28" strokeWidth="3">
            <path d="M126 185q19-23 42 0v32q-20 12-42-1Zm84-8q19-24 37-1v30q-19 13-37 0Z" stroke="none"/><path d="M128 207q19 8 38-2m46-5q17 7 33-2" fill="none"/>
          </g></>}
        </g></g></g>
      </g>
      {/* During transfer the wrists pass in front of the cap. Keep the complete
          arm sprites in this foreground layer with their painted cuff overlap. */}
      <g className="hm-explorer-arms"><Limb name="leftArm" angle={pose.leftArm} preview={preview}/><Limb name="rightArm" angle={pose.rightArm} preview={preview}/></g>
    </g>
  </g>;
}
