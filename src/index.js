import * as THREE from 'three';
import { buildPlot, randomSeed } from './generator.js';

export { buildPlot, randomSeed };

/**
 * CAD-style hidden-line building turnaround on an orthographic turntable,
 * rendered on a transparent background. Framework agnostic: hand it a
 * <canvas> (or a container element to create one in) and drive it with
 * plain method calls from React, Svelte, vanilla JS, anywhere.
 *
 *   import { CadTurnaround } from 'cad-turnarounds';
 *   const ct = new CadTurnaround(el, { lineColor: 0x1e2226 });
 *   ct.generate();          // new random plot, returns the seed
 *   const png = await ct.exportPNG();
 *   ct.dispose();           // when the host component unmounts
 */
export class CadTurnaround {
  /**
   * @param {HTMLCanvasElement|HTMLElement} target canvas, or container to append one into
   * @param {object} [opts]
   * @param {number}  [opts.lineColor=0xffffff]  hex line color
   * @param {number}  [opts.speed=24]            turntable speed, deg/s
   * @param {number}  [opts.elevation=22]        camera elevation, deg
   * @param {boolean} [opts.autoRotate=true]
   * @param {boolean} [opts.hiddenLines=true]    faint dashed back-edges
   * @param {boolean} [opts.siteBoundary=true]   dashed site rectangle
   * @param {boolean} [opts.highlight=true]      mark the subject building
   * @param {number}  [opts.highlightColor=0xffc233] accent for the subject
   * @param {boolean} [opts.interactive=true]    drag to scrub the turntable
   * @param {number}  [opts.maxBuildings=5]
   * @param {number}  [opts.seed]                initial plot seed (random if omitted)
   * @param {number}  [opts.pixelRatio]
   * @param {(state:{yawDeg:number})=>void} [opts.onFrame]
   */
  constructor(target, opts = {}) {
    this.opts = {
      lineColor: 0xffffff, speed: 24, elevation: 22,
      autoRotate: true, hiddenLines: true, siteBoundary: true,
      highlight: true, highlightColor: 0xffc233,
      interactive: true, maxBuildings: 5,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      onFrame: null,
      ...opts,
    };

    if (target instanceof HTMLCanvasElement) {
      this.canvas = target;
    } else {
      this.canvas = document.createElement('canvas');
      Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%' });
      target.appendChild(this.canvas);
      this._ownsCanvas = true;
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
    });
    this.renderer.setClearColor(0x000000, 0);   // transparent background

