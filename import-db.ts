import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import Decimal from 'decimal.js';
import yaml from 'js-yaml';
import { IMPORT_LIMIT, TEST_RTP } from './config';

// 供应商常量（资源目录名与默认数据库前缀）
const VENDOR = 'pg';

// 颜色辅助（ANSI）
const COLOR_RESET = '\u001b[0m';
const COLOR_YELLOW = '\u001b[33m';
const COLOR_GREEN = '\u001b[32m';
const COLOR_RED = '\u001b[31m';

function yellow(s: any) { return `${COLOR_YELLOW}${s}${COLOR_RESET}`; }
function green(s: any) { return `${COLOR_GREEN}${s}${COLOR_RESET}`; }
function red(s: any) { return `${COLOR_RED}${s}${COLOR_RESET}`; }

// 简易结构化 logger（使用方括号标签替代 emoji）
function logInfo(msg?: any, ...args: any[]) {
	console.log(`[info] ${msg}`, ...args);
}

function logInsert(msg?: any, ...args: any[]) {
	console.log(`${green('[insert]')} ${msg}`, ...args);
}

function logWarn(msg?: any, ...args: any[]) {
	console.warn(`${yellow('[warn]')} ${msg}`, ...args);
}

function logError(msg?: any, ...args: any[]) {
	console.error(`${red('[error]')} ${msg}`, ...args);
}

interface MongoData {
	func: number;
	data: string;
	mul: number;
}

// 解析单个 JSONL 文件并构建文档列表（可设置最大条数限制）
function collectDocsFromFile(filePath: string, funcType: number, maxCount?: number): MongoData[] {
	const out: MongoData[] = [];
	if (!fs.existsSync(filePath)) return out;
	const raw = fs.readFileSync(filePath, 'utf8');
	const lines = raw.split('\n');
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed && (parsed.Exception || parsed.Message)) continue;
			const mul = computeMul(parsed);
			const doc: MongoData = {
				data: JSON.stringify(parsed.data),
				mul,
				func: funcType,
			};
			out.push(doc);
			if (maxCount && out.length >= maxCount) break;
		} catch (e) {
			logError(`解析 ${path.basename(filePath)} 行失败: ${String(e)}`);
		}
	}
	return out;
}

// 计算真实倍数的，仅返回倍数 mul（新格式：bet= data[0].dt.si.cs * ml，win= data[last].dt.si.tw）
function computeMul(parsed: any): number {
	try {
		const arr = Array.isArray(parsed?.data) ? parsed.data : [];
		if (arr.length === 0) return 0;
		const siFirst = arr[0]?.dt?.si;
		const siLast = arr[arr.length - 1]?.dt?.si;
		const cs = new Decimal(siFirst?.cs ?? 0);
		const ml = new Decimal(siFirst?.ml ?? 0);
		const bet = cs.mul(ml);
		const win = new Decimal(siLast?.aw ?? 0);
		if (bet.lte(0)) return 0;
		const m = win.div(bet);
		return m.isFinite() && !m.isNaN() ? m.toNumber() : 0;
	} catch {
		return 0;
	}
}

/**
 * 
 * @param dbName 
 * @param type 0.普通 1~3.购买 4~6.加注
 * @param gameId 
 * @param options 
 * @returns 
 */
async function importDB(gameIdParam: string | number): Promise<number> {
	const gameId = String(gameIdParam);
	const gameDir = path.join(__dirname, 'assets', VENDOR, gameId);
	// 默认直连本地 27017，无账号密码；允许以 MONGO_URI 覆盖
	const mongoHost = process.env.MONGO_HOST || 'localhost';
	const mongoPort = process.env.MONGO_PORT || '27017';
	const mongoUri = process.env.MONGO_URI || `mongodb://${mongoHost}:${mongoPort}`;

	// 强制使用 VENDOR 作为数据库名
	const dbName = VENDOR;

	// 只在非 dry-run 时连接数据库 url..
	let client: MongoClient | null = null;
	let col: any = null;
	client = new MongoClient(mongoUri);
	await client.connect();
	const db = client.db(dbName);
	// 集合名使用 `${gameId}:spins`
	col = db.collection(`${gameId}:spins`);

	const docs: MongoData[] = [];

	// 统一处理类型 0~6，并全局应用 IMPORT_LIMIT 限制
	for (let type = 0; type <= 6; type++) {
		const file = path.join(gameDir, `Spin.${type}.jsonl`);
		if (!fs.existsSync(file)) continue;
		const remain = IMPORT_LIMIT ? Math.max(IMPORT_LIMIT - docs.length, 0) : undefined;
		if (remain === 0) break;
		const part = collectDocsFromFile(file, type, remain);
		docs.push(...part);
		if (IMPORT_LIMIT && docs.length >= IMPORT_LIMIT) break;
	}

	if (docs.length > 0) {
		if (col) {
			try {
				const delRes = await col.deleteMany({});
				logInsert(`已清空集合 ${dbName}.${gameId}:spins, 删除 ${red(delRes.deletedCount || 0)} 条旧数据`);
			} catch (e) {
				logWarn(`清空集合失败：${String(e)}`);
			}
			const BATCH_SIZE = 500;
			let inserted = 0;
			for (let i = 0; i < docs.length; i += BATCH_SIZE) {
				const batch = docs.slice(i, i + BATCH_SIZE);
				try {
					const res = await col.insertMany(batch as any);
					inserted += (res.insertedCount || batch.length);
					logInsert(`已插入批次：从 ${i} 到 ${i + batch.length - 1}，本批 ${batch.length} 条`);
				} catch (e) {
					logError(`${red('插入批次失败')}（从 ${i} 到 ${i + batch.length - 1}): ${String(e)}`);
				}
			}
			logInsert(`总完成 ${green(inserted)} / ${green(docs.length)} 条文档到 ${dbName}.${gameId}:spins`);
		} else {
			logWarn(`${red('没有可用的 MongoDB 连接，无法插入数据。')}`);
		}
	}

	if (client) await client.close();

	return docs.length;
}

if (require.main === module) {
	const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

	let games: Array<{ gameId: string, kingId: string, dbName: string }> = [];

	// 从 assets/*.yml 中读取 games 列表
	const ymlPath = path.join('assets', `${VENDOR}.yml`);
	if (!fs.existsSync(ymlPath)) {
		logError(`未找到配置文件 ${ymlPath}`);
		process.exit(1);
	}
	const raw = fs.readFileSync(ymlPath, 'utf8');
	const doc: any = yaml.load(raw) as any;
	if (!doc || !Array.isArray(doc.games)) {
		logError('yml 格式不正确：缺少顶层 games 数组');
		process.exit(1);
	}
	games = doc.games;

	// 逐个导入 games 并汇总结果
	(async () => {
		let total = 0;
		let processed = 0;
		for (const game of games) {
			const { dbName, gameId } = game;
			logWarn(`开始导入游戏 '${gameId}' -> DB '${VENDOR}', 集合 '${gameId}:spins'`);
			try {
				// 强制使用 VENDOR 作为数据库名
				const count = await importDB(gameId);
				total += count;
				processed += 1;
			} catch (e) {
				logError(`${gameId} 导入失败:`, e);
			}
		}
		logInfo(`汇总: 处理游戏 ${processed} 个, 共导入 ${green(total)} 条文档`);
	})();
}
