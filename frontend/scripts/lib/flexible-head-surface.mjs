// Offline qualification shared by the head-contact experiments. No application
// imports this module yet. Geometry, attachment and deformation stay mesh-local;
// the eventual rigid-body owner supplies the pose and the rod solver supplies
// node translations/rotations. This module never moves an object or a body.
import * as T from 'three';

/** Recover authored open tubes through triangle adjacency, not world-height
 * sorting. UV/normal seams are welded only when their float positions match
 * exactly. The larger boundary is the attachment on tapered fibres; a capped
 * strand has just its root boundary. Unsupported topology fails explicitly. */
export function fibreTopology(geometry) {
  const position = geometry.getAttribute('position'), index = geometry.index;
  if (!position || position.itemSize !== 3) throw new Error('Head requires 3D positions');
  const points = [], ids = [], parents = [], welded = new Map(), triangles = [], edges = new Map();
  const find = i => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
  const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  for (let i = 0; i < position.count; i++) {
    const p = new T.Vector3().fromBufferAttribute(position, i), k = p.toArray().join(',');
    let id = welded.get(k);
    if (id === undefined) { id = points.length; points.push(p); parents.push(id); welded.set(k, id); }
    ids.push(id);
  }
  const count = index?.count ?? position.count;
  if (count % 3) throw new Error('Head requires triangles');
  for (let i = 0; i < count; i += 3) {
    const source = [0, 1, 2].map(k => index ? index.getX(i + k) : i + k), t = source.map(i => ids[i]);
    if (new Set(t).size !== 3) throw new Error('Degenerate head triangle');
    parents[find(t[1])] = find(t[0]); parents[find(t[2])] = find(t[0]);
    triangles.push({ source, welded: t });
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3], edge = key(a, b);
      if (!edges.has(edge)) edges.set(edge, { a, b, count: 0 });
      if (++edges.get(edge).count > 2) throw new Error('Nonmanifold head edge');
    }
  }
  const groups = new Map(), neighbours = points.map(() => []), boundary = points.map(() => []);
  for (let i = 0; i < points.length; i++) {
    const id = find(i); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(i);
  }
  for (const { a, b, count } of edges.values()) {
    neighbours[a].push(b); neighbours[b].push(a);
    if (count === 1) { boundary[a].push(b); boundary[b].push(a); }
  }
  const fibres = [], vertexBinding = new Array(points.length);
  for (const vertices of groups.values()) {
    const left = new Set(vertices.filter(i => boundary[i].length)), loops = [];
    for (const i of left) if (boundary[i].length !== 2) throw new Error('Open or branched fibre boundary');
    while (left.size) {
      const first = left.values().next().value, loop = []; let last = -1, at = first;
      do {
        if (!left.delete(at)) throw new Error('Intersecting fibre boundaries');
        loop.push(at); const next = boundary[at].find(i => i !== last); last = at; at = next;
      } while (at !== first);
      loops.push(loop);
    }
    if (loops.length < 1 || loops.length > 2) throw new Error('Expected one or two fibre boundaries');
    const perimeter = loop => loop.reduce((s, id, i) => s + points[id].distanceTo(points[loop[(i + 1) % loop.length]]), 0);
    loops.sort((a, b) => perimeter(b) - perimeter(a));
    if (loops.length === 2 && perimeter(loops[0]) <= perimeter(loops[1]) * 1.01) throw new Error('Ambiguous fibre attachment');
    const root = loops[0], distance = new Map(root.map(i => [i, 0])), queue = [...root];
    for (let i = 0; i < queue.length; i++) for (const n of neighbours[queue[i]]) if (!distance.has(n)) {
      distance.set(n, distance.get(queue[i]) + 1); queue.push(n);
    }
    const rings = [];
    for (const id of vertices) { const ring = distance.get(id); (rings[ring] ??= []).push(id); }
    if (rings.length < 2 || rings.some(r => r.length !== root.length)) throw new Error('Fibre is not an authored ring chain');
    const centers = rings.map(r => r.reduce((s, i) => s.add(points[i]), new T.Vector3()).multiplyScalar(1 / r.length));
    const lengths = [0];
    for (let i = 1; i < centers.length; i++) {
      const length = centers[i].distanceTo(centers[i - 1]);
      if (length < 1e-8) throw new Error('Zero-length fibre segment');
      lengths.push(lengths[i - 1] + length);
    }
    const fibre = { rings, centers, lengths, length: lengths.at(-1), vertices, triangles: [] };
    const fibreId = fibres.length;
    for (let ring = 0; ring < rings.length; ring++) for (const id of rings[ring]) vertexBinding[id] = { fibre: fibreId, s: lengths[ring] };
    fibres.push(fibre);
  }
  for (const triangle of triangles) {
    const bindings = triangle.welded.map(i => vertexBinding[i]);
    if (!bindings.every(b => b.fibre === bindings[0].fibre)) throw new Error('Triangle crosses fibres');
    triangle.s = bindings.map(b => b.s); fibres[bindings[0].fibre].triangles.push(triangle);
  }
  return { fibres, points, sourceIds: ids, sourceTriangles: triangles.length };
}

