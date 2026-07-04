import * as THREE from 'three';

/** 32-bit seed suitable for buildPlot. */
export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GAP = 6;          // clear distance between building footprints, meters
const PLACE_TRIES = 400;

/* Oriented-rectangle math (footprints may sit at any angle) */

// world-axis half-extents of a rotated footprint
function extents(p) {
  const c = Math.abs(Math.cos(p.a || 0)), s = Math.abs(Math.sin(p.a || 0));
  return [(p.w / 2) * c + (p.d / 2) * s, (p.w / 2) * s + (p.d / 2) * c];
}

function rectProj(p, nx, nz) {
  const c = Math.cos(p.a || 0), s = Math.sin(p.a || 0);
  return (p.w / 2) * Math.abs(c * nx - s * nz) +
         (p.d / 2) * Math.abs(s * nx + c * nz);
}

// separating-axis test for two rotated footprints, with a clearance gap
function obbSeparated(A, B, gap) {
  const dx = B.x - A.x, dz = B.z - A.z;
  for (const p of [A, B]) {
    const c = Math.cos(p.a || 0), s = Math.sin(p.a || 0);
    for (const [nx, nz] of [[c, -s], [s, c]]) {
      if (Math.abs(dx * nx + dz * nz) > rectProj(A, nx, nz) + rectProj(B, nx, nz) + gap)
        return true;
    }
  }
  return false;
}

function pointNearRect(x, z, p, margin) {
  const dx = x - p.x, dz = z - p.z;
  const c = Math.cos(p.a || 0), s = Math.sin(p.a || 0);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) <= p.w / 2 + margin && Math.abs(lz) <= p.d / 2 + margin;
}

/**
 * Build one procedural plot: up to `maxBuildings` buildings from the pool
 * (mall, parking deck, office, data center, cluster of little houses),
 * laid out without overlaps, plus a dashed site boundary.
 *
 * Every part is added three times for hidden-line rendering:
 * a depth-only occluder mesh, crisp visible edges, and faint dashed
 * back-edges drawn where geometry is occluded.
 *
 * The first (anchor) building is returned as `subject` — the "building we
 * are building" — so its edges can be swapped to an accent material.
 *
 * @returns {{ group: THREE.Group, seed: number, count: number,
 *             hiddenLines: THREE.Object3D[], siteLines: THREE.Object3D[],
 *             subject: { visible: THREE.Object3D[], hidden: THREE.Object3D[] } }}
 */
