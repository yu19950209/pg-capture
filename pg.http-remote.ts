import axios from 'axios';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { parsePGInit, PGInitResult, parseParams } from './pg.parse';

const HOST = 'api.8jkxzybcq.com';
// const HOST = 'api.pgf-thcvvo.com'; // 生产环境

const url = (p: string) => `https://${HOST}${p}`;

let HTTP_LOG_FILE: string | null = null;

function formatLogTime(): string {
    // 将当前时间转换为北京时间 (UTC+8)，格式：YYYY-MM-DD HH:mm
    const now = new Date();
    const utcMillis = now.getTime() + now.getTimezoneOffset() * 60000;
    const bj = new Date(utcMillis + 8 * 60 * 60 * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    const y = bj.getFullYear();
    const m = pad(bj.getMonth() + 1);
    const d = pad(bj.getDate());
    const hh = pad(bj.getHours());
    const mm = pad(bj.getMinutes());
    return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function setHttpLogFile(filePath: string) {
    HTTP_LOG_FILE = filePath;
    try {
        fs.writeFileSync(HTTP_LOG_FILE, '', 'utf-8');
    } catch { }
}

function appendHttp(lines: string[]) {
    if (!HTTP_LOG_FILE) return;
    try {
        fs.appendFileSync(HTTP_LOG_FILE, lines.join('\n') + '\n', 'utf-8');
    } catch { }
}

export function randomTraceId(): string {
    return Math.random().toString(16).slice(2, 10);
}

export interface PGTokenResult {
    token: string;
}

// 获取 Token
export async function pgGetToken(gameId: number): Promise<PGTokenResult> {
    const start = Date.now();
    try {
        const result = await axios.post(
            url(`/web-api/auth/session/v2/verifySession?traceId=${randomTraceId()}`),
            `btt=2&vc=2&pf=2&l=zh&gi=${gameId}&tk=null&otk=ca7094186b309ee149c55c8822e7ecf2`,
            {
                headers: {
                    'accept': '*/*',
                    'content-type': 'application/x-www-form-urlencoded'
                },
                validateStatus: () => true
            }
        );

        const ms = Date.now() - start;
        const respText = JSON.stringify(result.data);
        
        appendHttp([
            `[HTTP] time=${formatLogTime()} status=${result.status} ms=${ms} len=${respText.length}`,
            `url=${url('/web-api/auth/session/v2/verifySession')}`,
            `body=btt=2&vc=2&pf=2&l=zh&gi=${gameId}&tk=null&otk=...`,
            `resp=${respText}`,
            ''
        ]);

        if (result.status === 200) {
            const data: any = result.data;
            const token = data?.dt?.tk || '';
            if (!token) {
                throw new Error('Token missing in response');
            }
            return { token };
        } else {
            throw new Error(`HTTP ${result.status}`);
        }
    } catch (e: any) {
        const ms = Date.now() - start;
        appendHttp([
            `[HTTP ERROR] time=${formatLogTime()} ms=${ms}`,
            `url=${url('/web-api/auth/session/v2/verifySession')}`,
            `error=${e.message}`,
            ''
        ]);
        throw e;
    }
}

// 获取游戏配置（GameInfo）
export async function pgGetGameInfo(gameApi: string, token: string, gameInfoPath?: string): Promise<PGInitResult> {
    // 如果提供了 gameInfoPath 且文件已存在，则直接解析本地文件
    if (gameInfoPath && fs.existsSync(gameInfoPath)) {
        try {
            const content = fs.readFileSync(gameInfoPath, 'utf-8');
            const data = JSON.parse(content);
            return parsePGInit(data);
        } catch {
            // 读取失败则继续请求
        }
    }

    const start = Date.now();
    try {
        const result = await axios.post(
            url(`/game-api/${gameApi}/v2/GameInfo/Get?traceId=${randomTraceId()}`),
            `btt=2&atk=${token}&pf=2&vc=0`,
            {
                headers: {
                    'accept': '*/*',
                    'content-type': 'application/x-www-form-urlencoded'
                },
                validateStatus: () => true
            }
        );

        const ms = Date.now() - start;
        const respText = JSON.stringify(result.data);
        
        appendHttp([
            `[HTTP] time=${formatLogTime()} status=${result.status} ms=${ms} len=${respText.length}`,
            `url=${url(`/game-api/${gameApi}/v2/GameInfo/Get`)}`,
            `body=btt=2&atk=${token}&pf=2&vc=0`,
            `resp=${respText}`,
            ''
        ]);

        if (result.status === 200) {
            const data: any = result.data;
            const gameInfo = data?.dt || null;
            
            if (!gameInfo) {
                throw new Error('GameInfo missing in response');
            }

            // 如果提供了路径，则写入文件
            if (gameInfoPath) {
                try {
                    fs.writeFileSync(gameInfoPath, JSON.stringify(data, null, 2), 'utf-8');
                } catch { }
            }

            return parsePGInit(gameInfo);
        } else {
            throw new Error(`HTTP ${result.status}`);
        }
    } catch (e: any) {
        const ms = Date.now() - start;
        appendHttp([
            `[HTTP ERROR] time=${formatLogTime()} ms=${ms}`,
            `url=${url(`/game-api/${gameApi}/v2/GameInfo/Get`)}`,
            `error=${e.message}`,
            ''
        ]);
        throw e;
    }
}

export interface PGSpinParams {
    gameApi: string;
    token: string;
    orderId: number;
    cs?: string;      // coin size，默认 0.3
    ml?: string;      // multiplier level，默认 2
    wk?: string;      // work key，默认 0_C
    fb?: string;      // feature buy，购买模式：'2' 等
}

export interface PGSpinResult {
    rawSpins: any[];
    spinData: any;
    nextOrderId: number;
}

// 检查响应错误
function validatePGResponse(data: any): void {
    if (!data) {
        throw new Error('Empty response');
    }
    if (data.err) {
        const cd = data.err.cd;
        if (cd === '1200' || cd === '1201') {
            throw new Error('Token expired');
        }
        throw new Error(`Error ${cd}: ${data.err.msg || 'Unknown'}`);
    }
}

// 判断回合是否结束
function isRoundComplete(si: any): boolean {
    // nst === 1 表示回合结束
    return si.nst === 1 || si.nst === '1';
}

// Spin 请求：封装一次完整回合（可能包含多次 spin）
export async function pgSpin(params: PGSpinParams): Promise<PGSpinResult> {
    const rawSpins: any[] = [];
    let currentOrderId = params.orderId;
    let psid: string | null = null;

    const cs = params.cs || '0.3';
    const ml = params.ml || '2';
    const wk = params.wk || '0_C';
    
    // 构建请求 body
    let body = `id=${currentOrderId}&cs=${cs}&ml=${ml}&wk=${wk}&btt=2&atk=${params.token}&pf=2`;
    if (params.fb) {
        body += `&fb=${params.fb}`;
    }

    while (true) {
        const start = Date.now();
        try {
            const result = await axios.post(
                url(`/game-api/${params.gameApi}/v2/Spin?traceId=${randomTraceId()}`),
                body,
                {
                    headers: {
                        'accept': '*/*',
                        'content-type': 'application/x-www-form-urlencoded'
                    },
                    validateStatus: () => true
                }
            );

            const ms = Date.now() - start;
            const respText = JSON.stringify(result.data);
            
            appendHttp([
                `[HTTP] time=${formatLogTime()} status=${result.status} ms=${ms} len=${respText.length}`,
                `url=${url(`/game-api/${params.gameApi}/v2/Spin`)}`,
                `body=${body}`,
                `resp=${respText}`,
                ''
            ]);

            if (result.status !== 200) {
                throw new Error(`HTTP ${result.status}`);
            }

            const data = result.data;
            validatePGResponse(data);

            const si = data?.dt?.si;
            if (!si) {
                throw new Error('Spin info missing');
            }

            // 检查 psid 一致性
            if (!psid) {
                psid = si.psid;
            } else if (si.psid !== psid) {
                throw new Error('PSID mismatch');
            }

            rawSpins.push(data);
            currentOrderId = si.sid;

            // 后续 spin 不再携带 fb 参数
            body = `id=${currentOrderId}&cs=${cs}&ml=${ml}&wk=${wk}&btt=2&atk=${params.token}&pf=2`;

            // 检查回合是否结束
            if (isRoundComplete(si)) {
                break;
            }
        } catch (e: any) {
            const ms = Date.now() - start;
            appendHttp([
                `[HTTP ERROR] time=${formatLogTime()} ms=${ms}`,
                `url=${url(`/game-api/${params.gameApi}/v2/Spin`)}`,
                `error=${e.message}`,
                ''
            ]);
            throw e;
        }
    }

    const lastSpin = rawSpins[rawSpins.length - 1];
    return {
        rawSpins,
        spinData: lastSpin,
        nextOrderId: currentOrderId
    };
}
