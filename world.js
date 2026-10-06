/* THE NEW CAVE — one continuous world, one camera.
   Everything here is procedural: geometry, textures (canvas), shaders. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* ---------- JS value noise (geometry) ---------- */
function h3(x, y, z) { let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683); h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967295; }
function vn3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(h3(xi, yi, zi), h3(xi + 1, yi, zi), fx), l(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), fx), fy),
           l(l(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), fx), l(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), fx), fy), fz);
}
function fbm3(x, y, z, o = 4) { let a = .5, s = 0, n = 0; for (let i = 0; i < o; i++) { s += a * vn3(x, y, z); n += a; x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; z = z * 2.03 + 9.3; a *= .5; } return s / n; }

/* ---------- GLSL snippets ---------- */
const GLSL_NOISE = /* glsl */`
float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float vnoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),f.x), mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),f.x), mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),f.x),f.y), f.z); }
float fbmR(vec3 p){ float a=.5, s=0.; for(int i=0;i<ROCK_OCT;i++){ s+=a*vnoise(p); p=p*2.07+vec3(1.7,9.2,3.1); a*=.5;} return s; }
`;

/* Rock / scatter / cheap-light material enhancer for MeshStandardMaterial */
const shared = {
  uTime: { value: 0 },
  uCLPos: { value: Array.from({ length: 8 }, () => new THREE.Vector3(0, -999, 0)) },
  uCLCol: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
  uScPos: { value: [V3(0, -999, 0), V3(0, -999, 0), V3(0, -999, 0)] },
  uScCol: { value: [V3(), V3(), V3()] },
  uHC: { value: Array.from({ length: 7 }, () => new THREE.Vector3(0, -999, 0)) },
  uHR: { value: Array.from({ length: 7 }, () => new THREE.Vector3(1, 1, 1)) },
  uEng: { value: null },
  uEngR: { value: new THREE.Vector4(-38, 40, 0.9, 6.0) },
  uEngX: { value: -4 },
};

function enhance(mat, opts = {}) {
  const { rock = false, holes = false, engrave = false, oct = 4, tint = [1, 1, 1], scatter = true, bump = 1 } = opts;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, { uTint: { value: new THREE.Vector3(...tint) }, uBump: { value: bump } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos; varying vec3 vWN; attribute float aSmooth; varying float vSmooth;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n vec4 wp4 = modelMatrix * vec4(transformed,1.0);
       #ifdef USE_INSTANCING
         wp4 = modelMatrix * instanceMatrix * vec4(transformed,1.0);
       #endif
       vWPos = wp4.xyz; vWN = normalize(mat3(modelMatrix) * objectNormal);
       #ifdef ROCK_SMOOTH
       vSmooth = aSmooth;
       #else
       vSmooth = 0.0;
       #endif`);
    let fs = sh.fragmentShader;
    const defs = `#define ROCK_OCT ${oct}\n` + (rock ? '#define IS_ROCK\n' : '') + (holes ? '#define HAS_HOLES\n' : '') + (engrave ? '#define HAS_ENGRAVE\n' : '') + (scatter ? '#define HAS_SCATTER\n' : '');
    fs = defs + fs.replace('#include <common>', `#include <common>
      varying vec3 vWPos; varying vec3 vWN; varying float vSmooth;
      uniform float uTime; uniform vec3 uCLPos[8]; uniform vec3 uCLCol[8]; uniform vec3 uScPos[3]; uniform vec3 uScCol[3];
      uniform vec3 uHC[7]; uniform vec3 uHR[7]; uniform sampler2D uEng; uniform vec4 uEngR; uniform float uEngX; uniform vec3 uTint; uniform float uBump;
      ${GLSL_NOISE}
      vec3 perturbRock( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
        vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) ); vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) ); vec3 vN = surf_norm;
        vec3 R1 = cross( vSigmaY, vN ); vec3 R2 = cross( vN, vSigmaX ); float fDet = dot( vSigmaX, R1 ) * faceDirection;
        vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 ); return normalize( abs( fDet ) * surf_norm - vGrad ); }
      float inscat(vec3 ro, vec3 rd, float d, vec3 lp){ vec3 q = ro - lp; float b = dot(rd, q); float c = dot(q,q);
        float s = inversesqrt(max(c - b*b, 0.02)); return s * (atan((d + b) * s) - atan(b * s)); }
      float gH; float gEng;`)
      .replace('void main() {', `void main() {
        #ifdef HAS_HOLES
        for(int i=0;i<7;i++){ vec3 q=(vWPos-uHC[i])/uHR[i]; if(dot(q,q)<1.0) discard; }
        #endif
        gEng = 0.0; gH = 0.0;
        #ifdef IS_ROCK
        { vec3 P = vWPos;
          float sm = vSmooth;
          float big = fbmR(P*0.55);
          float rid = 1.0 - abs(vnoise(P*vec3(1.1,2.6,1.1))*2.0-1.0);
          float fine = vnoise(P*7.0);
          gH = (big*0.10 + rid*rid*0.045 + fine*0.012) * mix(1.0, 0.16, sm);
          #ifdef HAS_ENGRAVE
          vec2 euv = vec2((uEngR.x - P.z)/uEngR.y, (P.y - uEngR.z)/uEngR.w);
          float inE = step(P.x, uEngX) * step(0.0, euv.x) * step(euv.x, 1.0) * step(0.0, euv.y) * step(euv.y, 1.0);
          gEng = texture2D(uEng, clamp(euv, 0.0, 1.0)).r * inE; gH -= gEng * 0.06;
          #endif
          gH *= uBump;
        }
        #endif`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        #ifdef IS_ROCK
        { vec3 P = vWPos; float n1 = fbmR(P*0.21 + 3.0); float n2 = vnoise(P*3.1);
          float strata = 0.5 + 0.5*sin(P.y*3.3 + n1*7.0 + P.z*0.05);
          vec3 basalt = vec3(0.060,0.052,0.046), umber = vec3(0.135,0.098,0.070), ash = vec3(0.115,0.108,0.100);
          vec3 c = mix(basalt, umber, smoothstep(0.35,0.75,n1));
          c = mix(c, ash, strata*0.35);
          c *= 0.82 + 0.36*n2;
          float floorK = smoothstep(0.55, 0.9, vWN.y);
          c = mix(c, vec3(0.13,0.115,0.098)*(0.8+0.4*n2), floorK*0.85);
          c = mix(c, vec3(0.24,0.21,0.18), vSmooth*0.55);
          c = mix(c, vec3(0.62,0.48,0.34), gEng*0.95);
          diffuseColor.rgb = c * uTint; }
        #endif`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        #ifdef IS_ROCK
        { float w = vnoise(vWPos*0.45 + 11.0); float floorK = smoothstep(0.55,0.9,vWN.y);
          roughnessFactor = mix(0.92, 0.78, w);
          roughnessFactor = mix(roughnessFactor, 0.32, floorK * smoothstep(0.55,0.8,w));
          roughnessFactor = mix(roughnessFactor, 0.97, vSmooth*0.7); }
        #endif`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        #ifdef IS_ROCK
        normal = perturbRock(-vViewPosition, normal, vec2(dFdx(gH), dFdy(gH)), faceDirection);
        #endif`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        for(int i=0;i<8;i++){ vec3 Lv = uCLPos[i] - vWPos; float d2 = dot(Lv,Lv); if (d2 > 900.0) continue;
          vec3 Ld = (viewMatrix * vec4(Lv*inversesqrt(d2),0.0)).xyz; float nl = max(dot(normal, Ld), 0.0);
          float att = 1.0/(1.0 + d2*0.6) * (1.0 - smoothstep(400.0, 900.0, d2));
          reflectedLight.directDiffuse += uCLCol[i] * nl * att * BRDF_Lambert(material.diffuseColor); }`)
      .replace('#include <fog_fragment>', `#include <fog_fragment>
        #ifdef HAS_SCATTER
        { vec3 rd = vWPos - cameraPosition; float dd = length(rd); rd /= dd; vec3 sc = vec3(0.0);
          for(int i=0;i<3;i++){ sc += uScCol[i] * inscat(cameraPosition, rd, dd, uScPos[i]); }
          gl_FragColor.rgb += sc; }
        #endif`);
    sh.fragmentShader = fs;
    if (rock) sh.vertexShader = '#define ROCK_SMOOTH\n' + sh.vertexShader;
  };
  mat.customProgramCacheKey = () => `rk${+rock}${+holes}${+engrave}${oct}${+scatter}`;
  return mat;
}

