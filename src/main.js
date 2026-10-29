import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createDog } from './dog.js';
import { cookie, cacau } from './coats.js';

const BG = 0xdedbd6;
const canvas = document.querySelector('#scene');
const phone = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 4, 11);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
const HOME = { pos: new THREE.Vector3(0, 0.95, 3.3), target: new THREE.Vector3(0, 0.26, -0.05) };
camera.position.copy(HOME.pos);
const controls = new OrbitControls(camera, canvas);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.minDistance = 0.5;
controls.maxDistance = 12;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8780, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e6, 2.2);
sun.position.set(1.4, 3.2, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(phone ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -1.8, right: 1.8, top: 1.8, bottom: -1.8, near: 0.5, far: 8 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.015;
sun.shadow.radius = 4;
scene.add(sun);
const rim = new THREE.DirectionalLight(0xdfe8ff, 0.8);
rim.position.set(-2, 1.5, -2);
scene.add(rim);

// Porcelain floor tiles, like the floor in both photos.
function tileTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#c9c6c1';
  g.fillRect(0, 0, 512, 512);
  const img = g.getImageData(0, 0, 512, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(120,116,110,0.55)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 510, 510);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(30 / 0.8, 30 / 0.8);
  t.anisotropy = 8;
  return t;
}
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30),
  new THREE.MeshStandardMaterial({ map: tileTexture(), roughness: 0.55 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// --- dogs
// ?ref=Cookie|Cacau shows one dog frozen in her photo pose, next to the photo, from a camera that
// roughly matches where the phone was — for checking the model against the reference.
const params = new URLSearchParams(location.search);
const refCfg = [cookie, cacau].find((c) => c.name === params.get('ref'));
const modo = params.get('modo') ?? 'codigo';
document.querySelectorAll('[data-modo]').forEach((b) => {
  b.classList.toggle('on', b.dataset.modo === modo);
  b.onclick = () => { params.set('modo', b.dataset.modo); location.search = params.toString(); };
});
const dogs = [];
// On a tall (phone) screen there's no room for two long dogs side by side in profile, so they
// stand closer together and turned more toward the camera — faces and paws to the front.
const portrait = innerWidth / innerHeight < 0.8;
const placements = refCfg
  ? [{ cfg: refCfg, x: 0, z: 0, yaw: 0 }]
  : portrait
    ? [
        { cfg: cookie, x: -0.4, z: 0, yaw: 0.3 },
        { cfg: cacau, x: 0.4, z: 0.05, yaw: -0.3 },
      ]
    : [
        { cfg: cookie, x: -0.8, z: 0, yaw: 0.95 },
        { cfg: cacau, x: 0.82, z: 0.06, yaw: -0.85 },
      ];
if (refCfg) {
  document.body.classList.add('ref');
  const n = refCfg.name.toLowerCase();
  document.querySelector('#refimg').src = `fotos/${n}/${n}.jpeg`;
  const rc = refCfg.refCam;
  camera.fov = rc.fov;
  camera.position.fromArray(rc.pos);
  controls.target.fromArray(rc.target);
}
const status = document.querySelector('#status');
const labels = document.querySelector('#labels');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function build() {
  for (const p of placements) {
    status.textContent = `Esculpindo ${p.cfg.name}…`;
    await nextFrame();
    const dog = createDog(p.cfg, phone ? 1.3 : 1);
    dog.group.position.set(p.x, 0, p.z);
    dog.group.rotation.y = p.yaw;
    scene.add(dog.group);
    const tag = document.createElement('button');
    tag.className = 'tag';
    tag.textContent = p.cfg.name;
    tag.onclick = () => dog.cheer();
    labels.appendChild(tag);
    dog.tag = tag;
    dogs.push(dog);
  }
  status.textContent = '';
  document.body.classList.add('ready');
  const foco = params.get('foco');
  pawView = params.has('patas');
  if (!refCfg) focus(foco ?? 'all', true); // also fits the framing to this screen's shape
  if (params.has('pata')) dogs.forEach((d) => d.cheer()); // ?pata: both give a paw right away
  window.__ready = true; // lets headless screenshots wait for the models
}

// --- camera focus buttons
let fly = null;
function focus(which, instant = false) {
  subject = which;
  const d = dogs.find((x) => x.name === which);
  let pos = HOME.pos, target = HOME.target;
  if (pawView) {
    // low camera on the front paws (of one dog, or of both)
    const pts = (d ? [d] : dogs).flatMap((x) =>
      x.pawAnchors?.length ? x.pawAnchors.map((a) => a.getWorldPosition(new THREE.Vector3())) : [x.group.position.clone()]);
    target = pts.reduce((acc, v) => acc.add(v), new THREE.Vector3()).divideScalar(pts.length).setY(0.05);
    if (d) {
      const fwd = new THREE.Vector3(Math.sin(d.group.rotation.y), 0, Math.cos(d.group.rotation.y));
      pos = target.clone().add(fwd.add(new THREE.Vector3(0, 0, 0.8)).normalize().multiplyScalar(1.3)).add(new THREE.Vector3(0, 0.16, 0));
    } else {
      pos = target.clone().add(new THREE.Vector3(0, 0.22, 2.0));
    }
  } else if (d) {
    const g = d.group;
    const fwd = new THREE.Vector3(Math.sin(g.rotation.y), 0, Math.cos(g.rotation.y));
    target = g.position.clone().add(fwd.clone().multiplyScalar(0.32)).setY(0.4);
    const dir = fwd.add(new THREE.Vector3(0, 0, 0.7)).normalize();
    pos = target.clone().add(dir.multiplyScalar(1.6)).add(new THREE.Vector3(0, 0.14, 0));
  }
  // pull back until the subject fits the screen's width (matters on tall phone screens)
  const halfWidth = pawView ? (d ? 0.45 : portrait ? 0.62 : 1.3) : d ? 0.65 : portrait ? 0.78 : 1.4;
  const off = pos.clone().sub(target);
  const need = halfWidth / Math.tan(Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
  if (need > off.length()) pos = target.clone().add(off.setLength(need));
  fly = { from: camera.position.clone(), fromT: controls.target.clone(), pos, target, t: instant ? 1 : 0 };
  if (instant) { camera.position.copy(pos); controls.target.copy(target); fly = null; }
  document.querySelectorAll('[data-focus]').forEach((b) => b.classList.toggle('on', b.dataset.focus === which));
  document.querySelector('[data-patas]').classList.toggle('on', pawView);
}
let subject = 'all';
let pawView = false;
document.querySelectorAll('[data-focus]').forEach((b) => (b.onclick = () => focus(b.dataset.focus)));
document.querySelector('[data-patas]').onclick = () => { pawView = !pawView; focus(subject); };

// click a dog to make her happy
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let down = null;
canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  const r = canvas.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects(dogs.map((d) => d.group), true)[0];
  // clicking a dog makes her wag and give a paw; clicking one of her front paws gives that one
  if (hit) dogs.find((d) => d.group === hit.object.userData.dog)?.cheer(hit.object.userData.pawSide);
});

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  if (fly) {
    fly.t = Math.min(1, fly.t + dt / 1.1);
    const k = fly.t * fly.t * (3 - 2 * fly.t);
    camera.position.lerpVectors(fly.from, fly.pos, k);
    controls.target.lerpVectors(fly.fromT, fly.target, k);
    if (fly.t === 1) fly = null;
  }
  controls.update();
  for (const d of dogs) {
    d.update(t, dt, !!refCfg);
    tmp.copy(d.group.position).setY(0.82).project(camera);
    d.tag.style.transform = `translate(-50%, -50%) translate(${(tmp.x * 0.5 + 0.5) * innerWidth}px, ${(-tmp.y * 0.5 + 0.5) * innerHeight}px)`;
  }
  renderer.render(scene, camera);
});