    this.scene = new THREE.Scene();
    this.rig = new THREE.Group();               // turntable
    this.scene.add(this.rig);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);

    this.materials = {
      visible: new THREE.LineBasicMaterial({ color: 0xffffff }),
      hidden: new THREE.LineDashedMaterial({
        color: 0xffffff, dashSize: 0.6, gapSize: 0.45,
        transparent: true, opacity: 0.28,
        depthFunc: THREE.GreaterDepth, depthWrite: false,
      }),
      site: new THREE.LineDashedMaterial({
        color: 0xffffff, dashSize: 1.6, gapSize: 1.1, transparent: true, opacity: 0.45,
      }),
      occluder: new THREE.MeshBasicMaterial({
        colorWrite: false,                      // depth-only: hides lines behind faces
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }),
      accent: new THREE.LineBasicMaterial({ color: 0xffc233 }),
      accentHidden: new THREE.LineDashedMaterial({
        color: 0xffc233, dashSize: 0.6, gapSize: 0.45,
        transparent: true, opacity: 0.35,
        depthFunc: THREE.GreaterDepth, depthWrite: false,
      }),
    };
    this.setLineColor(this.opts.lineColor);
    this.setHighlightColor(this.opts.highlightColor);

    this._camR = 220;
    this._camTarget = new THREE.Vector3();
    this._frustumHalf = 40;
    this._zoom = 1;
    this._yaw = THREE.MathUtils.degToRad(35);
    this._dragging = false;
    this.playing = this.opts.autoRotate;
    this.plot = null;
    this.info = { seed: null, count: 0 };

    if (this.opts.interactive) this._bindDrag();

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.canvas);
    this._resize();

    this.generate(this.opts.seed);

    this._prev = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  /* ——— content ——— */

  /** Build a new random plot (or rebuild a specific seed). Returns the seed. */
  generate(seed = randomSeed()) {
    if (this.plot) {
      this.rig.remove(this.plot.group);
      this.plot.group.traverse(o => o.geometry?.dispose());
    }
    this.plot = buildPlot({
      seed, maxBuildings: this.opts.maxBuildings, materials: this.materials,
    });
    this.rig.add(this.plot.group);
    this.setHiddenLines(this.opts.hiddenLines);
    this.setSiteBoundary(this.opts.siteBoundary);
    this.setHighlight(this.opts.highlight);

    const bbox = new THREE.Box3().setFromObject(this.plot.group);
    const sphere = bbox.getBoundingSphere(new THREE.Sphere());
    this._frustumHalf = sphere.radius * 1.12;
    this._camTarget.set(0, bbox.max.y * 0.42, 0);
    this._updateCamera();
    this._resize();

    this.info = { seed, count: this.plot.count };
    return seed;
  }

  /* ——— playback ——— */

  play() { this.playing = true; }
  pause() { this.playing = false; }

  get yawDeg() { return THREE.MathUtils.euclideanModulo(this._yaw * 180 / Math.PI, 360); }
  set yawDeg(v) { this._yaw = THREE.MathUtils.degToRad(v); }

  get zoom() { return this._zoom; }
  set zoom(v) { this._zoom = THREE.MathUtils.clamp(v, 0.3, 5); this._resize(); }

  setSpeed(degPerSec) { this.opts.speed = degPerSec; }
  setElevation(deg) { this.opts.elevation = deg; this._updateCamera(); }

  /* ——— appearance ——— */

  setLineColor(hex) {
    const c = new THREE.Color(hex);
    this.materials.visible.color.copy(c);
    this.materials.hidden.color.copy(c);
    this.materials.site.color.copy(c);
  }

  setHiddenLines(on) {
    this.opts.hiddenLines = on;
    if (this.plot) for (const l of this.plot.hiddenLines) l.visible = on;
  }

  setSiteBoundary(on) {
    this.opts.siteBoundary = on;
    if (this.plot) for (const l of this.plot.siteLines) l.visible = on;
  }

  /** Mark / unmark the subject building ("the one we are building"). */
  setHighlight(on) {
    this.opts.highlight = on;
    const s = this.plot?.subject;
    if (!s) return;
    for (const l of s.visible)
      l.material = on ? this.materials.accent : this.materials.visible;
    for (const l of s.hidden)
      l.material = on ? this.materials.accentHidden : this.materials.hidden;
  }

  setHighlightColor(hex) {
    this.opts.highlightColor = hex;
    const c = new THREE.Color(hex);
    this.materials.accent.color.copy(c);
    this.materials.accentHidden.color.copy(c);
  }

  /** Paper-space scale denominator ("1 : N") at 96 dpi, for title blocks. */
  get scaleDenominator() {
    const h = this.canvas.clientHeight || 1;
    return Math.round(((2 * this._frustumHalf / this._zoom) / h) * (96 / 0.0254));
  }

  /* ——— export ——— */

  /** Current frame as a transparent PNG. @returns {Promise<Blob>} */
  exportPNG() {
    this.renderer.render(this.scene, this.camera);
    return new Promise(resolve => this.canvas.toBlob(resolve, 'image/png'));
  }

  /**
   * Record exactly one full revolution as WebM at the current speed.
   * Renders at `scale`× the display resolution for the duration (default 2×),
   * then restores the live pixel ratio.
   * @returns {{ done: Promise<Blob>, stop: () => void }}
   */
  recordTurn({ fps = 60, videoBitsPerSecond = 24_000_000, scale = 2 } = {}) {
    const recordRatio = this.opts.pixelRatio * scale;
    this.renderer.setPixelRatio(recordRatio);
    this.renderer.setSize(
      this.canvas.clientWidth || 300, this.canvas.clientHeight || 150, false);

    const stream = this.canvas.captureStream(fps);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond });
    const chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);

    const done = new Promise(resolve => {
      rec.onstop = () => {
        this._resize();                     // restore the live pixel ratio
        resolve(new Blob(chunks, { type: 'video/webm' }));
      };
    });
    const stop = () => { if (rec.state === 'recording') rec.stop(); };

    this.play();
    rec.start();
    const secs = 360 / Math.max(this.opts.speed, 1);
    setTimeout(stop, secs * 1000);
    return { done, stop };
  }

  /* ——— lifecycle ——— */

  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    if (this.plot) this.plot.group.traverse(o => o.geometry?.dispose());
    for (const m of Object.values(this.materials)) m.dispose();
    this.renderer.dispose();
    if (this._ownsCanvas) this.canvas.remove();
  }

  /* ——— internals ——— */

  _tick = (now) => {
    const dt = Math.min((now - this._prev) / 1000, 0.1);
    this._prev = now;
    if (this.playing && !this._dragging)
      this._yaw += THREE.MathUtils.degToRad(this.opts.speed) * dt;
    this.rig.rotation.y = this._yaw;
    this.renderer.render(this.scene, this.camera);
    this.opts.onFrame?.({ yawDeg: this.yawDeg });
    this._raf = requestAnimationFrame(this._tick);
  };

  _updateCamera() {
    const el = THREE.MathUtils.degToRad(this.opts.elevation);
    this.camera.position.set(
      0, this._camR * Math.sin(el) + this._camTarget.y, this._camR * Math.cos(el));
    this.camera.lookAt(this._camTarget);
  }

  _resize() {
    const w = this.canvas.clientWidth || 300;
    const h = this.canvas.clientHeight || 150;
    this.renderer.setPixelRatio(this.opts.pixelRatio);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    const half = this._frustumHalf / this._zoom;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.updateProjectionMatrix();
  }

  _bindDrag() {
    let lastX = 0;
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('pointerdown', e => {
      this._dragging = true; lastX = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', e => {
      if (!this._dragging) return;
      this._yaw += (e.clientX - lastX) * 0.005;
      lastX = e.clientX;
    });
    const up = e => {
      this._dragging = false;
      if (this.canvas.hasPointerCapture?.(e.pointerId))
        this.canvas.releasePointerCapture(e.pointerId);
    };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    // Vertical scroll zooms, horizontal scroll spins the turntable.
    // Trackpad pinch arrives as ctrl+wheel (Chrome/Edge/Firefox) or as
    // Safari's proprietary gesture* events — handle all of them.
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey) {                                 // pinch gesture
        this.zoom = this._zoom * Math.exp(-e.deltaY * 0.012);
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        this._yaw -= e.deltaX * 0.003;
      } else {
        const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;  // lines → px
        this.zoom = this._zoom * Math.exp(-px * 0.002);
      }
    }, { passive: false });
    let pinchStart = 1;
    this.canvas.addEventListener('gesturestart', e => {
      e.preventDefault();
      pinchStart = this._zoom;
    });
    this.canvas.addEventListener('gesturechange', e => {
      e.preventDefault();
      this.zoom = pinchStart * e.scale;
    });
    this.canvas.addEventListener('gestureend', e => e.preventDefault());
  }
}
