import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';

interface SimRecord {
  _id?: { $oid?: string } | string;
  data: any[];
  [key: string]: any;
}

interface OutRecord {
  file: string;
  data: Array<{ dt: { si: any }; err: null }>;
}

async function processFile(inputPath: string, outputPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const inputStream = fs.createReadStream(inputPath);
  const stream = inputPath.endsWith('.gz')
    ? inputStream.pipe(zlib.createGunzip())
    : inputStream;

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });

  let lineNo = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineNo += 1;

    let rec: SimRecord;
    try {
      rec = JSON.parse(trimmed);
    } catch (e) {
      console.error(`Failed to parse JSON in ${inputPath} at line ${lineNo}:`, e);
      continue;
    }

    if (!Array.isArray(rec.data)) {
      console.error(`Record in ${inputPath} at line ${lineNo} has no data[] array, skipped`);
      continue;
    }

    const fileId =
      typeof rec._id === 'object' && rec._id && '$oid' in rec._id
        ? (rec._id as any).$oid
        : rec._id != null
        ? String(rec._id)
        : '';

    const out: OutRecord = {
      file: fileId,
      data: rec.data.map((d) => ({ dt: { si: d }, err: null })),
    };

    writeStream.write(JSON.stringify(out) + '\n');
  }

  await new Promise<void>((resolve, reject) => {
    writeStream.end(() => resolve());
    writeStream.on('error', reject);
  });
}

async function main() {
  const root1209 = path.resolve(__dirname, 'assets/1209');
  const entries = await fs.promises.readdir(root1209, { withFileTypes: true });

  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    if (!dirent.name.startsWith('pg_')) continue;

    const gameDir = path.join(root1209, dirent.name);
    const jsonGz = path.join(gameDir, 'simulate.json.gz');
    const jsonPlain = path.join(gameDir, 'simulate.json');

    let inputPath: string | null = null;
    if (fs.existsSync(jsonPlain)) inputPath = jsonPlain;
    else if (fs.existsSync(jsonGz)) inputPath = jsonGz;

    if (!inputPath) {
      console.warn(`Skip ${dirent.name}: no simulate.json[.gz] found`);
      continue;
    }

    // gameId 取去掉前缀 "pg_" 的部分，如 pg_24 -> 24
    const gameId = dirent.name.startsWith('pg_') ? dirent.name.slice(3) : dirent.name;
    const outputPath = path.resolve(__dirname, 'out', gameId, 'Spin.1.jsonl');

    console.log(`Converting ${inputPath} -> ${outputPath}`);
    await processFile(inputPath, outputPath);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