// "Foto 3D": the realistic models live on Meshy (exporting them is a paid feature), so they are
// shown through Meshy's official embeddable viewer instead of inside this scene.
function showGallery() {
  document.body.classList.add('foto', 'ready');
  // On a phone only one viewer is shown (and loaded) at a time; the Cookie/Cacau buttons switch.
  const narrow = matchMedia('(max-width: 760px)');
  const show = (name) => {
    for (const fig of gallery.children) {
      const on = !narrow.matches || fig.dataset.name === name;
      fig.hidden = !on;
      const frame = fig.querySelector('iframe');
      if (on && frame && !frame.src) frame.src = frame.dataset.src;
    }
    document.querySelectorAll('[data-focus]').forEach((b) => b.classList.toggle('on', b.dataset.focus === name));
  };
  document.querySelectorAll('[data-focus]').forEach((b) => (b.onclick = () => show(b.dataset.focus)));
  status.textContent = '';
  document.querySelector('header p').textContent = 'Modelos realistas feitos por IA · arraste para girar';
  const gallery = document.querySelector('#gallery');
  for (const cfg of [cookie, cacau]) {
    const fig = document.createElement('figure');
    fig.dataset.name = cfg.name;
    const cap = document.createElement('figcaption');
    cap.append(cfg.name);
    if (cfg.meshy) {
      const frame = document.createElement('iframe');
      frame.dataset.src = cfg.meshy.embed;
      frame.title = `${cfg.name} em 3D`;
      frame.allow = 'fullscreen; xr-spatial-tracking';
      fig.append(frame);
      const link = document.createElement('a');
      link.href = cfg.meshy.page;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'gerado no Meshy';
      cap.append(' · ', link);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const img = document.createElement('img');
      img.src = `fotos/${cfg.name.toLowerCase()}/${cfg.name.toLowerCase()}.jpeg`;
      img.alt = `Foto da ${cfg.name}`;
      const p = document.createElement('p');
      p.textContent = `A ${cfg.name} ainda não tem modelo realista. Gere no Meshy a partir de uma foto dela e compartilhe o link.`;
      empty.append(img, p);
      fig.append(empty);
    }
    fig.append(cap);
    gallery.append(fig);
  }
  show('Cookie');
  narrow.addEventListener('change', () => show('Cookie'));
}

if (modo === 'foto' && !refCfg) showGallery();
else build();
