/**
 * The model gallery. See `index.html` next to this file.
 *
 * Every tier of every model, one grid cell each, lit the way `vegetation.ts`
 * lights them (Lambert, the sun from the upper left, the ambient the game
 * uses). Vertex colours on, because that is what tier 2 depends on, and the
 * team mask on, because that is where the side's colour goes: each tier is two
 * rows, the first in player 0's colours and the second in player 1's. The
 * flora has no side, so the second row puts the pickup crystal in every
 * power's colour where the trees were. The figure is fetched from
 * `public/models/`, the rest is built in place.
 */

import * as THREE from "three";
import { readGlb } from "../../src/renderer/geometry";
import { type ModelTier, buildingModels, floraModels, propModels } from "../../src/renderer/models";
import {
  MAGNET_TEAM,
  PICKUP_POWER,
  type PerPlayer,
  SETTLEMENT_TEAM,
  TEAM_MASK_GLSL,
  WALKER_TEAM,
  pickupColour,
} from "../../src/renderer/palette";
import { POWER } from "../../src/verbs";

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

/** Cells in a row: eight flora, five buildings, the two props and the figure. */
const COLUMNS = 16;
const CELL_W = 1.6;
const CELL_H = 2.3;
let cursor = 0;
let row = 0;

/**
 * Lambert with the game's team mask (`TEAM_MASK_GLSL`) and nothing else: no
 * haze, no night lights, no walk cycle — the gallery shows the models, not the
 * planet.
 */
const teamLambert = (geometry: THREE.BufferGeometry, colour: number): THREE.Material => {
  const material = new THREE.MeshLambertMaterial({
    color: colour,
    vertexColors: geometry.hasAttribute("color"),
  });
  // A model with no team parts (the wall segment, the flora) is all zeros, as
  // `vegetation.ts` fills it: washed by the side's colour, never painted in it.
  if (!geometry.hasAttribute("team")) {
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute("team", new THREE.BufferAttribute(new Float32Array(count), 1));
  }
  material.onBeforeCompile = (shader) => {
    for (const marker of ["#include <common>", "#include <color_vertex>"]) {
      if (!shader.vertexShader.includes(marker)) throw new Error(`gallery: no ${marker}`);
    }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${TEAM_MASK_GLSL.head}`)
      .replace("#include <color_vertex>", TEAM_MASK_GLSL.colour);
  };
  material.customProgramCacheKey = () => "gallery-team";
  return material;
};

/**
 * One model in the next cell, as a one-instance `InstancedMesh` so the
 * per-instance colour reaches it the way it does in the game.
 */
const place = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  tint: number | readonly [number, number, number] = 0xffffff,
  scale = 1,
  /** Height above the cell's floor: the crystal floats, as it does in the game. */
  lift = 0,
): void => {
  const mesh = new THREE.InstancedMesh(geometry, material, 1);
  const col = cursor % COLUMNS;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(col * CELL_W + CELL_W / 2, -row * CELL_H - CELL_H + 0.25 + lift, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.6, 0)),
    new THREE.Vector3(scale, scale, scale),
  );
  mesh.setMatrixAt(0, m);
  const c = typeof tint === "number" ? new THREE.Color(tint) : new THREE.Color(...tint);
  mesh.setColorAt(0, c);
  scene.add(mesh);
  cursor += 1;
};

const pickupMaterial = (): THREE.Material =>
  new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });

async function build(): Promise<void> {
  for (const tier of tiers) {
    const file = tier >= 2 ? "/models/villager.glb" : "/models/villager-low.glb";
    const response = await fetch(file);
    // A 404 here is the one failure that used to pass: an empty last cell,
    // `data-ready` set, `shoot.mjs` exits 0. The header says the models are
    // required; make it so.
    if (!response.ok) throw new Error(`${file}: ${response.status} ${response.statusText}`);
    const figure = readGlb(await response.arrayBuffer());
    const flora = floraModels(tier);
    const houses = buildingModels(tier);
    const props = propModels(tier);

    for (const player of [0, 1] as const) {
      cursor = 0;
      const side = (table: PerPlayer) => table[player];
      if (player === 0) {
        for (let kind = 0; kind < flora.geometries.length; kind++) {
          for (const g of flora.geometries[kind] ?? []) {
            place(g, teamLambert(g, flora.colours[kind] ?? 0xffffff));
          }
          if ((flora.geometries[kind]?.length ?? 0) < 2) cursor += 1;
        }
      } else {
        // Every power's crystal, in power order, where the trees are above.
        for (const power of Object.values(POWER)) {
          if (PICKUP_POWER[power] === undefined) continue;
          place(props.pickup, pickupMaterial(), pickupColour(power), 0.45, 0.6);
        }
        cursor = 8;
      }
      for (const g of [houses.hut, houses.house, houses.tower, houses.wall]) {
        place(g, teamLambert(g, houses.colour), side(SETTLEMENT_TEAM));
      }
      place(
        houses.citadel,
        teamLambert(houses.citadel, houses.colour),
        side(SETTLEMENT_TEAM),
        0.75,
      );
      if (player === 0)
        place(props.pickup, pickupMaterial(), pickupColour(POWER.CHAMPION), 0.45, 0.6);
      else cursor += 1;
      place(props.magnet, teamLambert(props.magnet, 0xffffff), side(MAGNET_TEAM));
      place(figure, teamLambert(figure, 0xffffff), side(WALKER_TEAM), 1.4);
      row += 1;
    }
  }
  const width = COLUMNS * CELL_W;
  const height = row * CELL_H + 0.2;
  camera.left = 0;
  camera.right = width;
  camera.top = 0.1;
  camera.bottom = -height + 0.1;
  camera.position.set(0, 0, 10);
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, Math.round((innerWidth * height) / width));
  renderer.render(scene, camera);
  document.body.dataset.ready = "1";
}

void build();
