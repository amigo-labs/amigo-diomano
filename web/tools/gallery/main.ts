/**
 * The model gallery. See `index.html` next to this file.
 *
 * Both tiers of every model, one grid cell each, lit the way `vegetation.ts`
 * lights them (Lambert, the sun from the upper left, the ambient the game
 * uses). Vertex colours on, because that is what tier 2 depends on. The figure
 * is fetched from `public/models/`, the rest is built in place.
 */

import * as THREE from "three";
import { readGlb } from "../../src/renderer/geometry";
import { type ModelTier, buildingModels, floraModels, propModels } from "../../src/renderer/models";

const params = new URLSearchParams(location.search);
const only = params.get("tier");
const tiers: ModelTier[] = only === "1" ? [1] : only === "2" ? [2] : [1, 2];

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1c2230);
scene.add(new THREE.AmbientLight(0xffffff, 1.4));
const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
sun.position.set(-3, 5, 4);
scene.add(sun);

const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 100);

/** Cells in a row: the four flora species with two variants, buildings, props, figure. */
const COLUMNS = 16;
let cursor = 0;
let row = 0;

const place = (geometry: THREE.BufferGeometry, colour: number, scale = 1): void => {
  const material = new THREE.MeshLambertMaterial({
    color: colour,
    vertexColors: geometry.hasAttribute("color"),
  });
  const mesh = new THREE.Mesh(geometry, material);
  const col = cursor % COLUMNS;
  mesh.position.set(col * 1.6 + 0.8, -row * 2.0 - 1.7, 0);
  mesh.scale.setScalar(scale);
  mesh.rotation.y = 0.6;
  scene.add(mesh);
  cursor += 1;
};

async function build(): Promise<void> {
  for (const tier of tiers) {
    cursor = 0;
    const flora = floraModels(tier);
    for (let kind = 0; kind < flora.geometries.length; kind++) {
      for (const g of flora.geometries[kind] ?? []) place(g, flora.colours[kind] ?? 0xffffff);
      if ((flora.geometries[kind]?.length ?? 0) < 2) cursor += 1;
    }
    const houses = buildingModels(tier);
    for (const g of [houses.hut, houses.house, houses.tower, houses.wall]) place(g, houses.colour);
    const props = propModels(tier);
    place(props.pickup, 0xffe066, 0.5);
    place(props.magnet, 0xd6ffd0);
    const file = tier >= 2 ? "/models/villager.glb" : "/models/villager-low.glb";
    const response = await fetch(file);
    // A 404 here is the one failure that used to pass: an empty last cell,
    // `data-ready` set, `shoot.mjs` exits 0. The header says the models are
    // required; make it so.
    if (!response.ok) throw new Error(`${file}: ${response.status} ${response.statusText}`);
    place(readGlb(await response.arrayBuffer()), 0xffd9a8, 1.4);
    row += 1;
  }
  const width = COLUMNS * 1.6;
  const height = tiers.length * 2.0 + 0.4;
  camera.left = 0;
  camera.right = width;
  camera.top = 0.2;
  camera.bottom = -height + 0.2;
  camera.position.set(0, 0, 10);
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, Math.round((innerWidth * height) / width));
  renderer.render(scene, camera);
  document.body.dataset.ready = "1";
}

void build();
