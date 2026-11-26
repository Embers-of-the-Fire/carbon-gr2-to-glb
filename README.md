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
| `--flip-v` | Flip UV V coordinates |
| `--flip-green` | Flip normal-map green for a documented per-hull exception |
| `--no-flip-green` | Preserve source green with authored tangent frames (default) |
| `--no-convert` | Skip left-handed → right-handed coordinate conversion |
| `--texture-format png\|webp\|none` | Embedded texture format, or the factor-only lightweight variant |
| `--geometry-compression meshopt` | Geometry compression via `EXT_meshopt_compression` |

### Input files

All inputs may be gzip-wrapped (as found in the client's resource cache); they are detected and decompressed automatically.

| File | Role |
|---|---|
| `<stem>.gr2` | Ship mesh (LOD0 + lower LODs as separate meshes) |
| `<stem>_a.dds` | Albedo (BC7 RGBA, grayscale — tinted by faction colors) |
| `<stem>_n.dds` | Normal map XY (BC5; source bias retained and Z reconstructed) |
| `<stem>_r.dds` | Reflectivity (BC4) → gloss-modulated roughness |
| `<stem>_m.dds` | Four-band material-region selector (BC4), **not metallic** |
| `<stem>_g.dds` | Glow (BC4) → emissive, tinted by the area's SOF glow/heat color |
| `<stem>_d.dds` | Dirt mask — drives the documented fixed dust-layer approximation |
| `<stem>_p3.dds` | Independent paint mask (BC4), scaled by SOF `GeneralData.x` |
| `data.black` | SOF catalog: faction materials, glow colors, texture paths |

### DNA strings

The DNA identifies a ship variant: `hull:faction:race`. For t1 ships the hull name is the model file stem, e.g. `af1_t1:amarrbase:amarr`, `rifter:minmatar:minmatar`. The catalog can be enumerated through the runtime's `EveSOF` API for other hulls/factions.

### Batch mode

For converting many ships against one catalog, batch mode loads `data.black`
once and never touches the network — the caller resolves and stages all asset
bytes:

```sh
# Phase 1: resolve every job's DNA to authoritative res:/ asset paths
node cli.js --batch-resolve manifest.json --resolve-out resolved.json

# (caller stages the reported files locally, then fills in gr2/textures/out)

# Phase 2: convert everything offline
node cli.js --batch manifest.json --stats-out diagnostics.json
```

`--stats-out` persists per-job LOD and area associations, source/output texture
roles and dimensions, normal orientation, missing inputs, static approximations,
and completeness. Incomplete high-quality jobs are errors and never replace an
existing artifact.

Pipelines that shard phase 2 across several concurrent `cli.js --batch`
processes should set `GR2_TO_GLB_SHARP_THREADS=<n>` to cap libvips' thread
pool per process (sharp otherwise defaults to one thread per core in *every*
process, oversubscribing the host). A reasonable value is
`max(1, cores / processes)`.

Manifest schema (see `src/batch.js`):

```jsonc
{
  "dataBlack": "/path/to/data.black",
  "texture": { "format": "webp" },   // optional default; "png" | "webp" | "none"
  "geometry": "meshopt",             // optional default
  "jobs": [
    {
      "id": "587",                                 // opaque caller key
      "dna": "mf4_t1:minmatarbase:minmatar",
      // convert phase only:
      "gr2": "/staged/mf4_t1.gr2",
      "textures": { "res:/dx9/...": "/staged/file.dds" },
      "sof": { "...": "..." },                     // optional: pre-resolved SOF ship from phase 1
      "out": "/out/587.glb"
    }
  ]
}
```

Each resolve-phase job also reports `sof` (the full resolved SOF ship) and
`sofHash` (a sha256 fingerprint of it). Passing a job's `sof` through to the
convert phase converts from exactly those values without re-reading the
catalog; the fingerprint lets callers memoize conversions per DNA (a catalog
change that leaves a DNA's resolved values untouched keeps its `sofHash`).

`texture.format: "none"` skips texture baking entirely and emits the base
(geometry-only) variant: factor-only PBR materials derived from the SOF
material constants (brightness-normalized hull color, glass/heat area looks),
no images.

> **WebP output is an app-internal contract.** `format: "webp"` payloads are
> written as plain `image/webp` image sources without the `EXT_texture_webp`
> extension wiring (the files would otherwise be refused by the EFA viewer,
> which rejects unknown `extensionsRequired` but decodes WebP bytes by
> content). A spec-conformant glTF toolchain may reject these files; use
> `format: "png"` for general-purpose output.

Resolved jobs report full `res:/...` paths, so assets can be staged from a
client cache or a resource index (`resfileindex.txt`) lookup.

### Artifact validation

Validate one artifact or every `.glb` below a generated model directory with the
pinned application's supported feature set:

```sh
node cli.js --validate /path/to/ships --stats-out validation.json
```

Validation independently parses meshopt/quantized geometry, checks finite vertex
data and index bounds, decodes every embedded image, verifies required material
roles and source-area associations, and reports compressed bytes plus estimated
decoded RGBA texture memory. Textures above the application's 2048-pixel import
cap are explicit warnings.

### Skybox mode

Skybox mode bakes a scene skybox (`*_cube.dds`, a BC6H_SF16 2048x2048
cubemap — except y01, the catalog's one LDR outlier, which is BC7 — plus
its `EveSpaceScene` `*_cube.black` descriptor) into a 2048x1024
Radiance `.hdr` equirect plus the metadata the app's flutter_scene viewer
consumes. Like batch mode it never touches the network — the caller stages
all bytes:

```sh
node cli.js --batch-skybox manifest.json --meta-out meta.json
```

Manifest schema (see `src/skybox.js`):

```jsonc
{
  "jobs": [
    {
      "id": "a01",                    // opaque caller key (the skybox id)
      "cube": "/staged/a01_cube_lowdetail.dds",
      "black": "/staged/a01_cube.black", // optional
      "outHdr": "/out/a01.hdr"
    }
  ]
}
```

Per job, the metadata report carries the descriptor scalars
(`nebulaIntensity`, `reflectionIntensity`, `ambientColor`, `tint` — omitted
when the descriptor lacks them), `repairedPixels` (isolated BC6H decode
spikes replaced by the neighborhood mean), and `diffuseSh`: the 9 L2
spherical-harmonic RGB coefficients
(27 floats) projected in flutter_scene's exact convention, so the runtime
never runs the SH quadrature. The equirect orientation undoes the
left-handed → right-handed conversion the ship geometry pipeline applies
(negated Z), so background and model reflections agree.

### Scene metadata mode

The data pipeline extracts preview/fitting `EveSpaceScene` descriptors without
baking any environment assets:

```sh
node cli.js --batch-scene-metadata manifest.json --meta-out metadata.json
```

The manifest is `{ "jobs": [{ "id": "amarr", "black": "/staged/amarr.black" }] }`.
Carbon decodes the binary Black payloads; the JSON report preserves
`nebulaIntensity`, `reflectionIntensity`, `ambientColor`, `envMapResPath`, sun
fields, and `backgroundEffect.resources[name=NebulaMap].resourcePath`. It does
not read cube files or write HDR/protobuf files. The Python pipeline owns
validation, Carbon defaults, item-preview runtime overrides, environment-id
mapping, coordinate conversion, and protobuf assembly.

## What the converter does

1. **Mesh** — identifies `BaseName LOD <threshold>` siblings, deterministically selects the unique unsuffixed full-detail base, validates all buffers, repairs invalid tangent frames, converts left-handed (EVE/DirectX) to right-handed (glTF) coordinates, and carries source-area identity into every primitive.
2. **Textures** — decodes each area's DDS set (BC7/BC5/BC4) on CPU. Four material-region weights are reconstructed from `MaterialMap`; albedo, region colors, dirt, paint, gloss, and Fresnel/F0 are composed in linear space. Output includes base color, reconstructed normals, region-derived roughness, source-F0 (`KHR_materials_specular`), and emissive maps. All full-variant WebP roles are lossless.
3. **Materials** — every visible SOF area receives its own static conversion decision and texture bake. Hull, heat, glass, sails, detail, decal, and additive areas never silently reuse the primary hull. The separate `none` variant remains factor-only and is not presented as equivalent quality.

## Known limitations

- **Environment reflections are not baked** (view-dependent by nature). Much of an EVE hull is metallic, and metal is black without an environment map — use a renderer with image-based lighting, or the model will look dim.
- Carbon's independently lit dust layer is approximated by a fixed diffuse blend; its separate view-dependent response cannot be represented by one static glTF material.
- Heat, sail-detail, additive-effect, and secondary-detail animation is omitted in favor of documented frame-zero/static composites. True additive blending becomes emissive alpha blending.
- Distortion and depth-only areas are omitted explicitly and reported; unsupported opaque shaders use their own factor approximation, never a hull substitute.
- SKINR editing and runtime material/pattern customization are not applied.
- Skinning/animation is not exported; the model is static.

## Development

```sh
pnpm test   # node --test
```

Layout:

```
cli.js          command-line entry (single-file + batch modes)
index.js        programmatic entry (barrel)
src/convert.js  orchestration (GR2 + textures + SOF -> GLB)
src/geometry.js shared-mesh -> per-primitive buffers (normals, UVs, LH->RH)
src/bake.js     DDS decode + per-texel PBR baking + PNG/WebP encode
src/glb.js      minimal glTF 2.0 binary writer (EXT_texture_webp aware)
src/compress.js optional EXT_meshopt_compression post-pass (gltf-transform)
src/sof.js      data.black catalog queries (colors, glow, texture paths)
src/batch.js    two-phase batch driver (resolve / convert)
src/skybox.js   skybox bake (BC6H cube -> HDR equirect + SH + black scalars)
src/scene-metadata.js metadata-only Carbon Black scene extraction
```

## License

MIT. EVE Online game assets are property of CCP Games; this tool only converts data you already possess.
