import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Post-processing: HDR render target (MSAA), threshold bloom for emissives
 * and the sun, then tone mapping + sRGB in the output pass. Low quality
 * renders straight to the canvas instead. Quality can change at runtime.
 */
export class Post {
  constructor(renderer, scene, camera, quality = 'high') {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.setQuality(quality);
  }
  setQuality(quality) {
    this.quality = quality;
    this.enabled = quality !== 'low';
    if (!this.enabled) return;
    const samples = quality === 'high' ? 4 : 2;
    if (this.composer && this.samples === samples) return;
    this.composer?.dispose?.();
    this.samples = samples;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.62, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }
  setSize(width, height) {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }
  render(dt) { if (this.enabled) this.composer.render(dt); else this.renderer.render(this.scene, this.camera); }
  setBloom(strength) { if (this.bloom) this.bloom.strength = strength; }
}