/* ---------- canvas helpers ---------- */
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function tex(c, srgb = true, renderer) {
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4; t.needsUpdate = true; return t;
}
const FD = "'Fraunces', Georgia, serif", FM = "'JetBrains Mono', ui-monospace, monospace";
function spacedText(ctx, text, x, y, spacing, align = 'left') {
  const chars = [...text]; const widths = chars.map(c => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const prev = ctx.textAlign; ctx.textAlign = 'left';
  chars.forEach((c, i) => { ctx.fillText(c, cx, y); cx += widths[i] + spacing; }); ctx.textAlign = prev; return total;
}

/* ====================================================================== */
export async function start(stage, ui) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 700;
  const LOW = coarse || small;
  const params = new URLSearchParams(location.search);
  const SHOT = params.has('shot');
  const reduced = ui.reduced;
  const tier = LOW
    ? { dpr: 1.25, shadow: 1024, slitShadow: false, cards: 2600, embers: 140, dust: 260, refl: 256, msaa: 0, oct: 3, rings: 520, segs: 56 }
    : { dpr: 1.5, shadow: 2048, slitShadow: true, cards: 4600, embers: 380, dust: 700, refl: 512, msaa: 4, oct: 4, rings: 760, segs: 80 };

  try { await Promise.race([Promise.all([document.fonts.load("300 100px Fraunces"), document.fonts.load("600 100px Fraunces"), document.fonts.load("500 40px 'JetBrains Mono'")]), new Promise(r => setTimeout(r, 3000))]); } catch (e) {}

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, tier.dpr));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.localClippingEnabled = true;
  renderer.setClearColor(0x050404, 1);
  stage.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-hidden', 'true');

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0x070605);
  scene.fog = new THREE.FogExp2(fogColor.clone(), 0.03);
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 3200);

  /* ======================= PATH & TUNNEL ======================= */
  const pathPts = [
    [0, 3, 24], [0, 3, 12], [0, 3, 0], [0, 3, -12], [1.6, 3, -26], [0.6, 3, -42], [-0.4, 3, -60], [0, 3, -78], [1.2, 3.2, -92],
    [1.2, 3.4, -104], [0, 3.2, -118], [0, 3, -132], [0, 3, -148], [-1.2, 3, -164], [0, 3, -180], [0.6, 3, -196], [0, 3, -212],
    [0, 3, -232], [0, 3, -252], [0.8, 3.3, -272], [0, 3.6, -292], [0, 3.4, -312], [0.6, 3, -330], [0, 3, -352]
  ].map(p => V3(...p));
  const curve = new THREE.CatmullRomCurve3(pathPts, false, 'centripetal');
  const LUT = curve.getSpacedPoints(4000);
  function P(z) { // centre at depth z (path is monotone in z)
    let lo = 0, hi = LUT.length - 1;
    if (z >= LUT[0].z) return LUT[0].clone(); if (z <= LUT[hi].z) return LUT[hi].clone();
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (LUT[m].z > z) lo = m; else hi = m; }
    const a = LUT[lo], b = LUT[hi], t = (z - a.z) / (b.z - a.z); return a.clone().lerp(b, t);
  }
  const px = z => P(z).x;
  const bump = (z, c, w) => Math.exp(-((z - c) * (z - c)) / (2 * w * w));
  function RX(z) { return 7.0 + 1.0 * bump(z, 0, 9) + 1.2 * bump(z, -142, 9) + 0.6 * bump(z, -181, 6) + 5.2 * bump(z, -296, 10) - 1.0 * bump(z, -342, 6); }
  function RY(z) { return 5.2 + 0.4 * bump(z, 0, 9) + 0.9 * bump(z, -100, 7) + 1.6 * bump(z, -142, 9) + 2.6 * bump(z, -296, 10) - 0.6 * bump(z, -342, 6); }

  // flattened wall regions: side -1 = left (−x), +1 = right
  const FLATS = [
    { side: -1, z0: 10, z1: -10, off: 6.6, fade: 4, name: 'hero' },
    { side: -1, z0: -35, z1: -80, off: 6.0, fade: 3, name: 'signal' },
    { side: 1, z0: -95.5, z1: -104.5, off: 6.0, fade: 2.5, name: 'ledge' },
    { side: -1, z0: -102, z1: -114, off: 5.8, fade: 2.5, name: 'hands' },
    { side: -1, z0: -204.5, z1: -211.5, off: 6.0, fade: 2.5 }, { side: 1, z0: -216.5, z1: -223.5, off: 6.0, fade: 2.5 },
    { side: -1, z0: -228.5, z1: -235.5, off: 6.0, fade: 2.5 }, { side: 1, z0: -240.5, z1: -247.5, off: 6.0, fade: 2.5 },
    { side: -1, z0: -252.5, z1: -259.5, off: 6.0, fade: 2.5 },
  ];
  const wallX = (side, z, off) => px(z) + side * off;
  const POOL = { z: -181, r: 3.4 };

  function buildTunnel() {
    const NR = tier.rings, NS = tier.segs, p = 2.7;
    const pos = new Float32Array((NR + 1) * NS * 3), smo = new Float32Array((NR + 1) * NS);
    const up = V3(0, 1, 0), side = V3(), upv = V3();
    let k = 0;
    for (let i = 0; i <= NR; i++) {
      const u = i / NR; const c = curve.getPointAt(u); const T = curve.getTangentAt(u);
      side.crossVectors(T, up).normalize(); upv.crossVectors(side, T).normalize();
      const z = c.z; const cap = smooth(23.5, 13, z);
      const rx = RX(z) * Math.max(0.04, Math.pow(cap, 0.6)), ry = RY(z) * Math.max(0.04, Math.pow(cap, 0.6));
      for (let j = 0; j < NS; j++) {
        const th = j / NS * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
        const ex = Math.sign(cs) * Math.pow(Math.abs(cs), 2 / p), ey = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / p);
        let x = c.x + side.x * rx * ex + upv.x * ry * ey, y = c.y + side.y * rx * ex + upv.y * ry * ey, zz = c.z + side.z * rx * ex + upv.z * ry * ey;
        // flatness weight
        let fw = 0, fl = null;
        for (const f of FLATS) {
          if (Math.sign(ex) !== f.side || Math.abs(ex) < 0.2) continue;
          const w = smooth(f.z0 + f.fade, f.z0, zz) * smooth(f.z1 - f.fade, f.z1, zz);
          if (w > fw) { fw = w; fl = f; }
        }
        const dx = x - c.x, dy = y - c.y; const dl = Math.hypot(dx, dy) || 1;
        const n1 = fbm3(x * 0.16, y * 0.16, zz * 0.16, 4) - 0.5, n2 = fbm3(x * 0.6 + 7, y * 0.6, zz * 0.6, 3) - 0.5;
        const amp = (1 - 0.92 * fw);
        let disp = (n1 * 2.6 + n2 * 0.55) * amp * cap;
        x += dx / dl * disp; y += dy / dl * disp;
        let sm = 0;
        if (fl) {
          const xw = wallX(fl.side, zz, fl.off);
          if ((fl.side < 0 && x < xw) || (fl.side > 0 && x > xw)) { x = lerp(x, xw + fl.side * (n2 * 0.04), fw); sm = fw; }
          else sm = fw * 0.5;
          if (y < 0.45) sm *= smooth(0, 0.45, y);
        }
        if (y < 0) { // floor
          const pd = Math.hypot(x - px(POOL.z), zz - POOL.z);
          y = (fbm3(x * 0.9, 3, zz * 0.9, 3) - 0.5) * 0.16 * (1 - smooth(POOL.r + 0.6, POOL.r - 0.2, pd)) - 0.06 * smooth(POOL.r + 0.4, POOL.r - 0.3, pd);
          sm = 0;
        }
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = zz; smo[k] = sm; k++;
      }
    }
    const idx = [];
    for (let i = 0; i < NR; i++) for (let j = 0; j < NS; j++) {
      const a = i * NS + j, b = (i + 1) * NS + j, c2 = i * NS + (j + 1) % NS, d = (i + 1) * NS + (j + 1) % NS;
      idx.push(a, c2, b, c2, d, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSmooth', new THREE.BufferAttribute(smo, 1));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  const rockMat = enhance(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 }), { rock: true, holes: true, engrave: true, oct: tier.oct });
  const tunnel = new THREE.Mesh(buildTunnel(), rockMat);
  tunnel.receiveShadow = true; tunnel.frustumCulled = false;
  scene.add(tunnel);

  const plainRock = (o = {}) => enhance(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, ...o.mat }), { rock: true, oct: tier.oct, ...o });
  function rockBlob(r, seed, squash = [1, 1, 1], detail = 20) {
    const g = new THREE.SphereGeometry(r, detail, Math.round(detail * 0.75));
    const a = g.attributes.position; const v = V3();
    for (let i = 0; i < a.count; i++) {
      v.fromBufferAttribute(a, i); const n = fbm3(v.x * 2.2 / r + seed, v.y * 2.2 / r, v.z * 2.2 / r, 3);
      v.multiplyScalar(0.72 + n * 0.6); v.x *= squash[0]; v.y *= squash[1]; v.z *= squash[2]; a.setXYZ(i, v.x, v.y, v.z);
    }
    g.setAttribute('aSmooth', new THREE.BufferAttribute(new Float32Array(a.count), 1));
    g.computeVertexNormals(); return g;
  }

  /* ======================= LIGHTS ======================= */
  const hemi = new THREE.HemisphereLight(0x3a2a20, 0x0a0806, 0.15); scene.add(hemi);
  const FIRE = V3(2.4, 0, 0.6);
  const LSTAR = V3(2.4, 1.15, 0.6);
  const fireSpot = new THREE.SpotLight(0xffa252, 900, 40, 0.72, 0.55, 2);
  fireSpot.castShadow = true; fireSpot.shadow.mapSize.set(tier.shadow, tier.shadow);
  fireSpot.shadow.camera.near = 0.3; fireSpot.shadow.camera.far = 30; fireSpot.shadow.bias = -0.0004; fireSpot.shadow.normalBias = 0.02;
  fireSpot.position.copy(LSTAR); scene.add(fireSpot); scene.add(fireSpot.target);
  const carry = new THREE.PointLight(0xff9a4a, 60, 26, 2); scene.add(carry);
  const slit = new THREE.SpotLight(0xfff1d6, 0, 30, 0.2, 0.6, 1.4);
  slit.castShadow = tier.slitShadow; if (tier.slitShadow) { slit.shadow.mapSize.set(1024, 1024); slit.shadow.bias = -0.0006; slit.shadow.camera.near = 4; slit.shadow.camera.far = 16; }
  scene.add(slit); scene.add(slit.target);
  const sun = new THREE.DirectionalLight(0xffd9a8, 0); sun.position.set(0, 10, -400); sun.target.position.set(0, 0, -300); scene.add(sun, sun.target);

  /* ======================= FIRE ======================= */
  const flameMat = (seed, hue = 0) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: shared.uTime, uSeed: { value: seed }, uGain: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; vec4 mv = modelViewMatrix*vec4(0.,0.,0.,1.);
      vec3 sc = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), 1.);
      mv.xy += position.xy*sc.xy; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying vec2 vUv; uniform float uTime, uSeed, uGain;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      float fb(vec2 p){ float s=0., a=.5; for(int i=0;i<4;i++){ s+=a*n(p); p*=2.1; a*=.5; } return s; }
      void main(){ vec2 uv = vUv; float y = uv.y; float t = uTime*1.7 + uSeed*10.;
        float nn = fb(vec2(uv.x*3.2 + uSeed*7., y*2.4 - t));
        float nn2 = fb(vec2(uv.x*6. - uSeed, y*5. - t*1.6));
        float x = (uv.x - 0.5) + (nn - 0.5)*0.42*y + (nn2-.5)*0.08;
        float width = mix(0.36, 0.02, pow(y, 0.8));
        float m = smoothstep(width, width*0.15, abs(x)) * smoothstep(0.0, 0.08, y) * smoothstep(1.0, 0.45, y + (nn-.5)*0.5);
        float core = smoothstep(width*0.55, 0.0, abs(x)) * smoothstep(0.75, 0.1, y);
        vec3 c = mix(vec3(0.9,0.16,0.02), vec3(1.0,0.5,0.12), m);
        c = mix(c, vec3(1.0,0.82,0.5), core*0.85);
        float a = m * (0.85 + 0.3*nn2);
        gl_FragColor = vec4(c * a * 1.55 * uGain, 1.0); }`
  });
  const glowTex = (() => { const [c, x] = canvas(128, 128); const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.25, 'rgba(255,255,255,.35)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); return tex(c, false); })();
  const emberTex = (() => { const [c, x] = canvas(256, 256); x.fillStyle = '#120a06'; x.fillRect(0, 0, 256, 256); const r = rng(7);
    for (let i = 0; i < 70; i++) { x.strokeStyle = `rgba(255,${80 + r() * 90 | 0},20,${0.35 + r() * 0.6})`; x.lineWidth = 0.8 + r() * 2.2; x.beginPath(); let X = r() * 256, Y = r() * 256; x.moveTo(X, Y); for (let k = 0; k < 6; k++) { X += (r() - .5) * 40; Y += (r() - .5) * 18; x.lineTo(X, Y); } x.stroke(); } return tex(c); })();
  const charMat = new THREE.MeshStandardMaterial({ color: 0x22160f, roughness: 0.85, emissive: 0xff6a20, emissiveMap: emberTex, emissiveIntensity: 1.4 });
  const fires = [];
  function makeFire(at, scale = 1) {
    const g = new THREE.Group(); g.position.copy(at); scene.add(g);
    const f1 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flameMat(0.1)); f1.scale.set(0.95 * scale, 1.55 * scale, 1); f1.position.y = 0.72 * scale;
    const f2 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flameMat(0.63)); f2.scale.set(0.7 * scale, 1.15 * scale, 1); f2.position.set(0.12 * scale, 0.55 * scale, 0.05);
    const f3 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flameMat(0.37)); f3.scale.set(0.6 * scale, 1.0 * scale, 1); f3.position.set(-0.14 * scale, 0.5 * scale, -0.05);
    [f1, f2, f3].forEach(m => { m.renderOrder = 5; m.frustumCulled = false; g.add(m); });
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff8a3a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 }));
    glow.scale.setScalar(2.6 * scale); glow.position.y = 0.6 * scale; glow.material.opacity = 0.28; g.add(glow);
    const r = rng(Math.round(at.z * 13 + 99));
    for (let i = 0; i < 5; i++) { // logs
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.07 * scale, 0.09 * scale, 1.05 * scale, 9), charMat);
      const a = i / 5 * Math.PI * 2 + r() * 0.4; log.position.set(Math.cos(a) * 0.22 * scale, 0.16 * scale, Math.sin(a) * 0.22 * scale);
      log.rotation.set(0, -a, 0); log.rotateZ(Math.PI / 2 - 0.55); g.add(log);
    }
    const ringMat = plainRock({ tint: [1.1, 1.0, 0.95] });
    for (let i = 0; i < 11; i++) { // stone ring
      const a = i / 11 * Math.PI * 2; const s = new THREE.Mesh(rockBlob(0.2 * scale, i * 3.1, [1.2, 0.7, 1], 10), ringMat);
      s.position.set(Math.cos(a) * 0.82 * scale, 0.06 * scale, Math.sin(a) * 0.82 * scale); s.rotation.y = r() * 6; g.add(s);
    }
    // embers
    const N = tier.embers; const eg = new THREE.BufferGeometry(); const seeds = new Float32Array(N * 4); const ps = new Float32Array(N * 3);
    for (let i = 0; i < N * 4; i++) seeds[i] = r();
    eg.setAttribute('position', new THREE.BufferAttribute(ps, 3)); eg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    const em = new THREE.Points(eg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: shared.uTime, uScale: { value: scale }, uPx: { value: renderer.getPixelRatio() } },
      vertexShader: `attribute vec4 aSeed; uniform float uTime, uScale, uPx; varying float vL;
        void main(){ float life = fract(uTime*(0.12+aSeed.w*0.22) + aSeed.x); vL = life;
          vec3 p = vec3((aSeed.y-.5)*0.7, 0.2, (aSeed.z-.5)*0.7)*uScale;
          p.y += life*life*0.0 + life*(2.4+aSeed.w*2.6)*uScale;
          p.x += sin(uTime*1.3 + aSeed.w*40.)*0.45*life*uScale + life*0.35*uScale; p.z += cos(uTime*1.1 + aSeed.y*30.)*0.45*life*uScale;
          vec4 mv = modelViewMatrix*vec4(p,1.); gl_Position = projectionMatrix*mv;
          gl_PointSize = (0.8 + aSeed.y*1.8) * uPx * (1.0-life*0.6) * (4.0 / -mv.z) * 3.0; }`,
      fragmentShader: `varying float vL; void main(){ vec2 d = gl_PointCoord-.5; float a = smoothstep(.5,.0,length(d));
        gl_FragColor = vec4(vec3(1.0,0.42,0.1)*a*(1.0-vL)*3.0, 1.0); }`
    }));
    em.frustumCulled = false; g.add(em);
    const fire = { g, flames: [f1, f2, f3], glow, at: at.clone(), scale }; fires.push(fire); return fire;
  }
  const heroFire = makeFire(FIRE, 1.0);
  const C_CREW = V3(px(-296), 0, -296);
  const crewFire = makeFire(C_CREW, 1.15);

  /* ======================= 01 · SHADOW NAME ======================= */
  const LETTERS = (() => {
    const arc = (cx, cy, rx, ry, a0, a1, n = 10) => { const pts = []; for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); } return pts; };
    return {
      C: { w: 0.84, s: [arc(0.45, 0.5, 0.43, 0.5, 48, 312, 12)] },
      E: { w: 0.62, s: [[[0.62, 1], [0, 1], [0, 0], [0.62, 0]], [[0, 0.52], [0.5, 0.52]]] },
      M: { w: 0.86, s: [[[0, 0], [0, 1], [0.43, 0.36], [0.86, 1], [0.86, 0]]] },
      G: { w: 0.9, s: [arc(0.46, 0.5, 0.44, 0.5, 46, 352, 12).concat([[0.9, 0.44], [0.9, 0.06]]), [[0.9, 0.44], [0.52, 0.44]]] },
      U: { w: 0.74, s: [[[0, 1], [0, 0.36]].concat(arc(0.37, 0.36, 0.37, 0.36, 180, 360, 9)).concat([[0.74, 1]])] },
      L: { w: 0.58, s: [[[0, 1], [0, 0], [0.58, 0]]] },
      R: { w: 0.7, s: [[[0, 0], [0, 1], [0.38, 1]].concat(arc(0.38, 0.75, 0.27, 0.25, 90, -90, 8)).concat([[0, 0.5]]), [[0.3, 0.5], [0.72, 0]]] },
      ' ': { w: 0.3, s: [] },
    };
  })();
  function nameSegments(portrait) {
    const lines = portrait ? ['CEM', 'GULER'] : ['CEM GULER'];
    const H = portrait ? 0.98 : 1.62, gap = 0.3, stroke = portrait ? 0.13 : 0.18;
    const segs = [];
    const yC = portrait ? 4.6 : 4.35;
    lines.forEach((line, li) => {
      const width = [...line].reduce((a, ch, i) => a + LETTERS[ch].w + (i ? gap : 0), 0) * H;
      let u = -width / 2; const y0 = yC + (lines.length === 2 ? (li === 0 ? 0.78 : -1.02) * H : -H / 2) - (lines.length === 2 ? H / 2 : 0);
      [...line].forEach((ch, i) => {
        if (i) u += gap * H; const L = LETTERS[ch];
        L.s.forEach(poly => { for (let k = 0; k < poly.length - 1; k++) segs.push([[u + poly[k][0] * H, y0 + poly[k][1] * H], [u + poly[k + 1][0] * H, y0 + poly[k + 1][1] * H]]); });
        u += L.w * H;
      });
    });
    return { segs, stroke };
  }
  const HERO_WX = wallX(-1, 0, 6.6);
  const NAME_Z = 0.0;
  const toWall = (u, y) => V3(HERO_WX + 0.02, y, NAME_Z - u);
  let rodData = [];
  const rodGeo = new THREE.BoxGeometry(1, 1, 1);
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x5a3c26, roughness: 0.72, metalness: 0.0 });
  let rods = null, threads = null;
  function buildRods(portrait) {
    const { segs, stroke } = nameSegments(portrait);
    const r = rng(portrait ? 11 : 5); rodData = [];
    for (const [a, b] of segs) {
      const A = toWall(a[0], a[1]), B = toWall(b[0], b[1]); const len = A.distanceTo(B);
      const n = Math.max(1, Math.round(len / 0.42));
      for (let i = 0; i < n; i++) {
        const t0 = Math.max(0, i / n - 0.02), t1 = Math.min(1, (i + 1) / n + 0.02);
        const Aw = A.clone().lerp(B, t0), Bw = A.clone().lerp(B, t1);
        const s1 = 0.36 + r() * 0.42, s2 = clamp(s1 + (r() - 0.5) * 0.22, 0.3, 0.82);
        const Pp = LSTAR.clone().lerp(Aw, s1), Qp = LSTAR.clone().lerp(Bw, s2);
        const w = stroke * (s1 + s2) / 2;
        const scatter = V3((r() - .5) * 2.4, (r() - .5) * 1.6, (r() - .5) * 3.2);
        const spin = new THREE.Euler((r() - .5) * 3, (r() - .5) * 3, (r() - .5) * 3);
        rodData.push({ P: Pp, Q: Qp, w, scatter, spin, roll: r() * Math.PI });
      }
    }
    if (rods) { scene.remove(rods); rods.dispose(); scene.remove(threads); threads.geometry.dispose(); }
    rods = new THREE.InstancedMesh(rodGeo, rodMat, rodData.length); rods.castShadow = true; rods.receiveShadow = false; rods.frustumCulled = false;
    scene.add(rods);
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rodData.length * 6), 3));
    threads = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0xcdb89a, transparent: true, opacity: 0.08, depthWrite: false }));
    threads.frustumCulled = false; scene.add(threads);
    lastK = -1;
  }
  let lastK = -1;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = V3(), _d = V3(), _c = V3(), _x = V3(1, 0, 0);
  function updateRods(k) {
    if (Math.abs(k - lastK) < 1e-4) return; lastK = k;
    const e = Math.pow(1 - k, 1.6); const tp = threads.geometry.attributes.position;
    rodData.forEach((d, i) => {
      _c.copy(d.P).add(d.Q).multiplyScalar(0.5).addScaledVector(d.scatter, e);
      _d.copy(d.Q).sub(d.P); const len = _d.length(); _d.normalize();
      _q.setFromUnitVectors(_x, _d); _q2.setFromAxisAngle(_x, d.roll); _q.multiply(_q2);
      if (e > 0.001) { _q2.setFromEuler(new THREE.Euler(d.spin.x * e, d.spin.y * e, d.spin.z * e)); _q.premultiply(_q2); }
      _s.set(len, d.w, d.w); _m.compose(_c, _q, _s); rods.setMatrixAt(i, _m);
      tp.setXYZ(i * 2, _c.x, _c.y + d.w * 0.5, _c.z); tp.setXYZ(i * 2 + 1, _c.x, 9.5, _c.z);
    });
    rods.instanceMatrix.needsUpdate = true; tp.needsUpdate = true; renderer.shadowMap.needsUpdate = true;
  }

  /* ======================= 02 · ENGRAVINGS ======================= */
  const ENG = { z0: -37, len: 42, y0: 0.7, h: 6.2 };
  shared.uEngR.value.set(ENG.z0, ENG.len, ENG.y0, ENG.h);
  shared.uEngX.value = px(-58) - 4.6;
  (function buildEngraving() {
    const W = LOW ? 3072 : 4096, H = Math.round(W * ENG.h / ENG.len);
    const pxm = W / ENG.len; const [c, xM] = canvas(W, H); xM.fillStyle = '#000'; xM.fillRect(0, 0, W, H);
    const [cS, xS] = canvas(W, H), [cH, xH] = canvas(W, H);
    let x = xH;
    const r = rng(42); const U = m => m * pxm; const Y = m => H - (m - ENG.y0) * pxm; // world y → canvas
    const groove = (draw, wide = 9, narrow = 3.2) => {
      for (const [cx, lw] of [[xS, wide], [xH, narrow]]) { if (!lw) continue; x = cx; x.save(); x.strokeStyle = '#fff'; x.fillStyle = '#fff'; x.lineWidth = lw; x.lineCap = 'round'; x.lineJoin = 'round'; draw(cx === xS); x.restore(); }
      x = xH;
    };
    const wob = (pts, amp = 2.2) => pts.map(([a, b]) => [a + (r() - .5) * amp, b + (r() - .5) * amp]);
    const poly = (pts, close = false) => { x.beginPath(); pts.forEach(([a, b], i) => i ? x.lineTo(a, b) : x.moveTo(a, b)); if (close) x.closePath(); x.stroke(); };
    const circ = (cx, cy, rr, a0 = 0, a1 = Math.PI * 2) => { const pts = []; const n = Math.max(10, rr / 3 | 0); for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); } return wob(pts, 3); };
    const peck = (cx, cy, w, h, n) => { xS.save(); xS.fillStyle = 'rgba(255,255,255,.7)'; for (let i = 0; i < n; i++) { xS.beginPath(); xS.arc(cx + (r() - .5) * w, cy + (r() - .5) * h, 1 + r() * 2.2, 0, 7); xS.fill(); } xS.restore(); };
    const text = (s, mx, my, sizeM, font, spacing = 0.06) => {
      const fs = sizeM * pxm; const f = font.replace('#', fs + 'px');
      for (const cx of [xH, xS]) { cx.save(); cx.font = f; cx.fillStyle = '#fff'; cx.strokeStyle = '#fff'; cx.lineWidth = fs * 0.07; cx.lineJoin = 'round';
        const chars = [...s]; let px0 = U(mx); chars.forEach(ch => { if (cx === xH) cx.fillText(ch, px0, Y(my)); else cx.strokeText(ch, px0, Y(my)); px0 += cx.measureText(ch).width + fs * spacing; }); cx.restore(); }
    };
    // glyphs (petroglyph style)
    const camera = (cx, cy, s) => groove(() => { poly(wob([[cx - s, cy - s * .55], [cx + s * .7, cy - s * .55], [cx + s * .7, cy + s * .55], [cx - s, cy + s * .55]]), true); poly(wob([[cx + s * .7, cy - s * .2], [cx + s * 1.25, cy - s * .55], [cx + s * 1.25, cy + s * .55], [cx + s * .7, cy + s * .2]])); poly(circ(cx - s * .55, cy - s * .95, s * .4)); poly(circ(cx + s * .15, cy - s * .95, s * .4)); poly(wob([[cx - s * .3, cy + s * .55], [cx - s * .7, cy + s * 1.6]])); poly(wob([[cx - s * .1, cy + s * .55], [cx + s * .25, cy + s * 1.6]])); }, 11, 4);
    const tower = (cx, cy, s) => groove(() => { poly(wob([[cx - s * .55, cy + s * 1.4], [cx, cy - s * 1.1], [cx + s * .55, cy + s * 1.4]])); poly(wob([[cx - s * .3, cy + s * .4], [cx + s * .3, cy + s * .4]])); for (let i = 1; i <= 3; i++) { poly(circ(cx, cy - s * 1.1, s * .38 * i, -Math.PI * .85, -Math.PI * .55)); poly(circ(cx, cy - s * 1.1, s * .38 * i, -Math.PI * .45, -Math.PI * .15)); } }, 11, 4);
    const eye = (cx, cy, s) => groove(() => { poly(wob([[cx - s, cy], [cx - s * .4, cy - s * .5], [cx + s * .4, cy - s * .5], [cx + s, cy], [cx + s * .4, cy + s * .5], [cx - s * .4, cy + s * .5], [cx - s, cy]])); poly(circ(cx, cy, s * .3)); for (let i = -2; i <= 2; i++) poly(wob([[cx + i * s * .35, cy - s * .62], [cx + i * s * .45, cy - s * .95]])); }, 11, 4);
    const reel = (cx, cy, s) => groove(() => { poly(circ(cx, cy, s)); poly(circ(cx, cy, s * .2)); for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; const ccx = cx + Math.cos(a) * s * .58, ccy = cy + Math.sin(a) * s * .58; poly(circ(ccx, ccy, s * .2)); } poly(wob([[cx + s, cy + s * .3], [cx + s * 2.2, cy + s * .9], [cx + s * 2.2, cy + s * 1.4]])); }, 11, 4);
    const figure = (cx, cy, s, arms = 1) => groove(() => { poly(circ(cx, cy - s * 1.25, s * .22)); poly(wob([[cx, cy - s * 1.0], [cx, cy + s * .2]])); poly(wob([[cx - s * .45, cy + s * 1.0], [cx, cy + s * .2], [cx + s * .45, cy + s * 1.0]])); poly(wob(arms ? [[cx - s * .6, cy - s * 1.3], [cx - s * .4, cy - s * .7], [cx, cy - s * .65], [cx + s * .4, cy - s * .7], [cx + s * .6, cy - s * 1.3]] : [[cx - s * .55, cy - s * .2], [cx, cy - s * .7], [cx + s * .55, cy - s * .2]])); }, 9, 3.4);
    const mic = (cx, cy, s) => groove(() => { x.beginPath(); x.ellipse(cx, cy - s * .6, s * .32, s * .55, 0, 0, 7); x.stroke(); poly(circ(cx, cy - s * .35, s * .55, 0.1, Math.PI - 0.1)); poly(wob([[cx, cy + s * .2], [cx, cy + s * 1.1]])); poly(wob([[cx - s * .45, cy + s * 1.1], [cx + s * .45, cy + s * 1.1]])); }, 11, 4);
    const laurel = (cx, cy, s) => groove(() => { for (const sgn of [-1, 1]) { poly(circ(cx, cy, s, sgn < 0 ? Math.PI * .55 : Math.PI * -.1, sgn < 0 ? Math.PI * 1.1 : Math.PI * .45)); for (let i = 0; i < 6; i++) { const a = (sgn < 0 ? Math.PI * .6 : -Math.PI * .05) + i * 0.09 * Math.PI; const ex = cx + Math.cos(a) * s, ey = cy + Math.sin(a) * s; x.beginPath(); x.ellipse(ex - sgn * 6, ey, 14, 6, a + sgn * 0.6, 0, 7); x.stroke(); } } }, 8, 3);
    const G = [{ u: 5.0 }, { u: 14.6 }, { u: 24.4 }, { u: 34.0 }];
    // 1 · TRT 2
    camera(U(G[0].u - 2.2), Y(4.6), 0.55 * pxm);
    text('TRT 2', G[0].u - 2.9, 3.05, 0.78, `600 # ${FD}`);
    text('2008–2011', G[0].u - 2.9, 2.2, 0.42, `500 # ${FM}`, 0.08);
    figure(U(G[0].u + 2.0), Y(2.6), 0.5 * pxm, 1); figure(U(G[0].u + 2.9), Y(2.5), 0.45 * pxm, 1);
    // 2 · TRT World (multimedia) + Courage in Journalism
    eye(U(G[1].u - 2.2), Y(4.9), 0.62 * pxm);
    text('TRT WORLD', G[1].u - 3.4, 3.45, 0.66, `600 # ${FD}`);
    text('2011–2013', G[1].u - 3.4, 2.7, 0.4, `500 # ${FM}`, 0.08);
    laurel(U(G[1].u + 2.65), Y(4.45), 0.62 * pxm);
    text('COURAGE IN JOURNALISM', G[1].u - 3.4, 1.85, 0.28, `500 # ${FM}`, 0.1);
    text('NOMINATED · BEST PHOTOGRAPH', G[1].u - 3.4, 1.38, 0.24, `500 # ${FM}`, 0.1);
    // 3 · TRT World producer / director
    tower(U(G[2].u - 2.0), Y(4.6), 0.62 * pxm);
    text('TRT WORLD', G[2].u - 3.4, 3.1, 0.66, `600 # ${FD}`);
    text('2013–2015', G[2].u - 3.4, 2.35, 0.4, `500 # ${FM}`, 0.08);
    text('MIPTV · MIPDOC CANNES 2013', G[2].u - 3.4, 1.6, 0.24, `500 # ${FM}`, 0.1);
    mic(U(G[2].u + 2.6), Y(4.4), 0.6 * pxm);
    // 4 · Pollux Films
    reel(U(G[3].u - 2.5), Y(4.7), 0.6 * pxm);
    text('POLLUX FILMS', G[3].u - 3.4, 3.1, 0.62, `600 # ${FD}`);
    text('2015–2016 · ISTANBUL', G[3].u - 3.4, 2.35, 0.36, `500 # ${FM}`, 0.08);
    // scattered signal marks between groups
    for (const gu of [9.8, 19.6, 29.2, 39]) { for (let i = 1; i <= 3; i++) groove(() => poly(circ(U(gu), Y(5.6), i * 0.28 * pxm, Math.PI * 0.15, Math.PI * 0.85)), 8, 3); peck(U(gu), Y(5.6), 30, 30, 30); figure(U(gu + 0.1), Y(2.4), 0.36 * pxm, gu % 2 > 1 ? 1 : 0); }
    peck(W / 2, H / 2, W, H, 900);
    xM.save(); xM.filter = 'blur(3px)'; xM.globalAlpha = 0.55; xM.drawImage(cS, 0, 0); xM.filter = 'blur(0.8px)'; xM.globalAlpha = 1; xM.globalCompositeOperation = 'lighter'; xM.drawImage(cH, 0, 0); xM.restore();
    const t = tex(c, false, renderer); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 1;
    shared.uEng.value = t;
  })();

  /* ======================= 03 · BOOKS, SLIT, HANDS ======================= */
  const LEDGE_Z = -100.2; const LEDGE_X = wallX(1, LEDGE_Z, 6.0);
  (function ledge() {
    const g = new THREE.BoxGeometry(1.25, 0.32, 3.0, 12, 4, 24); const a = g.attributes.position; const v = V3();
    for (let i = 0; i < a.count; i++) { v.fromBufferAttribute(a, i); const n = fbm3(v.x * 2 + 4, v.y * 2, v.z * 2, 3) - 0.5; if (v.y < 0.15) { v.x += n * 0.14; v.y += n * 0.1 - (v.x < 0 ? 0 : 0); v.z += n * 0.1; } else { v.y += n * 0.015; } if (v.x < -0.5) v.y -= (v.x + 0.5) * 0.12 * (v.y < 0 ? 1 : 0); a.setXYZ(i, v.x, v.y, v.z); }
    g.setAttribute('aSmooth', new THREE.BufferAttribute(new Float32Array(a.count).fill(0.0), 1)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, plainRock({ tint: [1.15, 1.05, 0.95] })); m.position.set(LEDGE_X - 0.5, 1.28, LEDGE_Z); m.receiveShadow = true; m.material.color.setRGB(0.8, 0.8, 0.8); m.castShadow = false; scene.add(m);
  })();
  function bookTextures(kind) {
    const W = 640, H = 960; const [c, x] = canvas(W, H); const r = rng(kind.length * 17);
    const grain = (alpha) => { const id = x.getImageData(0, 0, W, H); const d = id.data; for (let i = 0; i < d.length; i += 4) { const n = (r() - .5) * alpha; d[i] += n; d[i + 1] += n; d[i + 2] += n; } x.putImageData(id, 0, 0); };
    if (kind === 'cave') {
      x.fillStyle = '#121010'; x.fillRect(0, 0, W, H);
      const g = x.createLinearGradient(W / 2 - 60, 0, W / 2 + 60, 0); g.addColorStop(0, 'rgba(240,162,76,0)'); g.addColorStop(.5, 'rgba(255,214,150,.95)'); g.addColorStop(1, 'rgba(240,162,76,0)');
      x.fillStyle = g; x.beginPath(); x.moveTo(W / 2 - 6, 120); x.lineTo(W / 2 + 10, 120); x.lineTo(W / 2 + 70, 640); x.lineTo(W / 2 - 64, 640); x.closePath(); x.fill();
      const g2 = x.createRadialGradient(W / 2, 640, 10, W / 2, 640, 300); g2.addColorStop(0, 'rgba(240,162,76,.45)'); g2.addColorStop(1, 'rgba(240,162,76,0)'); x.fillStyle = g2; x.fillRect(0, 300, W, 660);
      x.fillStyle = '#efe6d4'; x.textAlign = 'center'; x.font = `300 92px ${FD}`; spacedText(x, 'THE NEW', W / 2, 770, 6, 'center'); x.font = `500 132px ${FD}`; spacedText(x, 'CAVE', W / 2, 880, 14, 'center');
      x.font = `500 19px ${FM}`; x.fillStyle = '#c9b89a'; spacedText(x, 'REALITY, RESPONSIBILITY &', W / 2, 60, 3, 'center'); spacedText(x, 'THE HUMAN AFTER AI', W / 2, 88, 3, 'center');
      x.font = `500 22px ${FM}`; x.fillStyle = '#f0a24c'; spacedText(x, 'CEM GULER', W / 2, 930, 8, 'center');
      grain(18);
    } else if (kind === 'hand') {
      x.fillStyle = '#d9c7a4'; x.fillRect(0, 0, W, H); grain(26);
      x.save(); x.translate(W / 2, 420); x.rotate(-0.12); drawHandStencil(x, 0, 0, 1.25, '#9e2c21', r); x.restore();
      x.fillStyle = '#1a1714'; x.textAlign = 'center'; x.font = `300 96px ${FD}`; spacedText(x, 'BEFORE', W / 2, 760, 4, 'center'); x.font = `italic 300 96px ${FD}`; spacedText(x, 'THE HAND', W / 2, 858, 4, 'center');
      x.font = `500 21px ${FM}`; spacedText(x, 'CEM GULER', W / 2, 920, 8, 'center');
      x.fillStyle = '#9e2c21'; x.fillRect(0, 54, W, 46); x.fillStyle = '#f5efe4'; x.font = `500 19px ${FM}`; spacedText(x, 'FORTHCOMING · À PARAÎTRE', W / 2, 84, 4, 'center');
    } else {
      x.fillStyle = '#2a1512'; x.fillRect(0, 0, W, H);
      x.globalAlpha = .13; x.fillStyle = '#e8d9bd'; for (let col = 0; col < 5; col++) for (let ln = 0; ln < 60; ln++) { if (r() < .08) continue; x.fillRect(30 + col * 120, 130 + ln * 13, 96 * (0.6 + r() * .4), 4); } x.globalAlpha = 1;
      x.fillStyle = '#efe6d4'; x.textAlign = 'center'; x.font = `300 74px ${FD}`; spacedText(x, 'THE', W / 2, 560, 10, 'center'); x.font = `600 104px ${FD}`; spacedText(x, 'TERRIBLE', W / 2, 670, 2, 'center');
      x.strokeStyle = '#c9853a'; x.lineWidth = 2; x.beginPath(); x.moveTo(140, 708); x.lineTo(W - 140, 708); x.stroke();
      x.font = `500 21px ${FM}`; x.fillStyle = '#c9853a'; spacedText(x, 'CEM GULER', W / 2, 920, 8, 'center');
      x.fillStyle = '#b4362a'; x.fillRect(0, 54, W, 46); x.fillStyle = '#f5efe4'; x.font = `500 19px ${FM}`; spacedText(x, 'FORTHCOMING · À PARAÎTRE', W / 2, 84, 4, 'center'); grain(16);
    }
    const front = tex(c, true, renderer);
    const [sc, sx] = canvas(96, 960); sx.fillStyle = kind === 'cave' ? '#121010' : kind === 'hand' ? '#d2bf9b' : '#2a1512'; sx.fillRect(0, 0, 96, 960);
    sx.save(); sx.translate(48, 480); sx.rotate(Math.PI / 2); sx.fillStyle = kind === 'hand' ? '#1a1714' : '#efe6d4'; sx.font = `500 34px ${FD}`; sx.textAlign = 'center'; sx.textBaseline = 'middle';
    sx.fillText(kind === 'cave' ? 'THE NEW CAVE' : kind === 'hand' ? 'BEFORE THE HAND' : 'THE TERRIBLE', -60, 0); sx.font = `500 16px ${FM}`; sx.fillStyle = kind === 'hand' ? '#9e2c21' : '#f0a24c'; sx.fillText('GULER', 340, 0); sx.restore();
    return { front, spine: tex(sc, true, renderer), base: kind === 'cave' ? 0x121010 : kind === 'hand' ? 0xd2bf9b : 0x2a1512 };
  }
  function drawHandStencil(x, cx, cy, s, color, r) {
    // negative hand stencil: spray cloud with the hand masked out
    const [hc, hx] = canvas(520, 640); const o = [260, 380];
    hx.fillStyle = '#000'; hx.translate(o[0], o[1]); hx.scale(s * 0.9, s * 0.9);
    hx.beginPath(); hx.ellipse(0, 40, 70, 82, 0, 0, 7); hx.fill();
    const fingers = [[-62, -10, -0.75, 26, 95], [-38, -50, -0.2, 21, 128], [-8, -58, -0.04, 22, 142], [22, -52, 0.12, 21, 132], [48, -36, 0.32, 18, 104]];
    fingers.forEach(([fx, fy, a, w, l]) => { hx.save(); hx.translate(fx, fy); hx.rotate(a); hx.beginPath(); hx.roundRect(-w / 2, -l, w, l + 30, w / 2); hx.fill(); hx.restore(); });
    hx.beginPath(); hx.roundRect(-58, 90, 116, 120, 30); hx.fill();
    // spray
    const [sc2, sx2] = canvas(520, 640);
    for (let i = 0; i < 7000; i++) { const a = r() * Math.PI * 2, d = Math.pow(r(), 0.65) * 250; const X = o[0] + Math.cos(a) * d * 0.95, Y = o[1] - 40 + Math.sin(a) * d * 1.12; sx2.fillStyle = color; sx2.globalAlpha = Math.max(0, 1 - d / 260) * 0.5; sx2.beginPath(); sx2.arc(X, Y, 1 + r() * 5, 0, 7); sx2.fill(); }
    sx2.globalAlpha = 1; sx2.globalCompositeOperation = 'destination-out'; sx2.filter = 'blur(1.5px)'; sx2.drawImage(hc, 0, 0);
    x.drawImage(sc2, cx - o[0], cy - o[1]);
  }
  const pagesTex = (() => { const [c, x] = canvas(256, 64); x.fillStyle = '#e9dfc9'; x.fillRect(0, 0, 256, 64); for (let i = 0; i < 64; i += 2) { x.fillStyle = `rgba(120,100,70,${0.08 + Math.random() * 0.12})`; x.fillRect(0, i, 256, 1); } return tex(c, true, renderer); })();
  pagesTex.wrapS = pagesTex.wrapT = THREE.RepeatWrapping;
  function makeBook(kind, w, h, d) {
    const T = bookTextures(kind); const grp = new THREE.Group();
    const coverMat = new THREE.MeshPhysicalMaterial({ map: T.front, roughness: 0.48, clearcoat: 0.35, clearcoatRoughness: 0.5 });
    const baseMat = new THREE.MeshStandardMaterial({ color: T.base, roughness: 0.6 });
    const spineMat = new THREE.MeshStandardMaterial({ map: T.spine, roughness: 0.55 });
    const pageMat = new THREE.MeshStandardMaterial({ map: pagesTex, roughness: 0.92, color: 0xf2ead8 });
    const ct = 0.006;
    const front = new THREE.Mesh(new THREE.BoxGeometry(w, h, ct), [baseMat, baseMat, baseMat, baseMat, coverMat, baseMat]); front.position.z = d / 2 - ct / 2;
    const back = new THREE.Mesh(new THREE.BoxGeometry(w, h, ct), baseMat); back.position.z = -d / 2 + ct / 2;
    const spine = new THREE.Mesh(new THREE.BoxGeometry(ct, h, d), [baseMat, spineMat, baseMat, baseMat, baseMat, baseMat]); spine.position.x = -w / 2 + ct / 2;
    const pages = new THREE.Mesh(new THREE.BoxGeometry(w - 0.012, h - 0.014, d - ct * 2), pageMat); pages.position.x = 0.002;
    [front, back, spine, pages].forEach(m => { m.castShadow = true; m.receiveShadow = true; grp.add(m); });
    return grp;
  }
  const books = new THREE.Group(); scene.add(books);
  {
    const BW = 0.27, BH = 0.41, BD = 0.05; const top = 1.28 + 0.16;
    const b1 = makeBook('cave', BW, BH, BD); b1.position.set(LEDGE_X - 0.45, top + BH / 2, LEDGE_Z + 0.42); b1.rotation.set(0, -Math.PI / 2 + 0.35, 0); b1.rotateX(-0.08);
    const b2 = makeBook('hand', BW, BH, BD); b2.position.set(LEDGE_X - 0.38, top + BH / 2, LEDGE_Z - 0.1); b2.rotation.set(0, -Math.PI / 2 + 0.12, 0); b2.rotateX(-0.12);
    const b3 = makeBook('terrible', BW, BH, BD); b3.position.set(LEDGE_X - 0.42, top + BD / 2, LEDGE_Z - 0.62); b3.rotation.set(-Math.PI / 2, 0, -Math.PI / 2 + 0.25); b3.rotateZ(0);
    books.add(b1, b2, b3);
  }
  // slit + beam
  const SLIT = V3(LEDGE_X - 2.4, 0, LEDGE_Z + 0.6); SLIT.y = P(LEDGE_Z).y + RY(LEDGE_Z) - 0.6;
  shared.uHC.value[0].set(SLIT.x, SLIT.y + 0.6, SLIT.z); shared.uHR.value[0].set(0.45, 1.6, 2.4);
  slit.position.set(SLIT.x - 0.4, SLIT.y + 4.5, SLIT.z + 0.4); slit.target.position.set(LEDGE_X - 0.42, 1.6, LEDGE_Z - 0.05);
  const skyPatch = new THREE.Mesh(new THREE.PlaneGeometry(6, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.4, 3.6), fog: false }));
  skyPatch.rotation.x = Math.PI / 2; skyPatch.position.set(SLIT.x, SLIT.y + 2.6, SLIT.z); scene.add(skyPatch);
  const beamMat = (col, k = 1) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: shared.uTime, uCol: { value: new THREE.Color(col) }, uK: { value: k } },
    vertexShader: `varying vec2 vUv; varying vec3 vW; varying vec3 vN; void main(){ vUv=uv; vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; vN = normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `varying vec2 vUv; varying vec3 vW; varying vec3 vN; uniform float uTime, uK; uniform vec3 uCol;
      float h(vec3 p){ p=fract(p*.1031); p+=dot(p,p.yzx+33.33); return fract((p.x+p.y)*p.z); }
      float n(vec3 p){ vec3 i=floor(p),f=fract(p); f=f*f*(3.-2.*f); return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){ vec3 V = normalize(cameraPosition - vW); float edge = pow(abs(dot(V, normalize(vN))), 1.6);
        float along = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
        float sides = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
        float mote = 0.75 + 0.5*n(vW*2.2 + vec3(0., uTime*0.15, uTime*0.05));
        float a = edge * along * mote * 0.16 * uK * (0.4 + 0.6*sides);
        gl_FragColor = vec4(uCol * a, 1.0); }`
  });
  function beamBetween(a, b, ra, rb, col, k) {
    const len = a.distanceTo(b); const g = new THREE.CylinderGeometry(ra, rb, len, 32, 1, true); g.translate(0, -len / 2, 0);
    // uv.y along (top=1), uv.x around
    const m = new THREE.Mesh(g, beamMat(col, k)); m.position.copy(a); m.quaternion.setFromUnitVectors(V3(0, -1, 0), b.clone().sub(a).normalize()); m.renderOrder = 4; m.frustumCulled = false; scene.add(m); return m;
  }
  const slitBeam = beamBetween(V3(SLIT.x, SLIT.y + 0.4, SLIT.z), V3(LEDGE_X - 0.45, 1.5, LEDGE_Z - 0.05), 0.35, 0.9, 0xffe2b5, 1.0);
  slitBeam.scale.set(1, 1, 2.2);
  // hand stencils on the left wall
  const HANDS_Z = -108; const HANDS_X = wallX(-1, HANDS_Z, 5.8);
  (function hands() {
    const r = rng(77); const [c, x] = canvas(1600, 900);
    const spots = [[300, 470, 1.05, -0.25, '#a3321f'], [640, 330, 0.95, 0.15, '#b5652a'], [930, 520, 1.1, -0.05, '#9e2c21'], [1270, 380, 0.9, 0.3, '#b97a35'], [1120, 720, 0.7, -0.4, '#a3321f'], [520, 700, 0.65, 0.5, '#b5652a']];
    spots.forEach(([X, Y, s, a, col]) => { x.save(); x.translate(X, Y); x.rotate(a); drawHandStencil(x, 0, 0, s, col, r); x.restore(); });
    const t = tex(c, true, renderer);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 3.6), new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.position.set(HANDS_X + 0.04, 3.1, HANDS_Z); m.rotation.y = Math.PI / 2; scene.add(m);
  })();

  /* ======================= 04 · THE TERRIBLE ======================= */
  const TT = { z: -147, y: 4.6 };
  const projO = V3(px(-128), P(-128).y + 4.6, -126.5);
  const titleC = V3(px(TT.z), TT.y - 0.4, TT.z);
  const projBeam = beamBetween(projO, titleC, 0.25, 5.2, 0xffd9a0, 0.55);
  const paperAtlas = (() => {
    const S = 1024, N = 4, T = S / N; const [c, x] = canvas(S, S); const r = rng(1890);
    for (let i = 0; i < N * N; i++) {
      const ox = (i % N) * T, oy = Math.floor(i / N) * T; x.save(); x.translate(ox, oy);
      x.beginPath(); const pts = []; const m = 10; for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; const rr = 0.5 - (r() * 0.05); pts.push([T / 2 + Math.cos(a) * T * rr * 1.25, T / 2 + Math.sin(a) * T * rr * 1.25]); }
      x.moveTo(m + r() * 8, m + r() * 8); x.lineTo(T - m - r() * 10, m + r() * 6); x.lineTo(T - m - r() * 6, T - m - r() * 12); x.lineTo(m + r() * 10, T - m - r() * 5); x.closePath(); x.clip();
      const base = [[236, 224, 198], [226, 211, 180], [240, 232, 214], [214, 196, 160]][i % 4];
      x.fillStyle = `rgb(${base})`; x.fillRect(0, 0, T, T);
      const st = x.createRadialGradient(r() * T, r() * T, 4, T / 2, T / 2, T * 0.8); st.addColorStop(0, 'rgba(140,100,50,.0)'); st.addColorStop(1, 'rgba(120,85,40,.35)'); x.fillStyle = st; x.fillRect(0, 0, T, T);
      x.fillStyle = 'rgba(40,30,20,.85)'; if (r() < .6) { x.fillRect(18, 22, T * (0.5 + r() * 0.35), 16 + r() * 10); }
      const cols = 2 + (r() * 2 | 0); const cw = (T - 36) / cols;
      for (let cI = 0; cI < cols; cI++) for (let ln = 0; ln < 22; ln++) { if (r() < .07) continue; x.fillStyle = `rgba(50,40,30,${0.35 + r() * .35})`; x.fillRect(18 + cI * cw, 56 + ln * 8.5, cw * (0.7 + r() * 0.24), 3); }
      if (r() < .4) { x.fillStyle = 'rgba(40,30,20,.5)'; x.fillRect(18 + r() * 60, 100, 70, 60); }
      x.restore();
    }
    return tex(c, true, renderer);
  })();
  function sampleText(lines, worldW, spacing) {
    const W = 1400, H = lines.length * 420 + 80; const [c, x] = canvas(W, H); x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    lines.forEach((l, i) => { let fs = 330; x.font = `900 ${fs}px ${FD}`; let w = x.measureText(l).width; if (w > W * 0.96) { fs *= W * 0.96 / w; x.font = `900 ${fs}px ${FD}`; } x.fillText(l, W / 2, 60 + 420 * i + 210); });
    const d = x.getImageData(0, 0, W, H).data; const pts = []; const scale = worldW / W; const step = Math.max(2, spacing / scale);
    for (let yy = 0; yy < H; yy += step) for (let xx = 0; xx < W; xx += step) { const jx = xx + (Math.random() - .5) * step * .6, jy = yy + (Math.random() - .5) * step * .6; const ix = Math.round(clamp(jx, 0, W - 1)), iy = Math.round(clamp(jy, 0, H - 1)); if (d[(iy * W + ix) * 4] > 128) pts.push([(jx - W / 2) * scale, -(jy - H / 2) * scale]); }
    return pts;
  }
  let cards = null; let routeLabels = [];
  function buildCards(portrait) {
    if (cards) { scene.remove(cards); cards.geometry.dispose(); }
    const N = tier.cards; const r = rng(10000);
    const tw = portrait ? 5.4 : 10.6; const title = sampleText(portrait ? ['THE', 'TERRIBLE'] : ['THE TERRIBLE'], tw, portrait ? 0.058 : 0.064);
    // route arc: TR → UK → US → CA (east → west)
    const nodes = portrait ? [[2.6, 0], [0.9, 0.15], [-1.3, 0.05], [-2.6, 0.12]] : [[4.4, 0], [1.6, 0.2], [-2.2, 0.05], [-4.4, 0.15]];
    const route = []; for (let i = 0; i < nodes.length - 1; i++) { const [a, b] = [nodes[i], nodes[i + 1]]; const n = Math.round(Math.hypot(b[0] - a[0], 1) * 22); for (let k = 0; k <= n; k++) { const t = k / n; route.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t) + Math.sin(t * Math.PI) * (0.55 + i * 0.12)]); } }
    nodes.forEach(([a, b]) => { for (let k = 0; k < 28; k++) { const an = k / 28 * Math.PI * 2; route.push([a + Math.cos(an) * 0.17, b + Math.sin(an) * 0.17]); } });
    const routeY = portrait ? TT.y - 2.65 : TT.y - 1.95; const titleY = portrait ? TT.y + 0.45 : TT.y + 0.15;
    const g = new THREE.InstancedBufferGeometry(); g.index = new THREE.PlaneGeometry(1, 1).index; g.attributes.position = new THREE.PlaneGeometry(1, 1).attributes.position; g.attributes.uv = new THREE.PlaneGeometry(1, 1).attributes.uv;
    const aS = new Float32Array(N * 3), aT = new Float32Array(N * 3), aR = new Float32Array(N * 4), aK = new Float32Array(N * 2);
    const axis = titleC.clone().sub(projO); const axL = axis.length(); axis.normalize(); const ref = Math.abs(axis.y) > .9 ? V3(1, 0, 0) : V3(0, 1, 0); const b1 = V3().crossVectors(axis, ref).normalize(), b2 = V3().crossVectors(axis, b1);
    for (let i = 0; i < N; i++) {
      const s = 0.25 + r() * 0.85; const rad = (0.25 + (5.0 - 0.25) * s) * Math.sqrt(r()) * 0.92; const an = r() * Math.PI * 2;
      const p = projO.clone().addScaledVector(axis, s * axL).addScaledVector(b1, Math.cos(an) * rad).addScaledVector(b2, Math.sin(an) * rad);
      aS.set([p.x, p.y, p.z], i * 3);
      let tgt, kind = 0;
      if (i < title.length && i < N * 0.8) { const [u, v] = title[i]; tgt = [titleC.x + u, titleY + v, TT.z + (r() - .5) * 0.06]; kind = 1; }
      else if (i - title.length < route.length && i - title.length >= 0) { const [u, v] = route[i - title.length]; tgt = [titleC.x + u, routeY + v, TT.z + 0.1]; kind = 2; }
      else { tgt = [p.x, p.y, p.z]; kind = 0; }
      if (kind === 1) tgt[2] = TT.z + (r() - .5) * 0.02; aT.set(tgt, i * 3); aR.set([r(), r(), r(), r()], i * 4); aK.set([kind, (r() * 16) | 0], i * 2);
    }
    g.setAttribute('aStart', new THREE.InstancedBufferAttribute(aS, 3)); g.setAttribute('aTarget', new THREE.InstancedBufferAttribute(aT, 3));
    g.setAttribute('aRnd', new THREE.InstancedBufferAttribute(aR, 4)); g.setAttribute('aKind', new THREE.InstancedBufferAttribute(aK, 2));
    g.instanceCount = N;
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide, transparent: false, alphaTest: 0.5,
      uniforms: { uTime: shared.uTime, uProg: { value: 0 }, uMap: { value: paperAtlas }, uO: { value: projO }, uAx: { value: axis }, uFogC: { value: fogColor }, uFogD: { value: 0.03 }, uVis: { value: 1 }, uSz: { value: portrait ? 0.062 : 0.07 } },
      vertexShader: `attribute vec3 aStart, aTarget; attribute vec4 aRnd; attribute vec2 aKind; uniform float uTime, uProg, uSz; uniform vec3 uO, uAx;
        varying vec2 vUv; varying float vLit; varying float vD; varying float vKind; varying float vP;
        mat3 rot(vec3 a){ float cx=cos(a.x), sx=sin(a.x), cy=cos(a.y), sy=sin(a.y), cz=cos(a.z), sz=sin(a.z);
          return mat3(cy*cz, cy*sz, -sy,  sx*sy*cz - cx*sz, sx*sy*sz + cx*cz, sx*cy,  cx*sy*cz + sx*sz, cx*sy*sz - sx*cz, cx*cy); }
        void main(){ float k = aKind.x; vKind = k;
          float del = aRnd.x*0.45 + (k > 1.5 ? 0.25 : 0.0); float p = clamp((uProg - del)/0.5, 0., 1.); p = p*p*(3.-2.*p); if (k < 0.5) p = 0.;
          vP = p;
          float tt = uTime*(0.08 + aRnd.y*0.1);
          vec3 drift = aStart + vec3(sin(tt*6.28 + aRnd.z*40.)*0.55, sin(tt*4.0 + aRnd.w*30.)*0.35 - mod(uTime*0.02*aRnd.y + aRnd.x*3., 3.)*0.0, cos(tt*5.0 + aRnd.y*20.)*0.55);
          vec3 pos = mix(drift, aTarget, p);
          if (k < 0.5) { float g = clamp(uProg, 0., 1.); vec3 q0 = pos - uO; float al = dot(q0, uAx); vec3 rad0 = q0 - uAx*al; pos += normalize(rad0 + vec3(0.001)) * g * 2.4 + uAx * g * -1.5; }
          vec3 ang = (1.0-p) * (aRnd.xyz*6.28 + vec3(uTime*0.4*aRnd.w, uTime*0.3*aRnd.z, uTime*0.2)) + p*vec3(0.,0., (aRnd.w-0.5)*0.22);
          float sz = mix(0.13 + aRnd.w*0.09, uSz*(k > 1.5 ? 0.85 : 1.08), p);
          vec3 lp = rot(ang) * vec3(position.x*sz, position.y*sz*1.25, 0.);
          vec4 w = modelMatrix * vec4(pos + lp, 1.0);
          vec3 q = w.xyz - uO; float along = dot(q, uAx); float rad = length(q - uAx*along); float coneR = 0.25 + along*0.24;
          vLit = mix(0.12, 1.6, smoothstep(coneR, coneR*0.35, rad)) * (0.8 + 0.3*aRnd.y);
          vLit = mix(vLit, 1.35, p); if (k < 0.5) vLit *= 1.0 - 0.75*clamp(uProg,0.,1.);
          vec4 mv = viewMatrix * w; vD = -mv.z; gl_Position = projectionMatrix * mv;
          float tile = aKind.y; vUv = (vec2(mod(tile,4.0), floor(tile/4.0)) + uv) / 4.0; }`,
      fragmentShader: `uniform sampler2D uMap; uniform vec3 uFogC; uniform float uFogD, uVis; varying vec2 vUv; varying float vLit, vD, vKind, vP;
        void main(){ vec4 t = texture2D(uMap, vUv); if (t.a < 0.5) discard; vec3 c = t.rgb * vLit;
          c = mix(c, c*vec3(1.15,0.92,0.7), 0.35);
          if (vKind > 1.5) c = mix(c, vec3(0.95,0.36,0.24)*1.6, vP*0.6);
          float f = 1.0 - exp(-uFogD*uFogD*vD*vD); gl_FragColor = vec4(mix(c, uFogC, f)*uVis, 1.0); }`
    });
    cards = new THREE.Mesh(g, mat); cards.frustumCulled = false; scene.add(cards);
    routeLabels.forEach(s => scene.remove(s)); routeLabels = [];
    ['TR', 'UK', 'US', 'CA'].forEach((lab, i) => {
      const [c, x] = canvas(256, 96); x.fillStyle = '#efe6d4'; x.font = `500 52px ${FM}`; x.textAlign = 'center'; x.textBaseline = 'middle'; spacedText(x, lab, 128, 50, 10, 'center');
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(c, true, renderer), transparent: true, opacity: 0, depthWrite: false, fog: false }));
      sp.scale.set(0.95, 0.36, 1); sp.position.set(titleC.x + nodes[i][0], routeY + nodes[i][1] - 0.48, TT.z + 0.15); scene.add(sp); routeLabels.push(sp);
    });
  }

  /* ======================= 05 · RADIO POOL ======================= */
  const POOLC = V3(px(POOL.z), 0.035, POOL.z);
  const RIPN = 10; const ripples = Array.from({ length: RIPN }, () => new THREE.Vector4(0, 0, -100, 0)); let ripI = 0;
  const waterShader = {
    name: 'PoolShader',
    uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, uTime: shared.uTime, uRip: { value: ripples }, uC: { value: POOLC }, uR: { value: POOL.r }, uGlow: { value: new THREE.Color(1.0, 0.62, 0.3) }, uFake: { value: 0 } },
    vertexShader: `uniform mat4 textureMatrix; varying vec4 vUvR; varying vec3 vW; void main(){ vUvR = textureMatrix*vec4(position,1.0); vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform vec3 color; uniform sampler2D tDiffuse; uniform float uTime, uR, uFake; uniform vec4 uRip[${RIPN}]; uniform vec3 uC, uGlow; varying vec4 vUvR; varying vec3 vW;
      void main(){ vec2 p = vW.xz; vec2 grad = vec2(0.); float rings = 0.;
        for(int i=0;i<${RIPN};i++){ vec4 r = uRip[i]; float age = uTime - r.z; if(age < 0.0 || age > 9.0) continue;
          vec2 d = p - r.xy; float dist = length(d); float front = age*0.95; float k = dist - front;
          float env = exp(-k*k*5.0) * exp(-age*0.42) * r.w / (1.0 + dist*0.6);
          grad += (d/max(dist,1e-3)) * cos(k*15.0) * env;
          for (int e=1;e<3;e++){ float ke = dist - front*(1.0 - float(e)*0.28); rings += exp(-ke*ke*120.0) * exp(-age*0.5) * r.w * (0.6/float(e)); }
          rings += exp(-k*k*150.0) * exp(-age*0.45) * r.w; }
        float amb = sin(p.x*3.1 + uTime*0.7)*sin(p.y*2.7 - uTime*0.6);
        grad += vec2(amb, -amb)*0.012;
        vec4 uv = vUvR; uv.xy += grad * 0.09 * uv.w;
        vec3 refl = texture2DProj(tDiffuse, uv).rgb;
        vec3 V = normalize(cameraPosition - vW); vec3 N = normalize(vec3(-grad.x*0.4, 1.0, -grad.y*0.4));
        float fr = 0.03 + 0.97*pow(1.0 - max(dot(N,V),0.0), 5.0);
        float rr = length(p - uC.xz)/uR; float edge = smoothstep(1.0, 0.86, rr);
        vec3 deep = vec3(0.006,0.008,0.009);
        vec3 c = mix(deep, refl*1.3, mix(0.6, 1.0, fr)) + uGlow * rings * 2.2;
        gl_FragColor = vec4(c, edge); }`
  };
  const pool = new Reflector(new THREE.CircleGeometry(POOL.r, 96), { shader: waterShader, textureWidth: tier.refl, textureHeight: tier.refl, clipBias: 0.003, color: 0x888888, multisample: LOW ? 0 : 4 });
  pool.material.transparent = true; pool.rotation.x = -Math.PI / 2; pool.position.copy(POOLC); scene.add(pool);
  const rimMat = plainRock({ tint: [0.9, 0.9, 0.95] });
  for (let i = 0; i < 22; i++) { const a = i / 22 * Math.PI * 2 + Math.random() * 0.1; const s = new THREE.Mesh(rockBlob(0.28 + Math.random() * 0.25, i * 1.7, [1.3, 0.45, 1], 12), rimMat); s.position.set(POOLC.x + Math.cos(a) * (POOL.r + 0.12), 0.02, POOL.z + Math.sin(a) * (POOL.r + 0.12)); s.rotation.y = a; scene.add(s); }
  // oscilloscope waveform
  const WAVE_N = 64; const waveData = new Float32Array(WAVE_N);
  const waveMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: shared.uTime, uAmp: { value: 0.3 }, uAud: { value: waveData }, uAudOn: { value: 0 }, uVis: { value: 1 } },
    vertexShader: `uniform float uTime, uAmp, uAudOn; uniform float uAud[${WAVE_N}]; varying vec2 vUv; varying float vY;
      float wave(float x){ float env = exp(-x*x*0.09);
        float v = sin(x*5.1 + uTime*3.0)*0.55 + sin(x*11.3 - uTime*4.7)*0.25 + sin(x*23.0 + uTime*7.3)*0.12;
        float talk = 0.35 + 0.65*pow(0.5+0.5*sin(uTime*1.1)*sin(uTime*0.37+1.0), 2.0);
        float a = mix(uAmp*talk, 0.0, 0.0);
        float idx = clamp((x/3.6*0.5+0.5)*${WAVE_N - 1}.0, 0.0, ${WAVE_N - 1}.0); int i0 = int(floor(idx));
        float au = 0.0; for (int k=0;k<${WAVE_N};k++){ if (k==i0) au = uAud[k]; }
        return mix(v*a, au*0.9, uAudOn) * env; }
      void main(){ vUv = uv; float x = position.x; float y = wave(x); vY = y; vec3 p = vec3(x, y + position.y, 0.); gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.); }`,
    fragmentShader: `varying vec2 vUv; varying float vY; uniform float uVis; void main(){ float d = abs(vUv.y-0.5)*0.5; float g = exp(-d*90.0)*2.6 + exp(-d*16.0)*0.32;
      float ends = smoothstep(0.0,0.12,vUv.x)*smoothstep(1.0,0.88,vUv.x); vec3 c = mix(vec3(1.0,0.55,0.22), vec3(1.0,0.9,0.75), exp(-d*120.0));
      gl_FragColor = vec4(c*g*ends*uVis, 1.0); }`
  });
  const wave = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 0.5, 360, 1), waveMat); wave.position.set(POOLC.x, 1.75, POOL.z - 0.2); wave.renderOrder = 6; wave.frustumCulled = false; scene.add(wave);
  function addRipple(x, z, amp = 1) { ripples[ripI].set(x, z, shared.uTime.value, amp); ripI = (ripI + 1) % RIPN; }

  /* ======================= 06 · CHAMBERS ======================= */
  const VENTURES = [
    { name: 'EVERSTAR XR', sub: 'NEW YORK · 2023–2026', col: [0.55, 0.49, 1.0], z: -208, side: -1 },
    { name: 'METACAMPUS', sub: 'LONDON · 2023', col: [0.25, 0.82, 0.74], z: -220, side: 1 },
    { name: 'GEN:A LABS', sub: 'OTTAWA · 2026–', col: [0.78, 0.93, 0.36], z: -232, side: -1 },
    { name: 'PARALLAX XP', sub: 'OTTAWA · 2025– · 6 CHAMBERS', col: [1.0, 0.7, 0.28], z: -244, side: 1 },
    { name: 'SILVERMOON', sub: 'PICTURES · OTTAWA · 2018–', col: [0.81, 0.85, 0.92], z: -256, side: -1 },
  ];
  const chamberLights = []; const chamberObjs = [];
  VENTURES.forEach((v, i) => {
    const wx = wallX(v.side, v.z, 6.0); const hy = 2.9;
    shared.uHC.value[i + 1].set(wx, hy, v.z); shared.uHR.value[i + 1].set(1.4, 2.15, 1.85);
    const g = (() => { const gg = new THREE.SphereGeometry(3.4, 40, 30); const a = gg.attributes.position; const vv = V3();
      for (let q = 0; q < a.count; q++) { vv.fromBufferAttribute(a, q); const n = fbm3(vv.x * 0.6 + i * 7, vv.y * 0.6, vv.z * 0.6, 3); vv.multiplyScalar(0.88 + n * 0.26); vv.y *= 1.15; a.setXYZ(q, vv.x, vv.y, vv.z); }
      gg.setAttribute('aSmooth', new THREE.BufferAttribute(new Float32Array(a.count), 1)); gg.computeVertexNormals(); return gg; })();
    const mat = enhance(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.BackSide }), { rock: true, oct: tier.oct, tint: [1.4, 1.4, 1.4] });
    mat.clippingPlanes = [new THREE.Plane(V3(v.side, 0, 0), -v.side * (wx + v.side * 0.05) * 1)];
    // keep points on the far side of the wall: side*(x) >= side*wx
    mat.clippingPlanes[0].set(V3(v.side, 0, 0), -(v.side * wx) + 0.05);
    const ch = new THREE.Mesh(g, mat); ch.userData.chamber = true; ch.position.set(wx + v.side * 1.5, hy + 0.2, v.z); scene.add(ch);
    // name projected onto back wall
    const [c, x] = canvas(1024, 512); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    let fs = 132; x.font = `400 ${fs}px ${FD}`; while (x.measureText(v.name).width > 940) { fs -= 6; x.font = `400 ${fs}px ${FD}`; }
    spacedText(x, v.name, 512, 230, 4, 'center'); x.font = `500 30px ${FM}`; spacedText(x, v.sub, 512, 350, 7, 'center');
    if (v.name === 'PARALLAX XP') { for (let k = 0; k < 6; k++) { x.beginPath(); const cx = 512 + (k - 2.5) * 70; x.moveTo(cx - 20, 455); x.lineTo(cx - 20, 425); x.arc(cx, 425, 20, Math.PI, 0); x.lineTo(cx + 20, 455); x.lineWidth = 3; x.strokeStyle = '#fff'; x.stroke(); } }
    const t = tex(c, true, renderer);
    const col = new THREE.Color(...v.col);
    const dm = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 1.25), new THREE.MeshBasicMaterial({ map: t, color: col.clone().multiplyScalar(2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    dm.position.set(wx + v.side * 3.7, hy + 0.15, v.z); dm.rotation.y = -v.side * Math.PI / 2; scene.add(dm);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(4.5, 5.5, 1); glow.position.set(wx + v.side * 1.2, hy, v.z); scene.add(glow);
    glow.userData.chamber = true; dm.userData.chamber = true;
    chamberObjs.push(ch, glow, dm);
    chamberLights.push({ pos: V3(wx - v.side * 0.2, 1.0, v.z), col: V3(...v.col), z: v.z, decal: dm, glow });
  });

  /* ======================= 07 · CREW AROUND THE FIRE ======================= */
  const CREW = () => [
    { n: 'Claude', d: ui.state.lang === 'fr' ? 'réflexion · construction' : 'thinking · building', s: 'Claude Code' },
    { n: 'Codex', d: ui.state.lang === 'fr' ? 'code · révision' : 'code · review', s: 'ChatGPT' },
    { n: 'Gemini', d: ui.state.lang === 'fr' ? 'images · vidéo' : 'images · video', s: 'Nano Banana · Veo' },
    { n: ui.state.lang === 'fr' ? 'Direction humaine' : 'Human direction', d: ui.state.lang === 'fr' ? 'jugement · approbation' : 'judgment · sign-off', s: ui.state.lang === 'fr' ? 'répond du résultat' : 'answerable for the result', human: true },
    { n: 'Unreal', d: ui.state.lang === 'fr' ? 'mondes · humains numériques' : 'worlds · digital humans', s: 'MetaHuman · CC4 · iClone' },
    { n: ui.state.lang === 'fr' ? 'Musique IA' : 'AI music', d: ui.state.lang === 'fr' ? 'musique originale' : 'original score', s: '' },
    { n: 'Adobe', d: ui.state.lang === 'fr' ? 'finition' : 'finishing', s: 'Creative Suite' },
  ];
  const stoneLabels = [];
  {
    const angs = [-82, -56, -28, 0, 28, 56, 82]; const R = 5.4; const r = rng(3);
    const stoneMat = plainRock({ tint: [1.35, 1.25, 1.15] });
    angs.forEach((a, i) => {
      const ar = a * Math.PI / 180; const human = i === 3; const h = human ? 2.7 : 1.7 + r() * 0.4;
      const g = rockBlob(1, i * 9.3, [0.62, h / 2, 0.36], 22);
      const st = new THREE.Mesh(g, stoneMat);
      const pos = V3(C_CREW.x + Math.sin(ar) * R * (human ? 1.12 : 1), h / 2 - 0.15, C_CREW.z - Math.cos(ar) * R * (human ? 1.12 : 1));
      st.position.copy(pos); st.lookAt(C_CREW.x, pos.y, C_CREW.z); st.rotateY((r() - .5) * 0.15); st.rotateZ((r() - .5) * 0.08); scene.add(st);
      const lab = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.125), new THREE.MeshStandardMaterial({ transparent: true, roughness: 1, depthWrite: false, emissive: 0xffffff, emissiveIntensity: 0.22, polygonOffset: true, polygonOffsetFactor: -4 }));
      lab.position.copy(pos).add(V3(C_CREW.x - pos.x, 0, C_CREW.z - pos.z).normalize().multiplyScalar(0.42)); lab.position.y = human ? 1.75 : Math.min(h * 0.62, 1.25);
      lab.lookAt(C_CREW.x, lab.position.y, C_CREW.z); scene.add(lab); stoneLabels.push({ mesh: lab, human });
    });
  }
  function drawStoneLabels() {
    const list = CREW();
    stoneLabels.forEach((sl, i) => {
      const it = list[i]; const [c, x] = canvas(640, 480);
      x.textAlign = 'center'; x.fillStyle = it.human ? '#f0a24c' : '#efe6d4';
      let fs = it.human ? 74 : 92; x.font = `400 ${fs}px ${FD}`; while (x.measureText(it.n).width > 600) { fs -= 4; x.font = `400 ${fs}px ${FD}`; }
      x.fillText(it.n, 320, 170); x.font = `500 28px ${FM}`; x.fillStyle = it.human ? '#ffcf9a' : '#d8cbb1'; spacedText(x, it.d.toUpperCase(), 320, 250, 3, 'center');
      if (it.s) { x.font = `400 26px ${FM}`; x.fillStyle = it.human ? '#ffcf9a' : '#b9ad97'; spacedText(x, it.s, 320, 305, 2, 'center'); }
      x.strokeStyle = it.human ? '#f0a24c' : 'rgba(239,230,212,.6)'; x.lineWidth = 3; x.beginPath(); x.moveTo(250, 345); x.lineTo(390, 345); x.stroke();
      const old = sl.mesh.material.map; sl.mesh.material.map = tex(c, true, renderer); sl.mesh.material.emissiveMap = sl.mesh.material.map; sl.mesh.material.emissiveIntensity = it.human ? 1.1 : 0.75; sl.mesh.material.needsUpdate = true; if (old) old.dispose();
    });
  }
  drawStoneLabels();

  /* ======================= 08–09 · OUTSIDE ======================= */
  const SUN_DIR = V3(0.22, 0.13, -1).normalize();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: { value: SUN_DIR }, uK: { value: 1 } },
    vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.); gl_Position = p.xyww; }`,
    fragmentShader: `varying vec3 vD; uniform vec3 uSun; uniform float uK; void main(){ vec3 d = normalize(vD); float h = d.y;
      vec3 zen = vec3(0.16,0.22,0.42), hor = vec3(0.98,0.56,0.32), low = vec3(0.78,0.4,0.26);
      vec3 c = mix(hor, zen, smoothstep(0.0, 0.55, h)); c = mix(low, c, smoothstep(-0.05, 0.08, h));
      float s = max(dot(d, uSun), 0.0); c += vec3(1.6,0.9,0.45)*pow(s, 8.0)*0.9 + vec3(2.5,1.7,1.0)*pow(s, 90.0)*1.5 + vec3(30.0,24.0,16.0)*smoothstep(0.9993,0.9997,s);
      c *= uK; gl_FragColor = vec4(c, 1.0); }`
  }));
  sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);
  const MOUTH_Z = -352;
  const ridges = new THREE.Group(); scene.add(ridges);
  [[-520, 34, 0.55, 1], [-820, 60, 0.38, 2], [-1250, 95, 0.24, 3], [-1800, 130, 0.12, 4]].forEach(([z, H, dark, seed]) => {
    const g = new THREE.PlaneGeometry(4200, H * 2.4, 240, 1); const a = g.attributes.position;
    for (let i = 0; i < a.count; i++) { const x = a.getX(i); if (a.getY(i) > 0) { const n = fbm3(x * 0.004 + seed * 10, seed, 0, 5); a.setY(i, H * (0.25 + n * 1.2) - 6); } else a.setY(i, -40); }
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ fog: false, depthWrite: true, uniforms: { uDark: { value: dark }, uSun: { value: SUN_DIR } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `varying vec3 vW; uniform float uDark; uniform vec3 uSun; void main(){ vec3 haze = vec3(1.1,0.72,0.5); vec3 base = vec3(0.10,0.07,0.09);
        float hgt = clamp((vW.y+10.0)/120.0, 0., 1.); vec3 c = mix(haze, base, uDark) * (0.85 + 0.25*hgt); c = mix(c, haze*1.05, (1.0-hgt)*0.25*(1.0-uDark));
        gl_FragColor = vec4(c, 1.); }` }));
    m.position.set(0, 0, z); ridges.add(m);
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 3000, 1, 1), new THREE.ShaderMaterial({ fog: false, uniforms: {},
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `varying vec3 vW; void main(){ float d = length(vW.xz - vec2(0.,-352.)); vec3 near = vec3(0.09,0.07,0.06), far = vec3(0.95,0.62,0.44); gl_FragColor = vec4(mix(near, far, smoothstep(10., 520., d)), 1.); }` }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, -0.4, MOUTH_Z - 1500); scene.add(ground);
  const outside = [sky, ridges, ground];

  /* ======================= DUST ======================= */
  const dust = (() => {
    const N = tier.dust; const g = new THREE.BufferGeometry(); const p = new Float32Array(N * 3), s = new Float32Array(N); const r = rng(9);
    for (let i = 0; i < N; i++) { p.set([(r() - .5) * 3.5, r() * 9, (r() - .5) * 3.5], i * 3); s[i] = r(); }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aS', new THREE.BufferAttribute(s, 1));
    const m = new THREE.Points(g, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: shared.uTime, uPx: { value: renderer.getPixelRatio() }, uCol: { value: new THREE.Color(1, 0.86, 0.66) }, uK: { value: 1 } },
      vertexShader: `attribute float aS; uniform float uTime, uPx; varying float vA; void main(){ vec3 p = position; p.y = mod(p.y - uTime*0.05*(0.4+aS), 9.0); p.x += sin(uTime*0.3 + aS*30.)*0.3; p.z += cos(uTime*0.27 + aS*20.)*0.3;
        vec4 mv = modelViewMatrix*vec4(p,1.); gl_Position = projectionMatrix*mv; gl_PointSize = uPx*(0.7+aS*1.3)*(3.2/-mv.z)*2.0; vA = (0.3+aS*0.7); }`,
      fragmentShader: `varying float vA; uniform vec3 uCol; uniform float uK; void main(){ float a = smoothstep(.5,.0,length(gl_PointCoord-.5)); gl_FragColor = vec4(uCol*a*vA*uK*0.7, 1.); }` }));
    m.frustumCulled = false; scene.add(m); return m;
  })();

  /* ======================= CAMERA KEYS ======================= */
  const HX = HERO_WX, SX = z => wallX(-1, z, 6.0), RXw = z => wallX(1, z, 6.0);
  const G = [-42, -51.6, -61.4, -71];
  const K = [
    { t: 0.00, p: [6.1, 1.35, 5.8], l: [-2.6, 2.7, -0.6], fov: 44, fx: .63, fy: .5, pfx: .5, pfy: .3, pfov: 66 },
    { t: 0.2, p: [6.2, 2.7, 3.6], l: [-6.6, 3.7, -0.3], fov: 48, fx: .56, fy: .46, pfy: .32, pfov: 68 },
    { t: 0.46, p: [5.9, 4.55, 1.5], l: [HX, 4.0, 0.05], fov: 50, fx: .5, fy: .4, pfy: .3, pp: [5.6, 4.7, 0.3], pl: [HX, 4.55, 0.0], pfov: 78 },
    { t: 0.72, p: [5.5, 4.45, 1.2], l: [HX, 3.9, 0.05], fov: 50, fx: .5, fy: .38, pfy: .28, pp: [5.4, 4.7, 0.2], pl: [HX, 4.55, 0.0], pfov: 78 },
    { t: 0.95, p: [px(-28) + 2.4, 2.8, -28], l: [SX(-40) + 1.5, 3.2, -42], fov: 50, fx: .55, fy: .48, pfy: .34, pfov: 66 },
    ...G.map((g, i) => ({ t: 1.158 + i * 0.21, p: [px(g + 4.4) + 2.3, 3.0, g + 4.4], l: [SX(g), 3.25, g - 0.5], fov: 46, fx: .36, fy: .47, pfx: .5, pfy: .3, pp: [px(g + 1.4) + 4.6, 3.2, g + 1.4], pl: [SX(g), 3.5, g - 0.3], pfov: 76 })),
    { t: 2.0, p: [px(-93) + 0.4, 2.2, -93], l: [LEDGE_X - 1.2, 2.6, LEDGE_Z], fov: 50, fx: .66, fy: .5, pfx: .5, pfy: .36, pfov: 66 },
    { t: 2.333, p: [LEDGE_X - 2.75, 1.95, LEDGE_Z + 2.0], l: [LEDGE_X - 0.42, 1.68, LEDGE_Z - 0.1], fov: 36, fx: .68, fy: .5, pfx: .5, pfy: .3, pfov: 56 },
    { t: 2.667, p: [px(-103) + 1.4, 2.8, -103], l: [HANDS_X, 3.05, HANDS_Z], fov: 46, fx: .3, fy: .48, pfx: .5, pfy: .3, pfov: 64 },
    { t: 2.96, p: [px(-129) + 0.2, 2.2, -129.5], l: [px(-147), 4.3, -147], fov: 52, fx: .66, fy: .5, pfy: .36, pfov: 70 },
    { t: 3.295, p: [px(-134), 3.9, -134.5], l: [titleC.x, 3.9, -147], fov: 50, fx: .5, fy: .5, pfy: .58, pfov: 72 },
    { t: 3.672, p: [px(-135) + 0.6, 3.6, -135.5], l: [titleC.x + 0.4, 3.75, -147], fov: 52, fx: .66, fy: .34, pfx: .5, pfy: .26, pfov: 72 },
    { t: 4.0, p: [POOLC.x + 0.6, 3.5, POOL.z + 9.6], l: [POOLC.x + 0.3, 0.9, POOL.z - 0.4], fov: 48, fx: .62, fy: .62, pfy: .26, pfov: 70 },
    { t: 4.5, p: [POOLC.x + 0.2, 3.3, POOL.z + 8.2], l: [POOLC.x, 0.95, POOL.z - 0.4], fov: 48, fx: .5, fy: .56, pfy: .3, pfov: 70 },
    { t: 4.93, p: [px(-197), 2.5, -197], l: [px(-214), 2.8, -214], fov: 50, fx: .62, fy: .48, pfy: .34, pfov: 66 },
    ...VENTURES.map((v, i) => ({ t: 5.13 + i * 0.174, p: [px(v.z + 3.4) - v.side * 3.3, 2.75, v.z + 3.4], l: [wallX(v.side, v.z, 6.0) + v.side * 1.8, 2.85, v.z - 0.2], fov: 46, fx: v.side < 0 ? .36 : .64, fy: .5, pfx: .5, pfy: .32, pfov: 66 })),
    { t: 6.0, p: [C_CREW.x + 1.2, 3.1, C_CREW.z + 15], l: [C_CREW.x, 1.5, C_CREW.z - 2], fov: 46, fx: .66, fy: .5, pfy: .36, pfov: 64 },
    { t: 6.333, p: [C_CREW.x - 0.6, 2.4, C_CREW.z + 8.6], l: [C_CREW.x - 0.3, 1.25, C_CREW.z - 3.0], fov: 54, fx: .3, fy: .5, pfx: .5, pfy: .34, pfov: 74 },
    { t: 6.667, p: [C_CREW.x + 2.6, 1.6, C_CREW.z + 3.6], l: [C_CREW.x - 0.6, 1.1, C_CREW.z - 2.2], fov: 46, fx: .68, fy: .5, pfy: .34, pfov: 66 },
    { t: 7.0, p: [px(-314), 2.6, -314], l: [px(-345), 2.8, -380], fov: 52, fx: .5, fy: .5, pfy: .5, pfov: 70 },
    { t: 7.95, p: [px(-340), 2.4, -340], l: [px(-350), 2.6, -420], fov: 56, fx: .5, fy: .5, pfy: .5, pfov: 72 },
    { t: 8.05, p: [px(-337), 1.6, -337], l: [px(-345), 3.0, -420], fov: 55, fx: .5, fy: .5, pfy: .5, pfov: 72 },
    { t: 9.0, p: [px(-337), 1.6, -337], l: [px(-345), 3.0, -420], fov: 55, fx: .5, fy: .42, pfy: .3, pfov: 72 },
    { t: 10.0, p: [px(-342), 1.75, -342], l: [px(-345), 3.6, -420], fov: 55, fx: .5, fy: .4, pfy: .28, pfov: 72 },
  ];
  const cr = (p0, p1, p2, p3, t) => { const t2 = t * t, t3 = t2 * t; return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3); };
  function sampleKeys(t, portrait) {
    let i = 0; while (i < K.length - 2 && t > K[i + 1].t) i++;
    const a = K[i], b = K[i + 1]; let u = clamp((t - a.t) / (b.t - a.t)); u = u * u * (3 - 2 * u);
    const k0 = K[Math.max(0, i - 1)], k3 = K[Math.min(K.length - 1, i + 2)];
    const get = (k, f) => (portrait && k['p' + f]) ? k['p' + f] : k[f];
    const v3 = f => [0, 1, 2].map(j => cr(get(k0, f)[j], get(a, f)[j], get(b, f)[j], get(k3, f)[j], u));
    const sc = f => lerp(get(a, f), get(b, f), u);
    return { p: v3('p'), l: v3('l'), fov: sc('fov'), fx: sc('fx'), fy: sc('fy') };
  }

  /* ======================= POST ======================= */
  const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: tier.msaa });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / (LOW ? 2 : 1), innerHeight / (LOW ? 2 : 1)), 0.55, 0.55, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const finalPass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uCA: { value: 0 }, uGrain: { value: 0.055 }, uVig: { value: 0.55 }, uRes: { value: new THREE.Vector2(innerWidth, innerHeight) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uCA, uGrain, uVig; uniform vec2 uRes; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
      void main(){ vec2 d = vUv - 0.5; vec3 c;
        if (uCA > 0.002) { vec2 o = d * uCA * 0.018; c = vec3(texture2D(tDiffuse, vUv + o).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - o).b); }
        else c = texture2D(tDiffuse, vUv).rgb;
        float v = smoothstep(0.95, 0.25, length(d*vec2(1.0, 0.9))*1.25); c *= mix(1.0, v, uVig);
        float g = h(vUv*uRes + fract(uTime*7.13)*100.) - 0.5; float l = dot(c, vec3(0.299,0.587,0.114));
        c += g * uGrain * (1.0 - l*0.7);
        gl_FragColor = vec4(c, 1.0); }`
  });
  composer.addPass(finalPass);

  /* ======================= SOUND ======================= */
  let audio = null;
  function setupAudio() {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    const ctx = new AC(); const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    const an = ctx.createAnalyser(); an.fftSize = 256; master.connect(an);
    const len = ctx.sampleRate * 3; const nb = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = nb.getChannelData(ch); let last = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; } }
    const room = ctx.createBufferSource(); room.buffer = nb; room.loop = true; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const roomG = ctx.createGain(); roomG.gain.value = 0.22; room.connect(lp).connect(roomG).connect(master); room.start();
    const irLen = ctx.sampleRate * 3.2; const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3.2); }
    const conv = ctx.createConvolver(); conv.buffer = ir; const wet = ctx.createGain(); wet.gain.value = 0.55; conv.connect(wet).connect(master);
    const delay = ctx.createDelay(2); delay.delayTime.value = 0.42; const fb = ctx.createGain(); fb.gain.value = 0.42; const dl = ctx.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 1800;
    delay.connect(dl).connect(fb).connect(delay); dl.connect(conv); dl.connect(master);
    const crackle = () => { if (!audio || !ui.state.soundOn) return; const b = ctx.createBufferSource(); const n = ctx.createBuffer(1, 800, ctx.sampleRate); const d = n.getChannelData(0); for (let i = 0; i < 800; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / 800, 6); b.buffer = n; const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500 + Math.random() * 2500; const g = ctx.createGain(); g.gain.value = 0.05 * audio.fireK * Math.random(); b.connect(bp).connect(g).connect(master); b.connect(bp); g.connect(conv); b.start(); };
    setInterval(() => { if (Math.random() < 0.6) crackle(); }, 140);
    const ping = (freq = 392, vol = 0.12) => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq; const g = ctx.createGain(); const t0 = ctx.currentTime; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0008, t0 + 1.6); o.connect(g); g.connect(delay); g.connect(conv); g.connect(master); o.start(t0); o.stop(t0 + 1.7); };
    return { ctx, master, an, ping, fireK: 1, buf: new Uint8Array(an.fftSize) };
  }
  const PENTA = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3];
  function setSound(on) {
    if (on && !audio) audio = setupAudio(); if (!audio) return;
    if (on) audio.ctx.resume();
    audio.master.gain.cancelScheduledValues(audio.ctx.currentTime); audio.master.gain.linearRampToValueAtTime(on ? 0.9 : 0, audio.ctx.currentTime + 0.6);
  }

  /* ======================= INTERACTION ======================= */
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2(); const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
  addEventListener('pointermove', e => { mouse.x = e.clientX / innerWidth * 2 - 1; mouse.y = e.clientY / innerHeight * 2 - 1; }, { passive: true });
  addEventListener('pointerdown', e => {
    if (e.target.closest('a,button,summary,input,.lang,table,details')) return;
    if (tS < 3.7 || tS > 5.3) return;
    ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(pool, false)[0];
    if (hit) { addRipple(hit.point.x, hit.point.z, 1.2); if (audio && ui.state.soundOn) audio.ping(PENTA[(Math.random() * PENTA.length) | 0], 0.14); }
  }, { passive: true });

  /* ======================= LAYOUT / RESIZE ======================= */
  let portrait = innerWidth / innerHeight < 0.9;
  buildRods(portrait); buildCards(portrait);
  function onResize() {
    const w = innerWidth, h = innerHeight; renderer.setSize(w, h); composer.setSize(w, h); bloom.setSize(w / (LOW ? 2 : 1), h / (LOW ? 2 : 1));
    finalPass.uniforms.uRes.value.set(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    const np = w / h < 0.9; if (np !== portrait) { portrait = np; buildRods(portrait); buildCards(portrait); }
    needs = true;
  }
  addEventListener('resize', onResize);

  /* ======================= UPDATE ======================= */
  const keysCL = [ // carry light: position, intensity, colour
    { t: 0, p: [FIRE.x, 1.1, FIRE.z], i: 40, c: [1, 0.58, 0.28] },
    { t: 0.74, p: [FIRE.x, 1.1, FIRE.z], i: 40, c: [1, 0.58, 0.28] },
    { t: 0.95, p: [SX(-40) + 1.4, 6.4, -34], i: 70, c: [1, 0.66, 0.36] },
    ...G.map((g, i) => ({ t: 1.158 + i * 0.21, p: [SX(g) + 1.3, 6.6, g + 5.0], i: 70, c: [1, 0.66, 0.36] })),
    { t: 1.95, p: [LEDGE_X - 2.0, 2.2, LEDGE_Z + 2], i: 3, c: [1, 0.62, 0.32] },
    { t: 2.667, p: [HANDS_X + 2.4, 2.4, HANDS_Z + 1.8], i: 110, c: [1, 0.7, 0.42] },
    { t: 2.96, p: [titleC.x, 1.0, -140], i: 8, c: [1, 0.78, 0.5] },
    { t: 3.8, p: [titleC.x, 1.0, -140], i: 8, c: [1, 0.78, 0.5] },
    { t: 4.0, p: [POOLC.x + 0.5, 2.6, POOL.z - 4.2], i: 22, c: [1, 0.66, 0.4] },
    { t: 4.8, p: [POOLC.x + 0.5, 2.6, POOL.z - 4.2], i: 22, c: [1, 0.66, 0.4] },
    { t: 5.0, p: [px(-200), 3, -200], i: 0, c: [1, 0.66, 0.4] },
    { t: 5.88, p: [C_CREW.x, 1.1, C_CREW.z], i: 0, c: [1, 0.58, 0.28] },
    { t: 6.0, p: [C_CREW.x, 1.1, C_CREW.z], i: 60, c: [1, 0.58, 0.28] },
    { t: 6.9, p: [C_CREW.x, 1.1, C_CREW.z], i: 60, c: [1, 0.58, 0.28] },
    { t: 7.4, p: [C_CREW.x, 1.1, C_CREW.z], i: 0, c: [1, 0.58, 0.28] },
    { t: 11, p: [C_CREW.x, 1.1, C_CREW.z], i: 0, c: [1, 0.58, 0.28] },
  ];
  function sampleCL(t) { let i = 0; while (i < keysCL.length - 2 && t > keysCL[i + 1].t) i++; const a = keysCL[i], b = keysCL[i + 1]; let u = clamp((t - a.t) / (b.t - a.t)); u = u * u * (3 - 2 * u); return { p: a.p.map((v, j) => lerp(v, b.p[j], u)), i: lerp(a.i, b.i, u), c: a.c.map((v, j) => lerp(v, b.c[j], u)) }; }

  if (SHOT || reduced) { [[0.4, 0.3, -1.6], [-0.6, -0.2, -3.4], [0.1, 0.5, -5.6]].forEach(([dx, dz, ts], i) => ripples[i].set(POOLC.x + dx, POOL.z + dz, ts + (reduced ? 3.3 : 0), 1.1)); ripI = 3; }
  let tS = ui.computeT().t, time = reduced ? 3.3 : 0, last = performance.now(), needs = true, lastT = -1, vel = 0;
  const fogDay = new THREE.Color(1.6, 1.3, 1.0), fogCave = new THREE.Color(0x070605);
  let lastLangDrawn = ui.state.lang; let autoRip = 0;

  function update(t, dt) {
    shared.uTime.value = time; finalPass.uniforms.uTime.value = time;
    // camera
    const c = sampleKeys(t, portrait);
    mouse.sx += (mouse.x - mouse.sx) * Math.min(1, dt * 2.5); mouse.sy += (mouse.y - mouse.sy) * Math.min(1, dt * 2.5);
    const par = (coarse || reduced) ? 0 : 1;
    camera.position.set(c.p[0] + mouse.sx * 0.18 * par, c.p[1] - mouse.sy * 0.1 * par, c.p[2]);
    camera.fov = portrait ? (sampleKeys(t, true), (() => { let i = 0; while (i < K.length - 2 && t > K[i + 1].t) i++; const a = K[i], b = K[i + 1]; let u = clamp((t - a.t) / (b.t - a.t)); u = u * u * (3 - 2 * u); return lerp(a.pfov || a.fov * 1.35, b.pfov || b.fov * 1.35, u); })()) : c.fov;
    camera.lookAt(c.l[0], c.l[1], c.l[2]);
    const w = innerWidth, h = innerHeight;
    const fx = portrait ? 0.5 + (c.fx - 0.5) * 0 : c.fx; const fy = c.fy;
    camera.setViewOffset(w, h, (0.5 - fx) * w, (0.5 - fy) * h, w, h);
    camera.updateProjectionMatrix();

    // hero: shadow name
    const k = smooth(0.06, 0.44, t);
    const flick = reduced ? 0 : (Math.sin(time * 9.1) * 0.5 + Math.sin(time * 23.7 + 1.3) * 0.3 + Math.sin(time * 3.3) * 0.4);
    const lpos = LSTAR.clone().add(V3(-0.5, -0.7, 2.4).multiplyScalar(Math.pow(1 - k, 1.3)));
    if (!reduced) lpos.add(V3(Math.sin(time * 7.3) * 0.012, Math.sin(time * 5.1) * 0.015, Math.cos(time * 6.7) * 0.012));
    fireSpot.position.copy(lpos); fireSpot.target.position.set(HERO_WX, portrait ? 4.5 : 4.2, NAME_Z);
    const heroOn = 1 - smooth(0.78, 1.0, t);
    fireSpot.intensity = (520 + 260 * k) * (1 + flick * 0.05) * heroOn;
    if (t < 1.6) updateRods(k);
    if (t < 1.6 && !reduced) renderer.shadowMap.needsUpdate = true;
    rods.visible = threads.visible = t < 1.6;
    heroFire.g.visible = t < 2.0; crewFire.g.visible = t > 5.6 && t < 7.8;
    heroFire.flames.forEach(f => f.material.uniforms.uGain.value = 0.75 + 0.35 * k + flick * 0.05);
    crewFire.flames.forEach(f => f.material.uniforms.uGain.value = 0.55 + flick * 0.05);
    heroFire.flames[0].scale.y = 1.55 * (0.8 + 0.3 * k);

    // carry light
    const cl = sampleCL(t); carry.position.set(...cl.p); carry.color.setRGB(...cl.c); carry.intensity = cl.i * (1 + flick * 0.06);
    // slit / books
    const bookK = smooth(1.85, 2.05, t) * (1 - smooth(2.9, 3.15, t));
    slit.intensity = 260 * bookK; slitBeam.visible = bookK > 0.01; slitBeam.material.uniforms.uK.value = bookK; skyPatch.visible = t > 1.7 && t < 3.3;
    // terrible
    const ttK = smooth(2.85, 3.05, t) * (1 - smooth(4.05, 4.25, t));
    cards.visible = t > 2.7 && t < 4.4; projBeam.visible = cards.visible; projBeam.material.uniforms.uK.value = 0.5 * ttK;
    cards.material.uniforms.uProg.value = reduced ? (t > 3.05 ? 1.2 : 0) : clamp((t - 3.0) / 0.26) * 1.2;
    cards.material.uniforms.uFogD.value = scene.fog.density;
    const lk = smooth(3.42, 3.62, t) * (1 - smooth(4.0, 4.2, t)); routeLabels.forEach(s => { s.material.opacity = lk; s.visible = lk > 0.01; });
    // radio
    const rK = smooth(3.9, 4.08, t) * (1 - smooth(5.0, 5.25, t));
    pool.visible = wave.visible = t > 3.7 && t < 5.4; waveMat.uniforms.uVis.value = rK;
    if (rK > 0.5 && !reduced) { autoRip -= dt; if (autoRip <= 0) { autoRip = 3.4; addRipple(POOLC.x + (Math.random() - .5) * 0.6, POOL.z + (Math.random() - .5) * 0.6, 0.8); if (audio && ui.state.soundOn) audio.ping(PENTA[(Math.random() * 4) | 0] / 2, 0.06); } }
    if (audio && ui.state.soundOn && rK > 0.1) { audio.an.getByteTimeDomainData(audio.buf); for (let i = 0; i < WAVE_N; i++) waveData[i] = (audio.buf[i * 2] - 128) / 128 * 3.0; waveMat.uniforms.uAudOn.value = 0.6; } else waveMat.uniforms.uAudOn.value = 0;
    if (audio) audio.fireK = Math.max(heroOn, smooth(5.9, 6.1, t) * (1 - smooth(7.0, 7.4, t)));
    // cheap lights
    const CL = shared.uCLPos.value, CC = shared.uCLCol.value;
    const crewK = smooth(5.7, 6.0, t) * (1 - smooth(7.3, 7.8, t));
    CL[0].set(C_CREW.x, 1.0, C_CREW.z); CC[0].set(1, 0.5, 0.2).multiplyScalar(26 * crewK * (1 + flick * 0.08));
    chamberLights.forEach((ch, i) => { const kk = smooth(4.85, 5.1, t) * (1 - smooth(6.1, 6.4, t)); CL[i + 1].copy(ch.pos); CC[i + 1].copy(ch.col).multiplyScalar(18 * kk); ch.decal.material.opacity = kk; });
    CL[6].set(POOLC.x, 1.75, POOL.z); CC[6].set(1, 0.6, 0.3).multiplyScalar(10 * rK);
    CL[7].set(titleC.x, TT.y, TT.z + 1.5); CC[7].set(1, 0.82, 0.55).multiplyScalar(6 * ttK);
    // volumetric in-scatter
    const SP = shared.uScPos.value, SCc = shared.uScCol.value;
    SP[0].copy(lpos); SCc[0].set(1, 0.5, 0.2).multiplyScalar(0.022 * heroOn * (1 + flick * 0.1));
    SP[1].set(...cl.p); SCc[1].set(...cl.c).multiplyScalar(cl.i * 0.00016);
    SP[2].set(C_CREW.x, 1.2, C_CREW.z); SCc[2].set(1, 0.5, 0.2).multiplyScalar(0.018 * crewK);
    // dust follows the active beam
    if (bookK > 0.05) { dust.position.set(LEDGE_X - 1.4, 0, LEDGE_Z + 0.2); dust.material.uniforms.uK.value = bookK; }
    else if (ttK > 0.05) { dust.position.set(titleC.x, 0.5, -138); dust.scale.set(2.2, 1, 3.2); dust.material.uniforms.uK.value = ttK * 0.6; }
    else { dust.position.set(FIRE.x - 2, 0, FIRE.z); dust.scale.set(2.5, 1, 2.5); dust.material.uniforms.uK.value = heroOn * 0.5; }
    if (bookK > 0.05) dust.scale.set(0.7, 1, 0.9);
    chamberObjs.forEach(o => o.visible = t > 4.5 && t < 6.6);
    // exposure → daylight
    const out = smooth(7.25, 8.0, t); const inSun = t >= 8.0;
    renderer.toneMappingExposure = inSun ? 1.05 : 1.0 + out * 1.6;
    scene.fog.color.copy(fogCave).lerp(fogDay, inSun ? 0.0 : out);
    scene.fog.density = inSun ? 0.012 : lerp(0.034, 0.02, out) - 0.006 * smooth(5.8, 6.2, t) * (1 - out);
    hemi.intensity = 0.3 + (inSun ? 1.2 : out * 2.2); hemi.color.setRGB(inSun ? 1 : 0.23 + out, inSun ? 0.75 : 0.16 + out * 0.8, inSun ? 0.6 : 0.12 + out * 0.6);
    sun.intensity = inSun ? 2.4 : out * 3.0;
    outside.forEach(o => o.visible = t > 6.9);
    sky.material.uniforms.uK.value = inSun ? 1 : 1 + out * 2;
    // chromatic aberration only during fast transitions
    finalPass.uniforms.uCA.value = reduced ? 0 : clamp(Math.abs(vel) * 1.8 - 0.05, 0, 1);
    finalPass.uniforms.uGrain.value = inSun ? 0.035 : 0.06;
    if (ui.state.lang !== lastLangDrawn) { lastLangDrawn = ui.state.lang; drawStoneLabels(); }
  }

  let running = true, raf = 0;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) { last = performance.now(); loop(); } else cancelAnimationFrame(raf); });
  addEventListener('scroll', () => { needs = true; }, { passive: true });

  function frame(dt) {
    const tgt = ui.computeT().t;
    const prev = tS;
    if (SHOT || reduced) tS = tgt; else tS += (tgt - tS) * (1 - Math.exp(-dt * 3.2));
    vel = (tS - prev) / Math.max(dt, 1e-3) * 0.12;
    const { covered } = ui.dayMode();
    stage.style.opacity = covered ? '0' : '1';
    if (covered) return false;
    if (!reduced) time += dt;
    update(tS, dt);
    composer.render(dt);
    return true;
  }
  function loop() {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    const now = performance.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (reduced && !needs && Math.abs(ui.computeT().t - lastT) < 1e-5) return;
    needs = false; lastT = ui.computeT().t; frame(dt);
  }
  // first render (synchronous), then loop
  update(tS, 0.016);
  renderer.shadowMap.needsUpdate = true; composer.render(0.016);
  if (!SHOT) loop();

  return {
    setSound,
    renderAt(t) { tS = t; renderer.shadowMap.needsUpdate = true; update(t, 0.016); composer.render(0.016); },
    ripple(x, z) { addRipple(x ?? POOLC.x, z ?? POOL.z, 1.2); },
    info: () => ({ rods: rodData.length, tier: LOW ? 'low' : 'high', calls: renderer.info.render.calls, tris: renderer.info.render.triangles }),
  };
}
