import * as T from 'three';
import type { EchoLifeGame } from '@/lib/echo-life/game/session';
import { acquireLifeAsset, instance, placeOn, releaseLifeAsset } from './assets';
import { getWorldAudio } from '../../echoLife/hudStore';

const BALL = 0.1217;
const RIM = 0.225;
const GRAVITY = 9.81;
export const THREE_POINT_ARC_M = 4.7;
export const COURT_LEAVE_RADIUS_M = 14.0;
/** Lateral right-hand dribble clearance (> 0.21 m hip/bag + 0.1217 m ball radius -> >= +4.8 cm air gap). */
export const DRIBBLE_RIGHT_OFFSET_M = 0.38;
export const DRIBBLE_FORWARD_OFFSET_M = 0.40;
export const DRIBBLE_APEX_HEIGHT_M = 0.76;

type Point = { x: number; z: number };

export type BasketballAnimMode = 'none' | 'dribble' | 'aim' | 'shoot' | 'retrieve';
export type BasketballShotResult = 'none' | 'score_2' | 'score_3' | 'streak_bonus' | 'miss';

export interface BasketballPoseState {
  active: boolean;
  mode: BasketballAnimMode;
  hoopYaw: number;
  hoopDistance: number;
  isThreePointRange: boolean;
  /** Normalized cyclic phase in `[0, 1)`: `0.0` = floor bounce impact, `0.5` = right-hand apex. */
  dribblePhase: number;
  aimPower: number;
  releaseProgress: number;
  ballWorld: { x: number; y: number; z: number };
  score: number;
  streak: number;
  bestStreak: number;
  lastShotPoints: number;
  lastShotResult: BasketballShotResult;
  continuousSession: boolean;
}

export interface BasketballUpdateOptions {
  /** Normalized Space-bar shot power (0..1) while charging a shot. */
  chargingPower?: number;
  /** Player body facing yaw in radians (keeps dribble pocket dynamically on player's right side). */
  playerYaw?: number;
  /** Optional live `hand.R` stage-space coordinates for closed-loop palm-apex coupling. */
  handRight?: { x: number; y: number; z: number } | null;
}

const _rollAxis = new T.Vector3();
const _rollQuat = new T.Quaternion();

function buildFallbackBasketball(): T.Group {
  const group = new T.Group();
  const sphere = new T.Mesh(
    new T.SphereGeometry(BALL, 18, 14),
    new T.MeshStandardMaterial({ color: '#d86628', roughness: 0.68, metalness: 0 }),
  );
  sphere.castShadow = true;
  sphere.receiveShadow = true;
  const seamMat = new T.MeshStandardMaterial({ color: '#1c1816', roughness: 0.85, metalness: 0 });
  const ringA = new T.Mesh(new T.TorusGeometry(BALL + 0.0012, 0.0022, 6, 28), seamMat);
  const ringB = new T.Mesh(new T.TorusGeometry(BALL + 0.0012, 0.0022, 6, 28), seamMat);
  ringB.rotation.y = Math.PI * 0.5;
  group.add(sphere, ringA, ringB);
  group.userData.fallbackBall = true;
  return group;
}

/** Coordinates are in StudyWorld metres. Collision planes use the staged hoop's measured basket anchor. */
export class Basketball {
  private ball: T.Group | null = null;
  private isFallbackBall = false;
  private loading = false;
  private disposed = false;
  private position = new T.Vector3();
  private velocity = new T.Vector3();
  private rim = new T.Vector3();
  private hoopBase = new T.Vector3();
  private normal = new T.Vector3();
  private ground = 0;
  private flight = false;
  private loose = false;
  private scored = false;
  private shotFinished = false;
  private dribbleT = 0;
  private lastDribbleCycle = 0;
  private sessionActive = false;
  private activeGame: EchoLifeGame | null = null;
  private aimPower = 0;
  private shotReleaseTimer = 0;
  private hoopYaw = 0;
  private hoopDistance = 0;
  private lastShotDistance = 0;
  private rimBounceCooldown = 0;
  private backboardCooldown = 0;

