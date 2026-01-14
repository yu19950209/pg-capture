import Decimal from 'decimal.js';

export interface PGInitResult {
    lines: number;          // 最大线数 mxl
    hasBuyFeature: boolean; // 是否支持购买功能 fb.is
    buyOptions?: any[];     // 购买选项 fb.bm
    cs: string;             // 最小 coin size
    ml: string;             // 最小 multiplier level
    raw: any;               // 原始数据
}

// 解析 PG GameInfo 返回的数据
export function parsePGInit(gameInfo: any): PGInitResult {
    // 提取最小 cs 和 ml
    let cs = '0.02';
    let ml = '1';
    
    if (Array.isArray(gameInfo?.cs) && gameInfo.cs.length > 0) {
        const minCs = Math.min(...gameInfo.cs.map((v: any) => Number(v)));
        cs = String(minCs);
    }
    
    if (Array.isArray(gameInfo?.ml) && gameInfo.ml.length > 0) {
        const minMl = Math.min(...gameInfo.ml.map((v: any) => Number(v)));
        ml = String(minMl);
    }
    
    const result: PGInitResult = {
        lines: Number(gameInfo?.mxl || 0),
        hasBuyFeature: false,
        cs,
        ml,
        raw: gameInfo
    };

    // 检查购买功能
    if (gameInfo?.fb?.is) {
        // console.log('游戏支持购买功能', gameInfo.fb);
        result.hasBuyFeature = true;
        // PG 的 fb.bm 可能是数字或数组
        // 如果是数字，转换为单元素数组
        const bm = gameInfo.fb.bm;
        if (Array.isArray(bm)) {
            result.buyOptions = bm;
        } else if (bm !== null && bm !== undefined) {
            result.buyOptions = [{ si: bm }];
        } else {
            result.buyOptions = [];
        }
    }

    return result;
}

// 通用参数解析（保留以备用）
export function parseParams(str: string): Record<string, string> {
    const result: Record<string, string> = {};
    if (!str) return result;
    
    for (const pair of str.split('&')) {
        if (!pair) continue;
        const [key, value] = pair.split('=');
        if (key) {
            result[key] = decodeURIComponent(value || '');
        }
    }
    
    return result;
}
