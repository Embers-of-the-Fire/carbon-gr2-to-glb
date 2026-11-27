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
 *   node cli.js --batch-skybox <manifest.json> [--meta-out <file>]
 *   node cli.js --batch-scene-metadata <manifest.json> [--meta-out <file>]
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

import { lstat, readFile, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { convertShip } from "./src/convert.js";
import { runBatch, runBatchResolve } from "./src/batch.js";
import { runBatchSkybox } from "./src/skybox.js";
import { runBatchSceneMetadata } from "./src/scene-metadata.js";
import { applySharpConcurrencyFromEnv } from "./src/bake.js";
import { validateGlb } from "./src/validate.js";

applySharpConcurrencyFromEnv();

function usage(code)
{
    console.log(`Usage: node cli.js <input.gr2> [-o output.glb] [options]
       node cli.js --batch-resolve <manifest.json> [--resolve-out <file>]
       node cli.js --batch <manifest.json>
       node cli.js --batch-skybox <manifest.json> [--meta-out <file>]
       node cli.js --batch-scene-metadata <manifest.json> [--meta-out <file>]
       node cli.js --validate <model.glb|directory> [--stats-out <file>]

Options:
  -o, --output <path>   Output .glb path (default: <input>.glb)
  --textures <dir>      Directory with the <stem>_*.dds set (default: input dir)
  --stem <name>         Texture stem override (default: input basename)
  --lod <n>             LOD rank, 0 = unsuffixed base; higher ranks follow
                        descending thresholds (default: 0)
  --flip-v              Flip UV V coordinates (default: off; EVE UVs match glTF)
  --flip-green          Flip normal-map green for a documented source exception
  --no-flip-green       Preserve source green with authored tangents (default)
  --no-convert          Skip left-handed to right-handed coordinate conversion
  --tint <r,g,b>        Faction color multiplier for the grayscale albedo,
                        0..1 per channel (e.g. Amarr gold: 0.85,0.65,0.35)
  --data-black <path>   SOF catalog (data.black, gzip or raw)
  --dna <h:f:r>         SOF DNA string, e.g. af1_t1:amarrbase:amarr.
                        With --data-black this pulls real faction colors,
                        glow color/strength and texture paths from the catalog.
  --texture-format <f>  Embedded texture format: png (default), lossless webp,
                        or none for the explicit factor-only lightweight variant.
  --geometry-compression <c>
                        Geometry compression: meshopt (EXT_meshopt_compression;
                        requires a meshopt-capable loader)
  --batch <file>        Convert-phase batch manifest (see src/batch.js)
  --batch-resolve <f>   Resolve-phase batch manifest; prints required res:/ paths
  --batch-skybox <f>    Skybox bake manifest (see src/skybox.js); writes .hdr
                        equirects and reports sidecar fields as JSON
  --batch-scene-metadata <f>
                        Metadata-only Black extraction manifest (see
                        src/scene-metadata.js); writes no environment assets
  --meta-out <file>     Write batch skybox/scene metadata here instead of stdout
  --resolve-out <file>  Write --batch-resolve output here instead of stdout
  --stats-out <file>    Write --batch conversion or --validate diagnostics as JSON
  --validate <path>     Independently parse and validate a GLB or directory tree
  --variant <full|base> Variant expected by --validate (default: full)
  -h, --help            Show this help`);
    process.exit(code);
}

function parseArgs(argv)
{
    const args = { input: null, output: null, textures: null, stem: null, lod: 0, flipV: false, flipGreen: false, convert: true, tint: null, dataBlack: null, dna: null, textureFormat: "png", geometryCompression: null, batch: null, batchResolve: null, resolveOut: null, statsOut: null, validate: null, validateVariant: "full", batchSkybox: null, batchSceneMetadata: null, metaOut: null };
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
            case "--flip-green": args.flipGreen = true; break;
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
            case "--texture-format": args.textureFormat = argv[++i]; break;
            case "--geometry-compression": args.geometryCompression = argv[++i]; break;
            case "--batch": args.batch = argv[++i]; break;
            case "--batch-resolve": args.batchResolve = argv[++i]; break;
            case "--batch-skybox": args.batchSkybox = argv[++i]; break;
            case "--batch-scene-metadata": args.batchSceneMetadata = argv[++i]; break;
            case "--meta-out": args.metaOut = argv[++i]; break;
            case "--resolve-out": args.resolveOut = argv[++i]; break;
            case "--stats-out": args.statsOut = argv[++i]; break;
            case "--validate": args.validate = argv[++i]; break;
            case "--variant": args.validateVariant = argv[++i]; break;
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
    const batchModes = [ args.batch, args.batchResolve, args.batchSkybox, args.batchSceneMetadata, args.validate ].filter(Boolean);
    if (batchModes.length > 1)
    {
        console.error("--batch, --batch-resolve, --batch-skybox, --batch-scene-metadata and --validate are mutually exclusive");
        process.exit(1);
    }
    if (args.validate && ![ "full", "base" ].includes(args.validateVariant))
    {
        console.error("--variant must be full or base");
        process.exit(1);
    }
    if (batchModes.length) return args;
    if (!args.input) usage(1);
    if ((args.dataBlack && !args.dna) || (!args.dataBlack && args.dna))
    {
        console.error("--data-black and --dna must be given together");
        process.exit(1);
    }
    if (!Number.isInteger(args.lod) || args.lod < 0) { console.error("--lod must be a non-negative integer"); process.exit(1); }
    if (![ "png", "webp", "none" ].includes(args.textureFormat)) { console.error("--texture-format must be png, webp or none"); process.exit(1); }
    if (args.geometryCompression !== null && args.geometryCompression !== "meshopt") { console.error("--geometry-compression must be meshopt"); process.exit(1); }
    if (![ "full", "base" ].includes(args.validateVariant)) { console.error("--variant must be full or base"); process.exit(1); }
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

async function runBatchCli(path, statsOut)
{
    const manifest = JSON.parse(await readFile(path, "utf8"));
    await assertReportPathDoesNotCollide(statsOut, (manifest.jobs ?? []).map((job) => job.out).filter(Boolean));
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
    if (statsOut)
    {
        await writeFile(statsOut, JSON.stringify({ results }, null, 2));
        console.error(`wrote conversion diagnostics -> ${statsOut}`);
    }
    for (const result of failures) console.error(`error: job ${result.id}: ${result.error}`);
    console.error(`converted ${results.length - failures.length}/${results.length} jobs`);
    if (failures.length) process.exitCode = 1;
}

async function runBatchSkyboxCli(path, metaOut)
{
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const { jobs } = await runBatchSkybox(manifest);
    const failures = jobs.filter((job) => !job.ok);
    const json = JSON.stringify({ jobs }, null, 2);
    if (metaOut)
    {
        await writeFile(metaOut, json);
        console.error(`baked ${jobs.length - failures.length}/${jobs.length} skyboxes -> ${metaOut}`);
    }
    else
    {
        console.log(json);
    }
    for (const job of failures) console.error(`error: skybox ${job.id}: ${job.error}`);
    if (failures.length) process.exitCode = 1;
}

async function runBatchSceneMetadataCli(path, metaOut)
{
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const { jobs } = await runBatchSceneMetadata(manifest);
    const failures = jobs.filter((job) => !job.ok);
    const json = JSON.stringify({ jobs }, null, 2);
    if (metaOut)
    {
        await writeFile(metaOut, json);
        console.error(`extracted ${jobs.length - failures.length}/${jobs.length} scene descriptors -> ${metaOut}`);
    }
    else
    {
        console.log(json);
    }
    for (const job of failures) console.error(`error: scene ${job.id}: ${job.error}`);
    if (failures.length) process.exitCode = 1;
}

async function collectGlbFiles(path)
{
    const info = await stat(path);
    if (info.isFile()) return path.toLowerCase().endsWith(".glb") ? [ path ] : [];
    if (!info.isDirectory()) return [];
    const files = [];
    for (const entry of await readdir(path, { withFileTypes: true }))
    {
        if (entry.isDirectory()) files.push(...await collectGlbFiles(join(path, entry.name)));
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".glb")) files.push(join(path, entry.name));
    }
    return files.sort();
}

