/**
 * Villagers on screen.
 *
 * 2D pixel sprites in a 3D world, billboarded around Y only - they turn to face
 * the camera as you orbit, but they stay standing up, which is the whole trick
 * behind the 2.5D look. Facing direction is derived from where the villager is
 * heading relative to the camera, so walking away really does show you their
 * back.
 */
import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  Texture,
} from 'three';
import { angleDelta, dampAngle } from '../core/mathx';
import { Villager } from '../sim/villager';
import { BoxBuilder } from './voxelBuilder';
import { COLS, FACING, POSE, PoseName, ROWS, bubbleTexture, createVillagerTexture } from './spriteFactory';

const SPRITE_WIDTH = 0.95;
const SPRITE_HEIGHT = 1.28;

const CARRY_COLORS: Record<string, number> = {
  wood: 0x9a6b3c,
  stone: 0x9a9791,
  food: 0xc0563a,
};

interface VillagerView {
  group: Group;
  body: Mesh;
  material: MeshLambertMaterial;
  texture: Texture;
  bubble: Sprite;
  bubbleMaterial: SpriteMaterial;
  carry: Mesh;
  shadow: Mesh;
  /** Smoothed facing, so sprites do not snap between atlas rows. */
  smoothedFacing: number;
  lastIcon: string;
}

export class VillagerRenderer {
  readonly group = new Group();
  private views = new Map<number, VillagerView>();
  private bodyGeometry = new PlaneGeometry(SPRITE_WIDTH, SPRITE_HEIGHT);
  private shadowGeometry = new CircleGeometry(0.38, 12);
  private shadowTexture = createBlobTexture();
  private shadowMaterial: MeshBasicMaterial;
  private carryGeometry = new BoxBuilder().add(0, 0, 0, 0.3, 0.3, 0.3, 0xffffff, { flat: true }).build();
  private selection: Mesh;
  private selectionTime = 0;
  /** Player setting: some people would rather just watch the village. */
  showBubbles = true;

  constructor() {
    this.group.name = 'villagers';
    // Origin at the feet, so positioning is just "stand here on the ground".
    this.bodyGeometry.translate(0, SPRITE_HEIGHT / 2, 0);

    // Point every normal straight up.
    //
    // A billboard's real normal faces the camera, which means a villager with
    // the sun behind them turns into a black silhouette every afternoon. With
    // the normal pinned to +Y they take the same light as the grass they are
    // standing on: bright at noon, blue at dusk, and always readable.
    const normals = this.bodyGeometry.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 1, 0);
    normals.needsUpdate = true;
    this.shadowGeometry.rotateX(-Math.PI / 2);

    this.shadowMaterial = new MeshBasicMaterial({
      map: this.shadowTexture,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      color: 0x1a2028,
    });