export function buildPlot({ seed = randomSeed(), maxBuildings = 5, materials }) {
  const rng = mulberry32(seed);
  const rand = (a, b) => a + rng() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = arr => arr[Math.floor(rng() * arr.length)];

  const { visible, hidden, occluder, site } = materials;
  const hiddenLines = [];
  const siteLines = [];

  /* ——— part helpers ——— */

  function part(group, geom, x = 0, y = 0, z = 0, ry = 0, threshold = 30) {
    const occ = new THREE.Mesh(geom, occluder);
    occ.position.set(x, y, z); occ.rotation.y = ry;
    group.add(occ);

    const edges = new THREE.EdgesGeometry(geom, threshold);

    const vis = new THREE.LineSegments(edges, visible);
    vis.position.set(x, y, z); vis.rotation.y = ry;
    vis.renderOrder = 2;
    group.add(vis);

    const hid = new THREE.LineSegments(edges, hidden);
    hid.computeLineDistances();
    hid.position.set(x, y, z); hid.rotation.y = ry;
    hid.renderOrder = 1;
    group.add(hid);
    hiddenLines.push(hid);
  }

  // Box sitting on yBottom.
  function box(g, w, h, d, x, z, yBottom = 0, ry = 0) {
    part(g, new THREE.BoxGeometry(w, h, d), x, yBottom + h / 2, z, ry);
  }

  // Low-poly vertical cylinder — reads as a drafted tank / fan / column.
  function cyl(g, r, h, x, z, yBottom = 0, seg = 12) {
    part(g, new THREE.CylinderGeometry(r, r, h, seg), x, yBottom + h / 2, z, 0, 20);
  }

  // Flat rectangle outline for facade detail (doors, glazing, louvres),
  // with optional vertical mullions. Faces +Z before ry is applied.
  function faceRect(g, w, h, cx, cy, cz, ry = 0, mullions = 0) {
    const pts = [];
    const w2 = w / 2, h2 = h / 2;
    pts.push(-w2, -h2, 0,  w2, -h2, 0,   w2, -h2, 0,  w2, h2, 0,
              w2,  h2, 0, -w2,  h2, 0,  -w2,  h2, 0, -w2, -h2, 0);
    for (let i = 1; i <= mullions; i++) {
      const mx = -w2 + (w / (mullions + 1)) * i;
      pts.push(mx, -h2, 0, mx, h2, 0);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const seg = new THREE.LineSegments(geom, visible);
    seg.position.set(cx, cy, cz);
    seg.rotation.y = ry;
    seg.renderOrder = 2;
    g.add(seg);
  }

  // Gabled-house solid: wall/roof profile extruded along z, base on y=0.
  function gable(g, w, d, wall, ridge, x, z, ry = 0) {
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, 0);
    shape.lineTo(w / 2, 0);
    shape.lineTo(w / 2, wall);
    shape.lineTo(0, wall + ridge);
    shape.lineTo(-w / 2, wall);
    shape.closePath();
    const geom = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
    geom.translate(0, 0, -d / 2);
    part(g, geom, x, 0, z, ry);
  }

  // Recenter a builder's parts on its footprint and report the footprint.
  function finalize(g) {
    const b = new THREE.Box3().setFromObject(g);
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    for (const c of g.children) { c.position.x -= cx; c.position.z -= cz; }
    return { g, w: b.max.x - b.min.x, d: b.max.z - b.min.z };
  }

  /* ——— building modules ——— */

  function bMall() {
    const g = new THREE.Group();
    const w = rand(38, 58), d = rand(26, 38), h = rand(7, 10);
    box(g, w, h, d, 0, 0);
    box(g, w + 0.8, 1.3, d + 0.8, 0, 0, h - 0.4);            // parapet band

    const cw = rand(12, 18), cx = rand(-w / 4, w / 4);       // entrance, front
    box(g, cw, 0.8, 5.5, cx, d / 2 + 2.6, h * 0.58);
    cyl(g, 0.26, h * 0.58, cx - cw / 2 + 1, d / 2 + 4.8, 0, 8);
    cyl(g, 0.26, h * 0.58, cx + cw / 2 - 1, d / 2 + 4.8, 0, 8);
    faceRect(g, cw - 1.5, h * 0.5, cx, h * 0.28, d / 2 + 0.03, 0, randInt(5, 9));

    if (rng() < 0.75) {                                      // pylon sign
      box(g, 1.6, rand(11, 15), 0.9, -w / 2 - 4, d / 2 + 1);
      box(g, 4.6, 2.4, 0.6, -w / 2 - 4, d / 2 + 1, rand(9, 12));
    }
    const rtus = randInt(3, 6);                              // rooftop units
    for (let i = 0; i < rtus; i++)
      box(g, 3.2, 1.9, 2.2, rand(-w / 2 + 5, w / 2 - 5), rand(-d / 2 + 5, d / 2 - 5), h + 0.9);

    box(g, Math.min(w - 18, 20), 1.2, 3.5, rand(-w / 6, w / 6), -d / 2 - 1.8);  // dock
    const doors = randInt(2, 3), dx = rand(-w / 6, w / 6);
    for (let i = 0; i < doors; i++)
      faceRect(g, 3, 3.1, dx - (doors - 1) * 3 + i * 6, 2.8, -d / 2 - 0.03, Math.PI, 0);
    return finalize(g);
  }

  function bDataCenter() {
    const g = new THREE.Group();
    const w = rand(34, 52), d = rand(18, 26), h = rand(9, 12);
    box(g, w, h, d, 0, 0);                                   // hall
    const aw = rand(12, 18), ax = rand(-w / 4, w / 4);
    box(g, aw, h * 0.55, 8, ax, d / 2 + 4);                  // admin block
    faceRect(g, 3.2, 2.9, ax, 1.6, d / 2 + 8.03, 0, 1);      // entrance doors

    const bays = Math.max(2, Math.floor(w / 11));            // rooftop AHUs
    for (let i = 0; i < bays; i++) {
      const x = -w / 2 + 6 + i * ((w - 12) / Math.max(bays - 1, 1));
      box(g, 4.2, 2.4, 2.7, x, -d / 4, h);
      box(g, 4.2, 2.4, 2.7, x, d / 4, h);
    }
    const fans = Math.max(3, Math.floor(w / 9));             // fan wall
    for (let i = 0; i < fans; i++)
      cyl(g, 1.5, 1.1, -w / 2 + 6 + i * ((w - 12) / (fans - 1)), 0, h);

    const gens = randInt(2, 3);                              // generator yard
    for (let i = 0; i < gens; i++)
      box(g, 4.6, 3.2, 2.7, -w / 2 - 4.2, -(gens - 1) * 4 + i * 8);
    const tank = new THREE.CylinderGeometry(1.4, 1.4, 6, 12); // fuel tank
    tank.rotateX(Math.PI / 2);
    part(g, tank, w / 2 + 3.6, 1.8, 0, 0, 20);
    box(g, 3.2, 0.4, 6.6, w / 2 + 3.6, 0);

    const louvres = Math.floor(w / 9);                       // rear facade
    for (let i = 0; i < louvres; i++)
      faceRect(g, 5, h * 0.4, -w / 2 + 6 + i * 9, h * 0.5, -d / 2 - 0.03, Math.PI, 4);
    return finalize(g);
  }

  function bOffice() {
    const g = new THREE.Group();
    const fw = rand(16, 26), fd = rand(12, 18), floors = randInt(4, 10), FLOOR = 3.3;
    let y0 = 0;
    if (rng() < 0.6) {                                       // podium
      box(g, fw + 8, 4.2, fd + 5, 0, 0);
      box(g, 8, 0.5, 3.2, 0, (fd + 5) / 2 + 1.4, 3.2);       // canopy
      faceRect(g, 7, 2.8, 0, 1.55, (fd + 5) / 2 + 0.03, 0, 3);
      y0 = 4.2;
    }
    for (let f = 0; f < floors; f++) {                       // slab + glass band
      const y = y0 + f * FLOOR;
      box(g, fw + 1, 0.4, fd + 1, 0, 0, y);
      box(g, fw, FLOOR - 0.4, fd, 0, 0, y + 0.4);
    }
    const roofY = y0 + floors * FLOOR;
    box(g, fw + 1, 0.9, fd + 1, 0, 0, roofY);                // parapet
    box(g, 5.5, 2.8, 4, -fw / 6, fd / 8, roofY + 0.9);       // core overrun
    box(g, 4, 1.9, 2.4, fw / 5, -fd / 6, roofY + 0.9);       // plant
    return finalize(g);
  }

  function bParking() {
    const g = new THREE.Group();
    const w = rand(26, 36), d = rand(15, 20), decks = randInt(3, 5), FH = 2.8;
    for (let k = 0; k <= decks; k++) {
      const y = k * FH;
      box(g, w, 0.35, d, 0, 0, y);                           // deck slab
      if (k < decks)                                         // columns
        for (const cx of [-w / 2 + 1.2, 0, w / 2 - 1.2])
          for (const cz of [-d / 2 + 1.2, d / 2 - 1.2])
            box(g, 0.5, FH - 0.35, 0.5, cx, cz, y + 0.35);
      if (k > 0) {                                           // barrier bands
        box(g, w, 0.9, 0.14, 0, d / 2 - 0.07, y + 0.35);
        box(g, w, 0.9, 0.14, 0, -d / 2 + 0.07, y + 0.35);
        box(g, 0.14, 0.9, d - 0.3, -w / 2 + 0.07, 0, y + 0.35);
        box(g, 0.14, 0.9, d - 0.3, w / 2 - 0.07, 0, y + 0.35);
      }
    }
    box(g, 3.6, decks * FH + 2.4, 3.6, -w / 2 + 2, -d / 2 + 2);   // stair core
    box(g, 1, 4.6, 0.6, w / 2 + 2.4, d / 2 - 1);             // P sign
    box(g, 2.4, 2.4, 0.5, w / 2 + 2.4, d / 2 - 1, 4.6);
    faceRect(g, 6, 2.2, rand(-w / 4, w / 4), 1.28, d / 2 + 0.03, 0, 0);  // entry
    return finalize(g);
  }

  function bHouses() {
    const g = new THREE.Group();
    const n = randInt(2, 4);
    let x = 0;
    for (let i = 0; i < n; i++) {
      const hw = rand(5.5, 7.5), hd = rand(7, 10);
      const wall = rand(2.7, 3.4), ridge = rand(1.7, 2.5);
      const turned = rng() < 0.4;
      const fw = turned ? hd : hw;
      gable(g, hw, hd, wall, ridge, x + fw / 2, rand(-1.5, 1.5), turned ? Math.PI / 2 : 0);
      if (rng() < 0.5)                                       // chimney
        box(g, 0.7, wall + ridge + 0.8, 0.7, x + fw / 2 + hw / 5, rand(-1, 1));
      if (rng() < 0.4)                                       // garage
        box(g, 3.2, 2.5, 5.5, x + fw + 1.8, rand(-2, 2));
      x += fw + rand(3, 5) + (rng() < 0.4 ? 4 : 0);
    }
    return finalize(g);
  }

  // Open-air parking lot: perimeter + striped stall bays, pure ground linework.
  function bParkingLot() {
    const g = new THREE.Group();
    const w = rand(26, 42), d = rand(16, 26);
    const w2 = w / 2, d2 = d / 2, bay = 5, stall = 2.6;
    const pts = [
      -w2, 0, -d2,  w2, 0, -d2,   w2, 0, -d2,  w2, 0, d2,
       w2, 0,  d2, -w2, 0,  d2,  -w2, 0,  d2, -w2, 0, -d2,
    ];
    for (let x = -w2 + 2; x <= w2 - 2; x += stall) {
      pts.push(x, 0, -d2, x, 0, -d2 + bay);      // stall row, one long edge
      pts.push(x, 0, d2, x, 0, d2 - bay);        // stall row, other long edge
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const seg = new THREE.LineSegments(geom, visible);
    seg.position.y = 0.02;
    seg.renderOrder = 2;
    g.add(seg);
    return finalize(g);
  }

  // Drafting-style tree: trunk + cone, or trunk + faceted ball (a smooth
  // sphere shows no edges in hidden-line rendering, an icosahedron does).
  function tree(g, x, z) {
    const trunkH = rand(1.4, 2.4);
    cyl(g, rand(0.18, 0.3), trunkH, x, z, 0, 8);
    if (rng() < 0.5) {
      const h = rand(2.8, 4.6);
      part(g, new THREE.ConeGeometry(rand(1.1, 1.9), h, 7), x, trunkH + h / 2, z, 0, 15);
    } else {
      const r = rand(1.3, 2.1);
      part(g, new THREE.IcosahedronGeometry(r, 0), x, trunkH + r * 0.85, z, 0, 25);
    }
  }

  /* ——— choose buildings & lay out the plot ——— */

  const anchors = [bMall, bDataCenter, bParking, bOffice];
  const fillers = [bHouses, bHouses, bOffice, bParking, bMall, bDataCenter];

  // Retail-park plots (German Fachmarktzentrum): buildings ring a reserved
  // central area with their fronts facing in; the shared lot is generated
  // afterwards, filling whatever space the buildings actually left.
  const retailPark = rng() < 0.4;

  const count = Math.max(1, Math.min(maxBuildings, randInt(3, 5)));
  let builders;
  if (retailPark) {
    builders = [bMall];
    const pool = [bMall, bMall, bOffice, bHouses];
    while (builders.length < count) builders.push(pick(pool));
  } else {
    builders = [pick(anchors)];
    if (count >= 3) builders.push(bHouses);          // little houses in between
    while (builders.length < count) builders.push(pick(fillers));
    if (rng() < 0.6) builders.splice(1, 0, bParkingLot);  // lot isn't a building
  }

  const group = new THREE.Group();
  const placed = [];
  const subject = { visible: [], hidden: [] };
  let subjectTaken = false;
  let lotCount = 0;

  if (retailPark)                                    // reserve the central lot area
    placed.push({ x: 0, z: 0, w: rand(24, 36), d: rand(18, 28), a: 0, phantom: true });

  // Street-led orientation, the way game city generators do it: the street
  // plan is decided first, and buildings inherit alignment from what they
  // front. The street-side cluster aligns exactly to the street, everything
  // else to the plot's own grid; the rare freestanding landmark breaks both.
  const streetPlan = rng() < 0.6 ? {
    angle: rng() < 0.5 ? 0 : rand(0, Math.PI),
    sign: rng() < 0.5 ? 1 : -1,
    second: rng() < 0.35,
  } : null;
  if (streetPlan) {
    const t = streetPlan.angle;
    streetPlan.u = [Math.cos(t), Math.sin(t)];                    // along
    streetPlan.n = [-Math.sin(t) * streetPlan.sign, Math.cos(t) * streetPlan.sign];
  }
  const gridA = rng() < 0.7 ? 0 : rand(0, Math.PI / 2);           // plot grid

  function pickAngle(px, pz) {
    if (rng() < 0.08) return rand(0, Math.PI * 2);                // landmark
    if (streetPlan && px * streetPlan.n[0] + pz * streetPlan.n[1] > -4)
      return -streetPlan.angle + randInt(0, 3) * Math.PI / 2;     // fronts street
    return gridA + randInt(0, 3) * Math.PI / 2;
  }

  for (const build of builders) {
    const { g, w, d } = build();
    const isLot = build === bParkingLot;

    let px = 0, pz = 0, a = pickAngle(0, 0), ok = placed.length === 0;
    for (let t = 0; t < PLACE_TRIES && !ok; t++) {
      const ang = rng() * Math.PI * 2;
      const r = 8 + t * 0.45;
      px = Math.cos(ang) * r;
      pz = Math.sin(ang) * r * 0.8;                  // slightly landscape plots
      a = retailPark && !isLot
        ? Math.atan2(-px, -pz) + rand(-0.15, 0.15)   // front faces the lot
        : pickAngle(px, pz);
      const cand = { x: px, z: pz, w, d, a };
      ok = placed.every(p => obbSeparated(cand, p, GAP));
    }
    if (!ok) { g.traverse(o => o.geometry?.dispose()); continue; }

    const holder = new THREE.Group();
    holder.add(g);
    holder.rotation.y = a;
    holder.position.set(px, 0, pz);
    group.add(holder);

    if (!subjectTaken && !isLot) {                 // first building = subject
      subjectTaken = true;
      holder.traverse(o => {
        if (!o.isLineSegments) return;
        if (o.material === visible) subject.visible.push(o);
        else if (o.material === hidden) subject.hidden.push(o);
      });
    }

    placed.push({ x: px, z: pz, w, d, a });
    if (isLot) lotCount++;
  }

  // recenter plot on the origin, then draw the site boundary around it
  const real = placed.filter(p => !p.phantom);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of real) {
    const [ex, ez] = extents(p);
    minX = Math.min(minX, p.x - ex); maxX = Math.max(maxX, p.x + ex);
    minZ = Math.min(minZ, p.z - ez); maxZ = Math.max(maxZ, p.z + ez);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  for (const h of group.children) { h.position.x -= cx; h.position.z -= cz; }

  const rects = real.map(p => ({ ...p, x: p.x - cx, z: p.z - cz }));
  if (retailPark) rects.push(...adaptiveLot(group, rects));

  const siteW = maxX - minX + 16, siteD = maxZ - minZ + 16;
  if (streetPlan) rects.push(...streets(group, rects, streetPlan, siteW, siteD));

  // scatter trees in the leftover space between footprints
  const trees = randInt(4, 10);
  for (let i = 0; i < trees; i++) {
    let x = 0, z = 0, ok = false;
    for (let t = 0; t < 40 && !ok; t++) {
      x = rand(-siteW / 2 + 2, siteW / 2 - 2);
      z = rand(-siteD / 2 + 2, siteD / 2 - 2);
      ok = rects.every(p => !pointNearRect(x, z, p, 2));
    }
    if (ok) tree(group, x, z);
  }

  siteRect(group, siteW, siteD);
  return { group, seed, count: real.length - lotCount, hiddenLines, siteLines, subject };

  // Shared retail-park lot: fills the leftover space between the placed
  // buildings with stall rows, so its outline adapts to the neighbours.
  // Returns the drawn bay rectangles so trees can avoid them.
  function adaptiveLot(g, buildingRects) {
    const stall = 2.6, bay = 5, aisle = 6.5, setback = 2.5, minRun = 3 * stall;
    const xs = buildingRects.map(p => [p.x, extents(p)[0]]);
    const zs = buildingRects.map(p => [p.z, extents(p)[1]]);
    const x0 = Math.min(...xs.map(([c, e]) => c - e)) + 2;
    const x1 = Math.max(...xs.map(([c, e]) => c + e)) - 2;
    const z0 = Math.min(...zs.map(([c, e]) => c - e)) + 2;
    const z1 = Math.max(...zs.map(([c, e]) => c + e)) - 2;
    // exact test against rotated footprints, so stall rows hug angled walls
    const clear = (ax0, az0, ax1, az1) => {
      const cell = {
        x: (ax0 + ax1) / 2, z: (az0 + az1) / 2,
        w: ax1 - ax0, d: az1 - az0, a: 0,
      };
      return buildingRects.every(p => obbSeparated(cell, p, setback));
    };

    // 1. slice the area into bay/aisle strips, each a set of clear x-runs
    const strips = [];
    let z = z0, isBay = true;
    while (z + (isBay ? bay : aisle) <= z1) {
      const h = isBay ? bay : aisle;
      const runs = [];
      let x = x0;
      while (x + stall <= x1) {
        if (!clear(x, z, x + stall, z + h)) { x += stall; continue; }
        let xe = x + stall;
        while (xe + stall <= x1 && clear(xe, z, xe + stall, z + h)) xe += stall;
        if (xe - x >= minRun) runs.push([x, xe]);
        x = xe + stall;
      }
      strips.push({ z, h, runs, isBay });
      z += h; isBay = !isBay;
    }
    while (strips.length && !strips[0].runs.length) strips.shift();
    while (strips.length && !strips[strips.length - 1].runs.length) strips.pop();
    if (!strips.length) return [];

    const pts = [];
    const H = (xa, xb, zz) => { if (xb - xa > 0.01) pts.push(xa, 0, zz, xb, 0, zz); };
    const V = (xx, za, zb) => { if (zb - za > 0.01) pts.push(xx, 0, za, xx, 0, zb); };

    // 2. entrance drive: through a random aisle strip, out one side
    let ent = null;
    const aisles = strips.filter(s => !s.isBay && s.runs.length);
    if (aisles.length) {
      const s = aisles[Math.floor(rng() * aisles.length)];
      const dir = rng() < 0.5 ? 1 : -1;
      const run = s.runs.reduce((m, r) => (dir > 0 ? (r[1] > m[1] ? r : m)
                                                   : (r[0] < m[0] ? r : m)));
      ent = { strip: s, run, dir, x: dir > 0 ? run[1] : run[0],
              za: s.z + 0.5, zb: s.z + s.h - 0.5 };
      const far = ent.x + dir * 14;               // reaches past the boundary
      pts.push(ent.x, 0, ent.za, far, 0, ent.za,  ent.x, 0, ent.zb, far, 0, ent.zb);
    }

    // 3. one union outline around the whole lot, with a gap at the entrance
    for (const s of strips)
      for (const r of s.runs) {
        const [ra, rb] = r;
        if (ent && s === ent.strip && r === ent.run) {
          const solidEnd = ent.dir > 0 ? ra : rb;
          V(solidEnd, s.z, s.z + s.h);
          V(ent.x, s.z, ent.za);
          V(ent.x, ent.zb, s.z + s.h);
        } else {
          V(ra, s.z, s.z + s.h);
          V(rb, s.z, s.z + s.h);
        }
      }
    const uncovered = (A, B) => {   // parts of intervals A not covered by B
      const out = [];
      for (const [a0, a1] of A) {
        let cur = a0;
        for (const [b0, b1] of B) {
          if (b1 <= cur || b0 >= a1) continue;
          if (b0 > cur) out.push([cur, b0]);
          cur = Math.max(cur, b1);
          if (cur >= a1) break;
        }
        if (cur < a1) out.push([cur, a1]);
      }
      return out;
    };
    for (const [xa, xb] of strips[0].runs) H(xa, xb, strips[0].z);
    for (let i = 0; i < strips.length - 1; i++) {
      const zz = strips[i].z + strips[i].h;
      for (const [xa, xb] of uncovered(strips[i].runs, strips[i + 1].runs)) H(xa, xb, zz);
      for (const [xa, xb] of uncovered(strips[i + 1].runs, strips[i].runs)) H(xa, xb, zz);
    }
    const last = strips[strips.length - 1];
    for (const [xa, xb] of last.runs) H(xa, xb, last.z + last.h);

    // 4. sparse stall markings: clustered runs of dividers, not wall-to-wall
    for (const s of strips) {
      if (!s.isBay) continue;
      for (const [ra, rb] of s.runs) {
        let marking = rng() < 0.5;
        for (let mx = ra + stall; mx <= rb - stall + 1e-6; mx += stall) {
          if (rng() < 0.18) marking = !marking;
          if (marking) V(mx, s.z, s.z + s.h);
        }
      }
    }

    if (pts.length) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const seg = new THREE.LineSegments(geom, visible);
      seg.position.y = 0.02;
      seg.renderOrder = 2;
      g.add(seg);
    }

    // footprints so trees keep off the lot and the drive
    const bays = [];
    for (const s of strips)
      for (const [ra, rb] of s.runs)
        bays.push({ x: (ra + rb) / 2, z: s.z + s.h / 2, w: rb - ra, d: s.h, a: 0 });
    if (ent)
      bays.push({ x: ent.x + ent.dir * 7, z: (ent.za + ent.zb) / 2, w: 14, d: ent.zb - ent.za, a: 0 });
    return bays;
  }

  // Streets from the plan the buildings were oriented against: laid tangent
  // to the built-up edge, angled with the plan, kerb pair + dashed
  // centerline, overshooting so they read as through-roads. Returns their
  // footprints so trees keep off the tarmac.
  function streets(g, allRects, plan, sw, sd) {
    const roadW = 6.5;
    const len = Math.hypot(sw, sd) / 2 + 6;
    const roads = [];
    const solid = [], dashed = [];

    const lay = (u, n) => {
      let maxProj = -Infinity;              // built-up extent along the normal
      for (const p of allRects)
        maxProj = Math.max(maxProj, p.x * n[0] + p.z * n[1] + rectProj(p, n[0], n[1]));
      const off = maxProj + 2 + roadW / 2;
      for (const o of [-roadW / 2, roadW / 2])
        solid.push(
          n[0] * (off + o) - u[0] * len, 0, n[1] * (off + o) - u[1] * len,
          n[0] * (off + o) + u[0] * len, 0, n[1] * (off + o) + u[1] * len);
      dashed.push(
        n[0] * off - u[0] * len, 0, n[1] * off - u[1] * len,
        n[0] * off + u[0] * len, 0, n[1] * off + u[1] * len);
      roads.push({ x: n[0] * off, z: n[1] * off, w: 2 * len, d: roadW,
                   a: -Math.atan2(u[1], u[0]) });
    };

    lay(plan.u, plan.n);
    if (plan.second) {                      // cross street, perpendicular
      const s2 = rng() < 0.5 ? 1 : -1;
      lay(plan.n, [plan.u[0] * s2, plan.u[1] * s2]);
    }

    const kerbs = new THREE.BufferGeometry();
    kerbs.setAttribute('position', new THREE.Float32BufferAttribute(solid, 3));
    const kerbSeg = new THREE.LineSegments(kerbs, visible);
    kerbSeg.position.y = 0.015;
    kerbSeg.renderOrder = 2;
    g.add(kerbSeg);
    const center = new THREE.BufferGeometry();
    center.setAttribute('position', new THREE.Float32BufferAttribute(dashed, 3));
    const centerSeg = new THREE.LineSegments(center, site);
    centerSeg.computeLineDistances();
    centerSeg.position.y = 0.015;
    centerSeg.renderOrder = 2;
    g.add(centerSeg);
    return roads;
  }

  // Dashed site-boundary rectangle with outward corner ticks.
  function siteRect(g, w, d) {
    const w2 = w / 2, d2 = d / 2, t = 3;
    const pts = [
      -w2, 0, -d2,  w2, 0, -d2,   w2, 0, -d2,  w2, 0, d2,
       w2, 0,  d2, -w2, 0,  d2,  -w2, 0,  d2, -w2, 0, -d2,
      -w2, 0, -d2, -w2 - t, 0, -d2 - t,   w2, 0, -d2,  w2 + t, 0, -d2 - t,
       w2, 0,  d2,  w2 + t, 0,  d2 + t,  -w2, 0,  d2, -w2 - t, 0,  d2 + t,
    ];
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const seg = new THREE.LineSegments(geom, site);
    seg.computeLineDistances();
    seg.renderOrder = 2;
    g.add(seg);
    siteLines.push(seg);
  }
}
