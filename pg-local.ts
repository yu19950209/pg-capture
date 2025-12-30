#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import crypto from 'crypto';
import Decimal from 'decimal.js';
import { SPIN_LIMIT, BUY_LIMIT, RETRY_ATTEMPTS, RETRY_DELAY_MS, SPIN_DELAY_MS, LOG_INTERVAL, CONCURRENT_GAMES, CONCURRENT_PER_GAME, TEST_RTP } from './config';
import { setHttpLogFile } from './pg.http-remote';
import { localGetToken, localSpin, LocalSpinParams, LocalSpinResult, localGetGameInfo, localSpinBuy } from './pg.http.local';

interface PGGameMeta {
    gameId: number;
    name: string;
    name_en?: string;
    api: string;
}

interface PGConfig {
    games: PGGameMeta[];
}

// 根据购买模式计算类型编码
function getTypeCode(buyIndex?: number): number {
    if (buyIndex !== undefined && buyIndex >= 0) {
        return buyIndex + 1; // 购买模式：1, 2, 3...
    }
    return 0; // 普通模式
}

class Session {
    lines = 0;
    hasBuyFeature = false;
    buyOptions: any[] = [];
    private _initialized = false;
    private localToken = ''; // 用于本地环境的 token
    private localCs = '0.02'; // 本地环境的 cs
    private localMl = '1';    // 本地环境的 ml
    private fileHashes = new Set<string>(); // 用于去重的 MD5 集合

    constructor(private baseAssetsDir: string, private gameMeta: PGGameMeta) { }

    private get gameDir() {
        return path.join(this.baseAssetsDir, String(this.gameMeta.gameId));
    }

    // 根据类型获取对应的 Spin 文件路径：Spin.<type>.jsonl
    private spinPath(typeCode: number) {
        return path.join(this.gameDir, `Spin.${typeCode}.jsonl`);
    }

    private get gameInfoPath() {
        return path.join(this.gameDir, 'GameInfo.json');
    }

    private get completePath() {
        return path.join(this.gameDir, 'complete.txt');
    }

    async init(): Promise<boolean> {
        const isFirstInit = !this._initialized;
        if (isFirstInit) {
            console.log(`采集: ${this.gameMeta.gameId} (${this.gameMeta.name})`);
            this._initialized = true;
        }

        if (!fs.existsSync(this.gameDir)) {
            fs.mkdirSync(this.gameDir, { recursive: true });
        }

        // 仅在第一次初始化时设置 HTTP 日志文件
        if (isFirstInit) {
            setHttpLogFile(path.join(this.gameDir, 'http.log'));
        }

        try {
            // 获取 token
            const localTokenRes = await localGetToken(`pg_${this.gameMeta.gameId}`, TEST_RTP ? 300 : 100);
            this.localToken = localTokenRes.token;

            // 获取游戏配置
            const gameInfo = await localGetGameInfo(`${this.gameMeta.gameId}`, this.localToken, this.gameInfoPath);
            this.lines = gameInfo.lines;
            this.hasBuyFeature = gameInfo.hasBuyFeature;
            this.buyOptions = gameInfo.buyOptions || [];
            this.localCs = gameInfo.cs;
            this.localMl = gameInfo.ml;
            return true;
        } catch (error) {
            console.error(`初始化失败: ${this.gameMeta.gameId} ${error}`);  
            return false;
        }
    }
    private countSpins(pathFile: string): number {
        if (!fs.existsSync(pathFile)) return 0;
        const content = fs.readFileSync(pathFile, 'utf8');
        return content.split('\n').filter(Boolean).length;
    }

    private countSpinsByType(typeCode: number): number {
        const filePath = this.spinPath(typeCode);
        return this.countSpins(filePath);
    }

    private countNonNormalSpins(): number {
        if (!fs.existsSync(this.gameDir)) return 0;
        const files = fs.readdirSync(this.gameDir).filter(f => /^Spin\.\d+\.jsonl$/.test(f));
        let total = 0;
        for (const f of files) {
            const m = f.match(/^Spin\.(\d+)\.jsonl$/);
            if (!m) continue;
            const typeNum = Number(m[1]);
            if (Number.isNaN(typeNum) || typeNum === 0) continue;
            const fullPath = path.join(this.gameDir, f);
            total += this.countSpins(fullPath);
        }
        return total;
    }

    private async sleep(ms: number) {
        await new Promise(r => setTimeout(r, ms));
    }

    // 计算 MD5，排除 psid 和 sid
    private calculateHash(rawSpins: any[]): string {
        rawSpins.forEach(spin => {
            if (spin?.dt?.si) {
                delete spin.dt.si.psid;
                delete spin.dt.si.sid;
                delete spin.dt.si.bl;
                delete spin.dt.si.blab;
                delete spin.dt.si.blb;
            }
        });
        const joined = rawSpins.map(s => JSON.stringify(s)).join('\n');
        return crypto.createHash('md5').update(joined).digest('hex');
    }

