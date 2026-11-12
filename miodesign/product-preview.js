import * as THREE from '../vendor/three/build/three.module.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/three/examples/jsm/controls/OrbitControls.js';

const loader = new GLTFLoader();

function nodePaths(document) {
  const paths = new Map();
  const parents = new Set((document.nodes || []).flatMap((node) => node.children || []));
  const roots = document.scenes?.[document.scene ?? 0]?.nodes
    || document.nodes.map((_, index) => index).filter((index) => !parents.has(index));
  const visit = (index, parentPath) => {
    const node = document.nodes[index];
    if (!node) return;
    const label = node.name || document.meshes?.[node.mesh]?.name || `Nodo ${index + 1}`;
    const path = `${parentPath}/${label}[${index}]`;
    paths.set(index, path);
    (node.children || []).forEach((child) => visit(child, path));
  };
  roots.forEach((root) => visit(root, ''));
  return paths;
}

function disposeGltf(gltf) {
  const textures = new Set();
  gltf.scene.traverse((object) => {
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value?.isTexture) textures.add(value);
      });
      material.dispose();
    });
  });
  textures.forEach((texture) => texture.dispose());
}

export function createProductPreview(stage) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f5f7f3');
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  stage.replaceChildren(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x89958a, 2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
  keyLight.position.set(4, 7, 5);
  scene.add(keyLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));

  let model = null;
  let modelGltf = null;
  let running = true;
  const originalMaterials = new Map();
  const originalVisibility = new Map();
  const appliedMaterials = new Set();
  const materialCache = new Map();
  const materialInstances = new Set();
  const materialGltfs = [];
  let configurationEntries = [];
  let highlightedPath = null;

  const fitCamera = () => {
    if (!model) return;
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z);
    const distance = maxSize / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.35;
    camera.position.set(center.x + distance * 0.8, center.y + distance * 0.55, center.z + distance);
    camera.near = Math.max(distance / 1000, 0.01);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  };

  const resize = () => {
    if (!running) return;
    const width = Math.max(stage.clientWidth, 1);
    const height = Math.max(stage.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();

  const animate = () => {
    if (!running) return;
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  const applyConfiguration = (entries) => {
    if (!model) return;
    configurationEntries = entries;
    for (const [object, material] of originalMaterials) object.material = material;
    for (const [object, visible] of originalVisibility) object.visible = visible;
    for (const material of appliedMaterials) material.dispose();
    appliedMaterials.clear();

    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    model.traverse((object) => {
      if (!object.isMesh) return;
      const association = modelGltf.parser.associations.get(object);
      const path = association?.nodes == null ? null : modelGltf.userData.nodePaths.get(association.nodes);
      const entry = path ? byPath.get(path) : null;
      if (entry?.material) {
        const material = entry.material.clone();
        appliedMaterials.add(material);
        object.material = material;
      }
      if (typeof entry?.visible === 'boolean') object.visible = entry.visible;
      if (path !== highlightedPath) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const highlighted = materials.map((source) => {
        const material = source.clone();
        if (material.color) material.color.lerp(new THREE.Color('#a855f7'), 0.65);
        if (material.emissive) {
          material.emissive.set('#7e22ce');
          material.emissiveIntensity = Math.max(material.emissiveIntensity || 0, 0.5);
        }
        appliedMaterials.add(material);
        return material;
      });
      object.material = Array.isArray(object.material) ? highlighted : highlighted[0];
    });
  };

  return {
    async loadProduct(url) {
      if (model) {
        scene.remove(model);
        for (const [object, material] of originalMaterials) object.material = material;
        for (const material of appliedMaterials) material.dispose();
        appliedMaterials.clear();
        disposeGltf(modelGltf);
      }
      model = null;
      modelGltf = null;
      originalMaterials.clear();
      originalVisibility.clear();
      modelGltf = await loader.loadAsync(url);
      if (!running) {
        disposeGltf(modelGltf);
        modelGltf = null;
        throw new Error('Anteprima non più disponibile.');
      }
      model = modelGltf.scene;
      modelGltf.userData.nodePaths = nodePaths(modelGltf.parser.json);
      configurationEntries = [];
      model.traverse((object) => {
        if (!object.isMesh) return;
        originalMaterials.set(object, object.material);
        originalVisibility.set(object, object.visible);
      });
      scene.add(model);
      fitCamera();
      resize();
    },
    async loadMaterial(id, url) {
      if (materialCache.has(id)) return materialCache.get(id);
      const request = loader.loadAsync(url).then((gltf) => {
        let material = null;
        gltf.scene.traverse((object) => {
          if (!material && object.isMesh) material = Array.isArray(object.material) ? object.material[0] : object.material;
        });
        if (!material) {
          disposeGltf(gltf);
          throw new Error('Il GLB del materiale non contiene una mesh con materiale.');
        }
        if (!running) {
          disposeGltf(gltf);
          throw new Error('Anteprima non più disponibile.');
        }
        materialGltfs.push(gltf);
        const clonedMaterial = material.clone();
        materialInstances.add(clonedMaterial);
        return clonedMaterial;
      });
      materialCache.set(id, request);
      try {
        return await request;
      } catch (error) {
        materialCache.delete(id);
        throw error;
      }
    },
    clear() {
      if (!model) return;
      scene.remove(model);
      for (const [object, material] of originalMaterials) object.material = material;
      for (const material of appliedMaterials) material.dispose();
      appliedMaterials.clear();
      disposeGltf(modelGltf);
      model = null;
      modelGltf = null;
      originalMaterials.clear();
      originalVisibility.clear();
    },
    applyConfiguration,
    highlight(path) {
      highlightedPath = path;
      applyConfiguration(configurationEntries);
    },
    dispose() {
      running = false;
      observer.disconnect();
      controls.dispose();
      for (const material of materialInstances) material.dispose();
      materialInstances.clear();
      materialCache.clear();
      for (const [object, material] of originalMaterials) object.material = material;
      for (const material of appliedMaterials) material.dispose();
      appliedMaterials.clear();
      if (modelGltf) disposeGltf(modelGltf);
      materialGltfs.forEach(disposeGltf);
      renderer.dispose();
      stage.replaceChildren();
    },
  };
}
