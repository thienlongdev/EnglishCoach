import * as T from 'three';
import type { VfxTier } from './quality';

const time = { value: 0 };
const impulse = { value: 0 };
const materials = new Set<T.MeshPhysicalMaterial>();

/**
 * Physical Fresnel reflective transparent glass (ZERO `renderTransmissionPass()` opaque double-render!).
 *
 * Previously setting `transmission: 0.94` triggered Three.js's internal transmission pass, rendering all ~350
 * opaque city meshes TWICE per frame on outdoor/balanced views. Defaulting to physical Fresnel transparent
 * glass (`transparent: true`, `roughness: 0.05`, `clearcoat: 1.0`, `envMapIntensity: 1.6`, `transmission: 0`)
 * delivers crisp reflective glazing with zero opaque double-renders while preserving reactive ripple impulses.
 */
export function reactiveGlass(color: T.Color): T.MeshPhysicalMaterial {
  const material = new T.MeshPhysicalMaterial({
    color,
    roughness: 0.04,
    metalness: 0.02,
    transmission: 0,
    transparent: true,
    opacity: 0.18,
    ior: 1.52,
    reflectivity: 0.90,
    clearcoat: 1.0,
    clearcoatRoughness: 0.035,
    envMapIntensity: 1.25,
    depthWrite: false,
    side: T.DoubleSide,
  });
  material.userData.__echoReactiveGlass = true;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEchoGlassTime = time;
    shader.uniforms.uEchoGlassImpulse = impulse;
    shader.fragmentShader =
      'uniform float uEchoGlassTime;\nuniform float uEchoGlassImpulse;\n' +
      shader.fragmentShader
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
normal = normalize(normal + vec3(sin(vViewPosition.y * 32.0 - uEchoGlassTime * 9.0), cos(vViewPosition.x * 29.0 + uEchoGlassTime * 7.0), 0.0) * uEchoGlassImpulse * 0.035);`,
        )
        .replace(
          '#include <opaque_fragment>',
          `// Physical Schlick Fresnel edge-opacity lift: ~0.18 crystal-clear at normal incidence -> ~0.58 at grazing angles.
{
  vec3 gV = normalize(vViewPosition);
  float gFr = pow(1.0 - clamp(abs(dot(normal, gV)), 0.0, 1.0), 4.0);
  diffuseColor.a = clamp(diffuseColor.a + gFr * 0.40, 0.16, 0.58);
}
#include <opaque_fragment>`,
        );
  };
  material.customProgramCacheKey = () => 'echo-reactive-glass-v3';
  materials.add(material);
  material.addEventListener('dispose', () => materials.delete(material));
  return material;
}

export function pulseGlass(): void {
  impulse.value = 0.7;
}

/**
 * Steps glass ripple animations while keeping `transmission = 0` PERMANENTLY locked across every view
 * and doorway transition so Three.js NEVER runs `renderTransmissionPass()` and NEVER sets
 * `material.needsUpdate = true` (`programDelta === 0` invariant!).
 */
export function updateGlass(
  dt: number,
  _tier: VfxTier,
  reduced: boolean,
  _allowTransmission = false,
): void {
  if (!reduced) time.value += Math.min(dt, 0.05);
  impulse.value = reduced ? 0 : impulse.value * Math.exp(-dt * 4);
}