    const ring = new RingGeometry(0.44, 0.56, 24);
    ring.rotateX(-Math.PI / 2);
    this.selection = new Mesh(
      ring,
      new MeshBasicMaterial({
        color: 0xffd98a,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      }),
    );
    this.selection.visible = false;
    this.selection.renderOrder = 3;
    this.group.add(this.selection);
  }

  /**
   * Syncs every sprite to its villager.
   * `cameraAngle` is the camera's azimuth, used for billboarding and facing.
   */
  update(villagers: Villager[], cameraAngle: number, dt: number, selectedId: number | null): void {
    const alive = new Set<number>();
    this.selectionTime += dt;

    for (const villager of villagers) {
      alive.add(villager.id);
      let view = this.views.get(villager.id);
      if (!view) {
        view = this.createView(villager);
        this.views.set(villager.id, view);
      }

      const groundY = villager.y;
      view.group.position.set(villager.x, groundY, villager.z);
      // Y-axis billboard: always square-on to the camera, never tipped.
      view.group.rotation.y = cameraAngle;

      view.smoothedFacing = dampAngle(view.smoothedFacing, villager.facing, 9, dt);
      const pose = poseFor(villager);
      const row = facingRow(view.smoothedFacing, cameraAngle, pose);
      const col = frameFor(villager, pose);
      view.texture.offset.set(col / COLS, 1 - (row + 1) / ROWS);

      // A small bob while walking and a lean while working sell the animation
      // without needing extra frames.
      if (villager.anim === 'walk' || villager.anim === 'carry') {
        view.body.position.y = Math.abs(Math.sin(villager.animTime * 9)) * 0.045;
      } else if (villager.anim === 'work') {
        view.body.position.y = Math.sin(villager.animTime * 6) * 0.03;
      } else {
        view.body.position.y = Math.sin(villager.animTime * 1.6) * 0.012;
      }

      // Carried goods ride in front of the sprite.
      if (villager.carry) {
        view.carry.visible = true;
        (view.carry.material as MeshBasicMaterial).color.setHex(
          CARRY_COLORS[villager.carry.resource] ?? 0xaaaaaa,
        );
        view.carry.position.set(0, 0.62 + view.body.position.y, 0.22);
      } else {
        view.carry.visible = false;
      }

      // Speech bubble.
      if (this.showBubbles && villager.bubble !== 'none' && villager.bubbleTimer > 0) {
        if (view.lastIcon !== villager.bubble) {
          view.bubbleMaterial.map = bubbleTexture(villager.bubble);
          view.bubbleMaterial.needsUpdate = true;
          view.lastIcon = villager.bubble;
        }
        view.bubble.visible = true;
        const fade = Math.min(1, villager.bubbleTimer);
        view.bubbleMaterial.opacity = fade;
        view.bubble.position.y = SPRITE_HEIGHT + 0.22 + Math.sin(villager.animTime * 2.2) * 0.03;
      } else {
        view.bubble.visible = false;
      }

      view.shadow.position.y = 0.035;
      view.shadow.scale.setScalar(villager.isAsleep ? 1.15 : 1);
    }

    // Remove sprites for villagers that no longer exist.
    for (const [id, view] of this.views) {
      if (alive.has(id)) continue;
      this.disposeView(view);
      this.views.delete(id);
    }

    const selected = selectedId ? this.views.get(selectedId) : undefined;
    if (selected) {
      this.selection.visible = true;
      this.selection.position.copy(selected.group.position);
      this.selection.position.y += 0.06;
      const pulse = 0.72 + Math.sin(this.selectionTime * 4) * 0.22;
      (this.selection.material as MeshBasicMaterial).opacity = pulse;
      this.selection.scale.setScalar(1 + Math.sin(this.selectionTime * 4) * 0.06);
    } else {
      this.selection.visible = false;
    }
  }

  /** World position of a villager's sprite, for screen-space UI anchoring. */
  positionOf(id: number): { x: number; y: number; z: number } | undefined {
    const view = this.views.get(id);
    if (!view) return undefined;
    return { x: view.group.position.x, y: view.group.position.y, z: view.group.position.z };
  }

  private createView(villager: Villager): VillagerView {
    const group = new Group();
    const texture = createVillagerTexture(villager.look);
    texture.repeat.set(1 / COLS, 1 / ROWS);

    const material = new MeshLambertMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.5,
      side: DoubleSide,
    });

    const body = new Mesh(this.bodyGeometry, material);
    body.name = `villager:${villager.id}`;
    body.userData.villagerId = villager.id;
    group.add(body);

    const bubbleMaterial = new SpriteMaterial({
      map: bubbleTexture('chat'),
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    const bubble = new Sprite(bubbleMaterial);
    bubble.scale.set(0.46, 0.46, 1);
    bubble.position.y = SPRITE_HEIGHT + 0.22;
    bubble.visible = false;
    group.add(bubble);

    const carry = new Mesh(this.carryGeometry, new MeshBasicMaterial({ color: 0xffffff }));
    carry.visible = false;
    group.add(carry);

    // Blob shadow: cheaper than shadow-mapping a billboard, and it never
    // flickers as the sprite turns.
    const shadow = new Mesh(this.shadowGeometry, this.shadowMaterial);
    shadow.renderOrder = 1;
    group.add(shadow);

    this.group.add(group);
    return {
      group,
      body,
      material,
      texture,
      bubble,
      bubbleMaterial,
      carry,
      shadow,
      smoothedFacing: villager.facing,
      lastIcon: 'chat',
    };
  }

  /** Meshes to hit-test against when the player taps a villager. */
  pickables(): Mesh[] {
    return Array.from(this.views.values()).map((view) => view.body);
  }

  private disposeView(view: VillagerView): void {
    this.group.remove(view.group);
    view.material.dispose();
    view.texture.dispose();
    view.bubbleMaterial.dispose();
    (view.carry.material as MeshBasicMaterial).dispose();
    view.group.clear();
  }

  dispose(): void {
    for (const view of this.views.values()) this.disposeView(view);
    this.views.clear();
    this.bodyGeometry.dispose();
    this.shadowGeometry.dispose();
    this.shadowTexture.dispose();
    this.shadowMaterial.dispose();
    this.carryGeometry.dispose();
    this.selection.geometry.dispose();
    (this.selection.material as MeshBasicMaterial).dispose();
  }
}

function poseFor(villager: Villager): PoseName {
  switch (villager.anim) {
    case 'sleep':
      return 'sleep';
    case 'sit':
      return 'sit';
    case 'chat':
      return 'stand';
    case 'work':
      return 'work';
    case 'walk':
    case 'carry':
      return 'walkA';
    default:
      return 'stand';
  }
}

function frameFor(villager: Villager, pose: PoseName): number {
  if (pose === 'walkA') {
    // Two-frame walk cycle with a beat of stand between, which reads better at
    // pixel scale than a smooth four-frame loop.
    const step = Math.floor(villager.animTime * 7) % 4;
    if (step === 0) return POSE.walkA;
    if (step === 2) return POSE.walkB;
    return POSE.stand;
  }
  if (pose === 'work') {
    return Math.floor(villager.animTime * 4) % 2 === 0 ? POSE.work : POSE.stand;
  }
  return POSE[pose];
}

/**
 * Chooses the atlas row from the villager's heading relative to the camera.
 *
 * `cameraAngle` is the orbit azimuth: the camera sits in that direction from
 * the world, so it is *looking* along azimuth + PI. Measured against that,
 * cos(relative) > 0 means the villager is walking away from us, and
 * sin(relative) > 0 means they are crossing towards the left of the screen -
 * which is the side view the `west` row is drawn from.
 */
function facingRow(facing: number, cameraAngle: number, pose: PoseName): number {
  if (pose === 'sleep') return FACING.south;
  const relative = angleDelta(cameraAngle + Math.PI, facing);
  const away = Math.cos(relative);
  const sideways = Math.sin(relative);

  if (away > 0.45) return FACING.north;
  if (away < -0.45) return FACING.south;
  return sideways > 0 ? FACING.west : FACING.east;
}

/** Soft radial blob used as a contact shadow under each villager. */
function createBlobTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.85)');
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.42)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export { SPRITE_HEIGHT };
