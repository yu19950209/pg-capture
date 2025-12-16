import https from 'https';
import axios from 'axios';
import path from 'path';
import fs from 'fs/promises';
import { URL } from 'url';
import { parsePGInit } from './pg.parse';

export const APP_ID = 'faketrans2';
export const APP_SECRET = 'c21967e5-bd33-4a73-acbc-00da92a9cd92';
export const COOKIE =
    '_ga=GA1.1.1284137815.1764340497; _ga_0000000000=GS2.1.s1764773943$o5$g1$t1764778153$j60$l0$h0; cf_clearance=H.ti4WpFD.2Mu3vmc6CCUboZGL2Pk4T8kWNeYe8lx0s-1764778629-1.2.1.1-anO4D3mSzMUn77WNsYkKV4KjNJKNG2Bk3Dl6SyzYWqLx7QcxVKn9SOyltOQKlxkLuNSJBntMFxcK6zAW9JAQhtXHfgpykOaJX7HeGKlo37F7mbx6Cmqdcz6ZXj3eZvOAireCNKej83gt.ctLIAvRd0kj_BheVpQ_F1yKkLdvaimmw_9jVrU0Nlc6Sl3EKNUR4VomTkrryWJIwJpykrH1i.QyromoU2nObT.FaWAWbEA';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export const axiosClient = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    validateStatus: () => true,
});

export async function axiosJson(urlStr: string, headers: Record<string, string>, method: 'GET' | 'POST' = 'GET', body?: Buffer | string): Promise<any> {
    const res = await axiosClient.request({ url: urlStr, method, headers, data: body, responseType: 'text' });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = res.data as string;
    try {
        return JSON.parse(text);
    } catch (e) {
        try {
            const debugDir = path.resolve(process.cwd(), 'assets/_debug');
            await fs.mkdir(debugDir, { recursive: true });
            const u = new URL(urlStr);
            const fname = u.pathname.replace(/\W+/g, '_') || 'response';
            await fs.writeFile(path.join(debugDir, `${fname}.txt`), text);
        } catch { }
        throw e;
    }
}

export async function createPlayer(): Promise<number> {
    const userId = `DemoUser-${Date.now()}`;
    const json = await axiosJson(
        'https://localhost:8443/api/v1/player/create',
        { appid: APP_ID, appsecret: APP_SECRET, 'content-type': 'application/json', accept: 'application/json, text/plain, */*', cookie: COOKIE },
        'POST',
        Buffer.from(JSON.stringify({ UserID: userId }))
    );
    if (json?.code !== 0) throw new Error(`create player failed: ${JSON.stringify(json)}`);
    return json.data.Pid as number;
}

export async function launchGame(userId: string, gameId: string) {
    const json = await axiosJson(
        'https://localhost:8443/api/v1/game/launch',
        {
            'appid': APP_ID,
            'appsecret': APP_SECRET,
            'content-type': 'application/json',
            'accept': 'application/json, text/plain, */*',
            'lang': 'en',
            'cookie': COOKIE
        },
        'POST',
        Buffer.from(JSON.stringify({ UserID: userId, GameID: gameId, Platform: 'desktop', Language: 'en' }))
    );
    if (json?.code !== 0) throw new Error(`launch game failed: ${JSON.stringify(json)}`);
    const url: string = json.data.Url as string;
    const u = new URL(url);
    const token = u.searchParams.get('ops') ?? '';
    return { url, token };
}

export async function loginGame(ssoUrl: string) {
    const res = await axiosClient.post(ssoUrl, undefined, { headers: { accept: 'application/json, text/javascript, text/plain', cookie: COOKIE } });
    if (res.status < 200 || res.status >= 300) throw new Error(`login game failed: ${res.status} ${res.statusText}`);
}

export interface LocalTokenResult {
    token: string;
    userId: string;
    gameId: string;
}

