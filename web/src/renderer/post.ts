/**
 * Post-processing. HANDOFF §7.3.
 *
 * Tier 1: FXAA and subtle bloom. FXAA is explicitly *not optional* in the spec,
 * and the reason is specific: instanced trees on a sphere alias badly, and MSAA
 * would cost more on the integrated-graphics reference floor of §7.6 for a worse
 * result on exactly that content.
 *
 * Tier 2 adds a stronger bloom. Tier 3 (SSAO, depth of field, god rays) is out
 * of scope for this run.
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

  // Subtle at tier 1: bloom is the difference between "lit" and "glowing", and
  // a god game that glows everywhere loses the diorama read of §7.
  // Threshold high and strength low, deliberately. The planet fills most of the
  // frame, so a generous bloom does not pick out highlights — it washes the
  // whole image to a pale haze, which is the opposite of the crisp diorama
  // silhouettes §7 asks for.
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), tier >= 2 ? 0.14 : 0.08, 0.35, 0.96);
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
