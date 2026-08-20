/**
 * Post-processing. HANDOFF §7.3.
 *
 * Tier 1: FXAA and a tight bloom that only catches lava. FXAA is not
 * optional: instanced trees on a sphere alias badly. Tier 3 (SSAO, DoF,
 * god rays) is out of scope.
 *
 * Tone mapping is ACES and lives on the renderer rather than in a pass, so it
 * applies before the composer's colour space conversion.
 */

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import type { QualityTier } from "../main";

export interface Post {
  render(): void;
  resize(width: number, height: number): void;
}

export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  tier: QualityTier,
): Post {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Threshold at 1.0: the atmosphere rim peaks at cover x colour <= ~0.9 even
  // under warning red, so the sky still never blooms across the disk, while
  // lava's 1.75 core clears it with margin. The wider radius is for lava and
  // the night lights — the limb's own halo is the shell's exponential falloff,
  // not bloom, so do not chase it by lowering this threshold.
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), tier >= 2 ? 0.12 : 0.06, 0.28, 1.0);
  composer.addPass(bloom);

  // `OutputPass` before FXAA, not after. FXAA thresholds on luma, so it needs
  // sRGB input; three's own `OutputPass` documents the requirement ("if a pass
  // requires sRGB input (e.g. like FXAA), the pass must follow OutputPass").
  // Run the other way round it evaluates tone-mapped linear-light data and
  // under-detects edges in shadow while over-smoothing highlights — on exactly
  // the aliasing-instanced-trees content §7.3 makes FXAA non-optional for.
  composer.addPass(new OutputPass());
  const fxaa = new ShaderPass(FXAAShader);
  composer.addPass(fxaa);

  const setSize = (width: number, height: number): void => {
    // `EffectComposer.setSize` already multiplies by its pixel ratio for every
    // pass it owns, so calling `bloom.setSize(width, height)` afterwards — which
    // this used to — put bloom back to CSS resolution, i.e. half-res on a 2x
    // display.
    composer.setSize(width, height);
    const dpr = renderer.getPixelRatio();
    // FXAA works in texels, so it needs the *buffer* size, not the CSS size.
    // Getting this wrong is invisible on a 1x display and blurs everything on a
    // retina one.
    const res = fxaa.material.uniforms.resolution;
    if (res) res.value.set(1 / (width * dpr), 1 / (height * dpr));
  };
  // CSS pixels, matching what `resize` is called with. `domElement.width` is the
  // drawing buffer — CSS x DPR already — so passing it here counted DPR twice
  // and allocated targets four times too large until the first real resize.
  setSize(
    renderer.domElement.width / renderer.getPixelRatio() || 1,
    renderer.domElement.height / renderer.getPixelRatio() || 1,
  );

  return {
    render(): void {
      composer.render();
    },
    resize(width: number, height: number): void {
      setSize(width, height);
    },
  };
}
