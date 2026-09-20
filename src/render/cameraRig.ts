/**
 * Camera and touch controls.
 *
 * Tuned for a tablet held in two hands:
 *   - one finger drags to orbit the diorama
 *   - two fingers pinch to zoom, slide to pan, twist to spin
 *   - a quick tap selects whatever is under it
 *   - a double tap focuses and pushes in
 *
 * Everything is damped towards a target value, so a flick keeps gliding and a
 * pinch never snaps. The camera uses a narrow field of view: at this distance
 * it reads as an isometric diorama while keeping just enough perspective for
 * the world to have depth.
 */
import { PerspectiveCamera, Vector2, Vector3 } from 'three';
import { clamp, damp, dampAngle } from '../core/mathx';
import { WORLD_SIZE } from '../world/constants';

const MIN_DISTANCE = 9;
const MAX_DISTANCE = 108;
const MIN_POLAR = 0.34; // Looking down steeply, but never straight down.
const MAX_POLAR = 1.32; // Almost at ground level.

export interface TapEvent {
  x: number;
  y: number;
  /** Normalised device coordinates, ready for raycasting. */
  ndc: Vector2;
}

export interface CameraRigOptions {
  onTap?: (event: TapEvent) => void;
  onDoubleTap?: (event: TapEvent) => void;
  onDragStart?: () => void;
  /** Called with a height lookup so the camera target hugs the terrain. */
  groundHeight?: (x: number, z: number) => number;
}

interface PointerRecord {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
  moved: number;
}

export class CameraRig {
  readonly camera: PerspectiveCamera;

  /** Target values the actual camera is always easing towards. */
  private targetAzimuth = Math.PI * 0.22;
  private targetPolar = 0.78;
  private targetDistance = 42;
  private targetFocus = new Vector3(WORLD_SIZE / 2, 0, WORLD_SIZE / 2);

  private azimuth = this.targetAzimuth;
  private polar = this.targetPolar;
  private distance = this.targetDistance;
  private focus = this.targetFocus.clone();

  /** Spin momentum, so a flick keeps turning. */
  private spin = 0;

  private pointers = new Map<number, PointerRecord>();
  private pinchDistance = 0;
  private pinchAngle = 0;
  private pinchMid = new Vector2();
  private lastTapTime = 0;
  private lastTapPos = new Vector2();
  private disposers: (() => void)[] = [];

  constructor(
    private element: HTMLElement,
    private options: CameraRigOptions = {},
  ) {
    this.camera = new PerspectiveCamera(32, 1, 0.5, WORLD_SIZE * 5);
    this.attach();
    this.applyImmediately();
  }

  /** How zoomed in we are, 0 = wide ambient view, 1 = right down among them. */
  get zoomLevel(): number {
    return 1 - clamp((this.distance - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE), 0, 1);
  }

  get orbitAngle(): number {
    return this.azimuth;
  }

  get cameraDistance(): number {
    return this.distance;
  }

  get focusPoint(): Vector3 {
    return this.focus;
  }

  /** Centres the view on a point, optionally pushing in. */
  focusOn(x: number, z: number, distance?: number): void {
    this.targetFocus.x = x;
    this.targetFocus.z = z;
    if (distance !== undefined) {
      this.targetDistance = clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
    }
  }

  zoomBy(factor: number): void {
    this.targetDistance = clamp(this.targetDistance * factor, MIN_DISTANCE, MAX_DISTANCE);
  }

  rotateBy(radians: number): void {
    this.targetAzimuth += radians;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    // Portrait tablets need a wider field of view or the island crops badly.
    this.camera.fov = this.camera.aspect < 1 ? 40 : 32;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    // Momentum, bled off over about a second.
    if (Math.abs(this.spin) > 0.0001) {
      this.targetAzimuth += this.spin * dt;
      this.spin *= Math.exp(-3.2 * dt);
    }

    // Keep the focus over the island and glued to the ground beneath it.
    const margin = 6;
    this.targetFocus.x = clamp(this.targetFocus.x, margin, WORLD_SIZE - margin);
    this.targetFocus.z = clamp(this.targetFocus.z, margin, WORLD_SIZE - margin);
    if (this.options.groundHeight) {
      const ground = this.options.groundHeight(this.targetFocus.x, this.targetFocus.z);
      this.targetFocus.y = damp(this.targetFocus.y, ground, 3, dt);
    }

    this.azimuth = dampAngle(this.azimuth, this.targetAzimuth, 9, dt);
    this.polar = damp(this.polar, this.targetPolar, 9, dt);
    this.distance = damp(this.distance, this.targetDistance, 8, dt);
    this.focus.x = damp(this.focus.x, this.targetFocus.x, 8, dt);
    this.focus.y = damp(this.focus.y, this.targetFocus.y, 6, dt);
    this.focus.z = damp(this.focus.z, this.targetFocus.z, 8, dt);

    this.applyImmediately();
  }

  private applyImmediately(): void {
    const sinPolar = Math.sin(this.polar);
    const cosPolar = Math.cos(this.polar);
    this.camera.position.set(
      this.focus.x + this.distance * sinPolar * Math.sin(this.azimuth),
      this.focus.y + this.distance * cosPolar,
      this.focus.z + this.distance * sinPolar * Math.cos(this.azimuth),
    );
    this.camera.lookAt(this.focus);
  }