    async run(): Promise<void> {
        if (!fs.existsSync(this.gameDir)) {
            fs.mkdirSync(this.gameDir, { recursive: true });
        }

        let count = this.countSpins(this.spinPath(0));
        let buyCount = this.countNonNormalSpins();

        // 常规采集（NORMAL 模式）
        let localOrderId = 0; // 本地环境的 orderId
        while (count < SPIN_LIMIT) {
            let result;
            try {
                const spinParams: LocalSpinParams = {
                    gameId: `${this.gameMeta.gameId}`,
                    token: this.localToken,
                    orderId: localOrderId,
                    cs: this.localCs,  // 使用动态获取的 cs
                    ml: this.localMl,  // 使用动态获取的 ml
                    wk: '0_C'
                };
                result = await localSpin(spinParams, SPIN_DELAY_MS);
            } catch (e: any) {
                console.error(`[${this.gameMeta.gameId}] Spin 失败:`, e.message);
                await this.init();
                localOrderId = 0;
                continue;
            }

            // 更新 orderId
            localOrderId = result.nextOrderId;

            // 生成文件名（不包含 psid 和 sid）
            const file = this.calculateHash(result.rawSpins);

            // 去重检查
            if (this.fileHashes.has(file)) {
                console.log(`[${this.gameMeta.gameId}] 跳过重复数据: ${file}`);
                continue;
            }

            this.fileHashes.add(file);

            // 写入文件
            const type = 0;
            const record = { file, data: result.rawSpins };
            fs.appendFileSync(this.spinPath(type), JSON.stringify(record) + '\n', 'utf8');
            count++;

            if (count % LOG_INTERVAL === 0) {
                console.log('\x1b[33m%s\x1b[0m', `进度[NORMAL]: ${this.gameMeta.gameId} -> ${count}/${SPIN_LIMIT}`);
            }

            if (SPIN_DELAY_MS > 0) await this.sleep(SPIN_DELAY_MS);
        }

        console.log(`常规采集完成: ${this.gameMeta.gameId}, 共 ${count} 条`);

        // 购买采集（BUY 模式）- 使用本地环境
        console.log(`[${this.gameMeta.gameId}] 检查购买功能: hasBuyFeature=${this.hasBuyFeature}, buyOptions.length=${this.buyOptions.length}`);

        if (this.hasBuyFeature && this.buyOptions.length > 0) {
            console.log(`开始购买采集: ${this.gameMeta.gameId}, 购买选项:`, JSON.stringify(this.buyOptions));

            // 初始化本地环境 token
            if (!this.localToken) {
                const success = await this.init();
                if (!success) {
                    console.log(`跳过购买采集`);
                    return;
                }
            }

            for (let buyIdx = 0; buyIdx < this.buyOptions.length; buyIdx++) {
                const buyType = getTypeCode(buyIdx);
                let buyCountPerType = this.countSpinsByType(buyType);

                let localOrderId = 0; // 本地环境的 orderId
                await this.init();
                while (buyCountPerType < BUY_LIMIT) {
                    let result: LocalSpinResult;
                    try {
                        const spinParams: LocalSpinParams = {
                            gameId: `${this.gameMeta.gameId}`,
                            token: this.localToken,
                            orderId: localOrderId,
                            cs: this.localCs,  // 使用动态获取的 cs
                            ml: this.localMl,  // 使用动态获取的 ml
                            wk: '0_C'
                        };
                        result = await localSpinBuy(spinParams);
                    } catch (e: any) {
                        console.error(`[${this.gameMeta.gameId}] Local Buy Spin 失败:`, e.message);
                        // 本地环境出错，尝试重新初始化
                        const success = await this.init();
                        if (!success) {
                            console.error(`[${this.gameMeta.gameId}] 本地环境重新初始化失败，跳过剩余购买采集`);
                            break;
                        }
                        localOrderId = 0;
                        continue;
                    }

                    if (!result.rawSpins[0].dt.si.fb) {
                        break;
                    }

                    // 更新本地 orderId
                    localOrderId = result.nextOrderId;

                    // 计算倍数
                    const si = result.spinData?.dt?.si;
                    let mul = 0;
                    if (si) {
                        try {
                            const cs = new Decimal(String(si.cs || 0).replace(/,/g, ''));
                            const ml = new Decimal(String(si.ml || 0).replace(/,/g, ''));
                            const bet = cs.mul(ml).mul(this.lines);
                            const win = new Decimal(String(si.tw || 0).replace(/,/g, ''));
                            mul = bet.gt(0) ? Number(win.div(bet).toFixed(2)) : 0;
                        } catch {
                            mul = 0;
                        }
                    }

                    // 生成文件名（不包含 psid 和 sid）
                    const file = this.calculateHash(result.rawSpins);

                    // 去重检查
                    if (this.fileHashes.has(file)) {
                        console.log(`[${this.gameMeta.gameId}] 跳过重复数据: ${file}`);
                        continue;
                    }
                    this.fileHashes.add(file);

                    // 写入文件
                    const record = { file, mul, type: buyType, data: result.rawSpins };
                    fs.appendFileSync(this.spinPath(buyType), JSON.stringify(record) + '\n', 'utf8');
                    buyCountPerType++;
                    buyCount++;

                    if (buyCountPerType % LOG_INTERVAL === 0) {
                        console.log('\x1b[33m%s\x1b[0m', `进度[LOCAL BUY ${buyIdx}]: ${this.gameMeta.gameId} -> ${buyCountPerType}/${BUY_LIMIT}`);
                    }

                    if (SPIN_DELAY_MS > 0) await this.sleep(SPIN_DELAY_MS);
                }
            }
        }

        // 写入完成标记
        const summary = `${count}|${buyCount}`;
        fs.writeFileSync(this.completePath, summary, 'utf8');
        console.log(`采集完成: ${this.gameMeta.gameId}, 常规 ${count} 条, 购买 ${buyCount} 条`, this.hasBuyFeature, this.buyOptions.length);
    }
}