  score = 0;
  streak = 0;
  bestStreak = 0;
  lastShotPoints = 0;
  lastShotResult: BasketballShotResult = 'none';
  streakBonusCount = 0;

  constructor(private parent: T.Group) {}

  private playCourtSfx(kind: 'bounce' | 'rim' | 'backboard' | 'swish' | 'shoot' | 'catch', strength: number): void {
    try {
      getWorldAudio().triggerBasketball(kind, strength, {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      });
    } catch {
      /* headless / audio unavailable */
    }
  }

  private rearmContinuousChallenge(): void {
    const game = this.activeGame;
    if (!this.sessionActive || !game) return;
    if (!game.s.challenge) {
      game.s.challenge = {
        type: 'sport',
        start: game.s.elapsed,
        sequence: [0],
        index: 0,
      };
    }
  }

  /** Explicitly exits the continuous shootaround loop and stows the basketball. */
  leaveCourt(game?: EchoLifeGame): void {
    const target = game ?? this.activeGame;
    this.sessionActive = false;
    this.flight = false;
    this.loose = false;
    this.scored = false;
    this.shotFinished = false;
    this.aimPower = 0;
    this.shotReleaseTimer = 0;
    this.velocity.set(0, 0, 0);
    if (this.ball) this.ball.visible = false;
    if (target?.s.challenge?.type === 'sport') {
      target.s.challenge = null;
    }
  }

  /** Updates live shot-charge power (0..1) so the ball gathers smoothly into the shooting pocket. */
  setAimPower(power: number): void {
    this.aimPower = Number.isFinite(power) ? Math.max(0, Math.min(1, power)) : 0;
  }

  collect(p: Point) {
    if (!this.loose || this.flight || Math.hypot(p.x - this.position.x, p.z - this.position.z) > 2.4) {
      return false;
    }
    this.loose = false;
    this.aimPower = 0;
    this.velocity.set(0, 0, 0);
    this.rearmContinuousChallenge();
    if (this.ball && !this.sessionActive) this.ball.visible = false;
    return true;
  }

  summon(p: Point) {
    this.flight = false;
    this.loose = false;
    this.aimPower = 0;
    this.shotReleaseTimer = 0;
    this.position.set(p.x, this.ground + 1.0, p.z);
    this.velocity.set(0, 0, 0);
    this.rearmContinuousChallenge();
  }

  get needsRetrieval() {
    return this.loose;
  }

  get active() {
    return this.flight || this.loose;
  }

  get continuousSession() {
    return this.sessionActive;
  }

  get isThreePointRange() {
    return this.hoopDistance >= THREE_POINT_ARC_M;
  }

  /** Exported pose & orientation contract for the character animator (dribble / aim / shoot / retrieve). */
  get poseState(): BasketballPoseState {
    const active = this.sessionActive || this.flight || this.loose;
    let mode: BasketballAnimMode = 'none';
    if (active) {
      if (this.shotReleaseTimer > 0) mode = 'shoot';
      else if (this.loose || this.flight) mode = 'retrieve';
      else if (this.aimPower > 0.02) mode = 'aim';
      else mode = 'dribble';
    }
    const cycle01 = (((this.dribbleT / Math.PI) % 1) + 1) % 1;
    return {
      active,
      mode,
      hoopYaw: this.hoopYaw,
      hoopDistance: this.hoopDistance,
      isThreePointRange: this.hoopDistance >= THREE_POINT_ARC_M,
      dribblePhase: cycle01,
      aimPower: this.aimPower,
      releaseProgress: this.shotReleaseTimer > 0 ? 1 - this.shotReleaseTimer / 0.55 : 0,
      ballWorld: { x: this.position.x, y: this.position.y, z: this.position.z },
      score: this.score,
      streak: this.streak,
      bestStreak: this.bestStreak,
      lastShotPoints: this.lastShotPoints,
      lastShotResult: this.lastShotResult,
      continuousSession: this.sessionActive,
    };
  }