  /* ------------------------------------------------------------- input */

  private attach(): void {
    const el = this.element;

    const onPointerDown = (event: PointerEvent) => {
      el.setPointerCapture?.(event.pointerId);
      this.pointers.set(event.pointerId, {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        startTime: performance.now(),
        moved: 0,
      });
      this.spin = 0;
      if (this.pointers.size === 2) this.beginPinch();
      if (this.pointers.size === 1) this.options.onDragStart?.();
    };

    const onPointerMove = (event: PointerEvent) => {
      const record = this.pointers.get(event.pointerId);
      if (!record) return;
      const dx = event.clientX - record.x;
      const dy = event.clientY - record.y;
      record.x = event.clientX;
      record.y = event.clientY;
      record.moved += Math.abs(dx) + Math.abs(dy);

      if (this.pointers.size === 1) {
        this.orbit(dx, dy);
      } else if (this.pointers.size === 2) {
        this.pinch();
      }
      event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent) => {
      const record = this.pointers.get(event.pointerId);
      this.pointers.delete(event.pointerId);
      el.releasePointerCapture?.(event.pointerId);
      if (this.pointers.size === 1) this.beginPinch();
      if (!record) return;

      // A tap is short, still, and the only finger down.
      const elapsed = performance.now() - record.startTime;
      if (elapsed < 320 && record.moved < 14) {
        this.handleTap(record);
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Trackpad pinch on macOS arrives as ctrl+wheel.
      const scale = Math.exp(event.deltaY * (event.ctrlKey ? 0.012 : 0.0016));
      this.targetDistance = clamp(this.targetDistance * scale, MIN_DISTANCE, MAX_DISTANCE);
    };

    const onContextMenu = (event: Event) => event.preventDefault();

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove, { passive: false });
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContextMenu);

    this.disposers.push(() => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContextMenu);
    });
  }

  private orbit(dx: number, dy: number): void {
    const rect = this.element.getBoundingClientRect();
    const scale = 2.6 / Math.max(rect.width, 1);
    this.targetAzimuth -= dx * scale * Math.PI;
    this.targetPolar = clamp(this.targetPolar - dy * scale * Math.PI * 0.55, MIN_POLAR, MAX_POLAR);
    this.spin = -dx * scale * Math.PI * 7;
  }

  private beginPinch(): void {
    const [a, b] = Array.from(this.pointers.values());
    if (!a || !b) return;
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchAngle = Math.atan2(b.y - a.y, b.x - a.x);
    this.pinchMid.set((a.x + b.x) / 2, (a.y + b.y) / 2);
  }

  private pinch(): void {
    const [a, b] = Array.from(this.pointers.values());
    if (!a || !b) return;

    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    // Zoom.
    if (this.pinchDistance > 0 && distance > 0) {
      const ratio = this.pinchDistance / distance;
      this.targetDistance = clamp(this.targetDistance * ratio, MIN_DISTANCE, MAX_DISTANCE);
    }

    // Twist to spin. Small twists are ignored so panning does not wobble.
    let twist = angle - this.pinchAngle;
    if (twist > Math.PI) twist -= Math.PI * 2;
    if (twist < -Math.PI) twist += Math.PI * 2;
    if (Math.abs(twist) > 0.01) this.targetAzimuth += twist * 1.1;

    // Slide to pan, in the camera's own ground plane.
    const panX = midX - this.pinchMid.x;
    const panY = midY - this.pinchMid.y;
    this.panScreen(panX, panY);

    this.pinchDistance = distance;
    this.pinchAngle = angle;
    this.pinchMid.set(midX, midY);
  }

  /** Moves the focus point by a screen-space delta, in world units. */
  private panScreen(dx: number, dy: number): void {
    const rect = this.element.getBoundingClientRect();
    // Scale panning with distance so it feels the same at every zoom.
    const worldPerPixel = (this.distance * 1.4) / Math.max(rect.height, 1);
    const sin = Math.sin(this.azimuth);
    const cos = Math.cos(this.azimuth);

    const right = { x: cos, z: -sin };
    const forward = { x: sin, z: cos };

    this.targetFocus.x -= (right.x * dx + forward.x * dy) * worldPerPixel;
    this.targetFocus.z -= (right.z * dx + forward.z * dy) * worldPerPixel;
  }

  private handleTap(record: PointerRecord): void {
    const rect = this.element.getBoundingClientRect();
    const ndc = new Vector2(
      ((record.x - rect.left) / rect.width) * 2 - 1,
      -((record.y - rect.top) / rect.height) * 2 + 1,
    );
    const event: TapEvent = { x: record.x, y: record.y, ndc };

    const now = performance.now();
    const isDouble =
      now - this.lastTapTime < 320 && Math.hypot(record.x - this.lastTapPos.x, record.y - this.lastTapPos.y) < 36;

    this.lastTapTime = now;
    this.lastTapPos.set(record.x, record.y);

    if (isDouble) {
      this.lastTapTime = 0;
      this.options.onDoubleTap?.(event);
    } else {
      this.options.onTap?.(event);
    }
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.pointers.clear();
  }
}