// 获取本地测试环境的 Token
export async function localGetToken(gameId: string, controlRTP: number = 300): Promise<LocalTokenResult> {
    const pid = await createPlayer();
    const userId = `PID-${pid}`;
    const { token } = await launchGame(userId, gameId);

    // 设置 RTP
    try {
        await setDemoPlayerRTP({
            demoUserId: userId,
            gameId: gameId,
            controlRTP: controlRTP
        });
    } catch (e: any) {
        // RTP 设置失败不影响返回结果
        // console.warn(`RTP 设置失败: ${e.message}`, gameId);
    }

    return { token, userId, gameId };
}

// 获取本地环境的游戏配置（GameInfo）
export async function localGetGameInfo(gameId: string, token: string) {
    const url = `https://localhost:8443/game-api/${gameId}/v2/GameInfo/Get`;

    const data = await axiosJson(
        url,
        {
            'accept': '*/*',
            'content-type': 'application/x-www-form-urlencoded',
            'cookie': COOKIE
        },
        'POST',
        `btt=1&atk=${token}&pf=2&vc=0`
    );

    if (!data || !data.dt) {
        throw new Error('GameInfo missing in response');
    }

    return parsePGInit(data.dt);
}

export interface LocalSpinParams {
    gameId: string;
    token: string;
    orderId: number;
    cs?: string;      // coin size
    ml?: string;      // multiplier level
    wk?: string;      // work key
    fb?: string;      // feature buy
}

export interface LocalSpinResult {
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

// 本地环境 Spin 请求：封装一次完整回合（可能包含多次 spin）
export async function localSpin(params: LocalSpinParams, delay: number = 200): Promise<LocalSpinResult> {
    const rawSpins: any[] = [];
    let currentOrderId = params.orderId;
    let psid: string | null = null;

    const cs = params.cs || '0.02';
    const ml = params.ml || '1';
    const wk = params.wk || '0_C';

    // 构建请求 body
    let body = `id=${currentOrderId}&cs=${cs}&ml=${ml}&wk=${wk}&btt=1&atk=${params.token}&pf=2`;
    if (params.fb) {
        body += `&fb=${params.fb}`;
    }

    while (true) {
        const url = `https://localhost:8443/game-api/${params.gameId}/v2/Spin`;

        const data = await axiosJson(
            url,
            {
                'accept': '*/*',
                'content-type': 'application/x-www-form-urlencoded',
                'cookie': COOKIE
            },
            'POST',
            body
        );

        await new Promise(resolve => setTimeout(resolve, delay));

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

        body = `id=${currentOrderId}&cs=${cs}&ml=${ml}&wk=${wk}&btt=1&atk=${params.token}&pf=2`;

        currentOrderId = si.sid;

        // 后续 spin 不再携带 fb 参数
        body = `id=${currentOrderId}&cs=${cs}&ml=${ml}&wk=${wk}&btt=1&atk=${params.token}&pf=2`;

        // 检查回合是否结束
        if (isRoundComplete(si)) {
            break;
        }
    }
    
    const lastSpin = rawSpins[rawSpins.length - 1];
    return {
        rawSpins,
        spinData: lastSpin,
        nextOrderId: currentOrderId
    };
}

// 本地环境购买功能的便捷方法
export async function localSpinBuy(params: LocalSpinParams): Promise<LocalSpinResult> {
    // 确保 fb 参数存在
    if (!params.fb) {
        params.fb = '2'; // 默认购买类型
    }
    return localSpin(params);
}

export interface SetRTPParams {
    demoUserId: string;
    gameId: string;
    controlRTP: number; // RTP 控制值，例如 10 表示 10%
}

// 设置本地环境的 RTP
export async function setDemoPlayerRTP(params: SetRTPParams): Promise<void> {
    const json = await axiosJson(
        'https://localhost:8443/api/SetDemoPlayerRTP',
        {
            'appid': APP_ID,
            'appsecret': APP_SECRET,
            'content-type': 'application/json',
            'accept': 'application/json, text/plain, */*',
            'cookie': COOKIE,
            'lang': 'en'
        },
        'POST',
        Buffer.from(JSON.stringify({
            DemoUserId: params.demoUserId,
            GameID: params.gameId,
            ContrllRTP: params.controlRTP
        }))
    );

    if (json?.code !== 0) {
        throw new Error(`set RTP failed: ${JSON.stringify(json)}`);
    }
}