  near(p: Point) {
    return this.loose && Math.hypot(p.x - this.position.x, p.z - this.position.z) <= 2.4;
  }

  shoot(game: EchoLifeGame, p: Point, power: number) {
    const canShoot = game.s.challenge?.type === 'sport' || this.sessionActive;
    if (this.flight || this.loose || !this.ball || !canShoot) return;
    this.activeGame = game;
    this.sessionActive = true;
    const horizontal = Math.hypot(this.rim.x - p.x, this.rim.z - p.z);
    this.lastShotDistance = horizontal;
    this.hoopDistance = horizontal;
    this.hoopYaw = Math.atan2(this.rim.x - p.x, this.rim.z - p.z);

    // Launch from clean elevated release pocket above head/shoulders
    const baseFloor = game.nav.walk.groundAt(p.x, p.z) ?? this.ground;
    this.position.set(
      p.x + 0.36 * Math.sin(this.hoopYaw) - 0.06 * Math.cos(this.hoopYaw),
      baseFloor + 1.78,
      p.z + 0.36 * Math.cos(this.hoopYaw) + 0.06 * Math.sin(this.hoopYaw),
    );

    const seconds = 0.86 + Math.min(6, horizontal) * 0.075;
    // Optimal sweet spot sits near power = 0.54; short or overpowered releases miss naturally along the aim line.
    const clampedPower = Number.isFinite(power) ? Math.max(0, Math.min(1, power)) : 0.54;
    const strength = 0.72 + 0.52 * clampedPower;
    this.velocity.set(
      ((this.rim.x - this.position.x) * strength) / seconds,
      (this.rim.y - this.position.y) / seconds + (GRAVITY * seconds) / 2,
      ((this.rim.z - this.position.z) * strength) / seconds,
    );
    this.flight = true;
    this.scored = false;
    this.shotFinished = false;
    this.aimPower = 0;
    this.shotReleaseTimer = 0.55;
    this.rimBounceCooldown = 0;
    this.backboardCooldown = 0;
    this.playCourtSfx('shoot', 0.8);
  }

