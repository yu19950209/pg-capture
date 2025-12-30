/**
 * 遍历 assets/pg/* 中的所有游戏目录，按顺序请求外部接口并将响应 JSON 存到
 * 每个游戏目录下的 capture/*.json 中。
 *
 * 使用：
 *   yarn collect:pg                     # 顺序采集全部游戏
 *   yarn collect:pg --list              # 仅列出将采集的游戏，不发请求
 *   yarn collect:pg --gid 87,106        # 仅采集指定 gid 列表（逗号分隔）
 *   yarn collect:pg --start 80 --limit 5# 从 gid>=80 起采集 5 个
 *   yarn collect:pg --force             # 覆盖已存在的 json 文件
 *
 * 鉴权：在下方常量中直接配置 cookie、tk、otk；atk/eatk 将从第一步 verify 接口返回中提取。
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

type GameYaml = {
    games: Array<{ gameId: number; api?: string; name?: string; name_en?: string }>;
};

const ROOT = process.cwd();
const ASSETS_PG = path.resolve(ROOT, 'assets', 'pg');
const PG_YAML = path.resolve(ROOT, 'assets', 'pg.yml');

const BASE_URL = 'https://api.zmcyu9ypy.com';
const REFERER = 'https://m.zmcyu9ypy.com/';
// 凭据：根据你的需求更新为有效值
const COOKIE = 'aliyungf_tc=91330fe21146bc59c2ba663b3ec5c2768cafb93f4fc958faaef17bd2c5dffb08';
const TK = 'DI3X0F2R-OU34-34ZX-C4VR-YN232P218G28';
const OTK = '772BBB7B-255E-4883-945C-4DA1A97D0A13';

export type Argv = {
    listOnly: boolean;
    force: boolean;
    clean?: boolean;
    filterGids?: number[];
    start?: number;
    limit?: number;
    rps?: number; // 每秒请求上限
};

export function parseArgs(argv: string[]): Argv {
    const out: Argv = { listOnly: false, force: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--list') out.listOnly = true;
        else if (a === '--force') out.force = true;
        else if (a === '--clean') out.clean = true;
        else if (a === '--gid' && i + 1 < argv.length) {
            out.filterGids = String(argv[++i])
                .split(',')
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => Number.isFinite(n));
        } else if (a === '--start' && i + 1 < argv.length) {
            out.start = parseInt(argv[++i], 10);
        } else if (a === '--limit' && i + 1 < argv.length) {
            out.limit = parseInt(argv[++i], 10);
        } else if (a === '--rps' && i + 1 < argv.length) {
            out.rps = parseInt(argv[++i], 10);
        }
    }
    return out;
}

export function listGameDirs(base: string): number[] {
    if (!fs.existsSync(base)) return [];
    const dirs = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
        .map((d) => parseInt(d.name, 10));
    return dirs.sort((a, b) => a - b);
}

export function loadPgYaml(file: string): Map<number, string> {
    const m = new Map<number, string>();
    if (!fs.existsSync(file)) return m;
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) as GameYaml;
    if (!doc?.games) return m;
    for (const g of doc.games) {
        if (typeof g.gameId === 'number' && g.api) m.set(g.gameId, g.api);
    }
    return m;
}

export function ensureDir(p: string) {
    fs.mkdirSync(p, { recursive: true });
}

export function writeJsonIfNeeded(file: string, data: any, force: boolean) {
    if (data.err != null) {
        return console.log('err', data.err);
    }
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function writeTextIfNeeded(file: string, data: string, force: boolean = true) {
    if (!force && fs.existsSync(file)) return;
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, data, 'utf8');
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0';

function headers(extra: Record<string, string> = {}) {
    return {
        // 模拟浏览器请求头
        accept: '*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'content-type': 'application/x-www-form-urlencoded',
        priority: 'u=1, i',
        'sec-ch-ua': '"Not;A=Brand";v="99", "Microsoft Edge";v="139", "Chromium";v="139"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        Referer: REFERER,
        'User-Agent': USER_AGENT,
        ...(COOKIE ? { cookie: COOKIE } : {}),
        ...extra,
    } as Record<string, string>;
}

function form(data: Record<string, string | number | undefined>): string {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) {
        if (v !== undefined && v !== null) usp.append(k, String(v));
    }
    return usp.toString();
}

function traceId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

function pluck(obj: any, paths: string[][]): any {
    for (const p of paths) {
        let cur: any = obj;
        let ok = true;
        for (const key of p) {
            if (cur && typeof cur === 'object' && key in cur) cur = cur[key];
            else {
                ok = false;
                break;
            }
        }
        if (ok) return cur;
    }
    return undefined;
}

async function safeJson(res: Response) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}

// 简单限速器：每秒最多触发 rps 个请求
class RateLimiter {
    private queue: Array<() => void> = [];
    private timer: NodeJS.Timeout;
    private burst: number;
    constructor(rps: number) {
        this.burst = Math.max(1, rps | 0);
        this.timer = setInterval(() => {
            for (let i = 0; i < this.burst && this.queue.length > 0; i++) {
                const task = this.queue.shift();
                task && task();
            }
        }, 1000);
    }
    schedule<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push(() => {
                fn().then(resolve, reject);
            });
        });
    }
    dispose() {
        clearInterval(this.timer);
    }
}

// 修正：仅保留一个带限速 fetch 参数的签名
export async function collectForGame(
    gid: number,
    apiSlug: string | undefined,
    outDir: string,
    force: boolean,
    lf: (url: string, init: RequestInit) => Promise<Response>,
) {
    const files = {
        verify: path.join(outDir, 'VerifySession.json'),
        gameName: path.join(outDir, 'GameName.json'),
        gameInfo: path.join(outDir, 'GameInfo.json'),
        resGetByType: path.join(outDir, 'GetByResourcesTypeIds.json'),
        resGetByRef: path.join(outDir, 'GetByReferenceIdsResourceTypeIds.json'),
        ui: path.join(outDir, 'GameUI.json'),
        rule: path.join(outDir, 'GameRule.json'),
    } as const;
    console.log('[collect] 输出文件名: ', Object.values(files).map((p) => path.basename(p)).join(', '));

    let curAtk = '';
    let curEAtk = '';
    try {
        const url = `${BASE_URL}/web-api/auth/session/v2/verifySession?traceId=${traceId()}`;
        const body = form({ btt: 1, vc: 2, pf: 2, l: 'en', gi: gid, tk: TK, otk: OTK });
        const res = await lf(url, { method: 'POST', headers: headers(), body });
        const json = await safeJson(res);
        writeJsonIfNeeded(files.verify, json, force);
        const atk = pluck(json, [['data', 'atk'], ['dt', 'atk'], ['atk'], ['result', 'atk']]);
        const eatk = pluck(json, [['data', 'eatk'], ['dt', 'eatk'], ['eatk'], ['result', 'eatk']]);
        if (typeof atk === 'string') curAtk = atk;
        if (typeof eatk === 'string') curEAtk = eatk;
    } catch (e: any) {
        console.log('atk/eatk 获取失败，跳过后续请求', e);
        writeJsonIfNeeded(files.verify, { error: String(e) }, true);
    }

    curAtk = TK;

    // try {
    //     const url = `${BASE_URL}/web-api/game-proxy/v2/GameName/Get?traceId=${traceId()}`;
    //     const body = form({ lang: 'en', btt: 1, atk: curAtk, pf: 2, gid: gid });
    //     const res = await lf(url, { method: 'POST', headers: headers(), body });
    //     const json = await safeJson(res);
    //     writeJsonIfNeeded(files.gameName, json, force);
    // } catch (e: any) {
    //     writeJsonIfNeeded(files.gameName, { error: String(e) }, true);
    // }

    try {
        if (!apiSlug) {
            writeJsonIfNeeded(files.gameInfo, { skipped: true, reason: 'Missing api slug in pg.yml' }, force);
        } else {
            const url = `${BASE_URL}/game-api/${apiSlug}/v2/GameInfo/Get?traceId=${traceId()}`;
            const body = form({ eatk: curEAtk, btt: 1, atk: curAtk, pf: 2 });
            const res = await lf(url, { method: 'POST', headers: headers(), body });
            const json = await safeJson(res);
            writeJsonIfNeeded(files.gameInfo, json, force);
        }
    } catch (e: any) {
        writeJsonIfNeeded(files.gameInfo, { error: String(e) }, true);
    }

    // try {
    //     const url = `${BASE_URL}/web-api/game-proxy/v2/Resources/GetByResourcesTypeIds?traceId=${traceId()}`;
    //     const body = form({ du: REFERER.replace(/\/$/, ''), rtids: 14, otk: OTK, btt: 1, wk: '0_C', atk: curAtk, pf: 2, gid });
    //     const res = await lf(url, { method: 'POST', headers: headers(), body });
    //     const json = await safeJson(res);
    //     writeJsonIfNeeded(files.resGetByType, json, force);
    // } catch (e: any) {
    //     writeJsonIfNeeded(files.resGetByType, { error: String(e) }, true);
    // }

    // try {
    //     const url = `${BASE_URL}/web-api/game-proxy/v2/Resources/GetByReferenceIdsResourceTypeIds?traceId=${traceId()}`;
    //     const body = form({ btt: 1, atk: curAtk, pf: 2, gid, du: REFERER.replace(/\/$/, ''), rtids: 7, otk: OTK, lang: 'en' });
    //     const res = await lf(url, { method: 'POST', headers: headers(), body });
    //     const json = await safeJson(res);
    //     writeJsonIfNeeded(files.resGetByRef, json, force);
    // } catch (e: any) {
    //     writeJsonIfNeeded(files.resGetByRef, { error: String(e) }, true);
    // }

    // try {
    //     const url = `${BASE_URL}/web-api/game-proxy/v2/GameUI/Get?traceId=${traceId()}`;
    //     const body = form({ btt: 1, atk: curAtk, pf: 2, gid });
    //     const res = await lf(url, { method: 'POST', headers: headers(), body });
    //     const json = await safeJson(res);
    //     writeJsonIfNeeded(files.ui, json, force);
    // } catch (e: any) {
    //     writeJsonIfNeeded(files.ui, { error: String(e) }, true);
    // }


    // try {
    //     const url = `${BASE_URL}/web-api/game-proxy/v2/GameRule/Get?traceId=${traceId()}`;
    //     const body = form({ btt: 1, gid, atk: curAtk, pf: 2 });
    //     const res = await lf(url, { method: 'POST', headers: headers(), body });
    //     const json = await safeJson(res);
    //     writeJsonIfNeeded(files.rule, json, force);
    // } catch (e: any) {
    //     writeJsonIfNeeded(files.rule, { error: String(e) }, true);
    // }
}

// 先抓取 HTML 页面，便于后续分析或注入
export async function fetchHtmlForGame(
    gid: number,
    outDir: string,
    force: boolean,
    lf: (url: string, init: RequestInit) => Promise<Response>,
) {
    const htmlFile = path.join(outDir, 'index.html');
    if (!force && fs.existsSync(htmlFile)) {
        return; // 已存在且未强制覆盖
    }

    const url = `https://m.x1skf.com/${gid}/index.html`;
    // 构造接近浏览器的请求头
    const hdrs: Record<string, string> = {
        'user-agent': USER_AGENT,
        referer: `https://m.x1skf.com/${gid}/index.html`,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
    };

    const noTimeout = process.env.PG_NO_FETCH_TIMEOUT === '1';
    const ac = new AbortController();
    let to: NodeJS.Timeout | undefined;
    if (!noTimeout) {
        to = setTimeout(() => ac.abort(), 10000);
    }

    try {
        const res = await lf(url, {
            method: 'GET',
            headers: hdrs as any,
            redirect: 'follow',
            signal: ac.signal,
        } as any);
        if (to) clearTimeout(to);
        const text = await res.text();
        // 即便非 2xx，也写入内容用于排查
        writeTextIfNeeded(htmlFile, text, true);
    } catch (e: any) {
        if (to) clearTimeout(to);
        writeTextIfNeeded(path.join(outDir, 'index.error.txt'), String(e), true);
    }
}

async function runCore(args: Argv) {
    const allGids = listGameDirs(ASSETS_PG);
    const slugMap = loadPgYaml(PG_YAML);
    const rps = Math.max(1, args.rps ?? 3);
    const limiter = new RateLimiter(rps);
    const lf = (url: string, init: RequestInit) => limiter.schedule(() => fetch(url, init));

    let gids = allGids;
    if (args.filterGids?.length) gids = gids.filter((g) => args.filterGids!.includes(g));
    if (typeof args.start === 'number') gids = gids.filter((g) => g >= args.start!);
    if (typeof args.limit === 'number') gids = gids.slice(0, args.limit);

    console.log(`[collect] 将处理 ${gids.length} 个游戏: ${gids.join(', ')}`);
    if (args.listOnly) {
        limiter.dispose();
        return { processed: 0, gids };
    }

    for (const gid of gids) {
        const apiSlug = slugMap.get(gid);
        const outDir = path.join(ASSETS_PG, String(gid));
        if (args.clean) {
            try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { }
        }
        console.log(`[collect] gid=${gid} slug=${apiSlug ?? '-'} -> ${path.relative(ROOT, outDir)}`);
        // 1) 先抓 HTML
        await fetchHtmlForGame(gid, outDir, args.force, lf);
        // 2) 再采集 JSON 接口
        await collectForGame(gid, apiSlug, outDir, args.force, lf);
    }
    limiter.dispose();
    return { processed: gids.length, gids };
}

// 供外部（如控制器）直接调用的封装
export async function collectPgGames(options: Partial<Argv> & { gids?: number[] }) {
    const args: Argv = {
        listOnly: options.listOnly ?? false,
        force: options.force ?? false,
        clean: options.clean,
        filterGids: options.gids ?? options.filterGids,
        start: options.start,
        limit: options.limit,
        rps: options.rps,
    };
    return runCore(args);
}

async function main() {
    const args = parseArgs(process.argv);
    const summary = await runCore(args);
    console.log('[collect] 完成 processed=', summary.processed);
}

// 只有显式传入 --run 参数才执行主程序，避免被 import 时自动采集
if (require.main === module) {
    if (process.argv.includes('--run')) {
        main().catch((e) => {
            console.error('[collect] 运行失败:', e);
            process.exit(1);
        });
    } else {
        console.log('[collect] 跳过执行（缺少 --run 参数）');
    }
}
