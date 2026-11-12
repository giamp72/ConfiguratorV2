import * as THREE from '../vendor/three/build/three.module.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/three/examples/jsm/controls/OrbitControls.js';

function nodePaths(document) {
  const paths = new Map();
  const nodes = document.nodes || [];
  const parents = new Set(nodes.flatMap((node) => node.children || []));
  const roots = document.scenes?.[document.scene ?? 0]?.nodes
    || nodes.map((_, index) => index).filter((index) => !parents.has(index));
  const visit = (index, parentPath) => {
    const node = nodes[index];
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
  const materials = new Set();
  const geometries = new Set();
  gltf.scene.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    objectMaterials.filter(Boolean).forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => {
    Object.values(material).forEach((value) => {
      if (value?.isTexture) textures.add(value);
    });
    material.dispose();
  });
  textures.forEach((texture) => texture.dispose());
}

function validateComponents(components) {
  if (!Array.isArray(components)) throw new TypeError('I componenti devono essere un array.');
  const ids = new Set();
  return components.map((component) => {
    if (!component || typeof component.id !== 'string' || !component.id
        || ids.has(component.id) || typeof component.url !== 'string' || !component.url) {
      throw new TypeError('Ogni componente deve avere un id univoco e un URL.');
    }
    ids.add(component.id);
    for (const key of ['position', 'rotation']) {
      if (!component[key] || !['x', 'y', 'z'].every((axis) => Number.isFinite(component[key][axis]))) {
        throw new TypeError(`${key} deve contenere x, y e z numerici.`);
      }
    }
    return {
      id: component.id,
      url: component.url,
      position: { ...component.position },
      rotation: { ...component.rotation },
    };
  });
}

function supersededError() {
  const error = new Error('Caricamento anteprima annullato.');
  error.name = 'AbortError';
  return error;
}

// For multi-primitive meshes GLTFLoader associates the node with their parent group.
function meshPath(object, gltf, paths) {
  for (let node = object; node; node = node.parent) {
    const index = gltf.parser.associations.get(node)?.nodes;
    if (index != null) return paths.get(index);
    if (node === gltf.scene) break;
  }
  return null;
}

