import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../../vendor/three/build/three.module.js';

const requests = [];
const renderers = [];
const observers = [];
class Loader {
  loadAsync(url) {
    return new Promise((resolve, reject) => requests.push({ url, resolve, reject }));
  }
}
class Renderer {
  constructor() {
    this.domElement = { parentNode: null };
    renderers.push(this);
  }
  setPixelRatio() {}
  setSize() {}
  render(scene, camera) { this.scene = scene; this.camera = camera; }
  dispose() { this.disposed = true; }
}
class Controls {
  constructor(camera) { this.camera = camera; this.target = new THREE.Vector3(); }
  update() {}
  dispose() { this.disposed = true; }
}
globalThis.__previewMocks = { THREE: { ...THREE, WebGLRenderer: Renderer }, Loader, Controls };
globalThis.window = { devicePixelRatio: 1 };
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const source = (await readFile(new URL('../product-preview.js', import.meta.url), 'utf8'))
  .replace("import * as THREE from '../vendor/three/build/three.module.js';", 'const THREE = globalThis.__previewMocks.THREE;')
  .replace("import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';", 'const GLTFLoader = globalThis.__previewMocks.Loader;')
  .replace("import { OrbitControls } from '../vendor/three/examples/jsm/controls/OrbitControls.js';", 'const OrbitControls = globalThis.__previewMocks.Controls;');
const { createProductPreview } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function stage(width = 800, height = 600) {
  return {
    clientWidth: width, clientHeight: height, child: null,
    replaceChildren(child) {
      if (this.child) this.child.parentNode = null;
      this.child = child || null;
      if (child) child.parentNode = this;
    },
    removeChild(child) {
      assert.equal(this.child, child);
      this.child.parentNode = null;
      this.child = null;
    },
  };
}
function fixture({ multi = false } = {}) {
  const scene = new THREE.Group();
  const node = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 'white' });
  let geometryDisposals = 0;
  let materialDisposals = 0;
  geometry.addEventListener('dispose', () => geometryDisposals++);
  material.addEventListener('dispose', () => materialDisposals++);
  const mesh = new THREE.Mesh(geometry, material);
  const associations = new Map();
  if (multi) {
    node.add(mesh, new THREE.Mesh(geometry, material));
    scene.add(node);
    associations.set(node, { nodes: 0, meshes: 0 });
    associations.set(mesh, { meshes: 0, primitives: 0 });
  } else {
    scene.add(mesh);
    associations.set(mesh, { nodes: 0, meshes: 0, primitives: 0 });
  }
  return {
    scene, mesh, material, geometry,
    parser: { json: { nodes: [{ name: 'Part', mesh: 0 }], scenes: [{ nodes: [0] }] }, associations },
    get geometryDisposals() { return geometryDisposals; },
    get materialDisposals() { return materialDisposals; },
  };
}
const path = '/Part[0]';
const component = (id, url, x = 0, rotation = 0) => ({
  id, url, position: { x, y: 0, z: 0 }, rotation: { x: 0, y: rotation, z: 0 },
});
const nextRequest = () => {
  const request = requests.shift();
  assert.ok(request);
  return request;
};

test('material preview shows a sphere and preserves shared textures when replaced or cleared', async () => {
  const preview = createProductPreview(stage());
  const gltf = fixture();
  const texture = new THREE.Texture();
  let textureDisposals = 0;
  texture.addEventListener('dispose', () => textureDisposals++);
  gltf.material.map = texture;
  const loading = preview.loadMaterial(1, 'material.glb');
  nextRequest().resolve(gltf);
  const material = await loading;
  preview.showMaterial(material);
  const scene = renderers.at(-1).scene;
  const sphere = scene.children.find((object) => object.isMesh);
  assert.equal(sphere.geometry.type, 'SphereGeometry');
  assert.equal(sphere.material.map, texture);
  preview.showMaterial(material);
  assert.equal(textureDisposals, 0);
  preview.clear();
  assert.equal(textureDisposals, 0);
  preview.dispose();
  assert.equal(textureDisposals, 1);
});

