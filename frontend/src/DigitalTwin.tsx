// 3D digital twin of the bench rig: JGA12-N20 gear motor (flat-sided can, 1:100 gearbox, D-shaft,
// wheel), rear magnetic encoder board with its 6-wire lead, aluminium bracket and the MPU6050.
// Everything moving is driven by live telemetry: shaft/encoder/gears spin at the measured speed,
// the assembly shakes with the measured vibration, the can glows with temperature, current flows
// along the motor leads in proportion to the INA219 reading, and a halo shows the anomaly score.
import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface TwinPoint {
  time: number;
  ref: number;
  output: number;
  input: number;
  current: number;
  temp: number;
  vib?: number;
  twin?: number;
  an?: number;
  acl?: string;
  fault?: string;
  idK?: number;
  idTau?: number;
  idD?: number;
  idOk?: boolean;
  mode?: string;
  gKp?: number;
  gKi?: number;
  gKd?: number;
}

interface Props {
  latestRef: MutableRefObject<TwinPoint | undefined>;
  latest: TwinPoint | undefined;
  telemetry: TwinPoint[];
  live: boolean;
  supplyV: number | null;
}

const GEAR_RATIO = 100;
const COUNTS_PER_REV = 2800;   // 7 PPR x 4 edges x 1:100 at the output shaft
const T_AMBIENT = 28.5, T_LIMIT = 58;
const DISPLAY_CAP_RPS = 6;     // fast parts are shown slowed (labels give the true speed)

// The N20 can: a 12 mm circle with flats 10 mm apart.
function n20Profile(r = 6, half = 5) {
  const s = new THREE.Shape();
  const a = Math.asin(half / r);
  const xf = Math.sqrt(r * r - half * half);
  s.moveTo(xf, half);
  s.lineTo(-xf, half);
  s.absarc(0, 0, r, Math.PI - a, Math.PI + a, false);
  s.lineTo(xf, -half);
  s.absarc(0, 0, r, -a, a, false);
  return s;
}

function gearShape(rOuter: number, teeth: number, rHole: number) {
  const s = new THREE.Shape();
  const rRoot = rOuter - Math.min(0.9, rOuter * 0.18);
  for (let i = 0; i < teeth * 4; i++) {
    const ang = (i / (teeth * 4)) * Math.PI * 2;
    const r = i % 4 === 1 || i % 4 === 2 ? rOuter : rRoot;
    const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, rHole, 0, Math.PI * 2, true);
  s.holes.push(hole);
  return s;
}

