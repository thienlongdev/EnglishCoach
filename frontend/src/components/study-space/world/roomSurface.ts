/** Keep every source triangle, including degenerates, with identical Float32
 * coordinates and winding. Spatial leaves let native broad-phase CCD reject
 * distant room surfaces before running triangle/mesh casts. No hull, caps,
 * thickness, simplified mesh or collision filtering is introduced. */
export function roomSurfaceParts(vertices: Float32Array, indices: Uint32Array) {
  const faces = Array.from({ length: indices.length / 3 }, (_, i) => i);
  const parts: { vertices: Float32Array; indices: Uint32Array }[] = [];
  const center = (face: number, axis: number) => (
    vertices[indices[face * 3] * 3 + axis] +
    vertices[indices[face * 3 + 1] * 3 + axis] +
    vertices[indices[face * 3 + 2] * 3 + axis]
  ) / 3;
  const split = (subset: number[]) => {
    if (subset.length > 64) {
      const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
      for (const face of subset) for (let axis = 0; axis < 3; axis++) {
        const c = center(face, axis); low[axis] = Math.min(low[axis], c); high[axis] = Math.max(high[axis], c);
      }
      const span = high.map((value, axis) => value - low[axis]);
      const axis = span.indexOf(Math.max(...span));
      subset.sort((a, b) => center(a, axis) - center(b, axis) || a - b);
      const half = Math.floor(subset.length / 2);
      split(subset.slice(0, half)); split(subset.slice(half));
      return;
    }
    // Long trim faces on opposite walls can share a connected component.
    // A leaf spanning both walls makes CCD visit distant triangles whenever
    // a moving tool crosses the empty space between them. Keep long faces
    // together only if their bounds occupy the same 12.5 cm bands.
    const bands = new Map<string, number[]>();
    for (const face of subset) {
      const bounds: number[] = [];
      let longest = 0;
      for (let axis = 0; axis < 3; axis++) {
        const a = vertices[indices[face * 3] * 3 + axis];
        const b = vertices[indices[face * 3 + 1] * 3 + axis];
        const c = vertices[indices[face * 3 + 2] * 3 + axis];
        const lo = Math.min(a, b, c), hi = Math.max(a, b, c);
        bounds.push(Math.round(lo * 8), Math.round(hi * 8));
        longest = Math.max(longest, hi - lo);
      }
      const key = longest >= 1 ? bounds.join(',') : 'local';
      const band = bands.get(key);
      if (band) band.push(face); else bands.set(key, [face]);
    }
    for (const band of bands.values()) emit(band);
  };
  const emit = (subset: number[]) => {
    const local: number[] = [], remap = new Map<number, number>(), points: number[] = [];
    for (const face of subset) for (let corner = 0; corner < 3; corner++) {
      const source = indices[face * 3 + corner];
      if (!remap.has(source)) {
        remap.set(source, points.length / 3);
        points.push(vertices[source * 3], vertices[source * 3 + 1], vertices[source * 3 + 2]);
      }
      local.push(remap.get(source)!);
    }
    if (local.length) parts.push({ vertices: new Float32Array(points), indices: new Uint32Array(local) });
  };
  // Keep disconnected authored surfaces apart first. A floor triangle spans
  // the entire room; grouping it with a nearby window frame would give all
  // that frame's triangles the floor's broad-phase bounds again.
  const parent = Array.from({ length: vertices.length / 3 }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  // Render geometry may duplicate vertices for normals/UVs. Share only their
  // connectivity when coordinates are exactly equal; retain the original bits
  // in every output face. This matches indexed and non-indexed mesh topology.
  const same = new Map<string, number>();
  for (let i = 0; i < parent.length; i++) {
    const key = `${vertices[i * 3]},${vertices[i * 3 + 1]},${vertices[i * 3 + 2]}`;
    const other = same.get(key);
    if (other === undefined) same.set(key, i); else parent[i] = other;
  }
  for (const face of faces) for (let corner = 1; corner < 3; corner++)
    parent[find(indices[face * 3 + corner])] = find(indices[face * 3]);
  const components = new Map<number, number[]>();
  for (const face of faces) {
    const component = find(indices[face * 3]);
    if (!components.has(component)) components.set(component, []);
    components.get(component)!.push(face);
  }
  for (const component of components.values()) split(component);
  return parts;
}