export function createProductPreview(stage) {
  const loader = new GLTFLoader();
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
  let materialSphere = null;
  let components = [];
  let singleProduct = false;
  let pendingLoad = null;
  let running = true;
  let animationFrame = null;
  const originalMaterials = new Map();
  const originalVisibility = new Map();
  const appliedMaterials = new Set();
  const materialCache = new Map();
  const materialInstances = new Set();
  const materialGltfs = [];
  let configurationEntries = [];
  let highlighted = null;

  const fitCamera = () => {
    if (!model) return;
    const bounds = new THREE.Box3().setFromObject(model);
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.01);
    const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
    const distance = radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)) * 1.15;
    const direction = new THREE.Vector3(0.8, 0.55, 1).normalize();
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = 0.0001;
    camera.far = distance * 100 + radius * 2;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  };

  const resize = () => {
    if (!running) return;
    const width = Math.max(stage.clientWidth, 1);
    const height = Math.max(stage.clientHeight, 1);
    const aspectChanged = camera.aspect !== width / height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (aspectChanged && model) fitCamera();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();

  const animate = () => {
    if (!running) return;
    animationFrame = requestAnimationFrame(animate);
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

    for (const component of components) {
      const byPath = new Map(entries
        .filter((entry) => singleProduct ? entry.componentId == null : entry.componentId === component.id)
        .map((entry) => [entry.path, entry]));
      component.gltf.scene.traverse((object) => {
        if (!object.isMesh) return;
        const path = meshPath(object, component.gltf, component.paths);
        const entry = path ? byPath.get(path) : null;
        if (entry?.material) {
          const material = entry.material.clone();
          appliedMaterials.add(material);
          object.material = material;
        }
        if (typeof entry?.visible === 'boolean') object.visible = entry.visible;
        if (!path || path !== highlighted?.path
            || (!singleProduct && highlighted.componentId !== component.id)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const highlightedMaterials = materials.map((source) => {
          const material = source.clone();
          if (material.color) material.color.lerp(new THREE.Color('#a855f7'), 0.65);
          if (material.emissive) {
            material.emissive.set('#7e22ce');
            material.emissiveIntensity = Math.max(material.emissiveIntensity || 0, 0.5);
          }
          appliedMaterials.add(material);
          return material;
        });
        object.material = Array.isArray(object.material) ? highlightedMaterials : highlightedMaterials[0];
      });
    }
  };

  const removeModel = () => {
    if (model) scene.remove(model);
    for (const [object, material] of originalMaterials) object.material = material;
    for (const material of appliedMaterials) material.dispose();
    appliedMaterials.clear();
    components.forEach(({ gltf }) => disposeGltf(gltf));
    if (materialSphere) {
      materialSphere.geometry.dispose();
      materialSphere.material.dispose();
      materialSphere = null;
    }
    components = [];
    model = null;
    singleProduct = false;
    originalMaterials.clear();
    originalVisibility.clear();
    configurationEntries = [];
    highlighted = null;
  };

  const loadComponents = (definitions, isSingleProduct) => {
    if (!running) return Promise.reject(new Error('Anteprima non più disponibile.'));
    pendingLoad?.cancel();
    return new Promise((resolve, reject) => {
      const loaded = new Array(definitions.length);
      let remaining = definitions.length;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (pendingLoad === request) pendingLoad = null;
        loaded.forEach((gltf) => { if (gltf) disposeGltf(gltf); });
        reject(error);
      };
      const request = { cancel: () => finish(supersededError()) };
      pendingLoad = request;

      const install = () => {
        try {
          const group = new THREE.Group();
          const prepared = loaded.map((gltf, index) => {
            const definition = definitions[index];
            const wrapper = new THREE.Group();
            wrapper.position.set(definition.position.x, definition.position.y, definition.position.z);
            wrapper.rotation.set(definition.rotation.x, definition.rotation.y, definition.rotation.z, 'XYZ');
            wrapper.add(gltf.scene);
            group.add(wrapper);
            return { id: definition.id, gltf, paths: nodePaths(gltf.parser.json) };
          });
          removeModel();
          model = group;
          components = prepared;
          singleProduct = isSingleProduct;
          for (const component of components) {
            component.gltf.scene.traverse((object) => {
              if (!object.isMesh) return;
              originalMaterials.set(object, object.material);
              originalVisibility.set(object, object.visible);
            });
          }
          scene.add(model);
          resize();
          fitCamera();
          settled = true;
          if (pendingLoad === request) pendingLoad = null;
          resolve();
        } catch (error) {
          finish(error);
        }
      };
      if (!remaining) {
        install();
        return;
      }
      definitions.forEach(({ url }, index) => {
        if (settled) return;
        let promise;
        try {
          promise = loader.loadAsync(url);
        } catch (error) {
          finish(error);
          return;
        }
        Promise.resolve(promise).then((gltf) => {
          if (settled) {
            disposeGltf(gltf);
            return;
          }
          loaded[index] = gltf;
          if (!--remaining) install();
        }, finish);
      });
    });
  };

  return {
    showMaterial(material) {
      if (!running) throw new Error('Anteprima non più disponibile.');
      pendingLoad?.cancel();
      removeModel();
      materialSphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material.clone());
      model = materialSphere;
      scene.add(model);
      resize();
      fitCamera();
    },
    async loadProduct(url) {
      const zero = { x: 0, y: 0, z: 0 };
      return loadComponents(validateComponents([{ id: 'product', url, position: zero, rotation: zero }]), true);
    },
    // Positions use glTF units (meters by convention); XYZ Euler rotations are radians.
    // Assembly mappings and highlight use { componentId, path }.
    async loadAssembly(definitions) {
      return loadComponents(validateComponents(definitions), false);
    },
    async loadMaterial(id, url) {
      if (!running) throw new Error('Anteprima non più disponibile.');
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
        if (materialCache.get(id) === request) materialCache.delete(id);
        throw error;
      }
    },
    clear() {
      pendingLoad?.cancel();
      removeModel();
    },
    applyConfiguration,
    highlight(target) {
      highlighted = typeof target === 'string' ? { path: target } : target;
      applyConfiguration(configurationEntries);
    },
    dispose() {
      if (!running) return;
      running = false;
      pendingLoad?.cancel();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      observer.disconnect();
      controls.dispose();
      for (const material of materialInstances) material.dispose();
      materialInstances.clear();
      materialCache.clear();
      removeModel();
      materialGltfs.forEach(disposeGltf);
      renderer.dispose();
      if (renderer.domElement.parentNode === stage) stage.removeChild(renderer.domElement);
    },
  };
}