async function loadPGConfig(): Promise<PGConfig> {
    const ymlPath = path.resolve(process.cwd(), 'assets', 'pg.yml');
    try {
        if (!fs.existsSync(ymlPath)) return { games: [] };
        const raw = fs.readFileSync(ymlPath, 'utf-8');
        return yaml.load(raw) as PGConfig;
    } catch {
        return { games: [] };
    }
}

async function runGame(game: PGGameMeta, baseDir: string) {
    const gameDir = path.join(baseDir, String(game.gameId));
    const completePath = path.join(gameDir, 'complete.txt');

    // 检查是否已完成
    if (fs.existsSync(completePath)) {
        try {
            const txt = fs.readFileSync(completePath, 'utf8').trim();
            const [normalStr, buyStr] = txt.split('|');
            const normalCount = parseInt(normalStr || '0', 10) || 0;
            const buyCount = parseInt(buyStr || '0', 10) || 0;
            if (normalCount >= SPIN_LIMIT && buyCount >= BUY_LIMIT) {
                console.log(`跳过已完成: ${game.gameId} (${game.name})`);
                return;
            }
        } catch {
            // 解析失败则继续采集
        }
    }

    // 每个游戏的并发采集实例
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENT_PER_GAME; i++) {
        const sess = new Session(baseDir, game);
        tasks.push((async () => {
            try {
                await sess.init();
                await sess.run();
            } catch (e: any) {
                const msg = e && e.message ? e.message : String(e);
                console.error(`采集失败: ${game.gameId} ${msg}`);
            }
        })());
    }
    await Promise.all(tasks);

    // 采集完成后输出统计
    let normalCount = 0;
    let otherCount = 0;
    if (fs.existsSync(gameDir)) {
        const files = fs.readdirSync(gameDir).filter(f => /^Spin\.\d+\.jsonl$/.test(f));
        for (const f of files) {
            const m = f.match(/^Spin\.(\d+)\.jsonl$/);
            if (!m) continue;
            const typeNum = Number(m[1]);
            if (Number.isNaN(typeNum)) continue;
            const full = path.join(gameDir, f);
            const c = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).length;
            if (typeNum === 0) normalCount += c;
            else otherCount += c;
        }
    }
    const summary = `${normalCount}|${otherCount}`;
    fs.writeFileSync(completePath, summary, 'utf8');
}

function parseArgs(argv: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const arg of argv) {
        if (arg.startsWith('--')) {
            const [k, v] = arg.slice(2).split('=');
            result[k] = v || '';
        }
    }
    return result;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const baseDir = path.resolve(process.cwd(), 'assets', 'pg');
    const cfg = await loadPGConfig();

    const gameIdArg = args.gameId;

    if (gameIdArg) {
        // 单游戏模式
        const meta = cfg.games.find(g =>
            String(g.gameId) === gameIdArg ||
            g.name_en === gameIdArg ||
            g.name === gameIdArg ||
            g.api === gameIdArg
        );
        if (!meta) {
            console.log('未找到游戏:', gameIdArg);
            return;
        }
        await runGame(meta, baseDir);
    } else {
        // 批量模式
        console.log(`开始批量采集，共 ${cfg.games.length} 个游戏`);

        const running: Promise<void>[] = [];
        for (const game of cfg.games) {
            if (!game || !game.gameId) continue;

            // 等待并发槽位
            while (running.length >= CONCURRENT_GAMES) {
                await Promise.race(running);
                for (let i = running.length - 1; i >= 0; i--) {
                    if (Reflect.get(running[i], 'settled')) {
                        running.splice(i, 1);
                    }
                }
            }

            const p = runGame(game, baseDir).finally(() => {
                Reflect.set(p as any, 'settled', true);
            });
            running.push(p);
        }
        await Promise.all(running);

        console.log('所有游戏采集完成');
    }
}

if (require.main === module) {
    main().catch(e => {
        console.error('Fatal error:', e);
        process.exit(1);
    });
}

export default main;
