import * as THREE from 'three';
import { loadWhaleRig, type WhaleRig } from '@/components/landing/ocean/whaleRig';
import { ECHO_MODEL_URL } from '@/components/landing/ocean/echoAssets';

/**
 * Echo swims through the sky beside the local runner — the English Coach guide made visible. Echo only REACTS to
 * events the authority already decided (a door opened, a door refused, a burst, the finish); it never hints at a door.
 * The model is optional: if it cannot load, the race is unaffected.
 */
export class SkyEcho {
  readonly root = new THREE.Group();
  private rig: WhaleRig | null = null;
  private abort = new AbortController();
  private roll = 0; private rollTarget = 0;
  private dip = 0; private surge = 0; private cheer = 0;
  private position = new THREE.Vector3(-2.6, 2.6, 0);
  private ready = false;

  constructor(private onLoaded: () => void = () => {}) {
    this.root.visible = false;
    void loadWhaleRig(ECHO_MODEL_URL, this.abort.signal).then(rig => {
      if (this.abort.signal.aborted) { rig.dispose(); return; }
      this.rig = rig; rig.root.scale.setScalar(1.55); this.root.add(rig.root); this.ready = true; this.onLoaded();
    }).catch(() => { /* Echo is decoration; the race never waits for it. */ });
  }

  get loaded() { return this.ready; }

  react(kind: 'correct' | 'wrong' | 'dash' | 'rush' | 'finish' | 'streak') {
    if (kind === 'correct') { this.rollTarget += Math.PI * 2; this.cheer = 1; }
    if (kind === 'streak') { this.rollTarget += Math.PI * 2; this.cheer = 1.3; }
    if (kind === 'wrong') this.dip = 1;
    if (kind === 'dash' || kind === 'rush') this.surge = kind === 'rush' ? 1.4 : .8;
    if (kind === 'finish') { this.rollTarget += Math.PI * 4; this.cheer = 2; }
  }

  update(dt: number, time: number, runner: THREE.Vector3, speed01: number, reduced: boolean, mode: 'race' | 'attract' | 'celebrate') {
    if (!this.rig) return;
    this.root.visible = true;
    const k = 1 - Math.exp(-dt * 2.2);
    let target: THREE.Vector3;
    if (mode === 'race') {
      // Ahead-left of the runner, high enough never to cover a door or its banner line of sight.
      target = new THREE.Vector3(runner.x * .3 - 4.4, 4.3 + (reduced ? 0 : Math.sin(time * .9) * .35) - this.dip * 1.1 + this.cheer * .6, runner.z - 7 - this.surge * 3.2);
    } else if (mode === 'attract') {
      const a = time * .35;
      target = new THREE.Vector3(Math.cos(a) * 4.2, 2.6 + Math.sin(time * .8) * .5, runner.z - 1.5 + Math.sin(a) * 3.2);
    } else {
      const a = time * .6;
      target = new THREE.Vector3(Math.cos(a) * 3.2, 3.1 + Math.sin(time * 1.2) * .4, runner.z + Math.sin(a) * 2.4);
    }
    const previous = this.position.clone();
    this.position.lerp(target, reduced ? 1 : k);
    const velocity = this.position.clone().sub(previous).divideScalar(Math.max(dt, 1e-3));
    this.root.position.copy(this.position);
    // Face the direction of travel (the race goes −Z); bank into turns, barrel-roll on cheers.
    const heading = mode === 'race' ? Math.PI + Math.atan2(velocity.x, -Math.min(-2, velocity.z)) * .6 : Math.atan2(velocity.x, velocity.z);
    this.root.rotation.set(0, heading, 0);
    this.roll += (this.rollTarget - this.roll) * (reduced ? 1 : 1 - Math.exp(-dt * 3));
    this.rig.root.rotation.z = reduced ? 0 : this.roll + Math.sin(time * .7) * .08 - velocity.x * .03;
    this.dip = Math.max(0, this.dip - dt * 1.4); this.surge = Math.max(0, this.surge - dt * 1.1); this.cheer = Math.max(0, this.cheer - dt * .9);
    if (reduced) this.rig.pose();
    else this.rig.update(dt, .35 + speed01 * 1.1 + this.surge * .6, Math.min(1, this.cheer + this.surge * .5));
    this.rig.setWaterLight(time, .25);
  }

  dispose() {
    this.abort.abort();
    this.rig?.dispose(); this.rig = null;
  }
}