function sample(centers, lengths, s) {
  let i = 0;
  while (i < lengths.length - 2 && lengths[i + 1] < s) i++;
  const t = T.MathUtils.clamp((s - lengths[i]) / (lengths[i + 1] - lengths[i]), 0, 1);
  return { i, t, center: centers[i].clone().lerp(centers[i + 1], t) };
}

/** Subdivide the ORIGINAL triangles along their material coordinate. This
 * retains every triangle's plane, perimeter, UVs and seam normals at rest;
 * interpolating whole rings instead would change the twisted tapered surface.
 * The resulting visible vertices are also available to contact queries. */
export function headSurface(source, maxSegmentLength = .012) {
  if (!(maxSegmentLength > 0 && Number.isFinite(maxSegmentLength))) throw new Error('Invalid segment length');
  const topology = fibreTopology(source), positions = [], normals = [], uvs = [], bindings = [];
  const a = source.getAttribute('position'), n = source.getAttribute('normal'), uv = source.getAttribute('uv');
  if (!n || !uv) throw new Error('Head requires authored normals and UVs');
  const nodes = topology.fibres.map(f => {
    const lengths = [0];
    for (let i = 1; i < f.lengths.length; i++) {
      const start = f.lengths[i - 1], length = f.lengths[i] - start, count = Math.ceil(length / maxSegmentLength);
      for (let j = 1; j <= count; j++) lengths.push(start + length * j / count);
    }
    return { lengths, centers: lengths.map(s => sample(f.centers, f.lengths, s).center) };
  });
  const mix = (p, q, t) => ({ s: T.MathUtils.lerp(p.s, q.s, t), p: p.p.clone().lerp(q.p, t), n: p.n.clone().lerp(q.n, t), uv: p.uv.clone().lerp(q.uv, t) });
  const clip = (poly, value, lower) => {
    const out = [], inside = v => lower ? v.s >= value : v.s <= value;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length], pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) out.push(mix(p, q, (value - p.s) / (q.s - p.s)));
    }
    return out;
  };
  for (let f = 0; f < topology.fibres.length; f++) for (const triangle of topology.fibres[f].triangles) {
    const original = triangle.source.map((id, k) => ({ s: triangle.s[k], p: new T.Vector3().fromBufferAttribute(a, id), n: new T.Vector3().fromBufferAttribute(n, id), uv: new T.Vector2().fromBufferAttribute(uv, id) }));
    const low = Math.min(...triangle.s), high = Math.max(...triangle.s), cuts = low === high ? [low, high] : [low, ...nodes[f].lengths.filter(s => s > low && s < high), high];
    for (let c = 0; c < cuts.length - 1; c++) {
      const poly = low === high ? original : clip(clip(original, cuts[c], true), cuts[c + 1], false);
      for (let k = 1; k < poly.length - 1; k++) {
        const tri = [poly[0], poly[k], poly[k + 1]];
        if (new T.Triangle(...tri.map(v => v.p)).getArea() < 1e-16) continue;
        for (const v of tri) {
          const rest = sample(nodes[f].centers, nodes[f].lengths, v.s);
          positions.push(...v.p.toArray()); normals.push(...v.n.clone().normalize().toArray()); uvs.push(...v.uv.toArray());
          bindings.push({ fibre: f, segment: rest.i, t: rest.t, radial: v.p.clone().sub(rest.center) });
        }
      }
    }
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const restNormals = new Float32Array(normals), restPositions = geometry.attributes.position.array.slice();
  const states = nodes.map(f => ({ centers: f.centers.map(p => p.clone()), rotations: f.centers.map(() => new T.Quaternion()) }));
  // Every cut is at a material node, including each original authored ring.
  // Cache one transform per node, not a quaternion interpolation/allocation per
  // triangle vertex. UV/normal seams retain their separate visible vertices.
  const offsets = [], transforms = new Float64Array(nodes.reduce((n, f) => n + f.centers.length, 0) * 12);
  let total = 0;
  for (const f of nodes) { offsets.push(total); total += f.centers.length; }
  const nodeOf = new Uint32Array(bindings.length), radial = new Float64Array(bindings.length * 3);
  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i], node = b.t < .5 ? b.segment : b.segment + 1;
    if (Math.min(b.t, 1 - b.t) > 1e-8) throw new Error('Surface cut missed a material node');
    nodeOf[i] = offsets[b.fibre] + node; b.radial.toArray(radial, i * 3);
  }
  geometry.attributes.position.setUsage(T.DynamicDrawUsage); geometry.attributes.normal.setUsage(T.DynamicDrawUsage);
  const write = (pose = states) => {
    if (pose.length !== nodes.length || pose.some((f, i) => f.centers.length !== nodes[i].centers.length || f.rotations.length !== nodes[i].centers.length)) throw new Error('Head pose topology mismatch');
    // Validate the whole pose before writing any drawing, so a bad solver
    // output cannot leave a partially updated surface.
    if (pose.some(f => f.centers.some(p => !Number.isFinite(p.x + p.y + p.z)) || f.rotations.some(q => !Number.isFinite(q.x + q.y + q.z + q.w) || Math.abs(q.lengthSq() - 1) > 1e-5))) throw new Error('Invalid head pose');
    let at = 0;
    for (const f of pose) for (let i = 0; i < f.centers.length; i++) {
      const q = f.rotations[i], p = f.centers[i], x = q.x, y = q.y, z = q.z, w = q.w;
      transforms[at++] = 1 - 2 * (y * y + z * z); transforms[at++] = 2 * (x * y - z * w); transforms[at++] = 2 * (x * z + y * w);
      transforms[at++] = 2 * (x * y + z * w); transforms[at++] = 1 - 2 * (x * x + z * z); transforms[at++] = 2 * (y * z - x * w);
      transforms[at++] = 2 * (x * z - y * w); transforms[at++] = 2 * (y * z + x * w); transforms[at++] = 1 - 2 * (x * x + y * y);
      transforms[at++] = p.x; transforms[at++] = p.y; transforms[at++] = p.z;
    }
    const positions = geometry.attributes.position.array, normals = geometry.attributes.normal.array, m = transforms;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < bindings.length; i++) {
      const b = i * 3, t = nodeOf[i] * 12, x = radial[b], y = radial[b + 1], z = radial[b + 2];
      const px = m[t] * x + m[t + 1] * y + m[t + 2] * z + m[t + 9];
      const py = m[t + 3] * x + m[t + 4] * y + m[t + 5] * z + m[t + 10];
      const pz = m[t + 6] * x + m[t + 7] * y + m[t + 8] * z + m[t + 11];
      positions[b] = px; positions[b + 1] = py; positions[b + 2] = pz;
      minX = Math.min(minX, px); minY = Math.min(minY, py); minZ = Math.min(minZ, pz);
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); maxZ = Math.max(maxZ, pz);
      const nx = restNormals[b], ny = restNormals[b + 1], nz = restNormals[b + 2];
      normals[b] = m[t] * nx + m[t + 1] * ny + m[t + 2] * nz;
      normals[b + 1] = m[t + 3] * nx + m[t + 4] * ny + m[t + 5] * nz;
      normals[b + 2] = m[t + 6] * nx + m[t + 7] * ny + m[t + 8] * nz;
    }
    geometry.attributes.position.needsUpdate = geometry.attributes.normal.needsUpdate = true;
    geometry.boundingBox.min.set(minX, minY, minZ); geometry.boundingBox.max.set(maxX, maxY, maxZ);
    geometry.boundingBox.getCenter(geometry.boundingSphere.center);
    geometry.boundingSphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * .5;
  };
  return { topology, nodes, states, bindings, geometry, restPositions, write, dispose: () => geometry.dispose() };
}