test('assembly scopes mapping and highlight by identity, transforms instances and fits their bounds', async () => {
  const target = stage(300, 900);
  const preview = createProductPreview(target);
  const pending = preview.loadAssembly([component('left', 'same.glb', -10), component('right', 'same.glb', 10, Math.PI / 2)]);
  const left = fixture({ multi: true });
  const right = fixture({ multi: true });
  const first = nextRequest();
  const second = nextRequest();
  assert.equal(first.url, 'same.glb');
  assert.equal(second.url, 'same.glb');
  second.resolve(right);
  first.resolve(left);
  await pending;
  assert.equal(left.scene.parent.position.x, -10);
  assert.equal(right.scene.parent.position.x, 10);
  assert.equal(right.scene.parent.rotation.y, Math.PI / 2);

  const replacement = new THREE.MeshStandardMaterial({ color: 'red' });
  preview.applyConfiguration([
    { path, visible: false },
    { componentId: 'left', path, visible: false, material: replacement },
    { componentId: 'right', path, visible: true },
  ]);
  assert.equal(left.mesh.visible, false);
  assert.equal(left.scene.children[0].children[1].visible, false);
  assert.equal(right.mesh.visible, true);
  assert.notEqual(left.mesh.material, left.material);
  assert.equal(right.mesh.material, right.material);
  preview.highlight({ componentId: 'right', path });
  assert.equal(right.mesh.material.emissive.getHexString(), '7e22ce');
  assert.notEqual(left.mesh.material.emissive.getHexString(), '7e22ce');
  preview.highlight(path);
  assert.equal(right.mesh.material, right.material);

  const camera = renderers.at(-1).camera;
  const center = new THREE.Vector3();
  const distance = camera.position.distanceTo(center);
  const halfHorizontal = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
  assert.ok(distance * Math.sin(halfHorizontal) > 10.5);
  assert.ok(camera.near > 0 && camera.far > distance + 10.5);
  target.clientWidth = 100;
  observers.at(-1).callback();
  const narrowHalfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
  assert.ok(camera.position.distanceTo(center) * Math.sin(narrowHalfFov) > 10.5);
  preview.dispose();
  assert.equal(left.geometryDisposals, 1);
  assert.equal(left.materialDisposals, 1);
  assert.equal(right.geometryDisposals, 1);
  replacement.dispose();
});

test('single product API remains compatible and restores material and visibility', async () => {
  const preview = createProductPreview(stage());
  const product = fixture();
  const pending = preview.loadProduct('product');
  nextRequest().resolve(product);
  await pending;
  const replacement = new THREE.MeshStandardMaterial();
  preview.applyConfiguration([{ path, material: replacement, visible: false }]);
  assert.equal(product.mesh.visible, false);
  assert.notEqual(product.mesh.material, product.material);
  preview.highlight(path);
  assert.equal(product.mesh.material.emissive.getHexString(), '7e22ce');
  preview.highlight(null);
  preview.applyConfiguration([]);
  assert.equal(product.mesh.material, product.material);
  assert.equal(product.mesh.visible, true);
  preview.clear();
  assert.equal(product.materialDisposals, 1);
  preview.dispose();
  replacement.dispose();
});

test('latest load wins, clear and dispose invalidate pending loads, and failures clean all results', async () => {
  const preview = createProductPreview(stage());
  const old = fixture();
  const newer = fixture();
  const first = preview.loadProduct('old');
  const firstRequest = nextRequest();
  const second = preview.loadAssembly([component('new', 'new')]);
  const secondRequest = nextRequest();
  secondRequest.resolve(newer);
  await second;
  firstRequest.resolve(old);
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(old.materialDisposals, 1);
  assert.equal(newer.materialDisposals, 0);

  const partial = fixture();
  const failure = preview.loadAssembly([component('a', 'a'), component('b', 'b')]);
  const a = nextRequest();
  const b = nextRequest();
  b.reject(new Error('failed'));
  a.resolve(partial);
  await assert.rejects(failure, /failed/);
  assert.equal(partial.materialDisposals, 1);
  assert.equal(newer.materialDisposals, 0);

  const cleared = fixture();
  const third = preview.loadProduct('clear');
  const thirdRequest = nextRequest();
  preview.clear();
  thirdRequest.resolve(cleared);
  await assert.rejects(third, { name: 'AbortError' });
  assert.equal(cleared.materialDisposals, 1);
  assert.equal(newer.materialDisposals, 1);

  const disposed = fixture();
  const fourth = preview.loadProduct('dispose');
  const fourthRequest = nextRequest();
  preview.dispose();
  fourthRequest.resolve(disposed);
  await assert.rejects(fourth, { name: 'AbortError' });
  assert.equal(disposed.materialDisposals, 1);
  await assert.rejects(preview.loadProduct('after'), /non più disponibile/);
});

