# Local Three.js distribution

- Package: `three@0.180.0` from the official npm registry.
- Archive: `https://registry.npmjs.org/three/-/three-0.180.0.tgz`.
- Verified npm integrity: `sha512-o+qycAMZrh+TsE01GqWUxUIKR1AL0S8pq7zDkYOQw8GqfX8b8VoCKYUoHbhiX5j+7hr8XsuHDVU6+gkQJQKg9w==`.
- Core files: `build/three.module.js` and `build/three.core.js`.
- Addons: `examples/jsm/controls/OrbitControls.js`, `examples/jsm/loaders/GLTFLoader.js`, `examples/jsm/utils/BufferGeometryUtils.js` and `examples/jsm/libs/meshopt_decoder.module.js`.
- Addons are stored in this flat directory. Bare `three` imports and GLTFLoader's utility import are changed to local relative imports; no runtime CDN dependency is introduced.
- Original Three.js license and bundled third-party notices are retained. Model / texture assets are separate game resources, not covered by the Three.js license.
