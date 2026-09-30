import * as THREE from 'three';

// A ship-local camera mount avoids world-up lookAt singularities at loop poles.
export const CHASE_OFFSET = new THREE.Vector3(0, 12, 36);
const CHASE_AIM = new THREE.Vector3(0, 2, -30);
export const CHASE_ROTATION = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().lookAt(CHASE_OFFSET, CHASE_AIM, new THREE.Vector3(0, 1, 0)),
);
export function captureChaseMount(cameraPosition, cameraQuaternion, shipPosition, shipQuaternion) {
  const inverse = shipQuaternion.clone().invert();
  return {offset:cameraPosition.clone().sub(shipPosition).applyQuaternion(inverse),rotation:inverse.multiply(cameraQuaternion).normalize()};
}
export function chaseCameraPose(shipPosition, shipQuaternion, mount = null, elapsed = .22) {
  const linear=THREE.MathUtils.clamp(elapsed/.22,0,1),blend=linear*linear*(3-2*linear);
  const offset=mount?mount.offset.clone().lerp(CHASE_OFFSET,blend):CHASE_OFFSET.clone();
  const rotation=mount?mount.rotation.clone().slerp(CHASE_ROTATION,blend):CHASE_ROTATION.clone();
  return {position:offset.applyQuaternion(shipQuaternion).add(shipPosition),quaternion:shipQuaternion.clone().multiply(rotation).normalize(),up:new THREE.Vector3(0,1,0).applyQuaternion(shipQuaternion)};
}