test('failure and cancellation settle promptly and dispose both completed and late results', async () => {
  const preview = createProductPreview(stage());
  const failed = preview.loadAssembly([
    component('done', 'done'), component('failed', 'failed'), component('stalled', 'stalled'),
  ]);
  const doneRequest = nextRequest();
  const failedRequest = nextRequest();
  const stalledRequest = nextRequest();
  const done = fixture();
  doneRequest.resolve(done);
  await Promise.resolve();
  failedRequest.reject(new Error('broken'));
  await assert.rejects(failed, /broken/);
  assert.equal(done.materialDisposals, 1);
  const late = fixture();
  stalledRequest.resolve(late);
  await Promise.resolve();
  assert.equal(late.materialDisposals, 1);

  const cancelled = preview.loadAssembly([component('done', 'done'), component('stalled', 'stalled')]);
  const completedRequest = nextRequest();
  const delayedRequest = nextRequest();
  const completed = fixture();
  completedRequest.resolve(completed);
  await Promise.resolve();
  const replacement = preview.loadProduct('replacement');
  const replacementRequest = nextRequest();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(completed.materialDisposals, 1);
  const delayed = fixture();
  delayedRequest.resolve(delayed);
  await Promise.resolve();
  assert.equal(delayed.materialDisposals, 1);
  const current = fixture();
  replacementRequest.resolve(current);
  await replacement;
  preview.dispose();
});

test('camera near plane stays small for a widely separated assembly', async () => {
  const preview = createProductPreview(stage());
  const loading = preview.loadAssembly([
    component('left', 'a', -1_000_000), component('right', 'b', 1_000_000),
  ]);
  nextRequest().resolve(fixture());
  nextRequest().resolve(fixture());
  await loading;
  assert.equal(renderers.at(-1).camera.near, 0.0001);
  preview.dispose();
});

test('validates identities and transforms without disturbing existing loads', async () => {
  const preview = createProductPreview(stage());
  const product = fixture();
  const pending = preview.loadProduct('product');
  nextRequest().resolve(product);
  await pending;
  await assert.rejects(preview.loadAssembly([component('a', 'url'), component('a', 'url')]), TypeError);
  await assert.rejects(preview.loadAssembly([{ ...component('a', 'url'), rotation: { x: 0, y: NaN, z: 0 } }]), TypeError);
  assert.equal(product.materialDisposals, 0);
  preview.dispose();
});

test('material requests are cached, retryable and disposed including late results', async () => {
  const preview = createProductPreview(stage());
  const one = preview.loadMaterial('one', 'material');
  const two = preview.loadMaterial('one', 'other');
  const source = fixture();
  nextRequest().resolve(source);
  assert.equal(await one, await two);
  const retry = preview.loadMaterial('retry', 'bad');
  nextRequest().reject(new Error('network'));
  await assert.rejects(retry, /network/);
  const retryAgain = preview.loadMaterial('retry', 'good');
  const retried = fixture();
  nextRequest().resolve(retried);
  await retryAgain;
  const late = preview.loadMaterial('late', 'late');
  const request = nextRequest();
  preview.dispose();
  const lateFixture = fixture();
  request.resolve(lateFixture);
  await assert.rejects(late, /non più disponibile/);
  assert.equal(source.materialDisposals, 1);
  assert.equal(retried.materialDisposals, 1);
  assert.equal(lateFixture.materialDisposals, 1);
  await assert.rejects(preview.loadMaterial('one', 'material'), /non più disponibile/);
});

test('disposing one preview does not remove another preview canvas', () => {
  const target = stage();
  const first = createProductPreview(target);
  const firstRenderer = renderers.at(-1);
  const second = createProductPreview(target);
  const secondCanvas = target.child;
  first.dispose();
  assert.equal(target.child, secondCanvas);
  assert.equal(firstRenderer.disposed, true);
  second.dispose();
  second.dispose();
  assert.equal(target.child, null);
});

test('separate previews load and clear independently', async () => {
  const first = createProductPreview(stage());
  const second = createProductPreview(stage());
  const a = fixture();
  const b = fixture();
  const loadA = first.loadProduct('a');
  const requestA = nextRequest();
  const loadB = second.loadProduct('b');
  const requestB = nextRequest();
  first.clear();
  requestB.resolve(b);
  requestA.resolve(a);
  await loadB;
  await assert.rejects(loadA, { name: 'AbortError' });
  second.applyConfiguration([{ path, visible: false }]);
  assert.equal(b.mesh.visible, false);
  first.dispose();
  assert.equal(b.materialDisposals, 0);
  second.dispose();
  assert.equal(b.materialDisposals, 1);
});
