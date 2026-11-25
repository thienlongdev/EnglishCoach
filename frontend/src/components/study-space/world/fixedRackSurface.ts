import * as T from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

/** Partition only the authored rack's disconnected surfaces. The previous
 * single native trimesh made CCD traverse unrelated surfaces at every step.
 * This changes neither the drawing nor the geometric union. Clips remain
 * static here until the separately qualified articulated mechanism is wired. */
export function fixedRackSurface(R: typeof RAPIER, root: T.Object3D, toStage: T.Matrix4, articulated = false, storage = false): RAPIER.ColliderDesc[] | null {
  const descriptors: RAPIER.ColliderDesc[] = [];
  let sourceTriangles = 0;
  root.updateWorldMatrix(true, true);
  try {
    root.traverse(object => {
      const mesh = object as T.Mesh;
      if (storage && mesh.userData.rackStoragePart === 1) return;
      if (!mesh.isMesh || mesh.userData.blob || mesh.userData.noCollision || (articulated && Number.isInteger(mesh.userData.rackFinger))) return;
      const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
      if (!position) throw new Error('Rack surface has no positions');
      const points = Array.from({ length: position.count }, (_, i) => new T.Vector3().fromBufferAttribute(position, i));
      if (points.some(p => !Number.isFinite(p.x + p.y + p.z))) throw new Error('Invalid rack vertex');
      const count = index?.count ?? position.count;
      if (count % 3) throw new Error('Invalid rack triangles');
      const faces = Array.from({ length: count / 3 }, (_, i) => [0, 1, 2].map(j => index ? index.getX(i * 3 + j) : i * 3 + j));
      sourceTriangles += faces.length;
      const parent = points.map((_, i) => i), same = new Map<string, number>();
      const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      points.forEach((p, i) => {
        const key = p.toArray().join(','), other = same.get(key);
        if (other === undefined) same.set(key, i); else parent[find(i)] = find(other);
      });
      for (const face of faces) {
        if (face.some(i => !Number.isInteger(i) || i < 0 || i >= points.length)) throw new Error('Invalid rack face');
        for (const i of face.slice(1)) parent[find(i)] = find(face[0]);
      }
      const components = new Map<number, number[][]>();
      for (const face of faces) {
        const key = find(face[0]);
        if (!components.has(key)) components.set(key, []);
        components.get(key)!.push(face);
      }
      const transform = toStage.clone().multiply(mesh.matrixWorld), p = new T.Vector3(), q = new T.Quaternion(), scale = new T.Vector3();
      transform.decompose(p, q, scale);
      const rebuilt = new T.Matrix4().compose(p, q, scale);
      if (scale.x <= 0 || scale.y <= 0 || scale.z <= 0 || transform.elements.some((v, i) => Math.abs(v - rebuilt.elements[i]) > 1e-9)) throw new Error('Unsupported rack shear/reflection');
      for (const component of components.values()) {
        const triangles = component.map(face => new T.Triangle(...face.map(i => points[i]) as [T.Vector3, T.Vector3, T.Vector3]));
        const retained = triangles.map((triangle, i) => ({ triangle, i })).filter(({ triangle }) => triangle.getArea() > 0);
        // Prove source-coordinate zero-area faces wholly redundant before any
        // scale/rotation/Float32 conversion can introduce numerical slivers.
        const closest = new T.Vector3();
        for (const triangle of triangles) if (triangle.getArea() === 0 && !retained.some(({ triangle: owner }) =>
          [triangle.a, triangle.b, triangle.c].every(v => owner.closestPointToPoint(v, closest).distanceTo(v) < 1e-12))) throw new Error('Uncovered rack boundary');
        const used = [...new Set(retained.flatMap(({ i }) => component[i]))], remap = new Map(used.map((i, j) => [i, j]));
        if (!used.length) throw new Error('Empty rack surface');
        const vertices = new Float32Array(used.flatMap(i => points[i].clone().multiply(scale).toArray()));
        const indices = new Uint32Array(retained.flatMap(({ i }) => component[i].map(j => remap.get(j)!)));
        descriptors.push(R.ColliderDesc.trimesh(vertices, indices).setTranslation(p.x, p.y, p.z).setRotation(q));
      }
    });
    // Unknown/fallback art retains the complete existing collision path.
    return sourceTriangles === (articulated ? 1044 : 1396) && descriptors.length === (articulated ? 11 : 19) ? descriptors : null;
  } catch { return null; }
}