// Extrude a 2D profile along the world X axis, centred on x = 0.
function alongX(shape: THREE.Shape, length: number, bevel = 0) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: length, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 3, curveSegments: 32,
  });
  g.translate(0, 0, -length / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

function makeLabel(title: string) {
  const el = document.createElement('div');
  el.style.cssText = 'font:10px/1.25 ui-monospace,Menlo,monospace;color:#e8f6ff;background:rgba(10,18,28,.78);' +
    'border:1px solid rgba(120,190,255,.45);border-left:3px solid #4fc3f7;padding:3px 6px;border-radius:3px;' +
    'white-space:nowrap;pointer-events:none;transform:translateY(-18px)';
  const t = document.createElement('div');
  t.style.cssText = 'color:#8fd3ff;font-weight:bold;letter-spacing:.04em';
  t.textContent = title;
  const v = document.createElement('div');
  el.append(t, v);
  return { obj: new CSS2DObject(el), value: v };
}

export default function DigitalTwin({ latestRef, latest, telemetry, live, supplyV }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const W = () => host.clientWidth, H = () => host.clientHeight;

    // ---- renderer, camera, environment -------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W(), H());
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    host.appendChild(renderer.domElement);

    const labels = new CSS2DRenderer();
    labels.setSize(W(), H());
    labels.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    host.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);
    scene.fog = new THREE.Fog(0x0b0f14, 140, 260);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;

    const camera = new THREE.PerspectiveCamera(35, W() / H(), 0.5, 600);
    camera.position.set(-42, 34, 62);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(6, -2, 2);
    controls.enableDamping = true;
    controls.minDistance = 25;
    controls.maxDistance = 160;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.update();

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-30, 60, 40);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 200 });
    key.shadow.bias = -0.0005;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fb8ff, 1.0);
    rim.position.set(50, 20, -40);
    scene.add(rim);
    scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x1a1208, 0.35));

    const disposables: { dispose: () => void }[] = [envTex, pmrem];
    const track = <T extends { dispose: () => void }>(x: T) => { disposables.push(x); return x; };

    // ---- materials ----------------------------------------------------------------------------
    const steel = track(new THREE.MeshStandardMaterial({ color: 0xc3c7cc, metalness: 0.95, roughness: 0.32 }));
    const canMat = track(new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 0.9, roughness: 0.38, emissive: 0x000000 }));
    const brass = track(new THREE.MeshStandardMaterial({ color: 0xc9a24b, metalness: 0.9, roughness: 0.35 }));
    const darkPlastic = track(new THREE.MeshStandardMaterial({ color: 0x1b1b1d, metalness: 0.1, roughness: 0.6 }));
    const pcbGreen = track(new THREE.MeshStandardMaterial({ color: 0x1d6b3a, metalness: 0.2, roughness: 0.55 }));
    const pcbBlue = track(new THREE.MeshStandardMaterial({ color: 0x1f4fa8, metalness: 0.2, roughness: 0.5 }));
    const chip = track(new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.3, roughness: 0.4 }));
    const pinGold = track(new THREE.MeshStandardMaterial({ color: 0xd8b25a, metalness: 1.0, roughness: 0.25 }));
    const alu = track(new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.85, roughness: 0.45 }));
    const rubber = track(new THREE.MeshStandardMaterial({ color: 0x151515, metalness: 0.0, roughness: 0.92 }));
    const hubMat = track(new THREE.MeshStandardMaterial({ color: 0xf2c230, metalness: 0.1, roughness: 0.5 }));
    const white = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
    const deskMat = track(new THREE.MeshStandardMaterial({ color: 0x1c232c, metalness: 0.2, roughness: 0.85 }));

    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, shadow = true) => {
      track(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // ---- desk and bracket (static) ------------------------------------------------------------
    const desk = add(scene, new THREE.BoxGeometry(220, 2, 140), deskMat, 0, -19, 0, false);
    desk.receiveShadow = true;
    const grid = new THREE.GridHelper(220, 44, 0x2c3a48, 0x222c36);
    grid.position.y = -17.95;
    scene.add(grid);
    track(grid.geometry); track(grid.material as THREE.Material);

    const rig = new THREE.Group();   // the bolted assembly that vibrates
    scene.add(rig);
    // aluminium L-bracket: base plate + upright clamping the gearbox face
    add(rig, new RoundedBoxGeometry(40, 1.6, 48, 3, 0.5), alu, -2, -17.2, 0);
    add(rig, new RoundedBoxGeometry(1.6, 18, 22, 3, 0.5), alu, 18.4, -8.6, 0);
    for (const z of [-19, 19]) for (const x of [-18, 14]) add(rig, new THREE.CylinderGeometry(1.1, 1.1, 1, 16), steel, x, -16.1, z);
    // motor saddle
    add(rig, new RoundedBoxGeometry(16, 10.5, 14, 3, 1), alu, 0, -11.5, 0);

    // ---- motor ---------------------------------------------------------------------------------
    const motor = new THREE.Group();
    rig.add(motor);
    add(motor, alongX(n20Profile(), 15, 0.4), canMat, 0, 0, 0);
    // rolled seam and vent ribs on the can for realism
    for (const x of [-5, 5]) add(motor, alongX(n20Profile(6.08, 5.05), 0.5), steel, x, 0, 0);
    // rear end cap with brush terminals
    add(motor, alongX(n20Profile(6, 5), 2.2, 0.2), darkPlastic, -8.8, 0, 0);
    const tabGeo = new THREE.BoxGeometry(1.6, 2.2, 0.35);
    add(motor, tabGeo, brass, -10.3, 3.6, 3.2);
    add(motor, tabGeo.clone(), brass, -10.3, 3.6, -3.2);

    // gearbox: plates, standoffs, three visible stages
    const gb = new THREE.Group();
    gb.position.x = 7.5;
    motor.add(gb);
    const plate = new RoundedBoxGeometry(1.0, 10, 12, 2, 0.4);
    for (const x of [0.6, 9.4]) add(gb, plate.clone(), steel, x, 0, 0);
    add(gb, new RoundedBoxGeometry(1.0, 10, 12, 2, 0.4), brass, 3.6, 0, 0);
    add(gb, new RoundedBoxGeometry(1.0, 10, 12, 2, 0.4), brass, 6.6, 0, 0);
    track(plate);
    for (const [y, z] of [[4, 5], [4, -5], [-4, 5], [-4, -5]])
      add(gb, new THREE.CylinderGeometry(0.45, 0.45, 9.5, 10).rotateZ(Math.PI / 2), steel, 5, y, z);
    const gears: { mesh: THREE.Mesh; ratio: number }[] = [];
    const stage = (x: number, y: number, z: number, r: number, t: number, ratioToOutput: number) => {
      const m = add(gb, alongX(gearShape(r, t, 0.6), 1.4), brass, x, y, z);
      gears.push({ mesh: m, ratio: ratioToOutput });
    };
    stage(2.1, -1.8, 1.6, 3.4, 18, 21.5);
    stage(5.1, 1.6, -1.2, 3.9, 22, 4.64);
    stage(8.1, 0, 0, 4.4, 26, 1);

    // output D-shaft and wheel
    const out = new THREE.Group();
    out.position.x = 7.5 + 10;
    motor.add(out);
    const shaft = add(out, new THREE.CylinderGeometry(1.5, 1.5, 11, 24).rotateZ(Math.PI / 2), steel, 5.5, 0, 0);
    const wheel = new THREE.Group();
    wheel.position.x = 9;
    out.add(wheel);
    add(wheel, new THREE.TorusGeometry(13.5, 3.3, 24, 64).rotateY(Math.PI / 2), rubber, 0, 0, 0);
    add(wheel, new THREE.CylinderGeometry(11.2, 11.2, 4.6, 48, 1, true).rotateZ(Math.PI / 2), hubMat, 0, 0, 0);
    add(wheel, new THREE.CylinderGeometry(3.2, 3.2, 5.2, 32).rotateZ(Math.PI / 2), hubMat, 0, 0, 0);
    for (let i = 0; i < 5; i++) {
      const sp = add(wheel, new THREE.BoxGeometry(2.2, 9, 1.6), hubMat, 0, 0, 0);
      sp.geometry.translate(0, 6.6, 0);
      sp.rotation.x = (i / 5) * Math.PI * 2;
    }
    add(wheel, new THREE.BoxGeometry(3.6, 0.8, 3.0), white, 0, 16.9, 0);  // rotation marker on the tyre

    // rear encoder: green PCB, Hall sensors, multipole magnet disc on the motor shaft, header
    const enc = new THREE.Group();
    enc.position.x = -11.6;
    motor.add(enc);
    add(enc, new THREE.CylinderGeometry(7.4, 7.4, 1.2, 40).rotateZ(Math.PI / 2), pcbGreen, 0, 0, 0);
    for (const ang of [0.9, 2.45]) {
      add(enc, new THREE.BoxGeometry(0.9, 1.4, 1.4), chip, -0.95, Math.cos(ang) * 4.6, Math.sin(ang) * 4.6);
    }
    add(enc, new THREE.CylinderGeometry(0.5, 0.5, 4, 12).rotateZ(Math.PI / 2), steel, -1.5, 0, 0);
    const magnet = new THREE.Group();
    magnet.position.x = -2.4;
    enc.add(magnet);
    const north = track(new THREE.MeshStandardMaterial({ color: 0xc8352e, roughness: 0.5 }));
    const south = track(new THREE.MeshStandardMaterial({ color: 0x2f5fc8, roughness: 0.5 }));
    for (let i = 0; i < 14; i++) {   // 7 pole pairs = 7 pulses per motor revolution per channel
      add(magnet, new THREE.CylinderGeometry(3.4, 3.4, 1, 6, 1, false, (i / 14) * Math.PI * 2, Math.PI * 2 / 14).rotateZ(Math.PI / 2),
          i % 2 ? south : north, 0, 0, 0);
    }
    const header = new THREE.Group();
    header.position.set(-0.2, -8.3, 0);
    enc.add(header);
    add(header, new THREE.BoxGeometry(2.4, 2.6, 15), darkPlastic, 0, 0, 0);
    const wireColors = [0xd32f2f, 0x212121, 0xfdd835, 0x43a047, 0x1e88e5, 0xeeeeee]; // M1 GND C1 C2 VCC M2
    const flowDots: { curve: THREE.CatmullRomCurve3; dots: THREE.Mesh[] }[] = [];
    const dotMat = track(new THREE.MeshBasicMaterial({ color: 0xffe082, transparent: true, opacity: 0.95 }));
    wireColors.forEach((c, i) => {
      const z = -6.25 + i * 2.5;
      add(header, new THREE.BoxGeometry(0.6, 2.4, 0.6), pinGold, 0, -2.4, z);
      const pts = [new THREE.Vector3(-11.8, -11.5, z), new THREE.Vector3(-12.5, -14.5, z * 1.15),
                   new THREE.Vector3(-22, -16.6, z * 1.6 + 2), new THREE.Vector3(-46, -17.2, z * 2.2 + 4),
                   new THREE.Vector3(-72, -17.3, z * 2.6 + 6)];
      const curve = new THREE.CatmullRomCurve3(pts);
      const wireMat = track(new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.05 }));
      const w = new THREE.Mesh(track(new THREE.TubeGeometry(curve, 80, 0.55, 10, false)), wireMat);
      w.castShadow = true;
      scene.add(w);   // the lead lies on the desk; it does not shake with the rig
      if (i === 0 || i === 5) {   // M1 / M2 carry the motor current
        const dots: THREE.Mesh[] = [];
        for (let k = 0; k < 9; k++) {
          const d = new THREE.Mesh(track(new THREE.SphereGeometry(0.42, 10, 8)), dotMat);
          scene.add(d);
          dots.push(d);
        }
        flowDots.push({ curve, dots });
      }
    });

    // MPU6050 breakout on the bracket base
    const imu = new THREE.Group();
    imu.position.set(-4, -15.9, 15.5);
    imu.rotation.y = Math.PI / 2;
    rig.add(imu);
    add(imu, new RoundedBoxGeometry(16, 1.2, 21, 2, 0.4), pcbBlue, 0, 0, 0);
    add(imu, new THREE.BoxGeometry(4, 0.9, 4), chip, 0, 1, 1);
    for (let i = 0; i < 8; i++) add(imu, new THREE.BoxGeometry(0.6, 0.6, 0.6), pinGold, -5.25 + i * 1.5, 0.9, -9);
    for (const [x, z] of [[-6, 8.5], [6, 8.5]]) add(imu, new THREE.CylinderGeometry(1.1, 1.1, 1.3, 16), steel, x, 0.1, z);

    // anomaly halo around the can
    const haloMat = track(new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0, depthWrite: false }));
    const halo = new THREE.Mesh(track(new THREE.TorusGeometry(10.5, 0.55, 12, 80).rotateY(Math.PI / 2)), haloMat);
    halo.position.x = 2;
    motor.add(halo);
    // soft contact shadow under the rig
    const blob = add(scene, new THREE.CircleGeometry(30, 48).rotateX(-Math.PI / 2),
                     track(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })), 4, -17.9, 0, false);
    blob.receiveShadow = false;

    // ---- labels --------------------------------------------------------------------------------
    const L = {
      motor: makeLabel('N20 MOTOR · 12 V'),
      gear: makeLabel('GEARBOX 1:100'),
      out: makeLabel('OUTPUT SHAFT'),
      enc: makeLabel('ENCODER · 7 PPR'),
      leads: makeLabel('MOTOR LEADS M1/M2'),
      imu: makeLabel('MPU6050'),
    };
    L.enc.obj.position.set(-1, 8.5, 0); enc.add(L.enc.obj);       // low
    L.motor.obj.position.set(-1, 19, 0); motor.add(L.motor.obj);  // high
    L.gear.obj.position.set(6, 7.5, 0); gb.add(L.gear.obj);       // low
    L.out.obj.position.set(9, 24, 0); out.add(L.out.obj);         // high
    L.leads.obj.position.set(-40, -15, -2); scene.add(L.leads.obj);
    L.imu.obj.position.set(0, 2.5, 6); imu.add(L.imu.obj);

    // ---- animation -------------------------------------------------------------------------------
    const clock = new THREE.Clock();
    let outAngle = 0, flowPhase = 0, labelTimer = 0, raf = 0;
    const cold = new THREE.Color(0xb9bec4), hot = new THREE.Color(0xd06a3a), tmp = new THREE.Color();
    const capped = (rps: number) => Math.sign(rps) * Math.min(Math.abs(rps), DISPLAY_CAP_RPS);

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      const p = latestRef.current;
      const rpm = p?.output ?? 0;
      const outRps = rpm / 60;
      const driving = !!p && p.input > 0 && (p.fault ?? 'NOMINAL') === 'NOMINAL';

      outAngle += outRps * 2 * Math.PI * dt;
      wheel.rotation.x = outAngle;
      shaft.rotation.x = outAngle;
      gears.forEach((g, i) => { g.mesh.rotation.x += (i % 2 ? -1 : 1) * capped(outRps * g.ratio) * 2 * Math.PI * dt; });
      magnet.rotation.x += capped(outRps * GEAR_RATIO) * 2 * Math.PI * dt;

      // vibration: shake the bolted rig in proportion to the measured RMS vibration
      const vibMg = (p?.vib ?? 0) * 1000;
      const amp = Math.min(vibMg * 0.006, 0.45);
      rig.position.set((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp);

      // temperature: can tint + glow
      const tr = Math.max(0, Math.min(1, ((p?.temp ?? T_AMBIENT) - T_AMBIENT) / (T_LIMIT - T_AMBIENT)));
      canMat.color.copy(tmp.copy(cold).lerp(hot, tr * 0.8));
      const pulse = (p?.an ?? 0) > 0.05 ? (p!.an ?? 0) * (0.55 + 0.45 * Math.sin(performance.now() * 0.009)) : 0;
      canMat.emissive.setRGB(0.55 * tr * tr + 0.5 * pulse, 0.12 * tr * tr, 0);
      haloMat.opacity = pulse * 0.9;

      // current flow along M1/M2: dot speed and brightness follow the measured current
      const amps = p?.current ?? 0;
      flowPhase = (flowPhase + amps * 1.6 * dt) % 1000;
      flowDots.forEach(({ curve, dots }, w) => dots.forEach((d, k) => {
        const v = flowPhase * (w === 0 ? 1 : -1) + k / dots.length;
        const u = ((v % 1) + 1) % 1;   // wrap into [0, 1) for either flow direction
        curve.getPointAt(u, d.position);
        d.visible = amps > 0.004;
      }));
      dotMat.opacity = Math.min(1, 0.35 + amps * 6);

      labelTimer += dt;
      if (labelTimer > 0.1) {
        labelTimer = 0;
        const f = (v: number, n = 0) => v.toFixed(n);
        const duty = (p?.input ?? 0) / 255;
        L.motor.value.textContent = `${f(rpm * GEAR_RATIO)} RPM rotor · PWM ${f(duty * 100)} %\n`;
        L.motor.value.textContent += `${f(p?.temp ?? T_AMBIENT, 1)} °C`;
        L.gear.value.textContent = `${f(outRps * 4.64 * 60)} / ${f(outRps * 21.5 * 60)} RPM stages`;
        L.out.value.textContent = `${f(rpm, 1)} RPM · set ${f(p?.ref ?? 0)}` + (driving && p?.twin ? ` · twin ${f(p.twin)}` : '');
        L.enc.value.textContent = `${f(rpm / 60 * COUNTS_PER_REV)} counts/s (C1/C2)`;
        L.leads.value.textContent = `${(p?.current ?? 0).toFixed(3)} A` + (supplyV ? ` · ~${(supplyV * duty).toFixed(1)} V avg` : '');
        L.imu.value.textContent = `${f(vibMg, 1)} mg RMS vibration`;
        L.motor.value.style.whiteSpace = 'pre';
      }
      controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      camera.aspect = W() / H();
      camera.updateProjectionMatrix();
      renderer.setSize(W(), H());
      labels.setSize(W(), H());
    });
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposables.forEach(d => d.dispose());
      renderer.dispose();
      host.removeChild(renderer.domElement);
      host.removeChild(labels.domElement);
    };
    // the scene is built once; live values are read from latestRef every frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- HUD (React, 25 Hz) ----------
  const p = latest;
  const driving = !!p && p.input > 0 && (p.fault ?? 'NOMINAL') === 'NOMINAL';
  const rpm = p?.output ?? 0;
  const pct = (v: number, max: number) => `${Math.max(0, Math.min(1, v / max)) * 100}%`;
  const gaugeAngle = (v: number) => -120 + Math.max(0, Math.min(300, v)) / 300 * 240;
  const needle = (v: number, color: string, len: number, w: number) => {
    const a = (gaugeAngle(v) - 90) * Math.PI / 180;
    return <line x1={90} y1={90} x2={90 + Math.cos(a) * len} y2={90 + Math.sin(a) * len} stroke={color} strokeWidth={w} strokeLinecap="round" />;
  };
  const arc = (from: number, to: number) => {
    const p0 = (gaugeAngle(from) - 90) * Math.PI / 180, p1 = (gaugeAngle(to) - 90) * Math.PI / 180;
    const large = (to - from) / 300 * 240 > 180 ? 1 : 0;
    return `M ${90 + Math.cos(p0) * 70} ${90 + Math.sin(p0) * 70} A 70 70 0 ${large} 1 ${90 + Math.cos(p1) * 70} ${90 + Math.sin(p1) * 70}`;
  };
  const healthColor = !p?.acl ? '#9aa' : p.acl === 'NORMAL' ? '#5ee07a' : p.acl === 'LEARNING' ? '#9aa' : '#ff5a52';
  const trace = telemetry.slice(-150);
  const ymax = Math.max(60, ...trace.map(t => Math.max(t.ref, t.output))) * 1.1;
  const path = (f: (t: TwinPoint) => number) => trace.map((t, i) => `${i ? 'L' : 'M'} ${(i / 149) * 260} ${70 - (f(t) / ymax) * 66}`).join(' ');
  const card = (label: string, value: string, bar?: { v: number; max: number; color: string }) => (
    <div style={{ background: '#121a24', border: '1px solid #233142', padding: '6px 8px' }}>
      <div style={{ fontSize: 9, color: '#7f93a8', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 14, color: '#e8f1fa', fontFamily: 'ui-monospace,Menlo,monospace', fontWeight: 'bold' }}>{value}</div>
      {bar && <div style={{ height: 4, background: '#223042', marginTop: 4 }}><div style={{ width: pct(bar.v, bar.max), height: '100%', background: bar.color }} /></div>}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, minHeight: 0 }}>
      <div ref={hostRef} style={{ position: 'relative', flex: '1 1 480px', height: 560, minWidth: 0, background: '#0b0f14', border: '1px solid var(--color-border)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 8, left: 10, zIndex: 2, font: '10px ui-monospace,Menlo,monospace', color: 'rgba(220,235,250,.75)', pointerEvents: 'none' }}>
          {live ? 'LIVE · ESP32-S3 TELEMETRY' : 'SIMULATOR'} · drag to orbit · scroll to zoom
          <br />fast parts drawn slowed; labels show true speeds
        </div>
        {p?.acl && (
          <div style={{ position: 'absolute', top: 8, right: 10, zIndex: 2, font: 'bold 11px ui-monospace,Menlo,monospace', color: healthColor,
                        background: 'rgba(0,0,0,.55)', padding: '4px 8px', border: `1px solid ${healthColor}` }}>
            AI HEALTH: {p.acl}{p.acl !== 'LEARNING' ? ` ${(p.an ?? 0).toFixed(2)}` : ''}
          </div>
        )}
      </div>

      <div style={{ flex: '1 0 290px', maxWidth: 420, height: 560, display: 'flex', flexDirection: 'column', gap: 6, background: '#0d141c', padding: 8, border: '1px solid var(--color-border)', overflowY: 'auto' }}>
        <svg viewBox="0 0 180 150" style={{ width: '100%' }}>
          <path d={arc(0, 300)} stroke="#223042" strokeWidth={10} fill="none" />
          <path d={arc(0, Math.min(rpm, 300) || 0.001)} stroke="#2ecc71" strokeWidth={10} fill="none" />
          {[0, 50, 100, 150, 200, 250, 300].map(v => {
            const a = (gaugeAngle(v) - 90) * Math.PI / 180;
            return <text key={v} x={90 + Math.cos(a) * 54} y={93 + Math.sin(a) * 54} fill="#6f8296" fontSize={8} textAnchor="middle">{v}</text>;
          })}
          {needle(p?.ref ?? 0, '#ffd54f', 74, 2)}
          {driving && p?.twin ? needle(p.twin, '#00e5ff', 64, 2) : null}
          {needle(rpm, '#ffffff', 60, 3)}
          <circle cx={90} cy={90} r={5} fill="#e8f1fa" />
          <text x={90} y={122} fill="#e8f1fa" fontSize={18} fontWeight="bold" textAnchor="middle" fontFamily="ui-monospace,Menlo,monospace">{rpm.toFixed(1)}</text>
          <text x={90} y={135} fill="#7f93a8" fontSize={8} textAnchor="middle">RPM · set {(p?.ref ?? 0).toFixed(0)}{driving && p?.twin ? ` · twin ${p.twin.toFixed(0)}` : ''}</text>
        </svg>
        <div style={{ display: 'flex', gap: 10, fontSize: 9, color: '#9fb2c6', justifyContent: 'center' }}>
          <span style={{ color: '#fff' }}>━ speed</span><span style={{ color: '#ffd54f' }}>━ setpoint</span><span style={{ color: '#00e5ff' }}>━ twin model</span>
        </div>
        <svg viewBox="0 0 260 72" style={{ width: '100%', background: '#0a1018', border: '1px solid #1d2a38' }}>
          <path d={path(t => t.ref)} stroke="#ffd54f" fill="none" strokeWidth={1} />
          {trace.some(t => t.twin) && <path d={path(t => t.twin ?? 0)} stroke="#00e5ff" fill="none" strokeWidth={1} strokeDasharray="3 2" />}
          <path d={path(t => t.output)} stroke="#2ecc71" fill="none" strokeWidth={1.5} />
          <text x={4} y={9} fill="#6f8296" fontSize={7}>last 6 s</text>
        </svg>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {card('PWM DUTY', `${((p?.input ?? 0) / 2.55).toFixed(0)} %`, { v: p?.input ?? 0, max: 255, color: '#d05ce3' })}
          {card('MOTOR CURRENT', `${(p?.current ?? 0).toFixed(3)} A`, { v: p?.current ?? 0, max: 1.2, color: '#ffb74d' })}
          {card('CASING TEMP', `${(p?.temp ?? T_AMBIENT).toFixed(1)} °C`, { v: (p?.temp ?? T_AMBIENT) - T_AMBIENT, max: T_LIMIT - T_AMBIENT, color: '#ff7043' })}
          {card('VIBRATION', `${((p?.vib ?? 0) * 1000).toFixed(1)} mg`, { v: (p?.vib ?? 0) * 1000, max: 60, color: '#4fc3f7' })}
          {card('ROTOR SPEED', `${(rpm * GEAR_RATIO / 1000).toFixed(1)}k RPM`)}
          {card('ENCODER RATE', `${(rpm / 60 * COUNTS_PER_REV / 1000).toFixed(2)} kHz`)}
          {card('TWIN RESIDUAL', driving && p?.twin ? `${(rpm - p.twin).toFixed(1)} RPM` : '—')}
          {card('AI ANOMALY', p?.acl ? `${p.acl === 'LEARNING' ? 'learning' : (p.an ?? 0).toFixed(2)}` : '—', p?.acl ? { v: p.an ?? 0, max: 1, color: healthColor } : undefined)}
        </div>
        <div style={{ background: '#121a24', border: '1px solid #233142', padding: '6px 8px', fontSize: 10, color: '#c8d6e5', fontFamily: 'ui-monospace,Menlo,monospace', lineHeight: 1.5 }}>
          <div style={{ fontSize: 9, color: '#7f93a8', letterSpacing: '.05em', fontFamily: 'inherit' }}>LEARNED MODEL · CONTROLLER</div>
          {p?.idK !== undefined
            ? <>G(s) = {p.idK.toFixed(3)}·e^(-{((p.idD ?? 0) * 0.01).toFixed(2)}s) / ({(p.idTau ?? 0).toFixed(3)}s+1)
                {p.idOk === false && <span style={{ color: '#9aa' }}> (learning)</span>}</>
            : <>G(s) = 1.200·e^(-0.03s) / (0.060s+1) <span style={{ color: '#9aa' }}>(simulator plant)</span></>}
          <br />{p?.mode ?? '—'} · Kp {(p?.gKp ?? 0).toFixed(2)} Ki {(p?.gKi ?? 0).toFixed(2)} Kd {(p?.gKd ?? 0).toFixed(2)}
          <br />fault: <span style={{ color: (p?.fault ?? 'NOMINAL') === 'NOMINAL' ? '#5ee07a' : '#ffb74d' }}>{p?.fault ?? '—'}</span>
          {supplyV ? <> · supply ≈ {supplyV.toFixed(1)} V</> : null}
        </div>
      </div>
    </div>
  );
}
