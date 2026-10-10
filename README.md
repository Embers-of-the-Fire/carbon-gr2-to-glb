# carbon-gr2-to-glb

Convert EVE Online ship models into self-contained [glTF binary](https://www.khronos.org/gltf/) (`.glb`) files with baked PBR materials.

Reads the game's own data with [`@carbonenginejs/runtime`](https://www.npmjs.com/package/@carbonenginejs/runtime) — GR2 (Granny) meshes, DDS textures, and the SOF catalog (`data.black`) — and emits a standard 3D model that opens in Blender, Windows 3D Viewer, Sketchfab, `<model-viewer>`, or any glTF-compatible renderer. No GPU, browser, WebGPU or WebGL required; everything runs on the CPU in Node.js.

## Requirements

- Node.js >= 18
- pnpm
- Game files extracted from the EVE client (see below)

## Install

```sh
pnpm install
```

## Usage

```sh
node cli.js <input.gr2> [options]
```

Minimal (textures resolved by naming convention next to the input):

```sh
node cli.js /path/to/af1_t1.gr2 -o ship.glb
```

With the SOF catalog (recommended — real faction colors, glow, texture paths):

```sh
node cli.js /path/to/af1_t1.gr2 \
  --data-black /path/to/data.black \
  --dna af1_t1:amarrbase:amarr \
  -o ship.glb
```

### Options

| Option | Description |
|---|---|
| `-o, --output <path>` | Output `.glb` path (default: `<input>.glb`) |
| `--textures <dir>` | Directory holding the DDS set (default: input directory) |
| `--stem <name>` | Texture stem override (default: input basename) |
| `--lod <n>` | LOD mesh index, 0 = full detail (default: 0) |
| `--data-black <path>` | SOF catalog (`data.black`, gzip or raw) |
| `--dna <hull:faction:race>` | SOF DNA, e.g. `af1_t1:amarrbase:amarr` (requires `--data-black`) |
| `--tint <r,g,b>` | Manual albedo tint 0..1 per channel (ignored when SOF provides colors) |
| `--boost` | Normalize faction-color brightness to the raw albedo luminance |
| `--invert-roughness` | Treat the `_r` map as smoothness (`roughness = 1 - value`) |
| `--flip-v` | Flip UV V coordinates |
| `--no-flip-green` | Keep DirectX normal-map green channel |
| `--no-convert` | Skip left-handed → right-handed coordinate conversion |

### Input files

All inputs may be gzip-wrapped (as found in the client's resource cache); they are detected and decompressed automatically.

| File | Role |
|---|---|
| `<stem>.gr2` | Ship mesh (LOD0 + lower LODs as separate meshes) |
| `<stem>_a.dds` | Albedo (BC7 RGBA, grayscale — tinted by faction colors) |
| `<stem>_n.dds` | Normal map XY (BC5; Z reconstructed, green flipped to glTF convention) |
| `<stem>_r.dds` | Roughness (BC4) → metallicRoughness G channel |
| `<stem>_m.dds` | Metallic (BC4) → metallicRoughness B channel |
| `<stem>_g.dds` | Glow (BC4) → emissive, tinted by SOF `GeneralGlowColor` |
| `<stem>_d.dds` | Dirt — currently skipped (needs the shader's blend math) |
| `<stem>_p3.dds` | Paint mask (BC4) — blends material 1 ↔ material 3 colors |
| `data.black` | SOF catalog: faction materials, glow colors, texture paths |

### DNA strings

The DNA identifies a ship variant: `hull:faction:race`. For t1 ships the hull name is the model file stem, e.g. `af1_t1:amarrbase:amarr`, `rifter:minmatar:minmatar`. The catalog can be enumerated through the runtime's `EveSOF` API for other hulls/factions.

## What the converter does

1. **Mesh** — reads the GR2 with the runtime's format readers, takes LOD0, unpacks normals from EVE's packed tangent frames, converts left-handed (EVE/DirectX) to right-handed (glTF) coordinates, and emits one glTF primitive per mesh area.
2. **Textures** — decodes the DDS set (BC7/BC5/BC4) on CPU and bakes standard glTF PBR maps: base color (albedo × faction material colors through the paint mask), normal (Z reconstructed), metallic-roughness (channel-repacked), emissive (glow, with `KHR_materials_emissive_strength`). All maps share EVE's single UV space, so baking is per-texel compositing — nothing is rasterized.
3. **Materials** — data-faithful by default: every color comes from the game files or SOF catalog. Opinionated adjustments (`--boost`, `--invert-roughness`, `--tint`) are opt-in flags.

## Known limitations

- **Environment reflections are not baked** (view-dependent by nature). Much of an EVE hull is metallic, and metal is black without an environment map — use a renderer with image-based lighting, or the model will look dim.
- Dirt and dust-blend maps are skipped; the exact `quadv5` shader blend math is not reproduced.
- SKIN/pattern layers are not applied.
- Non-hull area shaders (glass, heat, sails, decals) fall back to the hull material; distortion areas are dropped.
- Skinning/animation is not exported; the model is static.

## Development

```sh
pnpm test   # node --test
```

Layout:

```
cli.js          command-line entry
src/convert.js  orchestration (GR2 + textures + SOF -> GLB)
src/geometry.js shared-mesh -> per-primitive buffers (normals, UVs, LH->RH)
src/bake.js     DDS decode + per-texel PBR baking + PNG encode
src/glb.js      minimal glTF 2.0 binary writer
src/sof.js      data.black catalog queries (colors, glow, texture paths)
```

## License

MIT. EVE Online game assets are property of CCP Games; this tool only converts data you already possess.