async function canonicalPath(path)
{
    try
    {
        return await realpath(path);
    }
    catch (error)
    {
        if (error.code !== "ENOENT") throw error;
        const absolute = resolve(path);
        const info = await lstat(absolute).catch((error) =>
        {
            if (error.code !== "ENOENT") throw error;
            return null;
        });
        if (info?.isSymbolicLink())
        {
            // realpath cannot follow a link whose target does not exist yet.
            // Resolve that target so a report cannot alias a future artifact.
            return canonicalPath(resolve(dirname(absolute), await readlink(absolute)));
        }
        const parent = dirname(absolute);
        if (parent === absolute) throw error;
        return join(await canonicalPath(parent), basename(absolute));
    }
}

async function assertReportPathDoesNotCollide(reportPath, artifactPaths)
{
    if (!reportPath) return;
    const report = await canonicalPath(reportPath);
    const reportInfo = await stat(reportPath).catch((error) =>
    {
        if (error.code !== "ENOENT") throw error;
        return null;
    });
    for (const artifact of artifactPaths)
    {
        const artifactCanonical = await canonicalPath(artifact);
        const artifactInfo = await stat(artifact).catch((error) =>
        {
            if (error.code !== "ENOENT") throw error;
            return null;
        });
        if (artifactCanonical === report ||
            (reportInfo && artifactInfo && reportInfo.dev === artifactInfo.dev && reportInfo.ino === artifactInfo.ino))
        {
            throw new Error(`statistics path ${reportPath} conflicts with artifact ${artifact}`);
        }
    }
}

