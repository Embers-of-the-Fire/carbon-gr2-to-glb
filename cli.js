#!/usr/bin/env node
/**
 * gr2-to-glb — convert an EVE ship GR2 + DDS textures to a self-contained GLB.
 *
 * Usage:
 *   node cli.js <input.gr2> [-o output.glb] [--textures <dir>] [--lod <n>]
 *               [--flip-v] [--no-flip-green] [--no-convert]
 *               [--data-black <path> --dna <h:f:r>]
 *               [--texture-format png|webp]
 *   node cli.js --batch-resolve <manifest.json> [--resolve-out <file>]
 *   node cli.js --batch <manifest.json>
 *
 * Single-file mode: textures are located by stem (<stem>_*.dds) next to the
 * input (or in --textures), or by the authoritative res:/ paths when
 * --data-black + --dna are given. Gzip-wrapped files are decompressed
 * automatically.
 *
 * Batch mode: see src/batch.js for the manifest schema. The resolve phase
 * reports the res:/ paths each DNA needs; the caller stages those files and
 * the convert phase runs fully offline.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { convertShip } from "./src/convert.js";
import { runBatch, runBatchResolve } from "./src/batch.js";
import { applySharpConcurrencyFromEnv } from "./src/bake.js";

applySharpConcurrencyFromEnv();

function usage(code)
{
    console.log(`Usage: node cli.js <input.gr2> [-o output.glb] [options]
       node cli.js --batch-resolve <manifest.json> [--resolve-out <file>]
       node cli.js --batch <manifest.json>

Options:
  -o, --output <path>   Output .glb path (default: <input>.glb)
  --textures <dir>      Directory with the <stem>_*.dds set (default: input dir)
  --stem <name>         Texture stem override (default: input basename)
  --lod <n>             LOD mesh index, 0 = full detail (default: 0)
  --flip-v              Flip UV V coordinates (default: off; EVE UVs match glTF)
  --no-flip-green       Keep DirectX normal-map green channel (default: flip)
  --no-convert          Skip left-handed to right-handed coordinate conversion
  --tint <r,g,b>        Faction color multiplier for the grayscale albedo,
                        0..1 per channel (e.g. Amarr gold: 0.85,0.65,0.35)
  --data-black <path>   SOF catalog (data.black, gzip or raw)
  --dna <h:f:r>         SOF DNA string, e.g. af1_t1:amarrbase:amarr.
                        With --data-black this pulls real faction colors,
                        glow color/strength and texture paths from the catalog.
  --no-boost            Keep data-faithful faction color brightness (default).
  --boost               Normalize faction-color brightness to the raw albedo
                        luminance (for viewers with weak lighting)
  --invert-roughness    Treat the _r map as smoothness (roughness = 1 - value)
  --texture-format <f>  Embedded texture format: png (default) or webp
                        (EXT_texture_webp; requires WebP-capable loaders).
                        WebP encodes per-slot: lossless color/emissive maps,
                        q95 (+smart subsample on normals) for data maps.
  --geometry-compression <c>
                        Geometry compression: meshopt (EXT_meshopt_compression;
                        requires a meshopt-capable loader)
  --batch <file>        Convert-phase batch manifest (see src/batch.js)
  --batch-resolve <f>   Resolve-phase batch manifest; prints required res:/ paths
  --resolve-out <file>  Write --batch-resolve output here instead of stdout
  -h, --help            Show this help`);
    process.exit(code);
}

function parseArgs(argv)
{
    const args = { input: null, output: null, textures: null, stem: null, lod: 0, flipV: false, flipGreen: true, convert: true, tint: null, dataBlack: null, dna: null, boost: false, invertRoughness: false, textureFormat: "png", geometryCompression: null, batch: null, batchResolve: null, resolveOut: null };
    for (let i = 0; i < argv.length; i++)
    {
        const arg = argv[i];
        switch (arg)
        {
            case "-h": case "--help": usage(0); break;
            case "-o": case "--output": args.output = argv[++i]; break;
            case "--textures": args.textures = argv[++i]; break;
            case "--stem": args.stem = argv[++i]; break;
            case "--lod": args.lod = Number(argv[++i]); break;
            case "--flip-v": args.flipV = true; break;
            case "--no-flip-green": args.flipGreen = false; break;
            case "--no-convert": args.convert = false; break;
            case "--tint":
                args.tint = String(argv[++i]).split(",").map(Number);
                if (args.tint.length !== 3 || args.tint.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
                {
                    console.error("--tint expects r,g,b with each channel in 0..1");
                    process.exit(1);
                }
                break;
            case "--data-black": args.dataBlack = argv[++i]; break;
            case "--dna": args.dna = argv[++i]; break;
            case "--boost": args.boost = true; break;
            case "--invert-roughness": args.invertRoughness = true; break;
            case "--texture-format": args.textureFormat = argv[++i]; break;
            case "--geometry-compression": args.geometryCompression = argv[++i]; break;
            case "--batch": args.batch = argv[++i]; break;
            case "--batch-resolve": args.batchResolve = argv[++i]; break;
            case "--resolve-out": args.resolveOut = argv[++i]; break;
            default:
                if (arg.startsWith("-")) { console.error(`unknown option: ${arg}`); usage(1); }
                if (args.input) { console.error("only one input file is supported"); usage(1); }
                args.input = arg;
        }
    }
    if (args.batch && args.batchResolve)
    {
        console.error("--batch and --batch-resolve are mutually exclusive");
        process.exit(1);
    }
    if (args.batch || args.batchResolve) return args;
    if (!args.input) usage(1);
    if ((args.dataBlack && !args.dna) || (!args.dataBlack && args.dna))
    {
        console.error("--data-black and --dna must be given together");
        process.exit(1);
    }
    if (!Number.isInteger(args.lod) || args.lod < 0) { console.error("--lod must be a non-negative integer"); process.exit(1); }
    if (![ "png", "webp" ].includes(args.textureFormat)) { console.error("--texture-format must be png or webp"); process.exit(1); }
    if (args.geometryCompression !== null && args.geometryCompression !== "meshopt") { console.error("--geometry-compression must be meshopt"); process.exit(1); }
    return args;
}

async function runBatchResolveCli(path, resolveOut)
{
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const resolved = await runBatchResolve(manifest);
    const failures = resolved.jobs.filter((job) => job.error);
    const json = JSON.stringify(resolved, null, 2);
    if (resolveOut)
    {
        await writeFile(resolveOut, json);
        console.error(`resolved ${resolved.jobs.length - failures.length}/${resolved.jobs.length} jobs -> ${resolveOut}`);
    }
    else
    {
        console.log(json);
    }
    for (const job of failures) console.error(`error: job ${job.id}: ${job.error}`);
    if (failures.length) process.exitCode = 1;
}

async function runBatchCli(path)
{
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const { results } = await runBatch(manifest, {
        onProgress: (job, stats) =>
        {
            if (stats)
            {
                console.error(`[${job.id}] ${stats.mesh}: ${stats.triangles} triangles, ${stats.images.length} textures`);
            }
            else
            {
                console.error(`[${job.id}] failed`);
            }
        }
    });
    const failures = results.filter((result) => result.error);
    for (const result of failures) console.error(`error: job ${result.id}: ${result.error}`);
    console.error(`converted ${results.length - failures.length}/${results.length} jobs`);
    if (failures.length) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));

if (args.batchResolve)
{
    await runBatchResolveCli(resolve(args.batchResolve), args.resolveOut ? resolve(args.resolveOut) : null);
}
else if (args.batch)
{
    await runBatchCli(resolve(args.batch));
}
else
{
    const input = resolve(args.input);
    const inputDir = dirname(input);
    const stem = args.stem ?? basename(input, extname(input));
    const output = resolve(args.output ?? join(inputDir, `${stem}.glb`));

    const gr2Bytes = new Uint8Array(await readFile(input));

    const { glb, stats } = await convertShip(gr2Bytes, {
        textureDir: args.textures ? resolve(args.textures) : inputDir,
        stem,
        lod: args.lod,
        convertCoordinates: args.convert,
        flipV: args.flipV,
        flipGreen: args.flipGreen,
        tint: args.tint,
        boost: args.boost,
        invertRoughness: args.invertRoughness,
        textureFormat: { format: args.textureFormat },
        geometryCompression: args.geometryCompression ?? undefined,
        sof: args.dataBlack ? { dataBlack: resolve(args.dataBlack), dna: args.dna } : undefined
    });

    await writeFile(output, glb);

    console.log(`${stats.mesh} (LOD ${stats.lod} of ${stats.lodsAvailable}): ${stats.vertices} vertices, ${stats.triangles} triangles, ${stats.primitives} primitives`);
    if (stats.dna) console.log(`dna: ${stats.dna} (hull shader: ${stats.shader})`);
    console.log(`materials: ${stats.materials.join(", ")}`);
    console.log(`textures: ${stats.images.length ? stats.images.join(", ") : "none found"}`);
    for (const skipped of stats.skippedTextures) console.log(`skipped: ${skipped}`);
    console.log(`wrote ${output} (${(glb.byteLength / 1024 / 1024).toFixed(2)} MiB)`);
}