  update(dt: number, game: EchoLifeGame, p: Point, options?: BasketballUpdateOptions) {
    this.activeGame = game;
    if (options?.chargingPower !== undefined) {
      this.setAimPower(options.chargingPower);
    }
    if (this.shotReleaseTimer > 0) {
      this.shotReleaseTimer = Math.max(0, this.shotReleaseTimer - dt);
    }
    if (this.rimBounceCooldown > 0) this.rimBounceCooldown = Math.max(0, this.rimBounceCooldown - dt);
    if (this.backboardCooldown > 0) this.backboardCooldown = Math.max(0, this.backboardCooldown - dt);

    if (game.s.challenge?.type === 'sport') {
      this.sessionActive = true;
    }

    const hoops = game.nav.city.props.filter((pr) => pr.asset === 'hoop-post');
    if (hoops.length > 0) {
      const hoop = hoops.reduce((a, b) =>
        Math.hypot(a.x - p.x, a.z - p.z) < Math.hypot(b.x - p.x, b.z - p.z) ? a : b,
      );
      this.ground = game.nav.walk.groundAt(hoop.x, hoop.z) ?? -3.2;
      this.hoopBase.set(hoop.x, this.ground, hoop.z);
      const scale = (hoop.scaleVal ?? 3.675) / 3.675;
      this.normal.set(Math.sin(hoop.rotY), 0, Math.cos(hoop.rotY));
      this.rim
        .set(hoop.x, this.ground + 3.05 * scale, hoop.z)
        .addScaledVector(this.normal, (0.675 - 0.259) * scale);
      this.hoopDistance = Math.hypot(this.rim.x - p.x, this.rim.z - p.z);
      this.hoopYaw = Math.atan2(this.rim.x - p.x, this.rim.z - p.z);

      // Auto-leave continuous shootaround if player walks > 14 m away from the court
      if (
        this.sessionActive &&
        Math.hypot(p.x - this.hoopBase.x, p.z - this.hoopBase.z) > COURT_LEAVE_RADIUS_M
      ) {
        this.leaveCourt(game);
        return;
      }
    }

    const playing = game.s.challenge?.type === 'sport' || this.sessionActive;
    if (!playing && !this.flight && !this.loose) {
      if (this.ball) this.ball.visible = false;
      return;
    }

    if (!this.loading) {
      this.loading = true;
      if (!this.ball) {
        this.ball = buildFallbackBasketball();
        this.isFallbackBall = true;
        this.parent.add(this.ball);
      }
      void acquireLifeAsset('basketball')
        .then((asset) => {
          if (this.disposed) return;
          if (asset) {
            if (this.ball && this.isFallbackBall) {
              this.ball.removeFromParent();
              disposeFallbackBall(this.ball);
              this.isFallbackBall = false;
            }
            this.ball = instance(asset, [placeOn(asset, 0, -BALL, 0, 0)]);
            this.parent.add(this.ball);
          }
        })
        .catch(() => {
          /* fallback basketball already mounted */
        });
    }

    if (!this.flight && !this.loose) {
      this.rearmContinuousChallenge();
      const baseFloor = game.nav.walk.groundAt(p.x, p.z) ?? this.ground;
      const bodyYaw = options?.playerYaw !== undefined && Number.isFinite(options.playerYaw)
        ? options.playerYaw
        : this.hoopYaw;

      if (this.aimPower > 0.02) {
        // Gather ball cleanly into the elevated shooting pocket in front of chest -> forehead
        const aimYaw = this.hoopYaw;
        const fwdX = Math.sin(aimYaw);
        const fwdZ = Math.cos(aimYaw);
        const rightX = -Math.cos(aimYaw);
        const rightZ = Math.sin(aimYaw);
        const liftY = baseFloor + 1.28 + this.aimPower * 0.42;
        this.position.set(
          p.x + 0.42 * fwdX + 0.04 * rightX,
          liftY,
          p.z + 0.42 * fwdZ + 0.04 * rightZ,
        );
      } else {
        // Rhythmic athletic right-hand crossover dribble anchored to player's live facing yaw
        // Lateral clearance = 0.38 m right + 0.40 m forward (> 0.21 m hip/bag + 0.1217 m ball -> 0 cm clipping!)
        this.dribbleT += dt * 4.6;
        const cycle = Math.floor(this.dribbleT / Math.PI);
        if (cycle !== this.lastDribbleCycle) {
          this.lastDribbleCycle = cycle;
          this.playCourtSfx('bounce', 0.42);
        }
        const cycle01 = (((this.dribbleT / Math.PI) % 1) + 1) % 1;
        const bounce = Math.sin(cycle01 * Math.PI);
        const fwdX = Math.sin(bodyYaw);
        const fwdZ = Math.cos(bodyYaw);
        const rightX = -Math.cos(bodyYaw);
        const rightZ = Math.sin(bodyYaw);

        let bx = p.x + DRIBBLE_FORWARD_OFFSET_M * fwdX + DRIBBLE_RIGHT_OFFSET_M * rightX;
        let by = baseFloor + BALL + bounce * DRIBBLE_APEX_HEIGHT_M;
        let bz = p.z + DRIBBLE_FORWARD_OFFSET_M * fwdZ + DRIBBLE_RIGHT_OFFSET_M * rightZ;

        // Optional closed-loop palm-apex coupling when live hand.R coordinates are supplied
        if (options?.handRight && bounce > 0.65) {
          const palmBlend = (bounce - 0.65) / 0.35;
          const handTargetY = Math.max(baseFloor + BALL + 0.35, options.handRight.y - BALL * 1.05);
          by = T.MathUtils.lerp(by, handTargetY, palmBlend * 0.45);
          const hx = options.handRight.x;
          const hz = options.handRight.z;
          // Enforce strict >= 0.36 m horizontal clearance from player hip/satchel center
          if (Math.hypot(hx - p.x, hz - p.z) >= 0.36) {
            bx = T.MathUtils.lerp(bx, hx, palmBlend * 0.35);
            bz = T.MathUtils.lerp(bz, hz, palmBlend * 0.35);
          }
        }
        this.position.set(bx, by, bz);
        if (this.ball) {
          this.ball.rotation.x += dt * 4.5;
        }
      }
    }

    if (this.flight) {
      const steps = Math.max(1, Math.ceil(dt * 120));
      for (let i = 0; i < steps && this.flight; i++) {
        const h = dt / steps;
        const prevY = this.position.y;
        this.position.addScaledVector(this.velocity, h);
        this.velocity.y -= GRAVITY * h;
        const x = this.position.x - this.rim.x;
        const z = this.position.z - this.rim.z;
        const dy = this.position.y - this.rim.y;
        const radial = Math.hypot(x, z);
        const depth = x * this.normal.x + z * this.normal.z;
        const lateral = x * this.normal.z - z * this.normal.x;

        // Clean swish detection through the rim cylinder
        if (
          !this.scored &&
          this.velocity.y < 0 &&
          prevY >= this.rim.y &&
          dy <= 0 &&
          radial < RIM - BALL * 0.58
        ) {
          this.scored = true;
          this.streak++;
          if (this.streak > this.bestStreak) this.bestStreak = this.streak;
          const isThree = this.lastShotDistance >= THREE_POINT_ARC_M;
          const basePoints = isThree ? 3 : 2;
          const streakBonus = this.streak >= 3 && this.streak % 3 === 0 ? 1 : 0;
          if (streakBonus > 0) this.streakBonusCount++;
          const awarded = basePoints + streakBonus;
          this.score += awarded;
          this.lastShotPoints = awarded;
          this.lastShotResult =
            streakBonus > 0 ? 'streak_bonus' : isThree ? 'score_3' : 'score_2';
          // Net drag gently slows ball drop right through the hoop
          this.velocity.x *= 0.35;
          this.velocity.z *= 0.35;
          this.velocity.y *= 0.65;
        }

        // Physical rim torus deflection along true contact normal
        if (!this.scored && Math.abs(dy) < BALL + 0.03) {
          const dr = radial - RIM;
          const torusDist = Math.hypot(dr, dy);
          if (torusDist < BALL + 0.011 && torusDist > 1e-4) {
            const radX = radial > 1e-4 ? x / radial : 1;
            const radZ = radial > 1e-4 ? z / radial : 0;
            const nx = (dr / torusDist) * radX;
            const ny = dy / torusDist;
            const nz = (dr / torusDist) * radZ;
            const vn = this.velocity.x * nx + this.velocity.y * ny + this.velocity.z * nz;
            if (vn < 0) {
              const e = 0.54; // realistic steel-rim restitution
              this.velocity.x -= (1 + e) * vn * nx;
              this.velocity.y -= (1 + e) * vn * ny;
              this.velocity.z -= (1 + e) * vn * nz;
              // Push clear of torus surface so ball never re-intersects next substep
              const push = BALL + 0.012 - torusDist;
              this.position.x += nx * push;
              this.position.y += ny * push;
              this.position.z += nz * push;
              if (this.rimBounceCooldown <= 0) {
                this.rimBounceCooldown = 0.09;
                this.playCourtSfx('rim', Math.min(1.0, Math.abs(vn) * 0.22 + 0.25));
              }
            }
          }
        }

        // Acrylic backboard deflection with realistic energy absorption
        const into = this.velocity.dot(this.normal);
        if (
          into < 0 &&
          depth < -0.21 &&
          depth > -0.36 &&
          dy > -0.12 &&
          dy < 0.68 &&
          Math.abs(lateral) < 0.62
        ) {
          this.velocity.addScaledVector(this.normal, -1.64 * into);
          this.velocity.y *= 0.86; // backspin friction along glass
          if (this.backboardCooldown <= 0) {
            this.backboardCooldown = 0.09;
            this.playCourtSfx('backboard', Math.min(1.0, Math.abs(into) * 0.2 + 0.25));
          }
        }

        // Per-XY court floor multi-bounce settling
        const floorHere = game.nav.walk.groundAt(this.position.x, this.position.z) ?? this.ground;
        if (this.position.y <= floorHere + BALL) {
          this.position.y = floorHere + BALL;
          const impactSpeed = Math.abs(this.velocity.y);
          if (impactSpeed > 0.48) {
            this.velocity.y = impactSpeed * 0.60;
            this.velocity.x *= 0.86;
            this.velocity.z *= 0.86;
            this.playCourtSfx('bounce', Math.min(1.0, impactSpeed * 0.14 + 0.18));
            // Finish scoring telemetry on first significant ground bounce while letting ball finish bouncing & rolling
            if (!this.shotFinished) {
              this.shotFinished = true;
              if (!this.scored) {
                this.streak = 0;
                this.lastShotPoints = 0;
                this.lastShotResult = 'miss';
              }
              game.finishBasket(this.scored, {
                threePointer: this.lastShotDistance >= THREE_POINT_ARC_M,
                streak: this.streak,
              });
            }
          } else {
            this.velocity.y = 0;
            this.flight = false;
            this.loose = true;
            if (!this.shotFinished) {
              this.shotFinished = true;
              if (!this.scored) {
                this.streak = 0;
                this.lastShotPoints = 0;
                this.lastShotResult = 'miss';
              }
              game.finishBasket(this.scored, {
                threePointer: this.lastShotDistance >= THREE_POINT_ARC_M,
                streak: this.streak,
              });
            }
          }
        }
      }
      if (this.ball) {
        this.ball.rotation.x -= dt * 9.5;
      }
    } else if (this.loose) {
      // Realistic court ground rolling deceleration after bounces settle
      const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
      if (hSpeed > 0.06) {
        const nextX = this.position.x + this.velocity.x * dt;
        const nextZ = this.position.z + this.velocity.z * dt;
        const nextFloor = game.nav.walk.groundAt(nextX, nextZ);
        const distFromHoop = Math.hypot(nextX - this.hoopBase.x, nextZ - this.hoopBase.z);
        if (nextFloor !== null && Math.abs(nextFloor - this.ground) < 0.45 && distFromHoop < 11.5) {
          this.position.set(nextX, nextFloor + BALL, nextZ);
        } else {
          // Soft elastic curb/boundary deflection keeps loose rebound retrievable on court
          this.velocity.x *= -0.45;
          this.velocity.z *= -0.45;
        }
        const drag = Math.exp(-2.2 * dt);
        this.velocity.x *= drag;
        this.velocity.z *= drag;
        if (this.ball) {
          // Roll ball physically around cross(UP, velocity)
          _rollAxis.set(this.velocity.z, 0, -this.velocity.x).normalize();
          const angle = (hSpeed * dt) / BALL;
          _rollQuat.setFromAxisAngle(_rollAxis, angle);
          this.ball.quaternion.premultiply(_rollQuat);
        }
      } else {
        this.velocity.set(0, 0, 0);
      }
    }

    if (this.ball) {
      this.ball.visible = true;
      this.ball.position.copy(this.position);
    }
  }

  dispose() {
    this.disposed = true;
    this.sessionActive = false;
    this.activeGame = null;
    if (this.ball) {
      this.ball.removeFromParent();
      if (this.isFallbackBall) disposeFallbackBall(this.ball);
      this.ball = null;
    }
    if (this.loading) releaseLifeAsset('basketball');
  }
}

function disposeFallbackBall(group: T.Group): void {
  group.traverse((o) => {
    const m = o as T.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    if (Array.isArray(m.material)) m.material.forEach((mt) => mt.dispose());
    else m.material.dispose();
  });
}

export { Basketball as BasketballSim };