async function runValidateCli(path, statsOut, variant)
{
    const files = await collectGlbFiles(path);
    if (!files.length) throw new Error(`no .glb files found under ${path}`);
    await assertReportPathDoesNotCollide(statsOut, files);
    const results = [];
    for (const file of files)
    {
        let report;
        try
        {
            report = await validateGlb(new Uint8Array(await readFile(file)), {
                variant,
                maxTextureSize: 2048
            });
        }
        catch (error)
        {
            report = {
                valid: false,
                errors: [ `failed to read GLB: ${error.message ?? error}` ],
                warnings: [],
                stats: { bytes: 0 }
            };
        }
        results.push({ path: file, ...report });
        for (const warning of report.warnings) console.error(`warning: ${file}: ${warning}`);
        for (const error of report.errors) console.error(`error: ${file}: ${error}`);
    }
    const complete = results.every((result) => result.valid);
    if (statsOut) await writeFile(statsOut, JSON.stringify({ complete, results }, null, 2));
    console.error(`validated ${results.filter((result) => result.valid).length}/${results.length} GLBs`);
    if (!complete) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));

if (args.validate)
{
    await runValidateCli(resolve(args.validate), args.statsOut ? resolve(args.statsOut) : null, args.validateVariant);
}
else if (args.batchSceneMetadata)
{
    await runBatchSceneMetadataCli(resolve(args.batchSceneMetadata), args.metaOut ? resolve(args.metaOut) : null);
}
else if (args.batchSkybox)
{
    await runBatchSkyboxCli(resolve(args.batchSkybox), args.metaOut ? resolve(args.metaOut) : null);
}
else if (args.batchResolve)
{
    await runBatchResolveCli(resolve(args.batchResolve), args.resolveOut ? resolve(args.resolveOut) : null);
}
else if (args.batch)
{
    await runBatchCli(resolve(args.batch), args.statsOut ? resolve(args.statsOut) : null);
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
        textureFormat: { format: args.textureFormat },
        geometryCompression: args.geometryCompression ?? undefined,
        sof: args.dataBlack ? { dataBlack: resolve(args.dataBlack), dna: args.dna } : undefined
    });

    if (stats.variant === "full" && !stats.complete)
    {
        for (const missing of stats.missingInputs) console.error(`missing: ${missing.area ?? "unknown"} ${missing.role ?? "input"}: ${missing.reason}`);
        console.error("refusing to replace the high-quality artifact with an incomplete conversion");
        process.exitCode = 1;
    }
    else
    {
        await writeFile(output, glb);
        console.log(`wrote ${output} (${(glb.byteLength / 1024 / 1024).toFixed(2)} MiB)`);
    }

    console.log(`${stats.mesh} (LOD ${stats.lod} of ${stats.lodsAvailable}): ${stats.vertices} vertices, ${stats.triangles} triangles, ${stats.primitives} primitives`);
    if (stats.dna) console.log(`dna: ${stats.dna} (hull shader: ${stats.shader})`);
    console.log(`materials: ${stats.materials.join(", ")}`);
    console.log(`textures: ${stats.images.length ? stats.images.join(", ") : "none found"}`);
    for (const skipped of stats.skippedTextures) console.log(`skipped: ${skipped}`);
}
