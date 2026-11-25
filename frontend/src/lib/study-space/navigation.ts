/** Deterministic A* over inflated, rotated furniture footprints. Rebuilt only when placement changes. */
export interface NavObstacle { x: number; z: number; width: number; depth: number; rotation: number }
export type NavPoint = { x: number; z: number };
export class RoomNavigation {
  readonly step = 0.12;
  readonly radius = 0.2;
  readonly half: number;
  readonly side: number;
  readonly blocked: Uint8Array;
  constructor(size: number, readonly obstacles: NavObstacle[]) {
    this.half = size / 2 - this.radius;
    this.side = Math.floor(this.half * 2 / this.step) + 1;
    this.blocked = new Uint8Array(this.side * this.side);
    for (let id = 0; id < this.blocked.length; id++) this.blocked[id] = +!this.free(this.point(id));
  }
  free(p: NavPoint) {
    if (Math.abs(p.x) > this.half || Math.abs(p.z) > this.half) return false;
    return !this.obstacles.some(o => {
      const dx = p.x - o.x, dz = p.z - o.z, c = Math.cos(o.rotation), s = Math.sin(o.rotation);
      return Math.abs(c * dx - s * dz) < o.width / 2 + this.radius && Math.abs(s * dx + c * dz) < o.depth / 2 + this.radius;
    });
  }
  private point(id: number): NavPoint { return { x: (id % this.side) * this.step - this.half, z: Math.floor(id / this.side) * this.step - this.half }; }
  private nearest(p: NavPoint, radius: number): number {
    let result = -1, best = radius * radius;
    const requireLine = this.free(p);
    for (let id = 0; id < this.blocked.length; id++) {
      if (this.blocked[id]) continue;
      const q = this.point(id), d = (p.x-q.x)**2+(p.z-q.z)**2;
      if (d <= best && (!requireLine || this.clearLine(p, q))) { best = d; result = id; }
    }
    return result;
  }
  clearLine(a: NavPoint, b: NavPoint) {
    return this.free(a) && this.free(b) && this.motionFraction(a, b) === 1;
  }
  /** Continuous root segment against the same inflated footprints as A*. No corner-skipping or sliding a clip off its path. */
  motionFraction(a: NavPoint, b: NavPoint) {
    if (![a.x, a.z, b.x, b.z].every(Number.isFinite) || Math.abs(a.x) > this.half + 1e-8 || Math.abs(a.z) > this.half + 1e-8) return 0;
    const dx = b.x - a.x, dz = b.z - a.z;
    let fraction = 1;
    for (const [p, d] of [[a.x, dx], [a.z, dz]]) {
      if (d > 0) fraction = Math.min(fraction, (this.half - p) / d);
      else if (d < 0) fraction = Math.min(fraction, (-this.half - p) / d);
    }
    for (const o of this.obstacles) {
      const c = Math.cos(o.rotation), s = Math.sin(o.rotation), x = a.x - o.x, z = a.z - o.z;
      if (Math.min(o.width/2+this.radius-Math.abs(c*x-s*z), o.depth/2+this.radius-Math.abs(s*x+c*z)) > 1e-8) return 0;
      let enter = -Infinity, exit = Infinity;
      for (const [p, d, half] of [[c*x-s*z, c*dx-s*dz, o.width/2+this.radius], [s*x+c*z, s*dx+c*dz, o.depth/2+this.radius]]) {
        if (Math.abs(d) < 1e-12) { if (Math.abs(p) >= half) { exit = -Infinity; break; } }
        else { const t0 = (-half-p)/d, t1 = (half-p)/d; enter = Math.max(enter, Math.min(t0,t1)); exit = Math.min(exit, Math.max(t0,t1)); }
      }
      if (enter < exit && exit > 0 && enter >= -1e-10) fraction = Math.min(fraction, Math.max(0, enter));
    }
    // A numerical inset, not a change to the existing body radius or physics clearance.
    return Math.max(0, Math.min(1, fraction < 1 ? fraction - 1e-7 / Math.max(1e-7, Math.hypot(dx,dz)) : 1));
  }
  path(start: NavPoint, end: NavPoint): NavPoint[] | null {
    if (!this.free(end)) return null;
    if(this.clearLine(start,end)) return [end];
    const from=this.nearest(start,this.free(start)?this.step*2:0.85), to=this.nearest(end,this.step*2);
    if(from<0||to<0) return null;
    const open=new Set([from]), closed=new Set<number>(), previous=new Int32Array(this.blocked.length).fill(-1);
    const cost=new Float64Array(this.blocked.length).fill(Infinity); cost[from]=0;
    const heuristic=(id:number)=>{const p=this.point(id);return Math.hypot(p.x-end.x,p.z-end.z)};
    while(open.size) {
      let current=-1,best=Infinity;
      for(const id of open){const score=cost[id]+heuristic(id);if(score<best){best=score;current=id;}}
      if(current===to) {
        const points:NavPoint[]=[end]; for(let id=to;id!==-1;id=previous[id]) points.unshift(this.point(id));
        // Remove unnecessary corners only when the complete segment is collision-free.
        const route:NavPoint[]=[];let anchor=this.free(start)?start:points[0];
        if(!this.free(start)) route.push(anchor);
        for(let i=1;i<points.length;i++){if(!this.clearLine(anchor,points[i])){anchor=points[i-1];route.push(anchor);}}
        route.push(end); return route;
      }
      open.delete(current);closed.add(current);
      const x=current%this.side,z=Math.floor(current/this.side);
      for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++) {
        if(!dx&&!dz)continue;const nx=x+dx,nz=z+dz;
        if(nx<0||nz<0||nx>=this.side||nz>=this.side)continue;
        const next=nz*this.side+nx;
        if(this.blocked[next]||closed.has(next)||!this.clearLine(this.point(current),this.point(next)))continue;
        const g=cost[current]+this.step*Math.hypot(dx,dz);
        if(g<cost[next]){previous[next]=current;cost[next]=g;open.add(next);}
      }
    }
    return null;
  }
}
